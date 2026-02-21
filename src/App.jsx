import { useState, useRef } from "react";

const ENGINES = [
  {
    id: "followup-lead",
    label: "Lead Follow-Up",
    icon: "↩",
    color: "#00E5B4",
    description: "Re-engage cold or warm leads with a personalized nudge",
    fields: [
      { key: "leadName", label: "Lead Name", placeholder: "e.g. Sarah Mitchell" },
      { key: "company", label: "Company", placeholder: "e.g. Apex Logistics" },
      { key: "lastContact", label: "Last Contact Context", placeholder: "e.g. demo call 2 weeks ago, expressed interest in analytics" },
      { key: "painPoint", label: "Pain Point / Goal", placeholder: "e.g. reducing manual reporting time" },
      { key: "tone", label: "Tone", type: "select", options: ["Warm & Casual", "Professional", "Urgent / FOMO", "Value-Led"] },
    ],
    prompt: (f) => `You are a senior sales rep at Scryp, a B2B SaaS platform for sales and operations automation. Write a concise, high-converting follow-up email to ${f.leadName || "[Lead Name]"} at ${f.company || "[Company]"}. 

Context: ${f.lastContact || "[last contact context]"}
Their key pain point or goal: ${f.painPoint || "[pain point]"}
Tone: ${f.tone || "Professional"}

Requirements:
- Subject line that creates curiosity or urgency (not generic)
- Opening that references the last interaction naturally
- One clear value proposition tied to their pain point
- A frictionless CTA (soft ask — 15-min call, quick reply, etc.)
- 3–5 sentences max body. No fluff.

Output: Subject line + Email body only.`,
  },
  {
    id: "industry-campaign",
    label: "Industry Campaign",
    icon: "◈",
    color: "#FF6B35",
    description: "Generate a targeted email sequence for a specific vertical",
    fields: [
      { key: "industry", label: "Industry / Vertical", placeholder: "e.g. Commercial Real Estate, Manufacturing, SaaS" },
      { key: "persona", label: "Target Persona", placeholder: "e.g. VP of Operations, Revenue Ops Manager" },
      { key: "companySize", label: "Company Size", type: "select", options: ["SMB (1–50)", "Mid-Market (51–500)", "Enterprise (500+)", "Any"] },
      { key: "campaignGoal", label: "Campaign Goal", type: "select", options: ["Book a Demo", "Free Trial Sign-Up", "Webinar Registration", "Awareness / Nurture"] },
      { key: "numEmails", label: "# of Emails in Sequence", type: "select", options: ["1", "2", "3", "5"] },
      { key: "differentiator", label: "Key Scryp Differentiator to Highlight", placeholder: "e.g. AI-powered outreach, real-time pipeline visibility" },
    ],
    prompt: (f) => `You are a B2B demand generation specialist at Scryp. Create a ${f.numEmails || "3"}-email cold outreach sequence targeting ${f.persona || "[persona]"} at ${f.companySize || "Mid-Market"} companies in the ${f.industry || "[industry]"} industry.

Campaign Goal: ${f.campaignGoal || "Book a Demo"}
Key Differentiator to Highlight: ${f.differentiator || "[differentiator]"}

For each email provide:
1. Email # and send timing (e.g. Day 1, Day 4, Day 8)
2. Subject line (A/B test variant if possible)
3. Body (concise, punchy, industry-specific language and pain points)
4. CTA

Make the sequence tell a story — don't repeat the same angle. Use industry-specific language and real pain points that resonate with ${f.industry || "this industry"} operations teams. No filler.`,
  },
  {
    id: "scheduled-followup",
    label: "Scheduled Follow-Up",
    icon: "◷",
    color: "#A78BFA",
    description: "Draft a follow-up to send at a specific future point in the deal cycle",
    fields: [
      { key: "leadName", label: "Lead Name", placeholder: "e.g. James Ortega" },
      { key: "company", label: "Company", placeholder: "e.g. TerraFlow Inc." },
      { key: "dealStage", label: "Deal Stage", type: "select", options: ["Initial Outreach", "Post-Demo", "Proposal Sent", "In Negotiation", "Gone Dark"] },
      { key: "daysFromNow", label: "Send Timing", type: "select", options: ["3 days", "1 week", "2 weeks", "1 month"] },
      { key: "objection", label: "Known Objection or Hesitation", placeholder: "e.g. budget concerns, evaluating competitors, timing" },
      { key: "nudge", label: "New Angle / Nudge to Include", placeholder: "e.g. new case study, limited-time offer, product update" },
    ],
    prompt: (f) => `You are a B2B account executive at Scryp. Write a follow-up email to be sent in ${f.daysFromNow || "1 week"} to ${f.leadName || "[Lead]"} at ${f.company || "[Company]"}.

Deal Stage: ${f.dealStage || "Post-Demo"}
Known Objection or Hesitation: ${f.objection || "[objection]"}
New Angle to Include: ${f.nudge || "[new nudge or info]"}

Write an email that:
- Acknowledges where we left off without being pushy
- Addresses their hesitation subtly or reframes it
- Introduces the new angle naturally to re-spark interest
- Ends with a low-pressure ask
- Feels like it was written by a human who genuinely wants to help, not close at all costs

Keep it under 100 words in the body. Include subject line.`,
  },
  {
    id: "cold-outreach",
    label: "Cold Outreach",
    icon: "⚡",
    color: "#FACC15",
    description: "First-touch cold email to a prospect with no prior contact",
    fields: [
      { key: "prospectName", label: "Prospect Name", placeholder: "e.g. Dana Chen" },
      { key: "company", label: "Prospect Company", placeholder: "e.g. Momentum Partners" },
      { key: "trigger", label: "Personalization Trigger", placeholder: "e.g. they just raised Series B, hired 10 sales reps, posted about ops challenges" },
      { key: "hook", label: "Opening Hook Style", type: "select", options: ["Insight / Industry Trend", "Pain Agitation", "Social Proof / Result", "Bold Question", "Compliment + Pivot"] },
      { key: "persona", label: "Their Role", placeholder: "e.g. Head of Revenue Operations" },
    ],
    prompt: (f) => `You are a top-performing SDR at Scryp. Write a cold outreach email to ${f.prospectName || "[Prospect]"}, ${f.persona || "[their role]"} at ${f.company || "[Company]"}.

Personalization Trigger: ${f.trigger || "[trigger]"}
Opening Hook Style: ${f.hook || "Pain Agitation"}

Rules:
- Subject line must be < 8 words and feel human, not salesy
- First line must be hyper-personalized using the trigger — no generic openers
- Body = 2–3 punchy sentences: problem → Scryp solution → result
- CTA = one easy yes/no question or a soft calendar ask
- Do NOT mention features. Focus on outcomes.
- Sound like a peer reaching out, not a vendor pitching.

Output: Subject + Email only.`,
  },
  {
    id: "re-engagement",
    label: "Re-Engagement",
    icon: "⟳",
    color: "#38BDF8",
    description: "Win back a churned customer or dormant contact",
    fields: [
      { key: "contactName", label: "Contact Name", placeholder: "e.g. Marcus Webb" },
      { key: "company", label: "Company", placeholder: "e.g. Solara Group" },
      { key: "dormantDuration", label: "How Long Gone Dark", type: "select", options: ["1–2 months", "3–6 months", "6–12 months", "1+ year"] },
      { key: "lastKnownStatus", label: "Last Known Status", type: "select", options: ["Was a customer (churned)", "Was a warm lead (stalled)", "Attended a webinar/event", "Downloaded content"] },
      { key: "newHook", label: "What's Changed at Scryp", placeholder: "e.g. new AI features, pricing restructure, relevant case study from their industry" },
    ],
    prompt: (f) => `You are a customer success and re-engagement specialist at Scryp. Write a re-engagement email to ${f.contactName || "[Contact]"} at ${f.company || "[Company]"} who has been dormant for ${f.dormantDuration || "3–6 months"}.

Last Known Status: ${f.lastKnownStatus || "Was a warm lead (stalled)"}
New Hook / What's Changed: ${f.newHook || "[new development]"}

Write an email that:
- Opens without guilt-tripping or being awkward about the silence
- Leads with what's new or relevant that earned the right to reach back out
- Is brief, warm, and curious — not desperate
- Ends with a low-commitment ask
- Subject line should feel fresh, not like "Just checking in..."

Body: max 80 words. Include subject line.`,
  },
  {
    id: "internal-ops",
    label: "Ops Briefing",
    icon: "≡",
    color: "#F472B6",
    description: "Generate internal ops updates, pipeline summaries, or team briefs",
    fields: [
      { key: "briefType", label: "Brief Type", type: "select", options: ["Weekly Pipeline Summary", "Deal Status Update", "Team Performance Brief", "Forecast Report Narrative", "Handoff / Transition Note"] },
      { key: "audience", label: "Audience", type: "select", options: ["Sales Leadership", "CEO / Exec Team", "Account Executive", "Customer Success", "Whole Team"] },
      { key: "keyData", label: "Key Data / Metrics to Include", placeholder: "e.g. 12 open deals, 3 in final stage, $240k pipeline, 2 deals at risk" },
      { key: "highlights", label: "Wins / Highlights", placeholder: "e.g. closed Apex deal, 2 new demos booked" },
      { key: "blockers", label: "Blockers / Risks", placeholder: "e.g. Q4 budget freeze affecting 3 prospects" },
    ],
    prompt: (f) => `You are a Revenue Operations analyst at Scryp. Write a ${f.briefType || "Weekly Pipeline Summary"} for ${f.audience || "Sales Leadership"}.

Key Data / Metrics: ${f.keyData || "[metrics]"}
Wins / Highlights: ${f.highlights || "[highlights]"}
Blockers / Risks: ${f.blockers || "[blockers]"}

Format:
- Clear headline (with date range if weekly)
- 3–4 short sections: Overview, Highlights, Risks/Blockers, Next Steps
- Use concise bullet points within sections
- Tone: confident, data-forward, no filler
- End with 2–3 clear action items or owner assignments

Make it scannable in under 60 seconds.`,
  },
];

