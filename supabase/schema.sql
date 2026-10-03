-- ============================================================
-- CHARRMPASS — RELATIONAL DATABASE SCHEMA v4.0 (DUAL-MODE RFID)
-- Dual-Range Architecture:
--   1. PEDESTRIANS (Walking users) -> CLOSE-RANGE RFID (Turnstiles / Tap readers)
--   2. VEHICLES (Driving users)    -> LONG-RANGE RFID (Windshield UHF / Boom barriers)
-- Tables: users, vehicles, rfid_cards, transactions,
--         special_tags, system_accounts, devices
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- 1. USERS TABLE
--    Supports both Pedestrians (walkers) and Vehicle drivers
-- ============================================================
CREATE TABLE IF NOT EXISTS public.users (
    id                    UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    full_name             TEXT NOT NULL,
    age                   INTEGER,
    sex                   TEXT,
    address               TEXT,
    program               TEXT,
    section               TEXT,
    role                  TEXT CHECK (role IN ('Student', 'Faculty', 'Staff', 'Visitor')),
    default_transit_mode  TEXT DEFAULT 'VEHICLE' CHECK (default_transit_mode IN ('PEDESTRIAN', 'VEHICLE', 'BOTH')),
    profile_image         TEXT,
    id_front_image        TEXT,
    id_back_image         TEXT,
    drivers_license_image TEXT,
    created_at            TIMESTAMPTZ DEFAULT NOW(),
    updated_at            TIMESTAMPTZ DEFAULT NOW()
);

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
    motorcycle_image TEXT,
    created_at       TIMESTAMPTZ DEFAULT NOW()
);

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

-- ============================================================
-- 4. TRANSACTIONS TABLE (Access Logs)
--    Records every Pedestrian Tap and Long-Range Vehicle Pass
--    user_type:  PEDESTRIAN | VEHICLE
--    rfid_type:  CLOSE_RANGE | LONG_RANGE
--    direction:  ENTRY | EXIT
-- ============================================================
CREATE TABLE IF NOT EXISTS public.transactions (
    id          UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    rfid_uid    TEXT NOT NULL,
    user_type   TEXT DEFAULT 'VEHICLE' CHECK (user_type IN ('PEDESTRIAN', 'VEHICLE')),
    rfid_type   TEXT DEFAULT 'LONG_RANGE' CHECK (rfid_type IN ('CLOSE_RANGE', 'LONG_RANGE')),
    vehicle_id  UUID REFERENCES public.vehicles(id) ON DELETE SET NULL,
    user_id     UUID REFERENCES public.users(id)    ON DELETE SET NULL,
    direction   TEXT NOT NULL CHECK (direction IN ('ENTRY', 'EXIT')),
    gate        TEXT,                        -- e.g., 'Turnstile-01 (Pedestrian)', 'Gate-01 (Vehicle Barrier)'
    timestamp   TIMESTAMPTZ DEFAULT NOW(),
    status      TEXT DEFAULT 'AUTHORIZED' CHECK (status IN ('AUTHORIZED', 'DENIED', 'PENDING')),
    remarks     TEXT
);

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
--    device_category: VEHICLE_BARRIER (Long-Range UHF)
--                     PEDESTRIAN_TURNSTILE (Close-Range NFC/RFID)
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

-- ============================================================
-- 8. ROW LEVEL SECURITY (RLS)
-- ============================================================
ALTER TABLE public.users         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vehicles      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rfid_cards    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.special_tags  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.system_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.devices       ENABLE ROW LEVEL SECURITY;

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
-- 9. REALTIME CONFIGURATION
-- ============================================================
ALTER TABLE public.transactions  REPLICA IDENTITY FULL;
ALTER TABLE public.rfid_cards    REPLICA IDENTITY FULL;
ALTER TABLE public.users         REPLICA IDENTITY FULL;
ALTER TABLE public.special_tags  REPLICA IDENTITY FULL;

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
END $$;

-- ============================================================
-- 10. MIGRATIONS (safe column additions for existing tables)
-- ============================================================
DO $$
BEGIN
    -- 1. devices.gate_type
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'devices' AND column_name = 'gate_type'
    ) THEN
        ALTER TABLE public.devices
            ADD COLUMN gate_type TEXT DEFAULT 'ENTRY'
            CHECK (gate_type IN ('ENTRY', 'EXIT', 'ADMIN'));
    END IF;

    -- 2. rfid_cards.rfid_type & user_type
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'rfid_cards' AND column_name = 'rfid_type'
    ) THEN
        ALTER TABLE public.rfid_cards
            ADD COLUMN rfid_type TEXT DEFAULT 'LONG_RANGE'
            CHECK (rfid_type IN ('CLOSE_RANGE', 'LONG_RANGE'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'rfid_cards' AND column_name = 'user_type'
    ) THEN
        ALTER TABLE public.rfid_cards
            ADD COLUMN user_type TEXT DEFAULT 'VEHICLE'
            CHECK (user_type IN ('PEDESTRIAN', 'VEHICLE'));
    END IF;

    -- 3. transactions.rfid_type & user_type
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'transactions' AND column_name = 'rfid_type'
    ) THEN
        ALTER TABLE public.transactions
            ADD COLUMN rfid_type TEXT DEFAULT 'LONG_RANGE'
            CHECK (rfid_type IN ('CLOSE_RANGE', 'LONG_RANGE'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'transactions' AND column_name = 'user_type'
    ) THEN
        ALTER TABLE public.transactions
            ADD COLUMN user_type TEXT DEFAULT 'VEHICLE'
            CHECK (user_type IN ('PEDESTRIAN', 'VEHICLE'));
    END IF;

    -- 4. special_tags.rfid_type & user_type
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'special_tags' AND column_name = 'rfid_type'
    ) THEN
        ALTER TABLE public.special_tags
            ADD COLUMN rfid_type TEXT DEFAULT 'CLOSE_RANGE'
            CHECK (rfid_type IN ('CLOSE_RANGE', 'LONG_RANGE'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'special_tags' AND column_name = 'user_type'
    ) THEN
        ALTER TABLE public.special_tags
            ADD COLUMN user_type TEXT DEFAULT 'PEDESTRIAN'
            CHECK (user_type IN ('PEDESTRIAN', 'VEHICLE'));
    END IF;

    -- 5. users.default_transit_mode
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'default_transit_mode'
    ) THEN
        ALTER TABLE public.users
            ADD COLUMN default_transit_mode TEXT DEFAULT 'VEHICLE'
            CHECK (default_transit_mode IN ('PEDESTRIAN', 'VEHICLE', 'BOTH'));
    END IF;
END $$;

-- ============================================================
-- 11. SEED DATA
-- ============================================================
INSERT INTO public.system_accounts (username, password, role) VALUES
    ('guard', 'guard123', 'GUARD'),
    ('admin', 'admin123', 'ADMIN')
ON CONFLICT (username) DO NOTHING;

INSERT INTO public.devices (device_name, device_location, esp32_identifier, gate_type) VALUES
    ('CHARRMPASS Entry Unit', 'Entry Gate',  'CHARRMPASS_GATE_ENTRY', 'ENTRY'),
    ('CHARRMPASS Exit Unit',  'Exit Gate',   'CHARRMPASS_GATE_EXIT',  'EXIT')
ON CONFLICT (esp32_identifier) DO NOTHING;

