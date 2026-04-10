# 🤖 Booking Agent — Deployment Guide

## What this does
Reads forwarded booking confirmation/cancellation emails → uses AI to extract details → finds the right GHL sub-account → updates the opportunity pipeline stage → creates a calendar appointment. Automatically. Every time.

---

## Files in this project

```
booking-agent/
├── api/
│   └── webhook.js          ← Main agent logic (Vercel function)
├── lib/
│   ├── ghl.js              ← GHL API helpers
│   ├── parseEmail.js       ← Claude AI email parser
│   └── clientMatcher.js    ← Supabase client lookup
├── scripts/
│   └── registerWebhook.js  ← Run once to connect AgentMail
├── supabase/
│   └── setup.sql           ← Run in Supabase SQL Editor
├── .env.example            ← Environment variable template
├── package.json
└── vercel.json
```

---

## STEP 1 — Set up Supabase (5 minutes)

1. Go to [supabase.com](https://supabase.com) → your project (`lavpnfluvywcjeiyuash`)
2. Click **SQL Editor** in the left sidebar
3. Click **New Query**
4. Open the file `supabase/setup.sql` and paste the entire contents
5. **Before running**, replace the 4 placeholder Location IDs:
   - `LOCATION_ID_1` → Élevé Cosmetics Location ID
   - `LOCATION_ID_2` → Rejuvia Beauty & Aesthetics Location ID
   - `LOCATION_ID_3` → MB Luxury Spa Location ID
   - `LOCATION_ID_4` → Oceanelle Medispa Location ID
6. Click **Run**
7. You should see a success message and 4 rows inserted

**Get your Supabase Service Role key:**
- Project Settings → API → `service_role` key (the long one — keep it secret)

---

## STEP 2 — Get your Anthropic API key (2 minutes)

1. Go to [console.anthropic.com](https://console.anthropic.com)
2. Click **API Keys** → **Create Key**
3. Copy it — you'll need it in Step 3

---

## STEP 3 — Deploy to Vercel (5 minutes)

### Option A: GitHub (recommended)
1. Create a new GitHub repository (can be private)
2. Upload all these files to it
3. Go to [vercel.com](https://vercel.com) → **New Project** → Import from GitHub
4. Select your repo → click **Deploy**

### Option B: Vercel CLI
```bash
npm install -g vercel
cd booking-agent
vercel
```

### Add Environment Variables in Vercel:
Go to your Vercel project → **Settings** → **Environment Variables** → add:

| Variable | Value |
|---|---|
| `AGENTMAIL_API_KEY` | `am_us_5f642438...` (your AgentMail key) |
| `ANTHROPIC_API_KEY` | Your Anthropic API key |
| `SUPABASE_URL` | `https://lavpnfluvywcjeiyuash.supabase.co` |
| `SUPABASE_SERVICE_KEY` | Your Supabase service_role key |

After adding variables → **Redeploy** the project.

---

## STEP 4 — Register AgentMail Webhook (2 minutes)

Once deployed, you'll have a URL like: `https://booking-agent-xyz.vercel.app`

Run this command (replace the URL with your actual Vercel URL):

```bash
AGENTMAIL_API_KEY=am_us_5f642438f54c583026f914ad5828fcde08d9f9d7e842758525c971a15d20904c \
VERCEL_URL=your-project-name.vercel.app \
node scripts/registerWebhook.js
```

You should see: `✅ Webhook registered successfully!`

---

## STEP 5 — Test it! (2 minutes)

1. Forward one of your booking confirmation emails to: **atlasdrifter@agentmail.to**
2. Wait 10-15 seconds
3. Check Supabase → Table Editor → `booking_agent_logs` to see what happened
4. Check GHL to confirm the appointment was created

---

## Adding more clients later

Just add a new row in Supabase → `booking_agent_clients` table with:
- `business_name` (must match what appears in booking emails)
- `business_name_aliases` (array of alternative spellings)
- `ghl_location_id`
- `ghl_api_key`
- `ghl_calendar_id`

No code changes needed — the agent picks it up automatically.

---

## Monitoring

View all processed bookings in Supabase:
```sql
SELECT 
  created_at,
  extracted_business_name,
  extracted_contact_name,
  booking_type,
  client_matched,
  opportunity_found,
  opportunity_updated,
  appointment_created,
  processing_status,
  error_message
FROM booking_agent_logs
ORDER BY created_at DESC;
```

---

## Troubleshooting

| Problem | Check |
|---|---|
| Email received but nothing happens | Check Vercel function logs (Vercel → your project → Logs) |
| Client not matched | Check `business_name` in Supabase matches email exactly |
| Opportunity not found | Contact must exist in GHL with same email |
| Appointment not created | Check `ghl_calendar_id` is correct |
| Stage not found | Confirm stage names exactly: `📆 Booking Confirmed` / `🚫 Booking Cancelled` |
