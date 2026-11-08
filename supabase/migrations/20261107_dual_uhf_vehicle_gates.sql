-- ============================================================================
-- CHARRMPASS — DUAL-DEVICE UHF LONG-RANGE VEHICLE GATE MIGRATION
-- Date: 2026-11-07
-- Run this once in Supabase Dashboard -> SQL Editor -> New Query -> Run
-- Safe & Idempotent: Can be executed multiple times without data loss.
-- ============================================================================

-- 1. Partial Composite Index for Sub-Millisecond Anti-Passback & Presence Lookups
CREATE INDEX IF NOT EXISTS idx_transactions_uid_auth_ts
    ON public.transactions (rfid_uid, timestamp DESC)
    WHERE status = 'AUTHORIZED';

-- 2. Cross-Lane UHF Ghost-Scan & Burst Protection Trigger
--    Fires BEFORE trg_self_healing_reentry (alphabetical trigger ordering: aa_trg_*).
--    Prevents 3-8m UHF side-lobe bleed across adjacent Entry/Exit lanes:
--      * Opposite-direction UHF scan within 25s -> silently ignored (RETURN NULL)
--      * Same-direction UHF scan within 15s     -> silently ignored (RETURN NULL)
--    Compares event timestamps so offline SD card replays with valid gaps still succeed.
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

            -- Block cross-lane opposite-direction RF bleed (< 25s)
            IF last_tx.direction <> NEW.direction AND elapsed_seconds < 25 THEN
                RETURN NULL;
            END IF;

            -- Block same-direction duplicate UHF hardware pulse (< 15s)
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

-- 3. Reusable Visitor Pass Auto-Vacate Trigger on Exit
--    Ensures Visitor UHF vehicle tags automatically reset to 'Reusable Visitor Tag'
--    when a visitor drives out past CHARRMPASS_GATE_02.
ALTER TABLE public.special_tags ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

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

-- 4. Register 4th Core ESP32 Gate Node: CHARRMPASS_GATE_02 (Dedicated UHF Vehicle Exit)
INSERT INTO public.devices (
    device_name, device_location, esp32_identifier, gate_type, device_category,
    rfid_range, sd_status, rfid_status, led_status, buzzer_status, lcd_status, relay_status
) VALUES
    ('CHARRMPASS Gate Unit 1', 'Main Gate', 'CHARRMPASS_GATE_01', 'ENTRY', 'VEHICLE (ENTRY)', '~860–960 MHz UHF', 'MOUNTED (HSPI)', 'WIEGAND 26/34', 'ACTIVE (🔴🟢)', 'PWM READY', 'INITIALIZED (16x2)', 'PASS SIGNAL ARMED'),
    ('CHARRMPASS Gate Unit 2', 'Main Gate', 'CHARRMPASS_GATE_02', 'EXIT',  'VEHICLE (EXIT)',  '~860–960 MHz UHF', 'MOUNTED (HSPI)', 'WIEGAND 26/34', 'ACTIVE (🔴🟢)', 'PWM READY', 'INITIALIZED (16x2)', 'PASS SIGNAL ARMED')
ON CONFLICT (esp32_identifier) DO UPDATE SET
    device_name     = EXCLUDED.device_name,
    device_location = EXCLUDED.device_location,
    gate_type       = EXCLUDED.gate_type,
    device_category = EXCLUDED.device_category,
    rfid_range      = EXCLUDED.rfid_range,
    sd_status       = EXCLUDED.sd_status,
    rfid_status     = EXCLUDED.rfid_status,
    led_status      = EXCLUDED.led_status,
    buzzer_status   = EXCLUDED.buzzer_status,
    lcd_status      = EXCLUDED.lcd_status,
    relay_status    = EXCLUDED.relay_status;
