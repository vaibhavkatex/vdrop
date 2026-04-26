// VDROP — Netlify Serverless Function v2
// Fixed: More reliable instances, better timeouts

const COBALT_INSTANCES = [
  'https://api.cobalt.tools',
  'https://co.wuk.sh',
  'https://cobalt-api.kwiatekmiki.com',
  'https://cobalt.api.timelessnesses.me',
  'https://nyc1-instance-1.cobalt.tools',
];

const ERROR_MAP = {
  'content.too_long': 'Video bahut lamba hai, shorter video try karo',
  'content.video.unavailable': 'Video unavailable — private ya deleted ho sakta hai',
  'content.video.age_restricted': 'Age-restricted video download nahi hoga',
  'content.video.not_found': 'Video nahi mila — link check karo',
  'content.post.unavailable': 'Post unavailable — private account ya deleted post',
  'content.post.not_found': 'Post nahi mila — link sahi hai?',
  'service.quota': 'Server busy hai, thodi der baad try karo',
  'service.unavailable': 'Service abhi available nahi',
  'api.rate_exceeded': 'Rate limit — 1 minute baad try karo',
  'link.unsupported': 'Yeh platform abhi supported nahi',
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
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const res = await fetch(`${instance}/`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; VDROP/2.0)',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${txt.slice(0, 100)}`);
    }
    return await res.json();
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

exports.handler = async (event) => {
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
    return respond(400, { success: false, error: 'Invalid request' });
  }

  const { url, quality = '1080', type = 'video' } = body;
  if (!url) return respond(400, { success: false, error: 'URL required' });
  try { new URL(url); } catch { return respond(400, { success: false, error: 'Invalid URL' }); }

  const isAudio = type === 'audio';
  const validQ = ['144','240','360','480','720','1080','1440','2160','max'];
  const videoQuality = validQ.includes(quality) ? quality : '1080';

  const cobaltPayload = {
    url,
    videoQuality,
    audioFormat: 'mp3',
    downloadMode: isAudio ? 'audio' : 'auto',
    filenameStyle: 'pretty',
    tiktokFullAudio: true,
    allowH265: true,
  };

  const errors = [];

  for (const instance of COBALT_INSTANCES) {
    try {
      console.log(`Trying: ${instance}`);
      const data = await callCobalt(instance, cobaltPayload);

      if (data.status === 'error') {
        const code = data.error?.code || '';
        const msg = ERROR_MAP[code] || `Error: ${code || 'Unknown'}`;
        errors.push(msg);
        if (code.startsWith('content.') || code.startsWith('link.')) {
          return respond(200, { success: false, error: msg, hint: 'Link ya content mein issue hai' });
        }
        continue;
      }

      if (data.status === 'rate-limit') { errors.push('rate-limit'); continue; }

      if (data.status === 'picker') {
        return respond(200, {
          success: true,
          picker: true,
          items: (data.picker || []).map(i => ({ type: i.type, url: i.url, thumb: i.thumb || null })),
          audio: data.audio || null,
        });
      }

      if (data.status === 'tunnel' || data.status === 'redirect') {
        return respond(200, {
          success: true,
          picker: false,
          url: data.url,
          filename: data.filename || (isAudio ? 'audio.mp3' : 'video.mp4'),
        });
      }

      errors.push(`Unknown status: ${data.status}`);

    } catch (e) {
      errors.push(`${instance.replace('https://','')} failed: ${(e.message||'').slice(0,60)}`);
      console.error(`${instance} error:`, e.message);
    }
  }

  return respond(200, {
    success: false,
    error: 'Abhi download nahi ho pa raha — server busy hai',
    hint: 'Thodi der (1-2 min) baad dobara try karo. Agar phir bhi nahi hua toh dusra link try karo.',
    debug: errors.join(' | '),
  });
};
