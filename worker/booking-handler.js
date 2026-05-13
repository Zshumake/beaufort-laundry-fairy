/**
 * Cloudflare Worker: laundry-fairy-bookings
 *
 * Receives booking form submissions from beaufortlaundryfairy.com and writes
 * them to Courtney's Airtable base, which uses a relational schema:
 *   - Customers (one row per person, identified by email)
 *   - Bookings  (one row per booking, linked to a Customer)
 *
 * Flow per submission:
 *   1. Look up existing Customer by email
 *   2. If none, create a new Customer row
 *   3. Create a Booking row linked to that Customer
 *
 * Secrets required (Cloudflare → Settings → Variables and Secrets):
 *   - AIRTABLE_TOKEN     PAT with data.records:read, data.records:write, schema.bases:read
 *   - AIRTABLE_BASE_ID   Base ID (starts with `app...`)
 *
 * Deploy: paste this entire file into the Cloudflare dashboard editor for the
 * `laundry-fairy-bookings` Worker, then click "Save and deploy".
 */

const ALLOWED_ORIGINS = [
  'https://www.beaufortlaundryfairy.com',
  'https://beaufortlaundryfairy.com',
];

// Maps the form's pickup_time value to (a) the hour we use for the Booking
// Date datetime field, and (b) a human label we include in Special Instructions.
const TIME_WINDOWS = {
  morning: { hour: 8, label: 'Morning (8am - 12pm)' },
  afternoon: { hour: 12, label: 'Afternoon (12pm - 4pm)' },
  evening: { hour: 16, label: 'Evening (4pm - 7pm)' },
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

    // Honeypot — silently accept if a bot filled the hidden field
    if (body._gotcha) {
      return json({ success: true }, 200, cors);
    }

    const required = ['name', 'email', 'phone', 'address', 'service_type', 'pickup_date', 'pickup_time'];
    for (const field of required) {
      if (!body[field]) {
        return json({ error: `Missing field: ${field}` }, 400, cors);
      }
    }

    try {
      const customerId = await findOrCreateCustomer(env, body);
      const booking = await createBooking(env, customerId, body);
      return json({ success: true, customerId, bookingId: booking.id }, 200, cors);
    } catch (err) {
      console.error('Worker error:', err);
      return json({ error: err.message || 'Unknown error' }, 500, cors);
    }
  },
};

// ─── Airtable helpers ────────────────────────────────────────────────────────

function airtableUrl(env, table) {
  return `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${encodeURIComponent(table)}`;
}

async function airtableGet(env, urlWithQuery) {
  const res = await fetch(urlWithQuery, {
    headers: { 'Authorization': `Bearer ${env.AIRTABLE_TOKEN}` },
  });
  if (!res.ok) {
    throw new Error(`Airtable GET failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function airtablePost(env, url, fields) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.AIRTABLE_TOKEN}`,
      'Content-Type': 'application/json',
    },
    // typecast: true lets Airtable auto-create new single-select options
    // (e.g. for Service Type values that aren't in her existing list yet)
    body: JSON.stringify({ fields, typecast: true }),
  });
  if (!res.ok) {
    throw new Error(`Airtable POST failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

// ─── Domain logic ────────────────────────────────────────────────────────────

async function findOrCreateCustomer(env, body) {
  // Email is the unique key for matching repeat customers.
  // filterByFormula uses Airtable formula syntax; we escape single quotes in
  // the email so a customer with name like `o'brien@example.com` doesn't break us.
  const safeEmail = body.email.replace(/'/g, "\\'");
  const formula = `LOWER({Email})=LOWER('${safeEmail}')`;
  const searchUrl = `${airtableUrl(env, 'Customers')}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1`;
  const search = await airtableGet(env, searchUrl);

  if (search.records && search.records.length > 0) {
    return search.records[0].id;
  }

  // No existing match — create a new Customer row.
  const addressParts = [body.address];
  if (body.zip) addressParts.push(body.zip);

  const fields = {
    'Customer Name': body.name,
    'Phone': body.phone,
    'Email': body.email,
    'Address': addressParts.join(', '),
  };

  if (body.base_housing === 'on' || body.base_housing === true) {
    fields['Notes'] = 'Military base housing — base access required for pickup/delivery.';
  }

  const created = await airtablePost(env, airtableUrl(env, 'Customers'), fields);
  return created.id;
}

async function createBooking(env, customerId, body) {
  const tw = TIME_WINDOWS[body.pickup_time] || TIME_WINDOWS.morning;

  // Booking Date is a datetime field set to display in UTC. We send a local
  // wall-clock time tagged as UTC so it displays correctly (e.g. 8am stays 8am).
  // If Courtney later changes the field's timezone to America/New_York, we can
  // remove this trick.
  const bookingDateTime = `${body.pickup_date}T${String(tw.hour).padStart(2, '0')}:00:00.000Z`;

  const instructionLines = [];
  if (body.instructions) instructionLines.push(body.instructions);
  instructionLines.push(`Requested time window: ${tw.label}`);
  if (body.base_housing === 'on' || body.base_housing === true) {
    instructionLines.push('⚠️ Military base housing — requires base access for pickup/delivery.');
  }
  instructionLines.push('— Submitted via website form');

  const fields = {
    'Customer': [customerId],
    'Booking Date': bookingDateTime,
    // typecast=true means Airtable will auto-add this option if it doesn't
    // exist yet (e.g. "Pickup & Delivery, 24hr Return" isn't in her default list)
    'Service Type': body.service_type,
    'Status': 'Pending',
    'Special Instructions': instructionLines.join('\n'),
  };

  return airtablePost(env, airtableUrl(env, 'Bookings'), fields);
}

// ─── Plumbing ────────────────────────────────────────────────────────────────

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
