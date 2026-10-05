-- ============================================================
-- CHARRMPASS — COMPLETE RELATIONAL DATABASE SCHEMA v5.0 (UNIFIED & MIGRATION-SAFE)
-- Campus Hybrid Automated RFID Real-time Management Parking & Access Security System
-- Includes Dual-Range Architecture, CPASS ID sequence & triggers, 
-- storage buckets, inside-campus analytics functions, RLS policies, and safe column migrations.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- 0. CPASS ID GENERATOR SEQUENCE & FUNCTION
--    Student           -> cpass_id = Student ID (e.g. 2022-00123)
--    Faculty/Staff/etc -> cpass_id = CP00, CP01 ... CP99, CP100 ...
-- ============================================================
CREATE SEQUENCE IF NOT EXISTS public.cpass_seq START 0 MINVALUE 0;

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
    status      TEXT DEFAULT 'AUTHORIZED' CHECK (status IN ('AUTHORIZED', 'DENIED', 'PENDING')),
    remarks     TEXT
);

-- Safe column additions if transactions table already existed
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS user_type TEXT DEFAULT 'VEHICLE';
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS rfid_type TEXT DEFAULT 'LONG_RANGE';
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS gate TEXT;
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'AUTHORIZED';
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS remarks TEXT;

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
    gate_type        TEXT DEFAULT 'ENTRY' CHECK (gate_type IN ('ENTRY', 'EXIT', 'ADMIN')),
    device_category  TEXT DEFAULT 'VEHICLE_BARRIER' CHECK (device_category IN ('VEHICLE_BARRIER', 'PEDESTRIAN_TURNSTILE', 'PORTABLE_SCANNER', 'ADMIN_STATION')),
    rfid_range       TEXT DEFAULT 'LONG_RANGE' CHECK (rfid_range IN ('CLOSE_RANGE', 'LONG_RANGE', 'HYBRID')),
    status           TEXT DEFAULT 'ONLINE' CHECK (status IN ('ONLINE', 'OFFLINE')),
    last_online      TIMESTAMPTZ DEFAULT NOW()
);

-- Safe column additions if devices table already existed from an older version
ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS gate_type TEXT DEFAULT 'ENTRY';
ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS device_category TEXT DEFAULT 'VEHICLE_BARRIER';
ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS rfid_range TEXT DEFAULT 'LONG_RANGE';
ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'ONLINE';
ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS last_online TIMESTAMPTZ DEFAULT NOW();

-- ============================================================
-- 8. INDEXES FOR PERFORMANCE & SCAN LATENCY
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_rfid_cards_uid ON public.rfid_cards(rfid_uid);
CREATE INDEX IF NOT EXISTS idx_transactions_uid ON public.transactions(rfid_uid);
CREATE INDEX IF NOT EXISTS idx_transactions_timestamp ON public.transactions(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_direction ON public.transactions(direction);
CREATE INDEX IF NOT EXISTS idx_vehicles_plate ON public.vehicles(plate_number);
CREATE INDEX IF NOT EXISTS idx_users_approval ON public.users(approval_status);

-- ============================================================
-- 9. INSIDE-CAMPUS ANALYTICS VIEW & HELPER FUNCTION
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_active_inside_entities()
RETURNS TABLE (
    rfid_uid TEXT,
    user_id UUID,
    vehicle_id UUID,
    user_type TEXT,
    rfid_type TEXT,
    entry_time TIMESTAMPTZ,
    entry_gate TEXT,
    full_name TEXT,
    role TEXT,
    plate_number TEXT,
    vehicle_model TEXT
) AS $$
BEGIN
    RETURN QUERY
    WITH latest_tx AS (
        SELECT DISTINCT ON (t.rfid_uid)
            t.rfid_uid,
            t.user_id,
            t.vehicle_id,
            t.user_type,
            t.rfid_type,
            t.direction,
            t.timestamp AS entry_time,
            t.gate AS entry_gate
        FROM public.transactions t
        WHERE t.status = 'AUTHORIZED'
        ORDER BY t.rfid_uid, t.timestamp DESC
    )
    SELECT 
        lt.rfid_uid,
        lt.user_id,
        lt.vehicle_id,
        lt.user_type,
        lt.rfid_type,
        lt.entry_time,
        lt.entry_gate,
        u.full_name,
        u.role,
        v.plate_number,
        v.vehicle_model
    FROM latest_tx lt
    LEFT JOIN public.users u ON lt.user_id = u.id
    LEFT JOIN public.vehicles v ON lt.vehicle_id = v.id
    WHERE lt.direction = 'ENTRY'
    ORDER BY lt.entry_time DESC;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 10. ROW LEVEL SECURITY (RLS)
-- ============================================================
ALTER TABLE public.users           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vehicles        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rfid_cards      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.special_tags    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.system_accounts   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.devices         ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_users"            ON public.users;
DROP POLICY IF EXISTS "anon_vehicles"         ON public.vehicles;
DROP POLICY IF EXISTS "anon_rfid_cards"       ON public.rfid_cards;
DROP POLICY IF EXISTS "anon_transactions"     ON public.transactions;
DROP POLICY IF EXISTS "anon_special_tags"     ON public.special_tags;
DROP POLICY IF EXISTS "anon_system_accounts"  ON public.system_accounts;
DROP POLICY IF EXISTS "anon_devices"          ON public.devices;

CREATE POLICY "anon_users"           ON public.users           FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "anon_vehicles"        ON public.vehicles         FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "anon_rfid_cards"      ON public.rfid_cards       FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "anon_transactions"    ON public.transactions     FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "anon_special_tags"    ON public.special_tags     FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "anon_system_accounts" ON public.system_accounts  FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "anon_devices"         ON public.devices          FOR ALL USING (true) WITH CHECK (true);

-- ============================================================
-- 11. REALTIME REPLICATION CONFIGURATION
-- ============================================================
ALTER TABLE public.transactions  REPLICA IDENTITY FULL;
ALTER TABLE public.rfid_cards    REPLICA IDENTITY FULL;
ALTER TABLE public.users         REPLICA IDENTITY FULL;
ALTER TABLE public.special_tags  REPLICA IDENTITY FULL;
ALTER TABLE public.vehicles      REPLICA IDENTITY FULL;

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
END $$;

-- ============================================================
-- 12. SEED DATA
-- ============================================================
INSERT INTO public.system_accounts (username, password, role) VALUES
    ('guard', 'guard123', 'GUARD'),
    ('admin', 'admin123', 'ADMIN')
ON CONFLICT (username) DO NOTHING;

INSERT INTO public.devices (device_name, device_location, esp32_identifier, gate_type, device_category, rfid_range) VALUES
    ('CHARRMPASS Entry Unit', 'Entry Gate', 'CHARRMPASS_GATE_ENTRY', 'ENTRY', 'VEHICLE_BARRIER', 'LONG_RANGE'),
    ('CHARRMPASS Exit Unit',  'Exit Gate',  'CHARRMPASS_GATE_EXIT',  'EXIT',  'VEHICLE_BARRIER', 'LONG_RANGE')
ON CONFLICT (esp32_identifier) DO NOTHING;
