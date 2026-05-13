/**
 * Cloudflare Worker: laundry-fairy-bookings
 *
 * Receives booking form submissions from beaufortlaundryfairy.com and creates
 * a row in Courtney's Airtable "Bookings" table.
 *
 * Secrets required (set in Cloudflare dashboard → Settings → Variables and Secrets):
 *   - AIRTABLE_TOKEN       Personal Access Token from airtable.com → Builder Hub → Personal access tokens
 *   - AIRTABLE_BASE_ID     Base ID from the Airtable URL (starts with `app...`)
 *   - AIRTABLE_TABLE_NAME  Defaults to "Bookings" if not set
 *
 * Deploy: paste this entire file into the Cloudflare dashboard editor for the
 * `laundry-fairy-bookings` Worker, then click "Save and deploy".
 */

const ALLOWED_ORIGINS = [
  'https://www.beaufortlaundryfairy.com',
  'https://beaufortlaundryfairy.com',
];

const TIME_WINDOW_LABELS = {
  morning: 'Morning (8am-12pm)',
  afternoon: 'Afternoon (12pm-4pm)',
  evening: 'Evening (4pm-7pm)',
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

    const fields = {
      'Customer Name': body.name,
      'Status': 'New Booking',
      'Service Type': body.service_type,
      'Pickup Date': body.pickup_date,
      'Time Window': TIME_WINDOW_LABELS[body.pickup_time] || body.pickup_time,
      'Phone': body.phone,
      'Email': body.email,
      'Address': body.address,
      'Zip': body.zip || '',
      'Military Base Housing': body.base_housing === 'on' || body.base_housing === true,
      'Special Instructions': body.instructions || '',
      'Booking Source': 'Website',
    };

    const tableName = env.AIRTABLE_TABLE_NAME || 'Bookings';
    const url = `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${encodeURIComponent(tableName)}`;

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.AIRTABLE_TOKEN}`,
          'Content-Type': 'application/json',
        },
        // typecast: true lets Airtable accept close matches on single-select
        // fields, so a minor option-rename in the schema doesn't break us.
        body: JSON.stringify({ fields, typecast: true }),
      });

      if (!res.ok) {
        const errText = await res.text();
        console.error('Airtable API failed:', res.status, errText);
        return json({ error: 'Airtable API failed', status: res.status, details: errText }, 500, cors);
      }

      const record = await res.json();
      return json({ success: true, recordId: record.id }, 200, cors);
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
