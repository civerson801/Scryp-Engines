export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();

  const { prompt, action, errorData, jiraData } = req.body;

  // Fetch Raygun errors server-side with pagination
  if (action === "fetch_raygun") {
    try {
      const allErrors = [];
      const pageSize = 50;
      let offset = 0;
      let keepFetching = true;

      while (keepFetching) {
        const raygunRes = await fetch(
          `https://api.raygun.com/v3/applications/19hynx5/error-groups?count=${pageSize}&offset=${offset}&sortBy=lastOccurredAt&sortOrder=desc&status=active`,
          {
            headers: {
              Authorization: `Bearer ${process.env.RAYGUN_TOKEN}`,
              "Content-Type": "application/json",
            },
          }
        );
        // Log total count on first page
        if (offset === 0) {
          const totalCount = raygunRes.headers.get("X-Raygun-Total-Count");
          console.log("Raygun total count header:", totalCount);
        }
        const data = await raygunRes.json();
        const page = Array.isArray(data) ? data : (data.data || []);
        console.log(`Page offset=${offset} returned ${page.length} errors`);
        if (page.length === 0) break;
        allErrors.push(...page);
        offset += pageSize;
        if (page.length < pageSize) keepFetching = false;
        if (allErrors.length >= 5000) keepFetching = false;
      }

      // Return active errors, sorted by lastOccurredAt desc
      const errors = allErrors
        .sort((a, b) => new Date(b.lastOccurredAt) - new Date(a.lastOccurredAt));
      return res.status(200).json({ errors });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // Debug: test MCP connectivity and return raw responses
  if (action === "debug_mcp" && errorData) {
    const MCP_URL = "https://api.raygun.com/v3/mcp";
    const mcpHeaders = {
      Authorization: `Bearer ${process.env.RAYGUN_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    const log = [];

    // Helper to POST to MCP and return full response text
    async function mcpPost(method, params) {
      const r = await fetch(MCP_URL, {
        method: "POST",
        headers: mcpHeaders,
        body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
      });
      const ct = r.headers.get("content-type") || "";
      const text = await r.text();
      // Parse SSE or JSON
      let parsed = null;
      if (ct.includes("text/event-stream")) {
        const lines = text.split("\n").filter(l => l.startsWith("data:"));
        for (let i = lines.length - 1; i >= 0; i--) {
          try { parsed = JSON.parse(lines[i].slice(5).trim()); break; } catch {}
        }
      } else {
        try { parsed = JSON.parse(text); } catch {}
      }
      return { status: r.status, contentType: ct, rawText: text.slice(0, 2000), parsed };
    }

    // Step 1: discover available tools
    try {
      const listResult = await mcpPost("tools/list", {});
      log.push({ step: "tools/list", ...listResult });
    } catch (e) { log.push({ step: "tools/list", error: e.message }); }

    // Step 2: try error_group_investigate with full error identifier
    try {
      const r = await mcpPost("tools/call", {
        name: "error_group_investigate",
        arguments: { applicationIdentifier: "19hynx5", errorGroupIdentifier: errorData.identifier },
      });
      log.push({ step: "error_group_investigate", ...r });
    } catch (e) { log.push({ step: "error_group_investigate", error: e.message }); }

    // Step 3: try error_instances_browse
    try {
      const r = await mcpPost("tools/call", {
        name: "error_instances_browse",
        arguments: { applicationIdentifier: "19hynx5", errorGroupIdentifier: errorData.identifier, count: 1 },
      });
      log.push({ step: "error_instances_browse", ...r });
    } catch (e) { log.push({ step: "error_instances_browse", error: e.message }); }

    return res.status(200).json({ errorIdentifier: errorData.identifier, debug: log });
  }

  // Analyze a single error with AI
  if (action === "analyze_error" && errorData) {
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });
    }

    // Fetch full error detail — try Raygun MCP first, fall back to v1 REST API
    let stackTrace = "";
    let errorContext = "";
    let rawInstanceData = "";
    let stackTraceSource = "none";

    // ── Helper: call one Raygun MCP tool via JSON-RPC ──────────────────────────
    async function callRaygunMcp(toolName, toolInput) {
      const MCP_URL = "https://api.raygun.com/v3/mcp";
      const headers = {
        Authorization: `Bearer ${process.env.RAYGUN_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      };
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/call",
        params: { name: toolName, arguments: toolInput },
      });

      const mcpRes = await fetch(MCP_URL, { method: "POST", headers, body });
      const ct = mcpRes.headers.get("content-type") || "";
      console.log(`[MCP] ${toolName} → HTTP ${mcpRes.status} content-type: ${ct}`);

      if (!mcpRes.ok) {
        const errBody = await mcpRes.text();
        console.log(`[MCP] ${toolName} error body (first 300): ${errBody.slice(0, 300)}`);
        return null;
      }

      // SSE response — read full stream and extract last result
      if (ct.includes("text/event-stream")) {
        const text = await mcpRes.text();
        console.log(`[MCP] ${toolName} SSE raw (first 500): ${text.slice(0, 500)}`);
        const lines = text.split("\n").filter(l => l.startsWith("data:"));
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const json = JSON.parse(lines[i].slice(5).trim());
            // Return the result object — may have isError:true which caller checks
            if (json?.result !== undefined) return json.result;
          } catch {}
        }
        console.log(`[MCP] ${toolName} SSE: no result found in ${lines.length} data lines`);
        return null;
      }

      // Plain JSON response
      const text = await mcpRes.text();
      console.log(`[MCP] ${toolName} JSON raw (first 500): ${text.slice(0, 500)}`);
      try {
        const json = JSON.parse(text);
        // Return result object — may have isError:true
        return json?.result !== undefined ? json.result : null;
      } catch {
        return null;
      }
    }

    // ── Helper: extract stack trace data from MCP result content ───────────────
    // Returns empty string if the result is an MCP error (isError: true)
    function extractFromMcpContent(result) {
      if (!result) return "";
      // MCP error response — don't pass this garbage to the AI
      if (result.isError === true) {
        const errText = Array.isArray(result.content)
          ? result.content.map(c => c.text || "").join(" ")
          : "";
        console.log(`[MCP] isError=true: ${errText.slice(0, 200)}`);
        return "";
      }
      return Array.isArray(result.content)
        ? result.content.map(c => c.text || "").join("\n")
        : typeof result === "string" ? result : JSON.stringify(result);
    }

    // ── Helper: parse structured fields from instance JSON ─────────────────────
    function parseInstanceJson(text) {
      // Try direct parse first
      try { return JSON.parse(text); } catch {}
      // Strip leading/trailing non-JSON characters
      try {
        const trimmed = text.replace(/^[^{[]*/, "").replace(/[^}\]]*$/, "");
        return JSON.parse(trimmed);
      } catch {}
      return null;
    }

    // ── Strategy 1: Raygun MCP (JSON-RPC) ─────────────────────────────────────
    try {
      console.log("[MCP] Starting MCP fetch for error:", errorData.identifier);

      // Step 1: error group overview
      const groupResult = await callRaygunMcp("error_group_investigate", {
        applicationIdentifier: "19hynx5",
        errorGroupIdentifier: errorData.identifier,
      });
      const groupContent = extractFromMcpContent(groupResult);
      if (groupContent) {
        rawInstanceData += groupContent + "\n";
        console.log(`[MCP] error_group_investigate: got ${groupContent.length} chars`);
      } else {
        console.log("[MCP] error_group_investigate: no content returned");
      }

      // Step 2: browse instances for a recent instance identifier
      const instancesResult = await callRaygunMcp("error_instances_browse", {
        applicationIdentifier: "19hynx5",
        errorGroupIdentifier: errorData.identifier,
        count: 1,
      });
      const instancesContent = extractFromMcpContent(instancesResult);
      let instanceId = null;
      if (instancesContent) {
        rawInstanceData += instancesContent + "\n";
        const idMatch = instancesContent.match(/"identifier"\s*:\s*"([^"]+)"/);
        instanceId = idMatch?.[1] || null;
        console.log(`[MCP] error_instances_browse: got ${instancesContent.length} chars, instanceId=${instanceId}`);
      } else {
        console.log("[MCP] error_instances_browse: no content returned");
      }

      // Step 3: full instance detail with stack trace
      if (instanceId) {
        const detailResult = await callRaygunMcp("error_instance_get_details", {
          applicationIdentifier: "19hynx5",
          errorGroupIdentifier: errorData.identifier,
          errorInstanceIdentifier: instanceId,
        });
        const detailContent = extractFromMcpContent(detailResult);
        if (detailContent) {
          rawInstanceData += detailContent + "\n";
          console.log(`[MCP] error_instance_get_details: got ${detailContent.length} chars`);

          const detailJson = parseInstanceJson(detailContent);
          if (detailJson) {
            const trace = detailJson?.details?.error?.stackTrace
              || detailJson?.error?.stackTrace
              || detailJson?.stackTrace
              || [];
            if (trace.length) {
              stackTrace = trace
                .slice(0, 25)
                .map(f => `  at ${f.methodName || f.className || "unknown"} (${f.fileName || f.className || ""}:${f.lineNumber || ""})`)
                .join("\n");
              stackTraceSource = "mcp";
              console.log(`[MCP] Extracted ${trace.length} stack frames`);
            }
            const req = detailJson?.details?.request || detailJson?.request;
            if (req?.url) errorContext = `${req.httpMethod || "GET"} ${req.url}`;
          } else {
            // AI can still parse freeform text — rawInstanceData has everything
            stackTraceSource = "mcp-freeform";
            console.log("[MCP] Could not parse JSON, passing freeform to AI");
          }
        } else {
          console.log("[MCP] error_instance_get_details: no content returned");
        }
      }
    } catch (e) {
      console.log("[MCP] Exception during MCP fetch:", e.message);
    }

    // ── Strategy 2: v1 REST API fallback (has /errors endpoint with raw payload) ─
    if (!rawInstanceData && stackTraceSource === "none") {
      try {
        console.log("[V1] MCP returned nothing — trying v1 REST API fallback");
        // The v1 API uses X-ApiKey header and a different base URL
        // Endpoint: GET /application/{appApiKey}/crashreporting/errors/{errorId}
        // We don't have the app API key, but we can try the v3 error-groups/{id} single record
        // which at least gives us more than the list endpoint
        const v3DetailRes = await fetch(
          `https://api.raygun.com/v3/applications/19hynx5/error-groups/${errorData.identifier}`,
          {
            headers: {
              Authorization: `Bearer ${process.env.RAYGUN_TOKEN}`,
              Accept: "application/json",
            },
          }
        );
        console.log(`[V1] v3 error-group detail → HTTP ${v3DetailRes.status}`);
        if (v3DetailRes.ok) {
          const v3Detail = await v3DetailRes.json();
          rawInstanceData = JSON.stringify(v3Detail, null, 2);
          stackTraceSource = "v3-detail";
          console.log(`[V1] v3 error-group detail: got ${rawInstanceData.length} chars`);
          // Extract any fields available
          if (v3Detail.message) errorContext = v3Detail.message;
        }
      } catch (e) {
        console.log("[V1] v1 fallback error:", e.message);
      }
    }

    console.log(`[TRIAGE] Stack source: ${stackTraceSource}, rawData: ${rawInstanceData.length} chars, stackTrace: ${stackTrace.length} chars`);

    // If we have no instance data at all, use a minimal prompt that returns honest unknowns
    const hasData = rawInstanceData.length > 0 || stackTrace.length > 0;

    const analysisPrompt = `You are a senior engineering triage assistant for a fintech company called Check City (CCO - Check City Online). Analyze this error and return ONLY valid JSON with no markdown, no code fences.

Error details:
- Message: ${errorData.message || "N/A"}
- First Seen: ${errorData.createdAt || "N/A"}
- Last Seen: ${errorData.lastOccurredAt || "N/A"}
- Status: ${errorData.status || "N/A"}
- Raygun Error URL: ${errorData.applicationUrl || "N/A"}
- Request Context: ${errorContext || "N/A"}
- Stack Trace (structured):
${stackTrace || (hasData ? "See raw data below" : "Not available — stack trace could not be retrieved")}

Raw Raygun Instance Data (use this as your primary source — extract stack trace, request URL, machine name, user info, environment, SQL errors, etc. from here):
${hasData ? rawInstanceData.slice(0, 6000) : "Not available — instance data could not be retrieved from Raygun"}

${!hasData ? `IMPORTANT: No stack trace or instance data was available for this error. You only have the error message and timestamps above.
Base your analysis ONLY on what the error message itself tells you. Do NOT invent details about affected pages, users, or root causes that you cannot confirm from the message alone.
For fields where you genuinely cannot determine the answer, use "Insufficient data — stack trace required" rather than speculating.
For priority: if the error message suggests a critical system (login, payments, loans), assign medium as a conservative estimate. Otherwise assign low.` : ""}

Priority guide (base priority on user/system impact, NOT recency):
- critical: directly blocks core user workflows (login, payments, loan applications, account access) OR causes data loss/corruption OR affects many users simultaneously
- high: degrades a significant feature or causes frequent errors that frustrate users but does not fully block them, OR affects a key business process like notifications or reporting
- medium: causes minor friction or edge case failures, limited user impact, workaround exists
- low: cosmetic issues, rare edge cases, errors that do not affect functionality or user experience

Always consider: how many users are affected, how critical is the broken feature to Check City's core business, and how severely is their experience degraded.

Return this exact JSON (all fields required, no nulls):
{
  "priority": "critical|high|medium|low",
  "plainEnglish": "2-3 sentences explaining what is broken in plain English for a Product Manager. Use the stack trace to identify the specific page or feature affected and the likely condition that triggers it. Be accurate about scope — avoid saying all users are affected unless the stack trace confirms it. Describe what the affected user experiences without overstating the severity.",
  "impact": "Based ONLY on what the stack trace and request context actually confirm — do not speculate or assume worst case. Identify the specific page or feature affected using the request URL and method names. Describe what a customer in that specific situation would experience. Be precise about scope: is this affecting all users or only users in a specific state, workflow step, or condition? Only mention revenue or compliance impact if the stack trace directly involves a payment, loan submission, or regulated transaction. If the error appears intermittent or conditional, say so. Write for a Product Manager in plain English — no jargon, no exaggeration.",
  "rootCause": "Use the stack trace to identify the specific file, method, or line where the error originates. Explain in developer terms what is failing and why — reference actual class names, methods, or modules from the stack trace if available.",
  "recommendation": "Specific first step the dev team should take",
  "priorityReason": "One sentence explaining the priority based strictly on what the stack trace confirms about scope and severity. Do not overstate — if the error is conditional or affects a subset of users, reflect that.",
  "jiraTitle": "Concise user-friendly ticket title under 80 chars — describe the user-facing problem, not the technical error. Example: 'Form validation fails on registration page' not 'jQuery .valid() undefined'",
  "summary": "2-3 sentences describing what is broken and what the user experiences. Write for a non-technical audience.",
  "stepsToReproduce": "Use the stack trace, request URL, referer, and any user/loan context to write the most accurate reproduction steps possible for a QA tester. Reference specific pages (.aspx routes), user states (logged in, loan in NV state, deferred loan, etc.), and the exact sequence of actions that led to the error. Include specific IDs or states if present in the stack context. Write 3-6 numbered steps. Be as specific as the stack trace allows.",
  "environment": "Extract all available environment details from the stack trace and request context. Return as a newline-separated list of key: value pairs. Include every field available such as: Host, Machine, Build, State, Affected User, Loan ID, isRefinance, Referer, Method, SQL Server, Occurred. Only include fields that have actual values from the stack trace — do not invent values. Example format: Host: members.checkcity.com\nMachine: CCDBMEMBERS11\nMethod: GET /Loan_ThankYou.aspx\nOccurred: 2026-03-10 1:39:13 PM",
  "technicalDetails": "Error message verbatim, first seen and last seen dates, likely technical cause in one sentence",
  "developerNotes": "The full Raygun error URL for direct investigation (use errorData.applicationUrl)"
}`;

    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1500,
        messages: [{ role: "user", content: analysisPrompt }],
      }),
    });
    const aiData = await aiRes.json();
    const text = aiData?.content?.[0]?.text || "";
    const clean = text.replace(/```json|```/g, "").trim();
    try {
      return res.status(200).json({ analysis: JSON.parse(clean) });
    } catch {
      return res.status(500).json({ error: "Failed to parse AI response", raw: text });
    }
  }

  // Create Jira ticket via Anthropic MCP
  if (action === "create_jira" && jiraData) {
    const atlassianEmail = process.env.ATLASSIAN_EMAIL;
    const atlassianToken = process.env.ATLASSIAN_TOKEN;
    const jiraDomain = "softwise.atlassian.net";

    if (!atlassianEmail || !atlassianToken) {
      return res.status(500).json({ error: "ATLASSIAN_EMAIL or ATLASSIAN_TOKEN not set in Vercel environment variables" });
    }

    const priorityMap = { critical: "Highest", high: "High", medium: "Medium", low: "Low" };
    const auth = Buffer.from(`${atlassianEmail}:${atlassianToken}`).toString("base64");

    // Build ADF description with structured sections
    function adfHeading(text, level = 3) {
      return { type: "heading", attrs: { level }, content: [{ type: "text", text }] };
    }
    function adfParagraph(text) {
      return { type: "paragraph", content: [{ type: "text", text: text || "To be investigated." }] };
    }
    function adfBullet(items) {
      return {
        type: "bulletList",
        content: items.map(item => ({
          type: "listItem",
          content: [{ type: "paragraph", content: [{ type: "text", text: item }] }]
        }))
      };
    }

    const d = jiraData.sections || {};

    // Build environment as bullet list
    const envLines = (d.environment || "").split("\n").filter(Boolean);
    const envNode = envLines.length > 1
      ? adfBullet(envLines)
      : adfParagraph(d.environment);

    // Build reproduction steps - detect numbered list
    const stepLines = (d.stepsToReproduce || "").split("\n").filter(l => l.trim());
    const stepsNode = stepLines.length > 1
      ? {
          type: "orderedList",
          content: stepLines.map(line => ({
            type: "listItem",
            content: [{ type: "paragraph", content: [{ type: "text", text: line.replace(/^\d+\.\s*/, "") }] }]
          }))
        }
      : adfParagraph(d.stepsToReproduce);

    const adfContent = [
      adfHeading("Description"),
      adfParagraph(d.summary),
      adfParagraph(d.technicalDetails),
      adfHeading("Reproduction Steps"),
      stepsNode,
      adfHeading("Environment"),
      envNode,
      adfHeading("Developer Notes"),
      adfParagraph(d.developerNotes || jiraData.raygunUrl || ""),
    ];

    const body = {
      fields: {
        project: { key: jiraData.project },
        summary: jiraData.title,
        issuetype: { name: "Bug" },
        priority: { name: priorityMap[jiraData.priority] || "Medium" },
        labels: ["CCO", "Raygun", "AI"],
        components: [{ name: "Web" }],
        parent: { key: "TDG-125" },
        description: { type: "doc", version: 1, content: adfContent },
      }
    };

    if (jiraData.assigneeId) {
      body.fields.assignee = { accountId: jiraData.assigneeId };
    }

    const jiraRes = await fetch(`https://${jiraDomain}/rest/api/3/issue`, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${auth}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify(body),
    });

    const jiraData2 = await jiraRes.json();
    console.log("Jira REST response:", JSON.stringify(jiraData2));

    if (!jiraRes.ok) {
      const errMsg = jiraData2.errors ? JSON.stringify(jiraData2.errors) : (jiraData2.errorMessages?.[0] || `HTTP ${jiraRes.status}`);
      return res.status(500).json({ error: `Jira error: ${errMsg}` });
    }

    return res.status(200).json({ success: true, key: jiraData2.key, id: jiraData2.id });
  }

  // Original prompt-based generation
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ text: "ERROR: ANTHROPIC_API_KEY is not set." });
  }
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await response.json();
  const text = data?.content?.[0]?.text || JSON.stringify(data);
  res.status(200).json({ text });
}
