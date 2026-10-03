-- ============================================================
-- CHARRMPASS MIGRATION: CPASS ID (person <-> vehicle bridge)
-- Run once in Supabase SQL Editor. Safe to re-run.
--
--   Student           -> cpass_id = Student ID (typed by the user)
--   Faculty/Staff/etc -> cpass_id = CP00, CP01 ... CP99, CP100 ... (auto)
-- ============================================================

-- 1. Sequence (starts at 0 so the first ID is CP00)
CREATE SEQUENCE IF NOT EXISTS public.cpass_seq START 0 MINVALUE 0;

-- 2. Generator: CP00..CP99, then CP100, CP101, ... (2 digits minimum)
CREATE OR REPLACE FUNCTION public.generate_cpass_id()
RETURNS TEXT AS $$
DECLARE n BIGINT;
BEGIN
    n := nextval('public.cpass_seq');
    IF n < 10 THEN
        RETURN 'CP0' || n::TEXT;
    END IF;
    RETURN 'CP' || n::TEXT;
END;
$$ LANGUAGE plpgsql;

-- 3. USERS: new columns
--    Existing rows are treated as APPROVED so current accounts keep working;
--    the default is then switched to PENDING for new registrations.
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS cpass_id        TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS student_id      TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS approval_status TEXT DEFAULT 'APPROVED';
ALTER TABLE public.users ALTER COLUMN approval_status SET DEFAULT 'PENDING';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_approval_status_check') THEN
        ALTER TABLE public.users
            ADD CONSTRAINT users_approval_status_check
            CHECK (approval_status IN ('PENDING', 'APPROVED', 'REJECTED'));
    END IF;
END $$;

-- 4. Back-fill CPASS IDs for existing users (oldest first)
DO $$
DECLARE r RECORD;
BEGIN
    FOR r IN SELECT id FROM public.users WHERE cpass_id IS NULL ORDER BY created_at LOOP
        UPDATE public.users SET cpass_id = public.generate_cpass_id() WHERE id = r.id;
    END LOOP;
END $$;

-- 5. Enforce uniqueness (case-insensitive)
CREATE UNIQUE INDEX IF NOT EXISTS users_cpass_id_key ON public.users (UPPER(cpass_id));

-- 6. Auto-assign on insert when the client does not supply one
CREATE OR REPLACE FUNCTION public.users_assign_cpass_id()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.cpass_id IS NULL OR LENGTH(TRIM(NEW.cpass_id)) = 0 THEN
        NEW.cpass_id := public.generate_cpass_id();
    ELSE
        NEW.cpass_id := UPPER(TRIM(NEW.cpass_id));
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_users_assign_cpass_id ON public.users;
CREATE TRIGGER trg_users_assign_cpass_id
    BEFORE INSERT ON public.users
    FOR EACH ROW EXECUTE FUNCTION public.users_assign_cpass_id();

-- 7. VEHICLES: approval + OR/CR document
ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS approval_status TEXT DEFAULT 'APPROVED';
ALTER TABLE public.vehicles ALTER COLUMN approval_status SET DEFAULT 'PENDING';
ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS or_cr_image TEXT;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vehicles_approval_status_check') THEN
        ALTER TABLE public.vehicles
            ADD CONSTRAINT vehicles_approval_status_check
            CHECK (approval_status IN ('PENDING', 'APPROVED', 'REJECTED'));
    END IF;
END $$;

-- 8. rfid_cards.vehicle_id is already nullable:
--    pedestrian card -> user_id only | vehicle sticker -> vehicle_id + user_id

-- 9. ROLE "Others" (vendors, contractors, any other role) + free-text detail
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS role_detail TEXT;

DO $$
DECLARE c RECORD;
BEGIN
    -- Drop whichever CHECK constraint currently limits users.role, then recreate it with 'Others'
    FOR c IN
        SELECT conname FROM pg_constraint
        WHERE conrelid = 'public.users'::regclass AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%role%' AND pg_get_constraintdef(oid) NOT ILIKE '%approval_status%'
          AND pg_get_constraintdef(oid) NOT ILIKE '%transit%'
    LOOP
        EXECUTE format('ALTER TABLE public.users DROP CONSTRAINT %I', c.conname);
    END LOOP;
    ALTER TABLE public.users
        ADD CONSTRAINT users_role_check
        CHECK (role IN ('Student', 'Faculty', 'Staff', 'Visitor', 'Others'));
END $$;
