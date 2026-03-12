export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
 
  if (req.method === "OPTIONS") return res.status(200).end();
 
  const RAYGUN_TOKEN = process.env.RAYGUN_TOKEN;
 
  if (!RAYGUN_TOKEN) {
    return res.status(500).json({ error: "RAYGUN_TOKEN not configured" });
  }
 
  try {
    const { path, ...rest } = req.query;
 
    if (!path) {
      return res.status(400).json({ error: "Missing path parameter" });
    }
 
    const extraParams = new URLSearchParams(rest).toString();
    const raygunUrl = `https://api.raygun.com/${path}${extraParams ? "&" + extraParams : ""}`;
 
    const raygunRes = await fetch(raygunUrl, {
      headers: {
        Authorization: `Bearer ${RAYGUN_TOKEN}`,
        "Content-Type": "application/json",
      },
    });
 
    const text = await raygunRes.text();
 
    // Return raw text if not JSON so we can see what Raygun is actually sending back
    try {
      const data = JSON.parse(text);
      return res.status(raygunRes.status).json(data);
    } catch {
      return res.status(raygunRes.status).json({
        error: "Raygun returned non-JSON",
        status: raygunRes.status,
        statusText: raygunRes.statusText,
        body: text.slice(0, 500),
        url: raygunUrl,
      });
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
 
