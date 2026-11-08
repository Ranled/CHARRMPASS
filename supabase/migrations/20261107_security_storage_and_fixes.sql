-- ============================================================================
-- CHARRMPASS MIGRATION: Security Hardening, Storage Buckets & Enriched Occupancy
-- Date: 2026-11-07
-- Safe & Idempotent: Run in Supabase SQL Editor on existing live projects
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. Collision-safe CPASS ID Sequence Generator
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

-- 2. Partial Composite Index for Fast Scan Lookups & Occupancy Resolution
CREATE INDEX IF NOT EXISTS idx_transactions_uid_auth_ts
    ON public.transactions (rfid_uid, timestamp DESC)
    WHERE status = 'AUTHORIZED';

-- 3. Enriched Single-Source-of-Truth Inside Campus Occupancy RPC
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

-- 4. System Accounts Bcrypt Hashing & SECURITY DEFINER RPCs
ALTER TABLE public.system_accounts ADD COLUMN IF NOT EXISTS password_hash TEXT;

UPDATE public.system_accounts
SET password_hash = crypt(password, gen_salt('bf'))
WHERE (password_hash IS NULL OR password_hash = '')
  AND password IS NOT NULL;

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

-- Lock down direct anon access to system_accounts table (all operations use SECURITY DEFINER RPCs)
DROP POLICY IF EXISTS "anon_system_accounts" ON public.system_accounts;
REVOKE ALL ON public.system_accounts FROM anon;

-- Protect audit log integrity: allow ESP32/Guard SELECT, INSERT, UPDATE on transactions, block anon DELETE
DROP POLICY IF EXISTS "anon_transactions" ON public.transactions;
DROP POLICY IF EXISTS "anon_transactions_select" ON public.transactions;
DROP POLICY IF EXISTS "anon_transactions_insert" ON public.transactions;
DROP POLICY IF EXISTS "anon_transactions_update" ON public.transactions;

CREATE POLICY "anon_transactions_select" ON public.transactions FOR SELECT USING (true);
CREATE POLICY "anon_transactions_insert" ON public.transactions FOR INSERT WITH CHECK (true);
CREATE POLICY "anon_transactions_update" ON public.transactions FOR UPDATE USING (true) WITH CHECK (true);

-- 5. Provision Public Supabase Storage Buckets ('avatars', 'documents', 'vehicles')
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
