export const config = {
  runtime: 'edge',
};

// Standard headers for the API request
const API_HEADERS = {
  "User-Agent": "com.google.ios.youtube/19.45.4 (iPhone; U; CPU iPhone OS 17_5_1 like Mac OS X; en_US)",
  "Content-Type": "application/json",
  "X-Youtube-Client-Name": "5", // 5 = iOS Client
  "X-Youtube-Client-Version": "19.45.4",
};

export default async function handler(request) {
  try {
    const url = new URL(request.url);
    const qp = url.searchParams;
    
    // Clean up path handling for Vercel
    const parts = url.pathname.split("/").filter((p) => p && p !== "api" && p !== "index");

    if (parts.length < 1) {
      return new Response("Usage: /<VIDEO_ID_OR_CHANNEL_ID>/index.m3u8", { status: 200 });
    }

    const id = parts[0];

    // 1. Segment Proxy (High traffic, keep it fast)
    if (qp.has("url")) {
      return await handleProxyRequest(qp.get("url"), request);
    }

    // 2. Variant Playlist Proxy
    if (qp.has("variant")) {
      return await handleVariantPlaylist(qp.get("variant"), request);
    }

    // 3. Master Playlist Logic
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
  // Resolve Channel ID/Handle to Video ID if necessary
  let videoId = id;
  if (id.startsWith("@") || id.length > 11) {
    videoId = await resolveChannelToVideoId(id);
    if (!videoId) {
      return new Response("Could not find live stream for this channel.", { status: 404 });
    }
  }

  // Fetch HLS Manifest using Internal API
  const manifestUrl = await getHlsManifest(videoId);

  if (!manifestUrl) {
    return new Response("Stream is offline, ID is invalid, or YouTube blocked the request.", { 
      status: 404, 
      headers: corsHeaders() 
    });
  }

  // Fetch and Rewrite
  const response = await fetch(manifestUrl);
  if (!response.ok) return new Response("YouTube Upstream Error", { status: 502 });

  const text = await response.text();
  const proxyUrl = request.url.split("?")[0];

  // Rewrite internal URLs to point back to this worker
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
  const response = await fetch(targetUrl);
  if (!response.ok) return new Response("Variant Fetch Failed", { status: 502 });

  const text = await response.text();
  const proxyUrl = request.url.split("?")[0];

  const rewritten = text.replace(
    /^(https?:\/\/.+)$/gm,
    (match) => `${proxyUrl}?url=${encodeURIComponent(match)}`
  );

  return new Response(rewritten, {
    headers: {
      "Content-Type": "application/vnd.apple.mpegurl",
      ...corsHeaders(),
    },
  });
}

async function handleProxyRequest(targetUrl, request) {
  const headers = new Headers({
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
  });
  
  if (request.headers.has("Range")) {
    headers.set("Range", request.headers.get("Range"));
  }

  const response = await fetch(targetUrl, { headers });

  // Forward essential headers
  const newHeaders = new Headers(response.headers);
  newHeaders.set("Access-Control-Allow-Origin", "*");

  return new Response(response.body, {
    status: response.status,
    headers: newHeaders,
  });
}

// --- YouTube API Logic (The Fix) ---

async function getHlsManifest(videoId) {
  // We use the iOS Client API because it natively supports HLS (m3u8)
  const apiUrl = "https://www.youtube.com/youtubei/v1/player";
  
  const payload = {
    videoId: videoId,
    context: {
      client: {
        clientName: "IOS",
        clientVersion: "19.45.4",
        deviceMake: "Apple",
        deviceModel: "iPhone16,2",
        hl: "en",
        gl: "US",
        utcOffsetMinutes: 0,
      },
    },
    playbackContext: {
      contentPlaybackContext: {
        html5Preference: "HTML5_PREF_WANTS"
      }
    }
  };

  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: API_HEADERS,
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    // Check for errors in the API response
    if (data.playabilityStatus && data.playabilityStatus.status !== "OK") {
      console.log("Playability Error:", data.playabilityStatus.reason);
      return null;
    }

    // Extract HLS URL
    if (data.streamingData && data.streamingData.hlsManifestUrl) {
      return data.streamingData.hlsManifestUrl;
    }
  } catch (e) {
    console.error("API Fetch Error:", e);
  }

  return null;
}

// Helper to resolve @handle or Channel ID to a Video ID
async function resolveChannelToVideoId(id) {
  try {
    // We still try to scrape the /live page just to get the redirect ID
    // This is usually less protected than the player page
    const url = `https://www.youtube.com/${id}/live`;
    const res = await fetch(url, { 
      headers: { 
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Accept": "text/html"
      },
      redirect: "follow" 
    });
    
    // If the URL redirected to /watch?v=..., we found it
    const finalUrl = new URL(res.url);
    if (finalUrl.pathname === "/watch" && finalUrl.searchParams.has("v")) {
      return finalUrl.searchParams.get("v");
    }
    
    // Fallback: Simple regex on the HTML if redirect didn't change URL bar
    const html = await res.text();
    const match = html.match(/"videoId":"([^"]+)"/);
    if (match) return match[1];

  } catch (e) {
    console.error("Channel Resolve Error:", e);
  }
  return null;
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  };
}
