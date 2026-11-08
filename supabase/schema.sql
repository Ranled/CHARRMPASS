-- ============================================================
-- CHARRMPASS — COMPLETE RELATIONAL DATABASE SCHEMA v5.0 (UNIFIED & MIGRATION-SAFE)
-- Campus Hybrid Automated RFID Real-time Management Parking & Access Security System
-- Includes Dual-Range Architecture, CPASS ID sequence & triggers, 
-- storage buckets, inside-campus analytics functions, RLS policies, and safe column migrations.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- 0. CPASS ID GENERATOR SEQUENCE & FUNCTION
--    Student           -> cpass_id = Student ID (e.g. 2022-00123)
--    Faculty/Staff/etc -> cpass_id = CP00, CP01 ... CP99, CP100 ...
-- ============================================================
CREATE SEQUENCE IF NOT EXISTS public.cpass_seq START 0 MINVALUE 0;

CREATE OR REPLACE FUNCTION public.generate_cpass_id()
RETURNS TEXT AS $$
DECLARE
    n BIGINT;
    candidate TEXT;
BEGIN
    LOOP
        n := nextval('public.cpass_seq');
        IF n < 10 THEN
            candidate := 'CP0' || n::TEXT;
        ELSE
            candidate := 'CP' || n::TEXT;
        END IF;
        EXIT WHEN NOT EXISTS (
            SELECT 1 FROM public.users u WHERE UPPER(u.cpass_id) = candidate
        );
    END LOOP;
    RETURN candidate;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 1. USERS TABLE
--    Supports both Pedestrians (walkers) and Vehicle drivers
-- ============================================================
CREATE TABLE IF NOT EXISTS public.users (
    id                    UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    cpass_id              TEXT,
    student_id            TEXT,
    full_name             TEXT NOT NULL,
    age                   INTEGER,
    sex                   TEXT,
    address               TEXT,
    program               TEXT,
    section               TEXT,
    role                  TEXT CHECK (role IN ('Student', 'Faculty', 'Staff', 'Visitor', 'Others')),
    role_detail           TEXT,
    default_transit_mode  TEXT DEFAULT 'VEHICLE' CHECK (default_transit_mode IN ('PEDESTRIAN', 'VEHICLE', 'BOTH')),
    approval_status       TEXT DEFAULT 'PENDING' CHECK (approval_status IN ('PENDING', 'APPROVED', 'REJECTED')),
    profile_image         TEXT,
    id_front_image        TEXT,
    id_back_image         TEXT,
    drivers_license_image TEXT,
    created_at            TIMESTAMPTZ DEFAULT NOW(),
    updated_at            TIMESTAMPTZ DEFAULT NOW()
);

-- Safe column additions if users table already existed
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS cpass_id TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS student_id TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS role_detail TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS default_transit_mode TEXT DEFAULT 'VEHICLE';
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS approval_status TEXT DEFAULT 'PENDING';
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS profile_image TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS id_front_image TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS id_back_image TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS drivers_license_image TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS users_cpass_id_key ON public.users (UPPER(cpass_id));

-- Trigger: Auto-assign CPASS ID on insert if not provided
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

