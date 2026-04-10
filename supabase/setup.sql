-- =============================================
-- BOOKING AGENT - Supabase Setup Script
-- Run this in your Supabase SQL Editor
-- =============================================

-- 1. CLIENT MAPPING TABLE
-- Maps business names from emails → GHL sub-account credentials
CREATE TABLE IF NOT EXISTS booking_agent_clients (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  business_name TEXT NOT NULL,          -- Must match what appears in booking emails
  business_name_aliases TEXT[] DEFAULT '{}', -- Alternative names (e.g. "MB Luxury SPA", "MB Spa")
  ghl_location_id TEXT NOT NULL,        -- GHL Sub-account Location ID
  ghl_api_key TEXT NOT NULL,            -- Sub-account Private Integration Token
  ghl_calendar_id TEXT NOT NULL,        -- GHL Calendar ID for appointments
  ghl_pipeline_id TEXT,                 -- Pipeline ID (we'll fetch this dynamically)
  confirmed_stage_name TEXT DEFAULT '📆 Booking Confirmed',
  cancelled_stage_name TEXT DEFAULT '🚫 Booking Cancelled',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. BOOKING LOGS TABLE
-- Full audit trail of every email processed
CREATE TABLE IF NOT EXISTS booking_agent_logs (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  agentmail_message_id TEXT,            -- AgentMail message ID (for deduplication)
  raw_email_subject TEXT,
  raw_email_from TEXT,
  booking_type TEXT,                    -- 'confirmed' or 'cancelled'
  extracted_business_name TEXT,
  extracted_contact_name TEXT,
  extracted_contact_email TEXT,
  extracted_contact_phone TEXT,
  extracted_service TEXT,
  extracted_staff TEXT,
  extracted_datetime TEXT,
  extracted_location TEXT,
  client_matched BOOLEAN DEFAULT false, -- Did we find a matching client?
  ghl_contact_id TEXT,                  -- GHL contact ID found
  opportunity_found BOOLEAN DEFAULT false,
  opportunity_id TEXT,
  opportunity_updated BOOLEAN DEFAULT false,
  appointment_created BOOLEAN DEFAULT false,
  ghl_appointment_id TEXT,
  error_message TEXT,
  processing_status TEXT DEFAULT 'pending', -- pending, success, partial, failed
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. INDEX for fast deduplication lookups
CREATE INDEX IF NOT EXISTS idx_logs_message_id ON booking_agent_logs(agentmail_message_id);
CREATE INDEX IF NOT EXISTS idx_logs_status ON booking_agent_logs(processing_status);
CREATE INDEX IF NOT EXISTS idx_clients_active ON booking_agent_clients(is_active);

-- 4. INSERT YOUR 4 CLIENTS

INSERT INTO booking_agent_clients (
  business_name, business_name_aliases, ghl_location_id, ghl_api_key, ghl_calendar_id
) VALUES
(
  'Élevé Cosmetics',
  ARRAY['Eleve Cosmetics', 'Elevé Cosmetics', 'Eleve'],
  'rFajpsOoJNX4thEnWQYC',
  'pit-38facba8-079e-44d5-9c09-a2108dcc232e',
  'Zztc2On1Fa0GDxFXgFmV'
),
(
  'Rejuvia Beauty & Aesthetics',
  ARRAY['Rejuvia Beauty', 'Rejuvia', 'Rejuvia Aesthetics'],
  '6gEUMWXFTDWjzKloUcaJ',
  'pit-a4f76dfe-14d9-4ee5-8412-a7d2df3bbc5e',
  'hiAl5jTkqlGpU7RVvFzg'
),
(
  'MB Luxury Spa',
  ARRAY['MB Luxury SPA', 'MB Spa', 'MB Luxury'],
  '0GqVioQ2ub0Vd9o4SIPg',
  'pit-7da08353-3d62-459f-a5ab-df110c8747ad',
  'PG1dPSO4UaidLoGVh0q3'
),
(
  'Oceanelle Medispa',
  ARRAY['Oceanelle', 'Oceanelle Medi Spa', 'Oceanelle MediSpa'],
  'Vw7Vk4DhpUlVXqAgymmv',
  'pit-c6a22490-20fb-4bf7-9921-b978b6664ca3',
  'gUXBkuGFYDctW7q1jqMB'
);

-- 5. HELPER: Update timestamp automatically
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER booking_agent_clients_updated_at
  BEFORE UPDATE ON booking_agent_clients
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- =============================================
-- VERIFICATION - Run after inserting to confirm
-- =============================================
-- SELECT business_name, ghl_location_id, ghl_calendar_id, is_active FROM booking_agent_clients;
