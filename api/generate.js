export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();

  const { prompt, action, errorData, jiraData } = req.body;

  // Fetch Raygun errors server-side
  if (action === "fetch_raygun") {
    try {
      const raygunRes = await fetch(
        "https://api.raygun.com/v3/applications/19hynx5/error-groups?count=200&sortBy=lastOccurredAt&sortOrder=desc",
        {
          headers: {
            Authorization: `Bearer ${process.env.RAYGUN_TOKEN}`,
            "Content-Type": "application/json",
          },
        }
      );
      const data = await raygunRes.json();
      const raw = Array.isArray(data) ? data : (data.data || []);
      // Only show active errors (matching Raygun's Active tab)
      const errors = raw.filter(e => e.status === 'active');
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
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });
    }
    const priorityMap = { critical: "Highest", high: "High", medium: "Medium", low: "Low" };
    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        messages: [{
          role: "user",
          content: `Create a Jira issue in project ${jiraData.project} with these details:\n- Summary: ${jiraData.title}\n- Issue Type: Bug\n- Priority: ${priorityMap[jiraData.priority] || "Medium"}\n- Description: ${jiraData.description}\n- Assignee account ID: ${jiraData.assigneeId || ""}`,
        }],
        mcp_servers: [{ type: "url", url: "https://mcp.atlassian.com/v1/mcp", name: "atlassian" }],
      }),
    });
    const data = await aiRes.json();
    let ticketKey = null;
    for (const block of (data.content || [])) {
      if (block.type === "mcp_tool_result") {
        const rt = block.content?.[0]?.text || "";
        try { const p = JSON.parse(rt); if (p.key) { ticketKey = p.key; break; } } catch {}
        const m = rt.match(/[A-Z]+-[0-9]+/); if (m) { ticketKey = m[0]; break; }
      }
      if (block.type === "text" && block.text && !ticketKey) {
        const m = block.text.match(/[A-Z]+-[0-9]+/); if (m) ticketKey = m[0];
      }
    }
    const textBlock = data.content?.find(b => b.type === "text");
    return res.status(200).json({ success: true, key: ticketKey, message: textBlock?.text });
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