-- ============================================================
-- 2. VEHICLES TABLE (Optional for Pedestrians)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.vehicles (
    id               UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    user_id          UUID REFERENCES public.users(id) ON DELETE CASCADE,
    vehicle_type     TEXT CHECK (vehicle_type IN ('Motorcycle', 'Car', 'Truck', 'Van', 'SUV', 'None', 'Other')),
    vehicle_model    TEXT,
    plate_number     TEXT UNIQUE NOT NULL,
    vehicle_color    TEXT,
    approval_status  TEXT DEFAULT 'PENDING' CHECK (approval_status IN ('PENDING', 'APPROVED', 'REJECTED')),
    motorcycle_image TEXT,
    or_cr_image      TEXT,
    created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- Safe column additions if vehicles table already existed
ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS approval_status TEXT DEFAULT 'PENDING';
ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS motorcycle_image TEXT;
ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS or_cr_image TEXT;

-- ============================================================
-- 3. RFID CARDS TABLE
--    rfid_type: 'CLOSE_RANGE' (13.56MHz/125kHz Pedestrian Cards)
--               'LONG_RANGE'  (900MHz UHF / Windshield Vehicle Tags)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.rfid_cards (
    id                   UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    rfid_uid             TEXT UNIQUE NOT NULL,
    rfid_type            TEXT DEFAULT 'LONG_RANGE' CHECK (rfid_type IN ('CLOSE_RANGE', 'LONG_RANGE')),
    user_type            TEXT DEFAULT 'VEHICLE' CHECK (user_type IN ('PEDESTRIAN', 'VEHICLE')),
    vehicle_id           UUID REFERENCES public.vehicles(id) ON DELETE CASCADE,
    user_id              UUID REFERENCES public.users(id) ON DELETE CASCADE,
    authorization_status TEXT DEFAULT 'PENDING' CHECK (authorization_status IN ('PENDING', 'AUTHORIZED', 'DENIED')),
    issued_at            TIMESTAMPTZ DEFAULT NOW(),
    updated_at           TIMESTAMPTZ DEFAULT NOW()
);

-- Safe column additions if rfid_cards table already existed
ALTER TABLE public.rfid_cards ADD COLUMN IF NOT EXISTS rfid_type TEXT DEFAULT 'LONG_RANGE';
ALTER TABLE public.rfid_cards ADD COLUMN IF NOT EXISTS user_type TEXT DEFAULT 'VEHICLE';
ALTER TABLE public.rfid_cards ADD COLUMN IF NOT EXISTS authorization_status TEXT DEFAULT 'PENDING';

-- ============================================================
-- 4. TRANSACTIONS TABLE (Access Logs)
--    Records every Pedestrian Tap and Long-Range Vehicle Pass
-- ============================================================
CREATE TABLE IF NOT EXISTS public.transactions (
    id          UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    rfid_uid    TEXT NOT NULL,
    user_type   TEXT DEFAULT 'VEHICLE' CHECK (user_type IN ('PEDESTRIAN', 'VEHICLE')),
    rfid_type   TEXT DEFAULT 'LONG_RANGE' CHECK (rfid_type IN ('CLOSE_RANGE', 'LONG_RANGE')),
    vehicle_id  UUID REFERENCES public.vehicles(id) ON DELETE SET NULL,
    user_id     UUID REFERENCES public.users(id)    ON DELETE SET NULL,
    direction   TEXT NOT NULL CHECK (direction IN ('ENTRY', 'EXIT')),
    gate        TEXT,
    timestamp   TIMESTAMPTZ DEFAULT NOW(),
    status      TEXT DEFAULT 'AUTHORIZED' CHECK (status IN ('AUTHORIZED', 'DENIED', 'PENDING', 'PENDING_CONFIRMATION')),
    remarks     TEXT
);

-- Safe column additions if transactions table already existed
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS user_type TEXT DEFAULT 'VEHICLE';
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS rfid_type TEXT DEFAULT 'LONG_RANGE';
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS gate TEXT;
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'AUTHORIZED';
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS remarks TEXT;
ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS transactions_status_check;
ALTER TABLE public.transactions ADD CONSTRAINT transactions_status_check CHECK (status IN ('AUTHORIZED', 'DENIED', 'PENDING', 'PENDING_CONFIRMATION'));

-- ============================================================
-- 4.1 OPTION A: SELF-HEALING RE-ENTRY TRIGGER (ZERO TIMERS)
--     When an AUTHORIZED ENTRY is logged and the cardholder's
--     previous session was an unclosed ENTRY (> 30s ago),
--     automatically create an AUTO_RESOLVED_EXIT right before the new entry.
-- ============================================================
CREATE OR REPLACE FUNCTION public.handle_self_healing_reentry()
RETURNS TRIGGER AS $$
DECLARE
    last_tx RECORD;
BEGIN
    -- Only evaluate on newly inserted AUTHORIZED ENTRY transactions
    -- Skip system auto-resolved exits to avoid any recursion
    IF NEW.direction = 'ENTRY' AND NEW.status = 'AUTHORIZED' AND (NEW.remarks IS NULL OR NEW.remarks NOT LIKE '%[AUTO_RESOLVED_EXIT]%') THEN
        -- Find the latest AUTHORIZED transaction for this RFID tag
        SELECT t.id, t.direction, t.timestamp, t.gate, t.user_id, t.vehicle_id, t.user_type, t.rfid_type
        INTO last_tx
        FROM public.transactions t
        WHERE t.rfid_uid = NEW.rfid_uid
          AND t.status = 'AUTHORIZED'
        ORDER BY t.timestamp DESC
        LIMIT 1;

        -- If an unclosed ENTRY exists:
        IF FOUND AND last_tx.direction = 'ENTRY' THEN
            -- Apply 30-second debounce check
            IF (COALESCE(NEW.timestamp, NOW()) - last_tx.timestamp) > INTERVAL '30 seconds' THEN
                INSERT INTO public.transactions (
                    rfid_uid,
                    direction,
                    gate,
                    user_type,
                    rfid_type,
                    vehicle_id,
                    user_id,
                    status,
                    timestamp,
                    remarks
                ) VALUES (
                    NEW.rfid_uid,
                    'EXIT',
                    COALESCE(last_tx.gate, 'AUTO_RESOLVED_EXIT'),
                    COALESCE(last_tx.user_type, NEW.user_type, 'PEDESTRIAN'),
                    COALESCE(last_tx.rfid_type, NEW.rfid_type, 'CLOSE_RANGE'),
                    COALESCE(last_tx.vehicle_id, NEW.vehicle_id),
                    COALESCE(last_tx.user_id, NEW.user_id),
                    'AUTHORIZED',
                    COALESCE(NEW.timestamp, NOW()) - INTERVAL '1 second',
                    '[AUTO_RESOLVED_EXIT] Unclosed session from ' || to_char(last_tx.timestamp AT TIME ZONE 'Asia/Manila', 'YYYY-MM-DD HH12:MI AM') || ' auto-closed upon re-entry'
                );
            END IF;
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_self_healing_reentry ON public.transactions;
CREATE TRIGGER trg_self_healing_reentry
    BEFORE INSERT ON public.transactions
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_self_healing_reentry();

-- ============================================================
-- 4.2 DUAL-UHF CROSS-LANE GHOST-SCAN & BURST GUARD
--     Named aa_trg_uhf_cross_gate_guard so PostgreSQL fires it
--     BEFORE trg_self_healing_reentry on automated UHF vehicle gates.
--     * Blocks opposite-direction cross-lane RF bleed within 25 seconds
--       (e.g., CHARRMPASS_GATE_02 catching an entering car 2s after GATE_01).
--     * Blocks same-direction duplicate hardware bursts within 15 seconds.
--     * Compares event timestamps (NEW.timestamp vs last_tx.timestamp) so
--       delayed offline MicroSD replays with valid timestamps are never dropped.
-- ============================================================
CREATE OR REPLACE FUNCTION public.handle_uhf_cross_gate_guard()
RETURNS TRIGGER AS $$
DECLARE
    last_tx RECORD;
    elapsed_seconds NUMERIC;
BEGIN
    IF NEW.rfid_type = 'LONG_RANGE'
       AND NEW.status = 'AUTHORIZED'
       AND NEW.gate IN ('CHARRMPASS_GATE_01', 'CHARRMPASS_GATE_02')
       AND (NEW.remarks IS NULL OR NEW.remarks NOT LIKE '%[AUTO_RESOLVED_EXIT]%') THEN

        SELECT t.id, t.direction, t.timestamp, t.gate
        INTO last_tx
        FROM public.transactions t
        WHERE t.rfid_uid = NEW.rfid_uid
          AND t.status = 'AUTHORIZED'
          AND (t.remarks IS NULL OR t.remarks NOT LIKE '%[AUTO_RESOLVED_EXIT]%')
        ORDER BY t.timestamp DESC
        LIMIT 1;

        IF FOUND AND last_tx.timestamp IS NOT NULL THEN
            elapsed_seconds := ABS(EXTRACT(EPOCH FROM (COALESCE(NEW.timestamp, NOW()) - last_tx.timestamp)));

            -- Case A: Cross-lane opposite-direction UHF bleed (< 25s)
            IF last_tx.direction <> NEW.direction AND elapsed_seconds < 25 THEN
                RETURN NULL;
            END IF;

            -- Case B: Same-direction duplicate UHF hardware pulse (< 15s)
            IF last_tx.direction = NEW.direction AND elapsed_seconds < 15 THEN
                RETURN NULL;
            END IF;
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS aa_trg_uhf_cross_gate_guard ON public.transactions;
CREATE TRIGGER aa_trg_uhf_cross_gate_guard
    BEFORE INSERT ON public.transactions
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_uhf_cross_gate_guard();

-- ============================================================
-- 5. SPECIAL TAGS TABLE (Visitor & Emergency passes)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.special_tags (
    id          UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    rfid_uid    TEXT UNIQUE NOT NULL,
    type        TEXT NOT NULL CHECK (type IN ('VISITOR', 'EMERGENCY')),
    rfid_type   TEXT DEFAULT 'CLOSE_RANGE' CHECK (rfid_type IN ('CLOSE_RANGE', 'LONG_RANGE')),
    user_type   TEXT DEFAULT 'PEDESTRIAN' CHECK (user_type IN ('PEDESTRIAN', 'VEHICLE')),
    label       TEXT,
    description TEXT,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Safe column additions if special_tags table already existed
ALTER TABLE public.special_tags ADD COLUMN IF NOT EXISTS rfid_type TEXT DEFAULT 'CLOSE_RANGE';
ALTER TABLE public.special_tags ADD COLUMN IF NOT EXISTS user_type TEXT DEFAULT 'PEDESTRIAN';
ALTER TABLE public.special_tags ADD COLUMN IF NOT EXISTS label TEXT;
ALTER TABLE public.special_tags ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE public.special_tags ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- ============================================================
-- 5.1 VISITOR TAG AUTO-VACATE ON VEHICLE / PEDESTRIAN EXIT
--     Automatically resets reusable VISITOR passes when an
--     AUTHORIZED EXIT is posted directly by ESP32 UHF Gate Unit 2
--     (CHARRMPASS_GATE_02) or any exit station.
-- ============================================================
CREATE OR REPLACE FUNCTION public.handle_vacate_visitor_on_exit()
RETURNS TRIGGER AS $$
DECLARE
    stripped_uid TEXT;
BEGIN
    IF NEW.direction = 'EXIT'
       AND NEW.status = 'AUTHORIZED'
       AND (NEW.remarks IS NULL OR NEW.remarks NOT LIKE '%[AUTO_RESOLVED_EXIT]%') THEN

        stripped_uid := LTRIM(COALESCE(NEW.rfid_uid, ''), '0');

        UPDATE public.special_tags
        SET label = 'Reusable Visitor Tag',
            description = NULL,
            updated_at = NOW()
        WHERE type = 'VISITOR'
          AND (
              rfid_uid = NEW.rfid_uid
              OR (stripped_uid <> '' AND LTRIM(rfid_uid, '0') = stripped_uid)
          );
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_vacate_visitor_on_exit ON public.transactions;
CREATE TRIGGER trg_vacate_visitor_on_exit
    AFTER INSERT ON public.transactions
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_vacate_visitor_on_exit();

-- ============================================================
-- 6. SYSTEM ACCOUNTS (Admin / Guard RBAC)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.system_accounts (
    id         UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    username   TEXT UNIQUE NOT NULL,
    password   TEXT NOT NULL,
    role       TEXT NOT NULL CHECK (role IN ('ADMIN', 'GUARD')),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 7. DEVICES TABLE (ESP32 Gateway registry)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.devices (
    id               UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    device_name      TEXT NOT NULL,
    device_location  TEXT NOT NULL,
    esp32_identifier TEXT UNIQUE NOT NULL,
    gate_type        TEXT DEFAULT 'ENTRY',
    device_category  TEXT DEFAULT 'VEHICLE (ENTRY)',
    rfid_range       TEXT DEFAULT '~860–960 MHz UHF',
    status           TEXT DEFAULT 'ONLINE' CHECK (status IN ('ONLINE', 'OFFLINE')),
    last_online      TIMESTAMPTZ DEFAULT NOW(),
    wifi_ssid        TEXT,
    target_ssid      TEXT,
    target_pass      TEXT,
    updated_at       TIMESTAMPTZ DEFAULT NOW(),
    sd_status        TEXT DEFAULT 'MOUNTED (HSPI)',
    rfid_status      TEXT DEFAULT 'READY',
    led_status       TEXT DEFAULT 'ACTIVE',
    buzzer_status    TEXT DEFAULT 'ACTIVE',
    lcd_status       TEXT DEFAULT 'INITIALIZED',
    relay_status     TEXT DEFAULT 'ARMED'
);

-- Drop legacy restrictive constraints so new gate types (ENTRY_EXIT), descriptive categories, and frequencies work cleanly
ALTER TABLE public.devices DROP CONSTRAINT IF EXISTS devices_gate_type_check;
ALTER TABLE public.devices ADD CONSTRAINT devices_gate_type_check 
    CHECK (gate_type IN ('ENTRY', 'EXIT', 'ENTRY_EXIT', 'BIDIRECTIONAL', 'ADMIN'));

ALTER TABLE public.devices DROP CONSTRAINT IF EXISTS devices_device_category_check;
ALTER TABLE public.devices DROP CONSTRAINT IF EXISTS devices_rfid_range_check;

-- Safe column additions if devices table already existed from an older version
ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS gate_type TEXT DEFAULT 'ENTRY';
ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS device_category TEXT DEFAULT 'VEHICLE (ENTRY)';
ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS rfid_range TEXT DEFAULT '~860–960 MHz UHF';
ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'ONLINE';
ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS last_online TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS wifi_ssid TEXT;
ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS target_ssid TEXT;
ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS target_pass TEXT;
ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS sd_status TEXT DEFAULT 'MOUNTED (HSPI)';
ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS rfid_status TEXT DEFAULT 'READY';
ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS led_status TEXT DEFAULT 'ACTIVE';
ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS buzzer_status TEXT DEFAULT 'ACTIVE';
ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS lcd_status TEXT DEFAULT 'INITIALIZED';
ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS relay_status TEXT DEFAULT 'ARMED';
-- Sent by every ESP32 heartbeat. Without this column PostgREST rejects the whole
-- heartbeat PATCH, so devices never update status / wifi_ssid / last_online.
ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS ip_address TEXT;

-- ============================================================
-- 8. INDEXES FOR PERFORMANCE & SCAN LATENCY
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_rfid_cards_uid ON public.rfid_cards(rfid_uid);
CREATE INDEX IF NOT EXISTS idx_transactions_uid ON public.transactions(rfid_uid);
CREATE INDEX IF NOT EXISTS idx_transactions_timestamp ON public.transactions(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_direction ON public.transactions(direction);
CREATE INDEX IF NOT EXISTS idx_vehicles_plate ON public.vehicles(plate_number);
CREATE INDEX IF NOT EXISTS idx_users_approval ON public.users(approval_status);
CREATE INDEX IF NOT EXISTS idx_transactions_uid_auth_ts
    ON public.transactions (rfid_uid, timestamp DESC)
    WHERE status = 'AUTHORIZED';

-- ============================================================
-- 9. INSIDE-CAMPUS ANALYTICS VIEW & HELPER FUNCTION
-- ============================================================
DROP FUNCTION IF EXISTS public.get_active_inside_entities();
CREATE OR REPLACE FUNCTION public.get_active_inside_entities()
RETURNS TABLE (
    rfid_uid TEXT,
    user_id UUID,
    vehicle_id UUID,
    user_type TEXT,
    rfid_type TEXT,
    entry_time TIMESTAMPTZ,
    entry_gate TEXT,
    remarks TEXT,
    full_name TEXT,
    role TEXT,
    cpass_id TEXT,
    program TEXT,
    section TEXT,
    plate_number TEXT,
    vehicle_type TEXT,
    vehicle_model TEXT,
    vehicle_color TEXT
) AS $$
BEGIN
    RETURN QUERY
    WITH latest_tx AS (
        SELECT DISTINCT ON (UPPER(TRIM(t.rfid_uid)))
            t.rfid_uid,
            t.user_id,
            t.vehicle_id,
            t.user_type,
            t.rfid_type,
            t.direction,
            t.timestamp AS entry_time,
            t.gate AS entry_gate,
            t.remarks
        FROM public.transactions t
        WHERE t.status = 'AUTHORIZED'
          AND t.rfid_uid IS NOT NULL
          AND TRIM(t.rfid_uid) <> ''
        ORDER BY UPPER(TRIM(t.rfid_uid)), t.timestamp DESC
    )
    SELECT 
        lt.rfid_uid,
        lt.user_id,
        lt.vehicle_id,
        lt.user_type,
        lt.rfid_type,
        lt.entry_time,
        lt.entry_gate,
        lt.remarks,
        u.full_name,
        u.role,
        COALESCE(u.cpass_id, u.student_id) AS cpass_id,
        u.program,
        u.section,
        v.plate_number,
        v.vehicle_type,
        v.vehicle_model,
        v.vehicle_color
    FROM latest_tx lt
    LEFT JOIN public.users u ON lt.user_id = u.id
    LEFT JOIN public.vehicles v ON lt.vehicle_id = v.id
    WHERE lt.direction = 'ENTRY'
    ORDER BY lt.entry_time DESC;
END;
$$ LANGUAGE plpgsql STABLE;

GRANT EXECUTE ON FUNCTION public.get_active_inside_entities() TO anon, authenticated;

-- ============================================================
-- 9.5 SYSTEM ACCOUNTS SECURITY DEFINER RPCs (pgcrypto)
-- ============================================================
ALTER TABLE public.system_accounts ADD COLUMN IF NOT EXISTS password_hash TEXT;

CREATE OR REPLACE FUNCTION public.verify_system_account(p_username TEXT, p_password TEXT)
RETURNS TABLE (
    id UUID,
    username TEXT,
    role TEXT,
    updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN QUERY
    SELECT sa.id, sa.username, sa.role, sa.updated_at
    FROM public.system_accounts sa
    WHERE LOWER(sa.username) = LOWER(TRIM(COALESCE(p_username, '')))
      AND (
          (sa.password_hash IS NOT NULL AND sa.password_hash = crypt(COALESCE(p_password, ''), sa.password_hash))
          OR (sa.password_hash IS NULL AND sa.password = COALESCE(p_password, ''))
      )
    LIMIT 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.list_system_accounts()
RETURNS TABLE (
    id UUID,
    username TEXT,
    role TEXT,
    updated_at TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT sa.id, sa.username, sa.role, sa.updated_at
    FROM public.system_accounts sa
    ORDER BY sa.role ASC, sa.username ASC;
$$;

CREATE OR REPLACE FUNCTION public.upsert_system_account(
    p_id UUID DEFAULT NULL,
    p_username TEXT DEFAULT NULL,
    p_password TEXT DEFAULT NULL,
    p_role TEXT DEFAULT 'GUARD'
)
RETURNS TABLE (
    id UUID,
    username TEXT,
    role TEXT,
    updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_clean_user TEXT := TRIM(COALESCE(p_username, ''));
    v_role TEXT := CASE WHEN UPPER(COALESCE(p_role, '')) = 'ADMIN' THEN 'ADMIN' ELSE 'GUARD' END;
    v_target_id UUID := p_id;
BEGIN
    IF v_clean_user = '' THEN
        RAISE EXCEPTION 'Username cannot be empty';
    END IF;

    IF v_target_id IS NULL THEN
        SELECT sa.id INTO v_target_id
        FROM public.system_accounts sa
        WHERE LOWER(sa.username) = LOWER(v_clean_user)
        LIMIT 1;
    END IF;

    IF v_target_id IS NOT NULL THEN
        UPDATE public.system_accounts sa
        SET username = v_clean_user,
            role = v_role,
            password = CASE WHEN p_password IS NOT NULL AND LENGTH(p_password) > 0 THEN '***HASHED***' ELSE sa.password END,
            password_hash = CASE WHEN p_password IS NOT NULL AND LENGTH(p_password) > 0 THEN crypt(p_password, gen_salt('bf')) ELSE sa.password_hash END,
            updated_at = NOW()
        WHERE sa.id = v_target_id;

        RETURN QUERY
        SELECT sa.id, sa.username, sa.role, sa.updated_at
        FROM public.system_accounts sa
        WHERE sa.id = v_target_id;
    ELSE
        IF p_password IS NULL OR LENGTH(p_password) = 0 THEN
            RAISE EXCEPTION 'Password is required for new system account';
        END IF;

        RETURN QUERY
        INSERT INTO public.system_accounts (username, password, password_hash, role, updated_at)
        VALUES (v_clean_user, '***HASHED***', crypt(p_password, gen_salt('bf')), v_role, NOW())
        RETURNING system_accounts.id, system_accounts.username, system_accounts.role, system_accounts.updated_at;
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_system_account(p_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    DELETE FROM public.system_accounts
    WHERE id = p_id AND role <> 'ADMIN';
    RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.reset_account_password_with_master_key(
    p_username TEXT,
    p_master_key TEXT,
    p_new_password TEXT
)
RETURNS TABLE (
    id UUID,
    username TEXT,
    role TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_key_sha TEXT;
    v_target RECORD;
BEGIN
    v_key_sha := encode(digest(UPPER(TRIM(COALESCE(p_master_key, ''))), 'sha256'), 'hex');
    IF v_key_sha NOT IN (
        '18c93f7389a26b783e8d9cb818cd0bdba2b06d9e98113a759bcde4b62a44997f',
        '99e008f1069240f9d44831d9a8954845373cf7619240897c58e6aea422a6d674'
    ) THEN
        RAISE EXCEPTION 'Invalid Master Emergency Key';
    END IF;

    IF p_new_password IS NULL OR LENGTH(p_new_password) < 4 THEN
        RAISE EXCEPTION 'Password must be at least 4 characters long';
    END IF;

    SELECT sa.id, sa.username, sa.role
    INTO v_target
    FROM public.system_accounts sa
    WHERE LOWER(sa.username) = LOWER(TRIM(COALESCE(p_username, '')))
    LIMIT 1;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Account not found';
    END IF;

    UPDATE public.system_accounts
    SET password = '***HASHED***',
        password_hash = crypt(p_new_password, gen_salt('bf')),
        updated_at = NOW()
    WHERE system_accounts.id = v_target.id;

    RETURN QUERY SELECT v_target.id, v_target.username, v_target.role;
END;
$$;

GRANT EXECUTE ON FUNCTION public.verify_system_account(TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_system_accounts() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_system_account(UUID, TEXT, TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_system_account(UUID) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reset_account_password_with_master_key(TEXT, TEXT, TEXT) TO anon, authenticated;

-- ============================================================
-- 10. ROW LEVEL SECURITY (RLS) & STORAGE BUCKETS
-- ============================================================
ALTER TABLE public.users           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vehicles        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rfid_cards      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.special_tags    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.system_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.devices         ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_users"               ON public.users;
DROP POLICY IF EXISTS "anon_vehicles"            ON public.vehicles;
DROP POLICY IF EXISTS "anon_rfid_cards"          ON public.rfid_cards;
DROP POLICY IF EXISTS "anon_transactions"        ON public.transactions;
DROP POLICY IF EXISTS "anon_transactions_select" ON public.transactions;
DROP POLICY IF EXISTS "anon_transactions_insert" ON public.transactions;
DROP POLICY IF EXISTS "anon_transactions_update" ON public.transactions;
DROP POLICY IF EXISTS "anon_special_tags"        ON public.special_tags;
DROP POLICY IF EXISTS "anon_system_accounts"     ON public.system_accounts;
DROP POLICY IF EXISTS "anon_devices"             ON public.devices;

CREATE POLICY "anon_users"               ON public.users        FOR ALL    USING (true) WITH CHECK (true);
CREATE POLICY "anon_vehicles"            ON public.vehicles     FOR ALL    USING (true) WITH CHECK (true);
CREATE POLICY "anon_rfid_cards"          ON public.rfid_cards   FOR ALL    USING (true) WITH CHECK (true);
CREATE POLICY "anon_transactions_select" ON public.transactions FOR SELECT USING (true);
CREATE POLICY "anon_transactions_insert" ON public.transactions FOR INSERT WITH CHECK (true);
CREATE POLICY "anon_transactions_update" ON public.transactions FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY "anon_special_tags"        ON public.special_tags FOR ALL    USING (true) WITH CHECK (true);
CREATE POLICY "anon_devices"             ON public.devices      FOR ALL    USING (true) WITH CHECK (true);

REVOKE ALL ON public.system_accounts FROM anon;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES
    ('avatars',   'avatars',   true, 5242880, ARRAY['image/jpeg', 'image/png', 'image/webp']),
    ('documents', 'documents', true, 5242880, ARRAY['image/jpeg', 'image/png', 'image/webp']),
    ('vehicles',  'vehicles',  true, 5242880, ARRAY['image/jpeg', 'image/png', 'image/webp'])
ON CONFLICT (id) DO UPDATE SET
    public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "charrmpass_storage_public_read" ON storage.objects;
DROP POLICY IF EXISTS "charrmpass_storage_anon_upload" ON storage.objects;
DROP POLICY IF EXISTS "charrmpass_storage_anon_update" ON storage.objects;

CREATE POLICY "charrmpass_storage_public_read"
    ON storage.objects FOR SELECT
    USING (bucket_id IN ('avatars', 'documents', 'vehicles'));

CREATE POLICY "charrmpass_storage_anon_upload"
    ON storage.objects FOR INSERT
    WITH CHECK (bucket_id IN ('avatars', 'documents', 'vehicles'));

CREATE POLICY "charrmpass_storage_anon_update"
    ON storage.objects FOR UPDATE
    USING (bucket_id IN ('avatars', 'documents', 'vehicles'))
    WITH CHECK (bucket_id IN ('avatars', 'documents', 'vehicles'));

-- ============================================================
-- 11. REALTIME REPLICATION CONFIGURATION
-- ============================================================
ALTER TABLE public.transactions  REPLICA IDENTITY FULL;
ALTER TABLE public.rfid_cards    REPLICA IDENTITY FULL;
ALTER TABLE public.users         REPLICA IDENTITY FULL;
ALTER TABLE public.special_tags  REPLICA IDENTITY FULL;
ALTER TABLE public.vehicles      REPLICA IDENTITY FULL;
ALTER TABLE public.devices       REPLICA IDENTITY FULL;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
        CREATE PUBLICATION supabase_realtime;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'transactions') THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.transactions;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'rfid_cards') THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.rfid_cards;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'users') THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.users;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'special_tags') THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.special_tags;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'vehicles') THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.vehicles;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'devices') THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.devices;
    END IF;
END $$;

-- ============================================================
-- 12. SEED DATA
-- ============================================================
INSERT INTO public.system_accounts (username, password, password_hash, role) VALUES
    ('guard', '***HASHED***', crypt('guard123', gen_salt('bf')), 'GUARD'),
    ('admin', '***HASHED***', crypt('admin123', gen_salt('bf')), 'ADMIN')
ON CONFLICT (username) DO UPDATE SET
    password_hash = COALESCE(public.system_accounts.password_hash, EXCLUDED.password_hash);

INSERT INTO public.devices (device_name, device_location, esp32_identifier, gate_type, device_category, rfid_range, sd_status, rfid_status, led_status, buzzer_status, lcd_status, relay_status) VALUES
    ('CHARRMPASS Entry Unit',  'Pedestrian Entry Gate', 'CHARRMPASS_GATE_ENTRY', 'ENTRY',      'PEDESTRIAN (ENTRY)',                 '13.56 MHz HF',     'MOUNTED (HSPI)', 'MFRC522 READY', 'ACTIVE (🔴🟡🟢)', 'PWM READY', 'INITIALIZED (16x2)', 'ARMED'),
    ('CHARRMPASS Exit Unit',   'Pedestrian Exit Gate',  'CHARRMPASS_GATE_EXIT',  'EXIT',       'PEDESTRIAN (EXIT)',                  '13.56 MHz HF',     'MOUNTED (HSPI)', 'MFRC522 READY', 'ACTIVE (🔴🟡🟢)', 'PWM READY', 'INITIALIZED (16x2)', 'ARMED'),
    ('CHARRMPASS Gate Unit 1', 'Main Gate',             'CHARRMPASS_GATE_01',    'ENTRY',      'VEHICLE (ENTRY)',                    '~860–960 MHz UHF', 'MOUNTED (HSPI)', 'WIEGAND 26/34', 'ACTIVE (🔴🟢)',   'PWM READY', 'INITIALIZED (16x2)', 'PASS SIGNAL ARMED'),
    ('CHARRMPASS Gate Unit 2', 'Main Gate',             'CHARRMPASS_GATE_02',    'EXIT',       'VEHICLE (EXIT)',                     '~860–960 MHz UHF', 'MOUNTED (HSPI)', 'WIEGAND 26/34', 'ACTIVE (🔴🟢)',   'PWM READY', 'INITIALIZED (16x2)', 'PASS SIGNAL ARMED')
ON CONFLICT (esp32_identifier) DO UPDATE SET
    device_name = EXCLUDED.device_name,
    device_location = EXCLUDED.device_location,
    gate_type = EXCLUDED.gate_type,
    device_category = EXCLUDED.device_category,
    rfid_range = EXCLUDED.rfid_range,
    sd_status = EXCLUDED.sd_status,
    rfid_status = EXCLUDED.rfid_status,
    led_status = EXCLUDED.led_status,
    buzzer_status = EXCLUDED.buzzer_status,
    lcd_status = EXCLUDED.lcd_status,
    relay_status = EXCLUDED.relay_status;

