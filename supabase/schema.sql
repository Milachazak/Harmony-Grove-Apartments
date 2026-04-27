-- ─── Harmony Grove Webinar Registrants ───────────────────────────────────────
-- Run this in Supabase Dashboard → SQL Editor

CREATE TABLE IF NOT EXISTS webinar_registrants (
  id                  UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  first_name          TEXT        NOT NULL,
  last_name           TEXT        NOT NULL,
  email               TEXT        UNIQUE NOT NULL,
  phone               TEXT        NOT NULL,
  referral_source     TEXT,
  partner_referral    TEXT        DEFAULT 'No',
  zoom_join_url       TEXT,
  zoom_registrant_id  TEXT,
  pipedrive_deal_id   TEXT
);

-- Row Level Security (edge function uses service role key, bypasses RLS)
ALTER TABLE webinar_registrants ENABLE ROW LEVEL SECURITY;

-- Optional: allow read access for authenticated dashboard users
CREATE POLICY "Authenticated users can read registrants"
  ON webinar_registrants FOR SELECT
  USING (auth.role() = 'authenticated');
