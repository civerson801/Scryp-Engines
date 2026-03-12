export default async function handler(req, res) {
  // CORS headers
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

    // Rebuild any additional query params that were separated by Vercel's query parser
    const extraParams = new URLSearchParams(rest).toString();
    const raygunUrl = `https://api.raygun.com/${path}${extraParams ? "&" + extraParams : ""}`;

    console.log("Proxying to:", raygunUrl);

    const raygunRes = await fetch(raygunUrl, {
      headers: {
        Authorization: `Bearer ${RAYGUN_TOKEN}`,
        "Content-Type": "application/json",
      },
    });

    const data = await raygunRes.json();
    return res.status(raygunRes.status).json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
