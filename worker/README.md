# Booking Handler Worker

Cloudflare Worker that receives booking submissions from beaufortlaundryfairy.com
and creates a row in Courtney's Airtable "Bookings" table.

## Architecture

```
Booking form submits
    │
    ├──→ Formspree (email — already working, unchanged)
    │
    └──→ This Worker (laundry-fairy-bookings)
            └──→ Airtable API → row in Bookings table
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
| `AIRTABLE_TOKEN` | Personal Access Token (starts with `pat...`) | airtable.com → click profile pic → Builder Hub → Personal access tokens |
| `AIRTABLE_BASE_ID` | Base ID (starts with `app...`) | The `appXXXXXXX` portion of your Airtable URL when viewing the base |
| `AIRTABLE_TABLE_NAME` | `Bookings` (optional — defaults to "Bookings" if not set) | The name of the table inside the base |

## Required Airtable Schema

Table named `Bookings` with these columns:

| Column | Type | Notes |
|---|---|---|
| Customer Name | Single line text | Primary field |
| Status | Single select | Options: New Booking, Picked Up, Washing, Delivered, Paid, Cancelled |
| Service Type | Single select | Options: Pickup & Delivery, 24hr Return / Pickup & Delivery, 48hr Return / Drop-Off & Pick Up, 24hr Return / Drop-Off & Pick Up, 48hr Return |
| Pickup Date | Date | No time field |
| Time Window | Single select | Options: Morning (8am-12pm), Afternoon (12pm-4pm), Evening (4pm-7pm) |
| Phone | Phone number | |
| Email | Email | |
| Address | Long text | |
| Zip | Single line text | |
| Military Base Housing | Checkbox | |
| Special Instructions | Long text | |
| Weight (lbs) | Number | Filled in manually after weighing |
| Rate ($/lb) | Number | Filled in manually based on service |
| Total ($) | Formula | `{Weight (lbs)} * {Rate ($/lb)}` formatted as currency |
| Booking Source | Single select | Options: Website, Text, Facebook, Referral |
| Created | Created time | Auto-fills |
| Notes | Long text | For Courtney's personal notes |

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

Returns `{ "success": true, "recordId": "rec..." }` on success,
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

A row should appear in Courtney's Airtable Bookings table within seconds.
