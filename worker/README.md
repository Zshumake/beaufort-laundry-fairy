# Booking Handler Worker

Cloudflare Worker that receives booking submissions from beaufortlaundryfairy.com
and creates a corresponding event on Courtney's Google Calendar.

## Architecture

```
Booking form submits
    │
    ├──→ Formspree (email — already working, unchanged)
    │
    └──→ This Worker (laundry-fairy-bookings)
            └──→ Google Calendar API → event on Courtney's calendar
```

If the Worker fails for any reason, Formspree still delivers the email. No
booking is ever lost.

## Deployment

This Worker is **not** auto-deployed from git. To deploy:

1. Go to **dash.cloudflare.com → Workers & Pages → `laundry-fairy-bookings`**
2. Click **Edit code**
3. Paste the contents of `booking-handler.js` into the editor
4. Click **Save and deploy**

## Secrets

Set these in the Cloudflare dashboard under
**Settings → Variables and Secrets → Secret Variables**:

| Name | Value | Source |
|---|---|---|
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | `laundry-fairy-bookings@beaufort-laundry-fairy.iam.gserviceaccount.com` | Google Cloud → IAM → Service Accounts |
| `GOOGLE_PRIVATE_KEY` | Full `private_key` value from the downloaded JSON key file (including BEGIN/END lines) | Google Cloud → Service Account → Keys → Add JSON key |
| `CALENDAR_ID` | Calendar ID Courtney shared with the service account | Google Calendar → Settings → Integrate calendar |

## Request shape

Expects a `POST` with JSON body:

```json
{
  "name": "Jane Smith",
  "email": "jane@example.com",
  "phone": "(843) 555-0123",
  "address": "123 Main St",
  "zip": "29902",
  "base_housing": true,
  "service_type": "Pickup & Delivery, 24hr Return",
  "pickup_date": "2026-05-15",
  "pickup_time": "morning",
  "instructions": "Bag on the porch, free & clear please"
}
```

Returns `{ "success": true, "eventId": "...", "htmlLink": "..." }` on success,
or `{ "error": "..." }` on failure.

## Testing

Once deployed, test from the command line:

```bash
curl -X POST https://laundry-fairy-bookings.<your-subdomain>.workers.dev \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test Customer",
    "email": "test@example.com",
    "phone": "555-1234",
    "address": "123 Test St, Beaufort SC",
    "service_type": "Pickup & Delivery, 48hr Return",
    "pickup_date": "2026-06-01",
    "pickup_time": "afternoon"
  }'
```

An event should appear on Courtney's calendar within seconds.
