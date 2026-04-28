// VDROP — Netlify Serverless Function
// Uses Cobalt API (api.cobalt.tools) — open source, free, no ads
// Supports: YouTube, Instagram, TikTok, Twitter/X, Facebook, Vimeo, SoundCloud, Reddit, and more

const COBALT_INSTANCES = [
  'https://api.cobalt.tools',
  'https://cobalt.api.timelessnesses.me',
  'https://cobalt.urderscore.me',
];

// Human-readable error messages
const ERROR_MAP = {
  'content.too_long': 'Video bahut lamba hai, shorter video try karo',
  'content.video.unavailable': 'Video unavailable hai — private ya deleted ho sakta hai',
  'content.video.age_restricted': 'Age-restricted video, login ke bina nahi utarega',
  'content.video.not_found': 'Video nahi mila — link check karo',
  'content.post.unavailable': 'Post unavailable — private account ya deleted post',
  'content.post.not_found': 'Post nahi mila — link sahi hai?',
  'service.quota': 'Server busy hai, thodi der baad try karo',
  'service.unavailable': 'Service abhi available nahi, retry karo',
  'api.rate_exceeded': 'Rate limit ho gayi, 1 minute baad try karo',
  'link.unsupported': 'Yeh link abhi supported nahi hai',
  'link.invalid': 'Invalid link — sahi URL paste karo',
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };
}

function respond(statusCode, body) {
  return {
    statusCode,
    headers: corsHeaders(),
    body: JSON.stringify(body),
  };
}

async function callCobalt(instance, payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(`${instance}/`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'VDROP/1.0',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
    }

    // FIX: Content-Type check — agar HTML aaya toh JSON parse mat karo
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Non-JSON response: ${txt.slice(0, 100)}`);
    }

    return await res.json();
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

exports.handler = async (event) => {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return respond(405, { success: false, error: 'Method not allowed' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return respond(400, { success: false, error: 'Invalid JSON request body' });
  }

  const { url, quality = '1080', type = 'video' } = body;

  if (!url || typeof url !== 'string') {
    return respond(400, { success: false, error: 'URL field required', hint: 'Request mein url field chahiye' });
  }

  // Basic URL sanity check
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return respond(400, { success: false, error: 'Invalid URL', hint: 'Sahi URL format chahiye (https://...)' });
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    return respond(400, { success: false, error: 'Only HTTP/HTTPS URLs allowed' });
  }

  // Map our quality/type to Cobalt params
  const isAudio = type === 'audio';
  const validQualities = ['144', '240', '360', '480', '720', '1080', '1440', '2160', 'max'];
  const videoQuality = validQualities.includes(quality) ? quality : '1080';

  const cobaltPayload = {
    url,
    videoQuality,
    audioFormat: 'mp3',
    downloadMode: isAudio ? 'audio' : 'auto',
    filenameStyle: 'pretty',
    tiktokFullAudio: true,
    allowH265: true,
  };

  let lastError = 'Download nahi hua';
  let lastHint = 'Link check karo — private ya restricted ho sakta hai';

  // Try each Cobalt instance in order
  for (const instance of COBALT_INSTANCES) {
    try {
      const data = await callCobalt(instance, cobaltPayload);

      // Cobalt error response
      if (data.status === 'error') {
        const code = data.error?.code || '';
        lastError = ERROR_MAP[code] || `Error: ${code || 'Unknown'}`;
        lastHint = 'Dusra link try karo ya thodi der baad aana';
        // Don't try next instance for content errors — they'll all fail
        const isContentError = code.startsWith('content.') || code.startsWith('link.');
        if (isContentError) break;
        continue; // Try next instance for service errors
      }

      // Rate limit — try next instance
      if (data.status === 'rate-limit') {
        lastError = 'Rate limit — thodi der baad try karo';
        lastHint = 'Server busy hai, 1 minute wait karo';
        continue;
      }

      // Picker response (Instagram carousels, Twitter multi-media, etc.)
      if (data.status === 'picker') {
        const items = (data.picker || []).map(item => ({
          type: item.type,       // 'video' | 'photo'
          url: item.url,
          thumb: item.thumb,
        }));
        return respond(200, {
          success: true,
          picker: true,
          items,
          audio: data.audio || null,
        });
      }

      // Tunnel or redirect — single file download
      if (data.status === 'tunnel' || data.status === 'redirect') {
        return respond(200, {
          success: true,
          picker: false,
          url: data.url,
          filename: data.filename || (isAudio ? 'audio.mp3' : 'video.mp4'),
        });
      }

      // Unknown status
      lastError = `Unexpected server response: ${data.status}`;
      lastHint = 'Server ne unexpected response diya';

    } catch (e) {
      // Network/timeout error — try next instance
      lastError = 'Server se connect nahi hua';
      lastHint = `${instance} se error: ${e.message?.slice(0, 80)}`;
      console.error(`Cobalt instance ${instance} failed:`, e.message);
      continue;
    }
  }

  // All instances failed
  return respond(200, {
    success: false,
    error: lastError,
    hint: lastHint,
  });
};
