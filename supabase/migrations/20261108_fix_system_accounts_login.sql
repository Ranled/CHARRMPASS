-- ============================================================================
-- CHARRMPASS HOTFIX: Fix verify_system_account & System Accounts Login
-- Date: 2026-11-08
-- Safe & Idempotent: Run in Supabase SQL Editor to restore instant login
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA extensions;

-- 1. Ensure password_hash column exists
ALTER TABLE public.system_accounts ADD COLUMN IF NOT EXISTS password_hash TEXT;

-- 2. Populate password_hash with bcrypt if missing
UPDATE public.system_accounts
SET password_hash = extensions.crypt(password, extensions.gen_salt('bf'))
WHERE (password_hash IS NULL OR password_hash = '')
  AND password IS NOT NULL;

-- 3. Update verify_system_account with correct extensions search_path
CREATE OR REPLACE FUNCTION public.verify_system_account(p_username TEXT, p_password TEXT)
RETURNS TABLE (
    id UUID,
    username TEXT,
    role TEXT,
    updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
    RETURN QUERY
    SELECT sa.id, sa.username, sa.role, sa.updated_at
    FROM public.system_accounts sa
    WHERE LOWER(sa.username) = LOWER(TRIM(COALESCE(p_username, '')))
      AND (
          (sa.password_hash IS NOT NULL AND sa.password_hash = extensions.crypt(COALESCE(p_password, ''), sa.password_hash))
          OR (sa.password IS NOT NULL AND sa.password = COALESCE(p_password, ''))
      )
    LIMIT 1;
END;
$$;

-- 4. Update upsert_system_account with extensions search_path
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
SET search_path = public, extensions
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
            password_hash = CASE WHEN p_password IS NOT NULL AND LENGTH(p_password) > 0 THEN extensions.crypt(p_password, extensions.gen_salt('bf')) ELSE sa.password_hash END,
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
        VALUES (v_clean_user, '***HASHED***', extensions.crypt(p_password, extensions.gen_salt('bf')), v_role, NOW())
        RETURNING system_accounts.id, system_accounts.username, system_accounts.role, system_accounts.updated_at;
    END IF;
END;
$$;

-- 5. Update reset_account_password_with_master_key with extensions search_path
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
SET search_path = public, extensions
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
        password_hash = extensions.crypt(p_new_password, extensions.gen_salt('bf')),
        updated_at = NOW()
    WHERE system_accounts.id = v_target.id;

    RETURN QUERY SELECT v_target.id, v_target.username, v_target.role;
END;
$$;

-- 6. Grant execute on RPCs and grant SELECT to anon as safe fallback
GRANT EXECUTE ON FUNCTION public.verify_system_account(TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_system_accounts() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_system_account(UUID, TEXT, TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_system_account(UUID) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reset_account_password_with_master_key(TEXT, TEXT, TEXT) TO anon, authenticated;

GRANT SELECT ON public.system_accounts TO anon, authenticated;
