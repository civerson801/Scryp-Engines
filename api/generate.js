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

  // Analyze a single error with AI
  if (action === "analyze_error" && errorData) {
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });
    }

    // Fetch full error detail via Raygun MCP server (supports stack traces + instance data)
    let stackTrace = "";
    let errorContext = "";
    let rawInstanceData = "";

    async function callRaygunMcp(toolName, toolInput) {
      // MCP over HTTP: send an initialize then a tools/call via JSON-RPC
      const MCP_URL = "https://api.raygun.com/v3/mcp";
      const headers = {
        Authorization: `Bearer ${process.env.RAYGUN_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      };

      // Use streamable HTTP transport (POST with JSON-RPC)
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/call",
        params: { name: toolName, arguments: toolInput },
      });

      const mcpRes = await fetch(MCP_URL, { method: "POST", headers, body });
      const ct = mcpRes.headers.get("content-type") || "";

      if (!mcpRes.ok) {
        console.log(`MCP ${toolName} failed: ${mcpRes.status}`);
        return null;
      }

      // Handle SSE response — read full stream and extract last data line
      if (ct.includes("text/event-stream")) {
        const text = await mcpRes.text();
        const lines = text.split("\n").filter(l => l.startsWith("data:"));
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const json = JSON.parse(lines[i].slice(5).trim());
            if (json?.result) return json.result;
          } catch {}
        }
        return null;
      }

      // Handle plain JSON response
      const json = await mcpRes.json();
      return json?.result || null;
    }

    try {
      // Step 1: get the error group overview + first occurrence stack trace
      const groupResult = await callRaygunMcp("error_group_investigate", {
        applicationIdentifier: "19hynx5",
        errorGroupIdentifier: errorData.identifier,
      });

      if (groupResult) {
        const content = Array.isArray(groupResult.content)
          ? groupResult.content.map(c => c.text || "").join("\n")
          : JSON.stringify(groupResult);
        rawInstanceData += content + "\n";
        console.log("MCP error_group_investigate response length:", content.length);
      }

      // Step 2: browse instances to get a recent one with full stack trace
      const instancesResult = await callRaygunMcp("error_instances_browse", {
        applicationIdentifier: "19hynx5",
        errorGroupIdentifier: errorData.identifier,
        count: 1,
      });

      let instanceId = null;
      if (instancesResult) {
        const instanceContent = Array.isArray(instancesResult.content)
          ? instancesResult.content.map(c => c.text || "").join("\n")
          : JSON.stringify(instancesResult);

        // Try to extract an instance identifier from the response text
        const idMatch = instanceContent.match(/"identifier"\s*:\s*"([^"]+)"/);
        if (idMatch) instanceId = idMatch[1];
        rawInstanceData += instanceContent + "\n";
        console.log("MCP error_instances_browse instanceId:", instanceId);
      }

      // Step 3: get full raw data for that instance (stack trace, request, environment)
      if (instanceId) {
        const instanceDetail = await callRaygunMcp("error_instance_get_details", {
          applicationIdentifier: "19hynx5",
          errorGroupIdentifier: errorData.identifier,
          errorInstanceIdentifier: instanceId,
        });

        if (instanceDetail) {
          const detailContent = Array.isArray(instanceDetail.content)
            ? instanceDetail.content.map(c => c.text || "").join("\n")
            : JSON.stringify(instanceDetail);
          rawInstanceData += detailContent + "\n";
          console.log("MCP error_instance_get_details response length:", detailContent.length);

          // Try to parse structured stack trace from detail
          try {
            const detailJson = JSON.parse(
              detailContent.replace(/^[^{[]*/, "").replace(/[^}\]]*$/, "")
            );
            const trace = detailJson?.details?.error?.stackTrace
              || detailJson?.error?.stackTrace
              || detailJson?.stackTrace
              || [];
            if (trace.length) {
              stackTrace = trace
                .slice(0, 20)
                .map(f => `  at ${f.methodName || f.className || "unknown"} (${f.fileName || f.className || ""}:${f.lineNumber || ""})`)
                .join("\n");
            }
            const req = detailJson?.details?.request || detailJson?.request;
            if (req?.url) errorContext = `${req.httpMethod || "GET"} ${req.url}`;
          } catch {
            // Let the AI parse rawInstanceData as freeform text — it has everything
          }
        }
      }
    } catch (e) {
      console.log("Raygun MCP fetch error:", e.message);
    }

    const analysisPrompt = `You are a senior engineering triage assistant for a fintech company called Check City (CCO - Check City Online). Analyze this error and return ONLY valid JSON with no markdown, no code fences.

Error details:
- Message: ${errorData.message || "N/A"}
- First Seen: ${errorData.createdAt || "N/A"}
- Last Seen: ${errorData.lastOccurredAt || "N/A"}
- Status: ${errorData.status || "N/A"}
- Raygun Error URL: ${errorData.applicationUrl || "N/A"}
- Request Context: ${errorContext || "N/A"}
- Stack Trace (structured):
${stackTrace || "See raw data below"}

Raw Raygun Instance Data (use this as your primary source — extract stack trace, request URL, machine name, user info, environment, SQL errors, etc. from here):
${rawInstanceData ? rawInstanceData.slice(0, 6000) : "Not available"}

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
