/* Vercel Serverless Function for YouTube */

export default async function handler(req, res) {
  // Get the path from the URL query (Vercel handles routing differently)
  // URL format: https://your-app.vercel.app/api?v=VIDEO_ID&type=m3u8
  const { v, type } = req.query;

  if (!v) {
    return res.status(400).send("Usage: /api?v=VIDEO_ID&type=m3u8 (or type=mp4)");
  }

  try {
    if (type === 'm3u8') {
      const m3u8Url = await getHlsUrl(v);
      // Fetch the actual m3u8 content
      const m3u8Content = await fetch(m3u8Url).then(r => r.text());
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.setHeader("Access-Control-Allow-Origin", "*");
      return res.status(200).send(m3u8Content);
    } else {
      // Handle MP4
      const mp4Url = await getMp4Url(v);
      return res.redirect(307, mp4Url);
    }
  } catch (e) {
    return res.status(500).send(e.message);
  }
}

async function getHlsUrl(videoId) {
  const resp = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0" }
  });
  const text = await resp.text();
  const match = text.match(/"hlsManifestUrl":"([^"]+)"/);
  if (!match) throw new Error("Live stream not found or ended.");
  return decodeURIComponent(match[1].replace(/\\u0026/g, "&"));
}

async function getMp4Url(videoId) {
  const resp = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0" }
  });
  const text = await resp.text();
  const jsonPattern = /var ytInitialPlayerResponse\s*=\s*({.+?});/s;
  const match = text.match(jsonPattern);
  if (!match) throw new Error("Video data not found");
  
  const data = JSON.parse(match[1]);
  const formats = data.streamingData?.formats || [];
  const mp4 = formats.find(f => f.mimeType && f.mimeType.includes("video/mp4"));
  
  if (!mp4) throw new Error("No standard MP4 found");
  return mp4.url;
}
