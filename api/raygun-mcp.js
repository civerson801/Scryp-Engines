// MCP-compatible endpoint for Raygun data
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
 
  const RAYGUN_TOKEN = process.env.RAYGUN_TOKEN;
  const APP_ID = "19hynx5";
 
  try {
    const raygunRes = await fetch(
      `https://api.raygun.com/v3/applications/${APP_ID}/error-groups?count=25&sortBy=lastOccurredAt&sortOrder=desc`,
      {
        headers: {
          Authorization: `Bearer ${RAYGUN_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );
    const data = await raygunRes.json();
    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
