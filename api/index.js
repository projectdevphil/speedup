export const config = {
  runtime: 'edge', // This forces Vercel to use the Edge Runtime (like Cloudflare)
};

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36";

const BASE_HEADERS = {
  "User-Agent": USER_AGENT,
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Cookie": "CONSENT=YES+cb.20210328-17-p0.en+FX+417;", 
  "Cache-Control": "max-age=0",
};

export default async function handler(request) {
  try {
    const url = new URL(request.url);
    const qp = url.searchParams;

    // Parse the path to get the ID
    // URL format: https://site.vercel.app/{id}/index.m3u8
    const parts = url.pathname.split("/").filter(Boolean);
    
    // Remove "api" from path if it exists due to Vercel internal routing
    if (parts[0] === "api") parts.shift();
    if (parts[0] === "index") parts.shift(); // Handle /api/index call specifically

    // 1. Root Check
    if (parts.length < 2) {
      return new Response("Usage: /{videoID_or_channelID}/index.m3u8", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }

    const id = parts[0];
    const filename = parts[1];

    if (!filename.endsWith(".m3u8")) {
      return new Response("Only .m3u8 files are supported.", { status: 400 });
    }

    // 2. Segment Proxy
    if (qp.has("url")) {
      return await handleProxyRequest(qp.get("url"), request);
    }

    // 3. Variant Playlist Proxy
    if (qp.has("variant")) {
      return await handleVariantPlaylist(qp.get("variant"), request);
    }

    // 4. Master Playlist Request
    return await handleMasterPlaylist(id, request);

  } catch (err) {
    return new Response(`Server Error: ${err.message}`, {
      status: 500,
      headers: corsHeaders(),
    });
  }
}

// --- Core Logic ---

async function handleMasterPlaylist(id, request) {
  const manifestUrl = await getHlsManifest(id);

  if (!manifestUrl) {
    return new Response("Stream offline or ID invalid.", { status: 404, headers: corsHeaders() });
  }

  const response = await fetch(manifestUrl, { headers: BASE_HEADERS });
  
  if (!response.ok) {
    return new Response("YouTube upstream error", { status: 502 });
  }

  const text = await response.text();
  const proxyUrl = request.url.split("?")[0];

  // Rewrite URLs to point back to Vercel
  const rewritten = text.replace(
    /^(https?:\/\/.+)$/gm,
    (match) => `${proxyUrl}?variant=${encodeURIComponent(match)}`
  );

  return new Response(rewritten, {
    headers: {
      "Content-Type": "application/vnd.apple.mpegurl",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      ...corsHeaders(),
    },
  });
}

async function handleVariantPlaylist(targetUrl, request) {
  const response = await fetch(targetUrl, { headers: BASE_HEADERS });
  if (!response.ok) return new Response("Variant upstream error", { status: 502 });

  const text = await response.text();
  const proxyUrl = request.url.split("?")[0];

  const rewritten = text.replace(
    /^(https?:\/\/.+)$/gm,
    (match) => `${proxyUrl}?url=${encodeURIComponent(match)}`
  );

  return new Response(rewritten, {
    headers: {
      "Content-Type": "application/vnd.apple.mpegurl",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      ...corsHeaders(),
    },
  });
}

async function handleProxyRequest(targetUrl, request) {
  const headers = new Headers(BASE_HEADERS);
  if (request.headers.has("Range")) {
    headers.set("Range", request.headers.get("Range"));
  }

  const response = await fetch(targetUrl, {
    headers: headers,
    method: "GET"
  });

  const newHeaders = new Headers(response.headers);
  newHeaders.set("Access-Control-Allow-Origin", "*");

  return new Response(response.body, {
    status: response.status,
    headers: newHeaders,
  });
}

// --- YouTube Scraper ---

async function getHlsManifest(id) {
  const isVideoId = id.length === 11 && !id.startsWith("@");
  const url = isVideoId 
    ? `https://www.youtube.com/watch?v=${id}`
    : `https://www.youtube.com/${id}/live`;

  try {
    const response = await fetch(url, { headers: BASE_HEADERS });
    const html = await response.text();

    // Reliable Method: ytInitialPlayerResponse JSON
    const playerResponseMatch = html.match(/var ytInitialPlayerResponse\s*=\s*({.+?});/);
    
    if (playerResponseMatch) {
      const json = JSON.parse(playerResponseMatch[1]);
      if (json.streamingData && json.streamingData.hlsManifestUrl) {
        return json.streamingData.hlsManifestUrl;
      }
    }
    
    // Fallback Method: Regex
    const rawMatch = html.match(/"hlsManifestUrl":"([^"]+)"/);
    if (rawMatch) return rawMatch[1].replace(/\\/g, "");

  } catch (e) {
    console.error(e);
  }
  return null;
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  };
}
