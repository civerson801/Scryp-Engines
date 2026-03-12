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
          `https://api.raygun.com/v3/applications/19hynx5/error-groups?count=${pageSize}&offset=${offset}&sortBy=lastOccurredAt&sortOrder=desc`,
          {
            headers: {
              Authorization: `Bearer ${process.env.RAYGUN_TOKEN}`,
              "Content-Type": "application/json",
            },
          }
        );
        const data = await raygunRes.json();
        const page = Array.isArray(data) ? data : (data.data || []);
        if (page.length === 0) break;
        allErrors.push(...page);
        offset += pageSize;
        // Stop if we got fewer results than requested (last page)
        if (page.length < pageSize) keepFetching = false;
        // Safety cap at 500 errors
        if (allErrors.length >= 500) keepFetching = false;
      }

      // Return active errors, sorted by lastOccurredAt desc
      const errors = allErrors
        .filter(e => e.status === "active")
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
    const analysisPrompt = `You are a senior engineering triage assistant for a fintech company called Check City (CCO system). Analyze this error and return ONLY valid JSON with no markdown.

Error:
- Message: ${errorData.message || "N/A"}
- First Seen: ${errorData.createdAt || "N/A"}
- Last Seen: ${errorData.lastOccurredAt || "N/A"}
- Status: ${errorData.status || "N/A"}
- URL: ${errorData.applicationUrl || "N/A"}

Return this exact JSON:
{
  "priority": "critical|high|medium|low",
  "plainEnglish": "2-3 sentence explanation for a Product Manager",
  "impact": "Who and what is affected, business impact",
  "rootCause": "Likely technical root cause",
  "recommendation": "What the dev team should investigate first",
  "jiraTitle": "[BUG] Concise ticket title",
  "jiraDescription": "Full bug description with sections: *Summary*, *Steps to Reproduce*, *Expected Behavior*, *Actual Behavior*, *Impact*, *Technical Details*",
  "priorityReason": "One sentence explaining the priority"
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

    // Build ADF description
    const descLines = (jiraData.description || "").split("\n").filter(Boolean);
    const adfContent = descLines.map(line => ({
      type: "paragraph",
      content: [{ type: "text", text: line }]
    }));

    const body = {
      fields: {
        project: { key: jiraData.project },
        summary: jiraData.title,
        issuetype: { name: "Bug" },
        priority: { name: priorityMap[jiraData.priority] || "Medium" },
        description: {
          type: "doc",
          version: 1,
          content: adfContent.length ? adfContent : [{ type: "paragraph", content: [{ type: "text", text: jiraData.description || "" }] }]
        },
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
