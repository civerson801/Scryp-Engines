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
    const analysisPrompt = `You are a senior engineering triage assistant for a fintech company called Check City (CCO - Check City Online). Analyze this JavaScript/application error and return ONLY valid JSON with no markdown, no code fences.

Error details:
- Message: ${errorData.message || "N/A"}
- First Seen: ${errorData.createdAt || "N/A"}
- Last Seen: ${errorData.lastOccurredAt || "N/A"}
- Status: ${errorData.status || "N/A"}
- Raygun URL: ${errorData.applicationUrl || "N/A"}
- Occurrences: ${errorData.occurrenceCount || "N/A"}
- Users Affected: ${errorData.affectedUsersCount || "N/A"}

Return this exact JSON (all fields required, no nulls):
{
  "priority": "critical|high|medium|low",
  "plainEnglish": "2-3 sentence plain-English explanation for a Product Manager",
  "impact": "Who and what is affected, business impact on CCO users",
  "rootCause": "Likely technical root cause in 1-2 sentences",
  "recommendation": "Specific first step the dev team should take",
  "priorityReason": "One sentence explaining why this priority level",
  "jiraTitle": "[BUG] Concise descriptive ticket title under 80 chars",
  "summary": "2-3 sentence summary of the bug for the Jira description header",
  "stepsToReproduce": "Numbered steps to reproduce, or note that investigation is required if steps are unknown",
  "expectedBehavior": "What should happen without this error",
  "actualBehavior": "What actually happens due to this error",
  "technicalDetails": "Error message, Raygun URL, first/last seen dates, occurrence count, likely cause"
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
    const adfContent = [
      adfHeading("Summary"),
      adfParagraph(d.summary),
      adfHeading("Steps to Reproduce"),
      adfParagraph(d.stepsToReproduce),
      adfHeading("Expected Behavior"),
      adfParagraph(d.expectedBehavior),
      adfHeading("Actual Behavior"),
      adfParagraph(d.actualBehavior),
      adfHeading("Impact"),
      adfParagraph(d.impact),
      adfHeading("Technical Details"),
      adfParagraph(d.technicalDetails),
    ];

    const body = {
      fields: {
        project: { key: jiraData.project },
        summary: jiraData.title,
        issuetype: { name: "Bug" },
        priority: { name: priorityMap[jiraData.priority] || "Medium" },
        labels: ["CCO", "Raygun"],
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