export default function ScrypEngines() {
  const [activeEngine, setActiveEngine] = useState(null);
  const [fields, setFields] = useState({});
  const [output, setOutput] = useState("");
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const outputRef = useRef(null);

  const engine = ENGINES.find((e) => e.id === activeEngine);

  const handleSelect = (id) => {
    setActiveEngine(id);
    setFields({});
    setOutput("");
    setCopied(false);
  };

  const handleFieldChange = (key, value) => {
    setFields((prev) => ({ ...prev, [key]: value }));
  };

  const handleGenerate = async () => {
    if (!engine) return;
    setLoading(true);
    setOutput("");
    setCopied(false);

    const prompt = engine.prompt(fields);

    try {
const response = await fetch("/api/generate", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ prompt }),
});
const data = await response.json();
setOutput(data.text);
    } catch (e) {
      setOutput("Error generating output. Please try again.");
    }
    setLoading(false);
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(output);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div style={{
      fontFamily: "'DM Mono', 'Courier New', monospace",
      background: "#0A0A0F",
      minHeight: "100vh",
      color: "#E0E0E8",
      padding: "0",
      overflow: "hidden",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:ital,wght@0,300;0,400;0,500;1,400&family=Syne:wght@600;700;800&display=swap');
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 4px; background: #111; }
        ::-webkit-scrollbar-thumb { background: #333; border-radius: 2px; }
        .engine-card {
          cursor: pointer;
          border: 1px solid #1E1E2E;
          border-radius: 4px;
          padding: 16px;
          background: #0E0E18;
          transition: all 0.15s ease;
          position: relative;
          overflow: hidden;
        }
        .engine-card::before {
          content: '';
          position: absolute;
          top: 0; left: 0; right: 0;
          height: 2px;
          background: var(--accent);
          transform: scaleX(0);
          transform-origin: left;
          transition: transform 0.2s ease;
        }
        .engine-card:hover::before,
        .engine-card.active::before { transform: scaleX(1); }
        .engine-card:hover { background: #13131F; border-color: #2E2E44; }
        .engine-card.active { background: #13131F; border-color: #2E2E44; }
        .field-input {
          width: 100%;
          background: #0A0A12;
          border: 1px solid #1E1E30;
          color: #C8C8D8;
          padding: 10px 12px;
          border-radius: 3px;
          font-family: 'DM Mono', monospace;
          font-size: 13px;
          outline: none;
          transition: border-color 0.15s;
        }
        .field-input:focus { border-color: #3E3E60; }
        .field-input::placeholder { color: #3A3A55; }
        .generate-btn {
          background: var(--accent);
          color: #000;
          border: none;
          padding: 12px 28px;
          font-family: 'DM Mono', monospace;
          font-size: 13px;
          font-weight: 500;
          letter-spacing: 0.08em;
          cursor: pointer;
          border-radius: 3px;
          transition: opacity 0.15s, transform 0.1s;
        }
        .generate-btn:hover { opacity: 0.88; }
        .generate-btn:active { transform: scale(0.98); }
        .generate-btn:disabled { opacity: 0.4; cursor: not-allowed; }
        .output-box {
          background: #06060E;
          border: 1px solid #1A1A2E;
          border-radius: 4px;
          padding: 20px;
          font-size: 13px;
          line-height: 1.75;
          color: #C0C0D0;
          white-space: pre-wrap;
          min-height: 120px;
          position: relative;
        }
        .loader {
          display: inline-block;
          width: 10px;
          height: 10px;
          border: 2px solid #333;
          border-top-color: var(--accent, #00E5B4);
          border-radius: 50%;
          animation: spin 0.7s linear infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
        .tag {
          display: inline-block;
          font-size: 10px;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          padding: 2px 8px;
          border-radius: 2px;
          background: #1A1A28;
          color: #5A5A80;
        }
        .icon-bg {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 32px;
          height: 32px;
          border-radius: 3px;
          font-size: 16px;
          background: rgba(255,255,255,0.04);
          flex-shrink: 0;
        }
      `}</style>

      {/* Header */}
      <div style={{
        borderBottom: "1px solid #141420",
        padding: "20px 32px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        background: "#080810",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
          <div style={{ fontFamily: "'Syne', sans-serif", fontSize: "22px", fontWeight: 800, letterSpacing: "-0.02em", color: "#fff" }}>
            SCRYP
          </div>
          <div style={{ width: "1px", height: "20px", background: "#2A2A3A" }} />
          <div style={{ color: "#5A5A70", fontSize: "13px", letterSpacing: "0.05em" }}>PROMPT ENGINES</div>
        </div>
        <div style={{ display: "flex", gap: "8px" }}>
          {["SALES", "OPS", "CAMPAIGNS"].map(t => (
            <div key={t} className="tag">{t}</div>
          ))}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "280px 1fr", height: "calc(100vh - 65px)" }}>
        {/* Sidebar */}
        <div style={{
          borderRight: "1px solid #141420",
          padding: "24px 16px",
          overflowY: "auto",
          background: "#080810",
        }}>
          <div style={{ fontSize: "10px", letterSpacing: "0.15em", color: "#3A3A55", marginBottom: "16px", paddingLeft: "8px" }}>
            SELECT ENGINE
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {ENGINES.map((eng) => (
              <div
                key={eng.id}
                className={`engine-card ${activeEngine === eng.id ? "active" : ""}`}
                style={{ "--accent": eng.color }}
                onClick={() => handleSelect(eng.id)}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "6px" }}>
                  <div className="icon-bg" style={{ color: eng.color }}>{eng.icon}</div>
                  <div style={{
                    fontFamily: "'Syne', sans-serif",
                    fontSize: "13px",
                    fontWeight: 700,
                    color: activeEngine === eng.id ? eng.color : "#C0C0D0",
                    letterSpacing: "0.02em",
                  }}>
                    {eng.label}
                  </div>
                </div>
                <div style={{ fontSize: "11px", color: "#4A4A65", lineHeight: 1.5, paddingLeft: "42px" }}>
                  {eng.description}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Main Panel */}
        <div style={{ overflowY: "auto", padding: "32px 40px" }}>
          {!engine ? (
            <div style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              height: "100%",
              gap: "12px",
              color: "#2A2A40",
              textAlign: "center",
            }}>
              <div style={{ fontSize: "48px" }}>◈</div>
              <div style={{ fontFamily: "'Syne', sans-serif", fontSize: "18px", fontWeight: 700, color: "#3A3A55" }}>
                Select an engine to begin
              </div>
              <div style={{ fontSize: "13px", color: "#2A2A40" }}>
                Choose a prompt engine from the sidebar
              </div>
            </div>
          ) : (
            <div style={{ maxWidth: "680px" }} key={engine.id}>
              {/* Engine Header */}
              <div style={{ marginBottom: "32px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "8px" }}>
                  <div style={{
                    width: "8px", height: "8px", borderRadius: "50%",
                    background: engine.color,
                    boxShadow: `0 0 8px ${engine.color}`,
                  }} />
                  <div style={{
                    fontFamily: "'Syne', sans-serif",
                    fontSize: "24px",
                    fontWeight: 800,
                    color: "#fff",
                    letterSpacing: "-0.02em",
                  }}>
                    {engine.label}
                  </div>
                </div>
                <div style={{ fontSize: "13px", color: "#5A5A75", paddingLeft: "20px" }}>
                  {engine.description}
                </div>
              </div>

              {/* Fields */}
              <div style={{ display: "flex", flexDirection: "column", gap: "20px", marginBottom: "28px" }}>
                {engine.fields.map((field) => (
                  <div key={field.key}>
                    <div style={{
                      fontSize: "11px",
                      letterSpacing: "0.1em",
                      color: "#5A5A75",
                      marginBottom: "8px",
                      textTransform: "uppercase",
                    }}>
                      {field.label}
                    </div>
                    {field.type === "select" ? (
                      <select
                        className="field-input"
                        value={fields[field.key] || ""}
                        onChange={(e) => handleFieldChange(field.key, e.target.value)}
                        style={{ appearance: "none" }}
                      >
                        <option value="">— Select —</option>
                        {field.options.map((o) => <option key={o} value={o}>{o}</option>)}
                      </select>
                    ) : (
                      <input
                        className="field-input"
                        type="text"
                        placeholder={field.placeholder}
                        value={fields[field.key] || ""}
                        onChange={(e) => handleFieldChange(field.key, e.target.value)}
                      />
                    )}
                  </div>
                ))}
              </div>

              {/* Prompt Preview */}
              <details style={{ marginBottom: "24px" }}>
                <summary style={{
                  fontSize: "11px",
                  letterSpacing: "0.1em",
                  color: "#3A3A55",
                  textTransform: "uppercase",
                  cursor: "pointer",
                  userSelect: "none",
                }}>
                  View Prompt
                </summary>
                <div style={{
                  marginTop: "12px",
                  background: "#06060E",
                  border: "1px dashed #1A1A2E",
                  borderRadius: "3px",
                  padding: "16px",
                  fontSize: "12px",
                  color: "#3A3A55",
                  whiteSpace: "pre-wrap",
                  lineHeight: 1.65,
                }}>
                  {engine.prompt(fields)}
                </div>
              </details>

              {/* Generate */}
              <div style={{ display: "flex", alignItems: "center", gap: "16px", marginBottom: "28px" }}>
                <button
                  className="generate-btn"
                  style={{ "--accent": engine.color }}
                  onClick={handleGenerate}
                  disabled={loading}
                >
                  {loading ? (
                    <span style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <span className="loader" style={{ "--accent": engine.color }} />
                      GENERATING...
                    </span>
                  ) : "GENERATE →"}
                </button>
              </div>

              {/* Output */}
              {(output || loading) && (
                <div>
                  <div style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: "10px",
                  }}>
                    <div style={{ fontSize: "11px", letterSpacing: "0.1em", color: "#5A5A75", textTransform: "uppercase" }}>
                      Output
                    </div>
                    {output && (
                      <button
                        onClick={handleCopy}
                        style={{
                          background: "none",
                          border: "1px solid #2A2A40",
                          color: copied ? engine.color : "#5A5A75",
                          padding: "4px 12px",
                          borderRadius: "2px",
                          fontSize: "11px",
                          letterSpacing: "0.08em",
                          cursor: "pointer",
                          fontFamily: "'DM Mono', monospace",
                          transition: "color 0.15s",
                        }}
                      >
                        {copied ? "COPIED ✓" : "COPY"}
                      </button>
                    )}
                  </div>
                  <div className="output-box" ref={outputRef}>
                    {loading && !output ? (
                      <div style={{ display: "flex", alignItems: "center", gap: "10px", color: "#3A3A55" }}>
                        <span className="loader" />
                        <span>Generating with AI...</span>
                      </div>
                    ) : output}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
