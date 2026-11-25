-- ============================================================
-- CHARRMPASS — RA 10173 Data Privacy Consent Audit Columns
-- Records when each registrant accepted the Terms & Privacy Policy
-- and which policy version was presented at registration time.
-- Safe to run multiple times (idempotent).
-- ============================================================

ALTER TABLE public.users
    ADD COLUMN IF NOT EXISTS privacy_consent_at TIMESTAMPTZ;

ALTER TABLE public.users
    ADD COLUMN IF NOT EXISTS privacy_policy_version TEXT;

ALTER TABLE public.vehicles
    ADD COLUMN IF NOT EXISTS privacy_consent_at TIMESTAMPTZ;

ALTER TABLE public.vehicles
    ADD COLUMN IF NOT EXISTS privacy_policy_version TEXT;

COMMENT ON COLUMN public.users.privacy_consent_at IS 'Timestamp when registrant accepted RA 10173 Data Privacy Consent & Terms.';
COMMENT ON COLUMN public.users.privacy_policy_version IS 'Version identifier of the RA 10173 Privacy Policy accepted (e.g. RA10173-v1.0).';
COMMENT ON COLUMN public.vehicles.privacy_consent_at IS 'Timestamp when vehicle registrant confirmed RA 10173 Data Privacy Consent & Terms.';
COMMENT ON COLUMN public.vehicles.privacy_policy_version IS 'Version identifier of the RA 10173 Privacy Policy confirmed at vehicle registration.';
