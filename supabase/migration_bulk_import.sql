-- ============================================================
-- CHARRMPASS: BULK UPLOAD & ACADEMIC HIERARCHY MIGRATION
-- Supports bulk enrollment of Students (by Section/Year/Program),
-- Faculty, Staff, and Master Academic Programs/Sections.
-- ============================================================

-- 1. ACADEMIC PROGRAMS TABLE
CREATE TABLE IF NOT EXISTS public.academic_programs (
    id          UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    code        TEXT UNIQUE NOT NULL,       -- e.g. 'BSIT', 'BSCS', 'BSA', 'BSED'
    name        TEXT NOT NULL,              -- e.g. 'Bachelor of Science in Information Technology'
    department  TEXT DEFAULT 'General',     -- e.g. 'College of Computing', 'College of Agriculture'
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Seed standard campus academic programs if not existing
INSERT INTO public.academic_programs (code, name, department)
VALUES
    ('BSIT', 'Bachelor of Science in Information Technology', 'College of Computing'),
    ('BSCS', 'Bachelor of Science in Computer Science', 'College of Computing'),
    ('BSA',  'Bachelor of Science in Agriculture', 'College of Agriculture'),
    ('BSHM', 'Bachelor of Science in Hospitality Management', 'College of Hospitality & Tourism'),
    ('BSED', 'Bachelor of Secondary Education', 'College of Education'),
    ('BSCRIM', 'Bachelor of Science in Criminology', 'College of Criminology'),
    ('ENGINEERING', 'College of Engineering & Architecture', 'Engineering'),
    ('ADMIN', 'Administrative & Support Staff', 'Administration')
ON CONFLICT (code) DO NOTHING;

-- 2. ACADEMIC SECTIONS TABLE
CREATE TABLE IF NOT EXISTS public.academic_sections (
    id          UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    program_code TEXT REFERENCES public.academic_programs(code) ON DELETE CASCADE,
    year_level  INTEGER DEFAULT 1,          -- 1, 2, 3, 4
    section     TEXT NOT NULL,              -- e.g. '1A', '1B', '2A', '3A', '4A'
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (program_code, year_level, section)
);

-- Seed standard sections
INSERT INTO public.academic_sections (program_code, year_level, section)
VALUES
    ('BSIT', 1, '1A'), ('BSIT', 1, '1B'),
    ('BSIT', 2, '2A'), ('BSIT', 2, '2B'),
    ('BSIT', 3, '3A'), ('BSIT', 3, '3B'),
    ('BSIT', 4, '4A'), ('BSIT', 4, '4B'),
    ('BSCS', 1, '1A'), ('BSCS', 2, '2A'), ('BSCS', 3, '3A'), ('BSCS', 4, '4A'),
    ('BSA',  1, '1A'), ('BSA',  2, '2A'), ('BSA',  3, '3A'), ('BSA',  4, '4A')
ON CONFLICT DO NOTHING;

-- 3. BULK UPSERT RPC FUNCTION
-- Takes an array of user objects and processes users, vehicles, and tags in a single batch
CREATE OR REPLACE FUNCTION public.bulk_upsert_users(
    users_payload JSONB,
    default_status TEXT DEFAULT 'APPROVED',
    default_transit TEXT DEFAULT 'PEDESTRIAN'
)
RETURNS JSONB AS $$
DECLARE
    item JSONB;
    v_user_id UUID;
    v_vehicle_id UUID;
    v_cpass TEXT;
    v_student_id TEXT;
    v_role TEXT;
    v_transit TEXT;
    v_plate TEXT;
    v_uid TEXT;
    inserted_count INT := 0;
    updated_count INT := 0;
    failed_count INT := 0;
BEGIN
    FOR item IN SELECT * FROM jsonb_array_elements(users_payload) LOOP
        BEGIN
            v_student_id := TRIM(COALESCE(item->>'student_id', item->>'cpass_id', ''));
            v_role := COALESCE(item->>'role', 'Student');
            v_transit := COALESCE(item->>'default_transit_mode', default_transit);
            
            -- If student_id is provided, use it as cpass_id for Students
            IF LENGTH(v_student_id) > 0 THEN
                v_cpass := UPPER(v_student_id);
            ELSE
                v_cpass := COALESCE(item->>'cpass_id', NULL);
            END IF;

            -- 1. Insert or Upsert User
            INSERT INTO public.users (
                full_name,
                cpass_id,
                student_id,
                role,
                role_detail,
                program,
                section,
                age,
                sex,
                address,
                default_transit_mode,
                approval_status
            ) VALUES (
                TRIM(item->>'full_name'),
                v_cpass,
                CASE WHEN LENGTH(v_student_id) > 0 THEN v_student_id ELSE NULL END,
                v_role,
                item->>'role_detail',
                UPPER(TRIM(COALESCE(item->>'program', ''))),
                UPPER(TRIM(COALESCE(item->>'section', ''))),
                NULLIF(TRIM(COALESCE(item->>'age', '')), '')::INTEGER,
                COALESCE(item->>'sex', 'Male'),
                item->>'address',
                v_transit,
                COALESCE(item->>'approval_status', default_status)
            )
            ON CONFLICT (UPPER(cpass_id)) DO UPDATE SET
                full_name            = EXCLUDED.full_name,
                program              = COALESCE(EXCLUDED.program, public.users.program),
                section              = COALESCE(EXCLUDED.section, public.users.section),
                role                 = EXCLUDED.role,
                role_detail          = COALESCE(EXCLUDED.role_detail, public.users.role_detail),
                default_transit_mode = EXCLUDED.default_transit_mode,
                approval_status      = EXCLUDED.approval_status,
                updated_at           = NOW()
            RETURNING id INTO v_user_id;

            IF v_user_id IS NOT NULL THEN
                inserted_count := inserted_count + 1;
            END IF;

            -- 2. Optional Vehicle Attachment
            v_plate := UPPER(TRIM(COALESCE(item->>'plate_number', '')));
            IF LENGTH(v_plate) > 0 AND v_plate != 'PEDESTRIAN' AND v_plate != 'NONE' THEN
                INSERT INTO public.vehicles (
                    user_id,
                    plate_number,
                    vehicle_type,
                    vehicle_model,
                    vehicle_color,
                    approval_status
                ) VALUES (
                    v_user_id,
                    v_plate,
                    COALESCE(item->>'vehicle_type', 'Motorcycle'),
                    item->>'vehicle_model',
                    item->>'vehicle_color',
                    COALESCE(item->>'approval_status', default_status)
                )
                ON CONFLICT (plate_number) DO UPDATE SET
                    user_id       = EXCLUDED.user_id,
                    vehicle_type  = EXCLUDED.vehicle_type,
                    vehicle_model = COALESCE(EXCLUDED.vehicle_model, public.vehicles.vehicle_model)
                RETURNING id INTO v_vehicle_id;
            END IF;

            -- 3. Optional RFID Tag UID Registration
            v_uid := UPPER(TRIM(COALESCE(item->>'rfid_uid', '')));
            IF LENGTH(v_uid) > 0 THEN
                INSERT INTO public.rfid_cards (
                    rfid_uid,
                    rfid_type,
                    user_type,
                    user_id,
                    vehicle_id,
                    authorization_status
                ) VALUES (
                    v_uid,
                    CASE WHEN v_transit = 'VEHICLE' THEN 'LONG_RANGE' ELSE 'CLOSE_RANGE' END,
                    v_transit,
                    v_user_id,
                    v_vehicle_id,
                    CASE WHEN COALESCE(item->>'approval_status', default_status) = 'APPROVED' THEN 'AUTHORIZED' ELSE 'PENDING' END
                )
                ON CONFLICT (rfid_uid) DO UPDATE SET
                    user_id              = EXCLUDED.user_id,
                    vehicle_id           = EXCLUDED.vehicle_id,
                    authorization_status = EXCLUDED.authorization_status,
                    updated_at           = NOW();
            END IF;

        EXCEPTION WHEN OTHERS THEN
            failed_count := failed_count + 1;
        END;
    END LOOP;

    RETURN jsonb_build_object(
        'success', true,
        'inserted_or_updated', inserted_count,
        'failed', failed_count
    );
END;
$$ LANGUAGE plpgsql;

-- 4. GATE DEVICE WI-FI REMOTE PROVISIONING COLUMNS
ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS target_ssid TEXT;
ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS target_pass TEXT;
ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS wifi_ssid TEXT;
ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS ip_address TEXT;

