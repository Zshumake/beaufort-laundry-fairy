/**
 * Cloudflare Worker: laundry-fairy-bookings
 *
 * Receives booking form submissions from beaufortlaundryfairy.com and creates
 * a corresponding event on Courtney's Google Calendar.
 *
 * Secrets required (set in Cloudflare dashboard → Settings → Variables and Secrets):
 *   - GOOGLE_SERVICE_ACCOUNT_EMAIL  e.g. laundry-fairy-bookings@beaufort-laundry-fairy.iam.gserviceaccount.com
 *   - GOOGLE_PRIVATE_KEY            the private_key field from the downloaded JSON key file
 *                                   (full string, including BEGIN/END PRIVATE KEY lines)
 *   - CALENDAR_ID                   the calendar to write events to (e.g. beaufortlaundryfairy@gmail.com)
 *
 * Deploy: paste this entire file into the Cloudflare dashboard editor for the
 * `laundry-fairy-bookings` Worker, then click "Save and deploy".
 */

const ALLOWED_ORIGINS = [
  'https://www.beaufortlaundryfairy.com',
  'https://beaufortlaundryfairy.com',
];

const TIME_WINDOWS = {
  morning: { start: '08:00', end: '12:00', label: 'Morning (8am – 12pm)' },
  afternoon: { start: '12:00', end: '16:00', label: 'Afternoon (12pm – 4pm)' },
  evening: { start: '16:00', end: '19:00', label: 'Evening (4pm – 7pm)' },
};

// Google Calendar color IDs: https://developers.google.com/calendar/api/v3/reference/colors
const SERVICE_COLORS = {
  'Pickup & Delivery, 24hr Return': '11', // Tomato (red) — urgent
  'Pickup & Delivery, 48hr Return': '9',  // Blueberry — standard pickup
  'Drop-Off & Pick Up, 24hr Return': '6', // Tangerine — urgent drop-off
  'Drop-Off & Pick Up, 48hr Return': '10',// Basil (green) — standard drop-off
};

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405, cors);
    }

    let body;
    try {
      body = await request.json();
    } catch (_) {
      return json({ error: 'Invalid JSON' }, 400, cors);
    }

    // Honeypot — silently accept and discard if a bot filled the hidden field
    if (body._gotcha) {
      return json({ success: true }, 200, cors);
    }

    // Validate required fields
    const required = ['name', 'email', 'phone', 'address', 'service_type', 'pickup_date', 'pickup_time'];
    for (const field of required) {
      if (!body[field]) {
        return json({ error: `Missing field: ${field}` }, 400, cors);
      }
    }

    try {
      const accessToken = await getGoogleAccessToken(env);
      const event = buildCalendarEvent(body);

      const calRes = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(env.CALENDAR_ID)}/events`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(event),
        }
      );

      if (!calRes.ok) {
        const errText = await calRes.text();
        console.error('Calendar API failed:', calRes.status, errText);
        return json({ error: 'Calendar API failed', status: calRes.status, details: errText }, 500, cors);
      }

      const created = await calRes.json();
      return json({ success: true, eventId: created.id, htmlLink: created.htmlLink }, 200, cors);
    } catch (err) {
      console.error('Worker error:', err);
      return json({ error: err.message || 'Unknown error' }, 500, cors);
    }
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

function buildCalendarEvent(b) {
  const tw = TIME_WINDOWS[b.pickup_time] || TIME_WINDOWS.morning;
  const startDateTime = `${b.pickup_date}T${tw.start}:00`;
  const endDateTime = `${b.pickup_date}T${tw.end}:00`;

  const descLines = [
    `Service: ${b.service_type}`,
    '',
    `Customer: ${b.name}`,
    `Phone: ${b.phone}`,
    `Email: ${b.email}`,
    '',
    `Address: ${b.address}`,
    b.zip ? `Zip: ${b.zip}` : null,
    b.base_housing === 'on' || b.base_housing === true ? 'Military base housing (base access required)' : null,
    '',
    `Time window: ${tw.label}`,
    b.instructions ? `\nSpecial instructions:\n${b.instructions}` : null,
  ].filter(Boolean);

  return {
    summary: `[${b.service_type}] ${b.name}`,
    description: descLines.join('\n'),
    location: b.address,
    start: { dateTime: startDateTime, timeZone: 'America/New_York' },
    end: { dateTime: endDateTime, timeZone: 'America/New_York' },
    colorId: SERVICE_COLORS[b.service_type] || '9',
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'popup', minutes: 60 },
        { method: 'popup', minutes: 24 * 60 },
      ],
    },
  };
}

// ─── Google Service Account JWT auth (using Web Crypto, no libraries) ────────

async function getGoogleAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    scope: 'https://www.googleapis.com/auth/calendar',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };
  const header = { alg: 'RS256', typ: 'JWT' };

  const encodedHeader = base64url(new TextEncoder().encode(JSON.stringify(header)));
  const encodedClaim = base64url(new TextEncoder().encode(JSON.stringify(claim)));
  const unsigned = `${encodedHeader}.${encodedClaim}`;

  const cryptoKey = await importPrivateKey(env.GOOGLE_PRIVATE_KEY);
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(unsigned)
  );
  const encodedSignature = base64url(new Uint8Array(signature));
  const jwt = `${unsigned}.${encodedSignature}`;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  if (!tokenRes.ok) {
    throw new Error(`Token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);
  }

  const data = await tokenRes.json();
  return data.access_token;
}

async function importPrivateKey(pem) {
  // Handle both literal-newline and escaped-newline forms of the key
  const normalized = pem.replace(/\\n/g, '\n').trim();
  const pemContents = normalized
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const binaryDer = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    'pkcs8',
    binaryDer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

function base64url(bytes) {
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
