// supabase/functions/rfid-scan/index.ts
// CHARRMPASS — Edge Function v3.6
// Handles Dual-Range ENTRY / EXIT logic with complete transaction auditing,
// Asia/Manila (UTC+8) LCD timestamp formatting, bidirectional gate normalization,
// anti-passback verification, special tags (Visitor & Emergency passes), and physical LCD payloads.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.7.1"

interface VehicleRecord {
  id: string
  plate_number: string | null
  vehicle_type: string | null
  vehicle_model: string | null
  vehicle_color: string | null
}

interface UserRecord {
  id: string
  full_name: string | null
  role: string | null
  role_detail: string | null
  program: string | null
  section: string | null
  profile_image: string | null
  cpass_id: string | null
  student_id: string | null
}

interface RfidCardRow {
  id: string
  rfid_uid: string
  authorization_status: string | null
  user_type: string | null
  rfid_type: string | null
  vehicles: VehicleRecord | VehicleRecord[] | null
  users: UserRecord | UserRecord[] | null
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function unwrapSingle<T>(rel: T | T[] | null | undefined): T | null {
  if (!rel) return null
  return Array.isArray(rel) ? (rel[0] ?? null) : rel
}

function formatManilaTime(d: Date): string {
  return d.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Manila',
  })
}

function formatManilaDate(d: Date): string {
  return d.toLocaleDateString('en-US', {
    month: '2-digit',
    day: '2-digit',
    timeZone: 'Asia/Manila',
  })
}

// LCD payload helper — 4 lines for the physical 16x2 / 20x4 LCD or OLED display
function lcdPayload(line1: string, line2: string, line3: string, line4: string) {
  return {
    lcd_line1: (line1 || '').substring(0, 20),
    lcd_line2: (line2 || '').substring(0, 20),
    lcd_line3: (line3 || '').substring(0, 20),
    lcd_line4: (line4 || '').substring(0, 20),
  }
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const { rfid_uid, device_id, gate_type } = await req.json()

    if (!rfid_uid) {
      return new Response(JSON.stringify({
        status: 'ERROR',
        message: 'Missing rfid_uid',
        ...lcdPayload('CHARRMPASS', '----------------', 'SCAN ERROR', 'NO UID RECEIVED')
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 })
    }

    const uid = String(rfid_uid).trim().toUpperCase()

    // ─── 1. UPDATE DEVICE HEARTBEAT ───────────────────────────────────────────
    if (device_id) {
      await supabase
        .from('devices')
        .update({ last_online: new Date().toISOString(), status: 'ONLINE' })
        .eq('esp32_identifier', device_id)
    }

    const now = new Date()
    const timeStr = formatManilaTime(now)

    // Fetch last authorized transaction up front so bidirectional gates ('ENTRY_EXIT' / 'BIDIRECTIONAL')
    // resolve cleanly to 'ENTRY' or 'EXIT' without violating transactions_direction_check.
    const { data: lastTxn } = await supabase
      .from('transactions')
      .select('id, direction, timestamp, status, remarks')
      .eq('rfid_uid', uid)
      .eq('status', 'AUTHORIZED')
      .order('timestamp', { ascending: false })
      .limit(1)
      .maybeSingle()

    let rawGateMode = String(gate_type || '').toUpperCase().trim()
    if (!rawGateMode && device_id) {
      const { data: device } = await supabase
        .from('devices')
        .select('gate_type')
        .eq('esp32_identifier', device_id)
        .maybeSingle()
      if (device?.gate_type) rawGateMode = String(device.gate_type).toUpperCase().trim()
    }

    let direction: 'ENTRY' | 'EXIT' = 'ENTRY'
    if (rawGateMode === 'EXIT') {
      direction = 'EXIT'
    } else if (rawGateMode === 'ENTRY') {
      direction = 'ENTRY'
    } else {
      // ENTRY_EXIT, BIDIRECTIONAL, or unspecified -> toggle from last authorized session state
      direction = lastTxn?.direction === 'ENTRY' ? 'EXIT' : 'ENTRY'
    }

    // ─── 2. CHECK SPECIAL TAGS (Visitor / Emergency) ──────────────────────────
    const { data: specialTag } = await supabase
      .from('special_tags')
      .select('*')
      .eq('rfid_uid', uid)
      .maybeSingle()

    if (specialTag) {
      const action: 'ENTRY' | 'EXIT' = direction
      const tagUserType = specialTag.user_type || 'PEDESTRIAN'
      const tagRfidType = specialTag.rfid_type || 'CLOSE_RANGE'

      if (specialTag.type === 'VISITOR') {
        if (action === 'EXIT') {
          const visitorName = specialTag.label || 'Visitor'
          const visitorPlate = specialTag.description?.match(/Plate:\s*([^|]+)/)?.[1]?.trim() || 'N/A'

          await supabase.from('transactions').insert({
            rfid_uid: uid,
            direction: 'EXIT',
            gate: device_id || 'EXIT_GATE',
            user_type: tagUserType,
            rfid_type: tagRfidType,
            status: 'AUTHORIZED',
            remarks: `Visitor Exit: ${visitorName} | Plate: ${visitorPlate}`
          })

          await supabase.from('special_tags').update({
            label: 'Reusable Visitor Tag',
            description: null
          }).eq('rfid_uid', uid)

          return new Response(JSON.stringify({
            status: 'AUTHORIZED',
            action: 'EXIT',
            tag_type: 'VISITOR',
            user_type: tagUserType,
            rfid_type: tagRfidType,
            label: visitorName,
            plate: visitorPlate,
            message: `Visitor ${visitorName} exited. Tag ${uid} is now available for reuse.`,
            ...lcdPayload('VISITOR EXIT', 'SAFE TRAVELS!', visitorName.toUpperCase(), 'TAG RETURNED')
          }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
        } else {
          const isAssigned = specialTag.label && specialTag.label !== 'Reusable Visitor Tag'
          if (!isAssigned) {
            return new Response(JSON.stringify({
              status: 'VISITOR_PROMPT',
              action: 'ENTRY',
              tag_type: 'VISITOR',
              user_type: tagUserType,
              rfid_type: tagRfidType,
              message: 'Please register visitor name and plate at Guard Station.',
              ...lcdPayload('VISITOR ENTRY', 'PLEASE WAIT', 'GUARD REGISTER', 'NAME & PLATE')
            }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
          }

          await supabase.from('transactions').insert({
            rfid_uid: uid,
            direction: 'ENTRY',
            gate: device_id || 'ENTRY_GATE',
            user_type: tagUserType,
            rfid_type: tagRfidType,
            status: 'AUTHORIZED',
            remarks: `Visitor Entry: ${specialTag.label} | ${specialTag.description || 'N/A'}`
          })

          return new Response(JSON.stringify({
            status: 'AUTHORIZED',
            action: 'ENTRY',
            tag_type: 'VISITOR',
            user_type: tagUserType,
            rfid_type: tagRfidType,
            label: specialTag.label,
            ...lcdPayload('VISITOR ENTRY', 'AUTHORIZED', specialTag.label.toUpperCase(), `ENTRY  ${timeStr}`)
          }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
        }
      }

      // Emergency Tag
      await supabase.from('transactions').insert({
        rfid_uid: uid,
        direction: action,
        gate: device_id || action,
        user_type: tagUserType,
        rfid_type: tagRfidType,
        status: 'AUTHORIZED',
        remarks: `${specialTag.type} tag: ${specialTag.label || 'Emergency Response'}`
      })

      return new Response(JSON.stringify({
        status: 'AUTHORIZED',
        action: action,
        tag_type: specialTag.type,
        user_type: tagUserType,
        rfid_type: tagRfidType,
        label: specialTag.label || specialTag.type,
        ...lcdPayload('EMERGENCY PASS', 'AUTHORIZED', (specialTag.label || specialTag.type), `${action}  ${timeStr}`)
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    // ─── 3. LOOK UP RFID CARD → VEHICLE → USER ────────────────────────────────
    const { data: rawCard } = await supabase
      .from('rfid_cards')
      .select(`
        id, rfid_uid, authorization_status, user_type, rfid_type,
        vehicles ( id, plate_number, vehicle_type, vehicle_model, vehicle_color ),
        users ( id, full_name, role, role_detail, program, section, profile_image, cpass_id, student_id )
      `)
      .eq('rfid_uid', uid)
      .maybeSingle()

    const card = rawCard as RfidCardRow | null

    // ─── 4. NOT REGISTERED ────────────────────────────────────────────────────
    if (!card) {
      await supabase.from('transactions').insert({
        rfid_uid: uid,
        direction: direction,
        gate: device_id || direction,
        user_type: 'VEHICLE',
        rfid_type: 'LONG_RANGE',
        status: 'DENIED',
        remarks: 'RFID not registered in system'
      })

      return new Response(JSON.stringify({
        status: 'UNAUTHORIZED',
        message: 'RFID not registered in system.',
        ...lcdPayload('CHARRMPASS', '----------------', 'ACCESS DENIED', 'INVALID CARD')
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    const vehicle = unwrapSingle(card.vehicles)
    const user = unwrapSingle(card.users)
    const userType = card.user_type || (vehicle ? 'VEHICLE' : 'PEDESTRIAN')
    const rfidType = card.rfid_type || (userType === 'PEDESTRIAN' ? 'CLOSE_RANGE' : 'LONG_RANGE')
    const plate = vehicle?.plate_number || (userType === 'PEDESTRIAN' ? 'PEDESTRIAN' : uid)

    // ─── 5. PENDING STATUS ────────────────────────────────────────────────────
    if (card.authorization_status === 'PENDING') {
      await supabase.from('transactions').insert({
        rfid_uid: uid,
        vehicle_id: vehicle?.id || null,
        user_id: user?.id || null,
        direction: direction,
        gate: device_id || direction,
        user_type: userType,
        rfid_type: rfidType,
        status: 'DENIED',
        remarks: 'Registration pending admin approval'
      })

      return new Response(JSON.stringify({
        status: 'PENDING',
        message: 'Account pending admin approval.',
        user: { name: user?.full_name, cpass_id: user?.cpass_id || user?.student_id },
        ...lcdPayload('CHARRMPASS', user?.full_name?.split(' ')[0] || 'USER', 'PENDING APPROVAL', 'SEE ADMIN')
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    // ─── 6. DENIED STATUS ─────────────────────────────────────────────────────
    if (card.authorization_status === 'DENIED') {
      await supabase.from('transactions').insert({
        rfid_uid: uid,
        vehicle_id: vehicle?.id || null,
        user_id: user?.id || null,
        direction: direction,
        gate: device_id || direction,
        user_type: userType,
        rfid_type: rfidType,
        status: 'DENIED',
        remarks: 'Registration denied by admin'
      })

      return new Response(JSON.stringify({
        status: 'DENIED',
        message: 'Access denied by administrator.',
        user: { name: user?.full_name, cpass_id: user?.cpass_id || user?.student_id },
        ...lcdPayload('CHARRMPASS', user?.full_name?.split(' ')[0] || 'USER', 'ACCESS BLOCKED', 'CONTACT ADMIN')
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    // ─── 7. CHECK FOR ANTI-PASSBACK & STATE CONFLICTS ──────────────────────────
    if (direction === 'ENTRY') {
      if (lastTxn && lastTxn.direction === 'ENTRY') {
        const prevEntryDate = new Date(lastTxn.timestamp)
        const elapsedSec = Math.floor((now.getTime() - prevEntryDate.getTime()) / 1000)
        const prevTimeStr = formatManilaTime(prevEntryDate)
        const prevDateStr = formatManilaDate(prevEntryDate)
        const formattedStamp = `${prevTimeStr} ${prevDateStr}`

        if (elapsedSec >= 0 && elapsedSec < 30) {
          return new Response(JSON.stringify({
            status: 'WAIT_COOLDOWN',
            message: `Double-scan suppressed. Please wait ${30 - elapsedSec}s before scanning again.`,
            plate: plate,
            ...lcdPayload('PLEASE WAIT', `COOLDOWN ${30 - elapsedSec}s`, plate, 'ALREADY SCANNED')
          }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 429 })
        }

        // Auto-close prior unclosed session so occupancy headcount stays accurate
        await supabase.from('transactions').insert({
          rfid_uid: uid,
          vehicle_id: vehicle?.id || null,
          user_id: user?.id || null,
          direction: 'EXIT',
          gate: 'AUTO_RESOLVED_EXIT',
          user_type: userType,
          rfid_type: rfidType,
          status: 'AUTHORIZED',
          remarks: `[AUTO_RESOLVED_EXIT] Unclosed session from ${formattedStamp} auto-closed upon re-entry`
        })
      }
    } else if (direction === 'EXIT') {
      if (!lastTxn) {
        await supabase.from('transactions').insert({
          rfid_uid: uid,
          vehicle_id: vehicle?.id || null,
          user_id: user?.id || null,
          direction: 'EXIT',
          gate: device_id || direction,
          user_type: userType,
          rfid_type: rfidType,
          status: 'PENDING_CONFIRMATION',
          remarks: 'Exit attempt without prior entry record - verify with guard'
        })

        return new Response(JSON.stringify({
          status: 'NO_ENTRY_RECORD',
          action: 'EXIT_ALERT',
          message: 'No entry record found for this card. Guard verification needed.',
          plate: plate,
          user_type: userType,
          rfid_type: rfidType,
          user: {
            name: user?.full_name,
            cpass_id: user?.cpass_id || user?.student_id,
            role: user?.role,
            program: user?.program,
            section: user?.section,
            profile_image: user?.profile_image,
          },
          vehicle: {
            type: vehicle?.vehicle_type,
            model: vehicle?.vehicle_model,
            plate: plate,
            color: vehicle?.vehicle_color,
          },
          ...lcdPayload('NO ENTRY LOGGED', 'VERIFY W/ GUARD', plate, 'CHECK RECORD')
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
      } else if (lastTxn.direction === 'EXIT') {
        const prevExitDate = new Date(lastTxn.timestamp)
        const prevTimeStr = formatManilaTime(prevExitDate)
        const prevDateStr = formatManilaDate(prevExitDate)
        const formattedStamp = `${prevTimeStr} ${prevDateStr}`

        await supabase.from('transactions').insert({
          rfid_uid: uid,
          vehicle_id: vehicle?.id || null,
          user_id: user?.id || null,
          direction: 'EXIT',
          gate: device_id || direction,
          user_type: userType,
          rfid_type: rfidType,
          status: 'PENDING_CONFIRMATION',
          remarks: `Duplicate exit scan - already recorded as exited at ${formattedStamp}`
        })

        return new Response(JSON.stringify({
          status: 'ALREADY_EXITED',
          action: 'EXIT_ALERT',
          message: `Already recorded as exited at ${formattedStamp}. Guard confirmation needed.`,
          previous_exit: lastTxn.timestamp,
          plate: plate,
          user_type: userType,
          rfid_type: rfidType,
          user: {
            name: user?.full_name,
            cpass_id: user?.cpass_id || user?.student_id,
            role: user?.role,
            program: user?.program,
            section: user?.section,
            profile_image: user?.profile_image,
          },
          vehicle: {
            type: vehicle?.vehicle_type,
            model: vehicle?.vehicle_model,
            plate: plate,
            color: vehicle?.vehicle_color,
          },
          ...lcdPayload('ALREADY EXITED', 'OUT AT:', formattedStamp, 'WAIT FOR GUARD')
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
      }
    }

    // ─── 8. AUTHORIZED PASS ───────────────────────────────────────────────────
    await supabase.from('transactions').insert({
      rfid_uid: uid,
      vehicle_id: vehicle?.id || null,
      user_id: user?.id || null,
      direction: direction,
      gate: device_id || direction,
      user_type: userType,
      rfid_type: rfidType,
      status: 'AUTHORIZED',
      remarks: `${direction} scan — ${user?.full_name || uid} (${userType})`
    })

    return new Response(JSON.stringify({
      status: 'AUTHORIZED',
      action: direction,
      plate: plate,
      user_type: userType,
      rfid_type: rfidType,
      user: {
        name: user?.full_name,
        cpass_id: user?.cpass_id || user?.student_id,
        role: user?.role,
        program: user?.program,
        section: user?.section,
        profile_image: user?.profile_image,
      },
      vehicle: {
        type: vehicle?.vehicle_type,
        model: vehicle?.vehicle_model,
        plate: plate,
        color: vehicle?.vehicle_color,
      },
      ...lcdPayload('CHARRMPASS', 'AUTHORIZED', plate, `${direction}  ${timeStr}`)
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

  } catch (error: unknown) {
    console.error('RFID Scan Error:', error)
    const errMsg = error instanceof Error ? error.message : String(error)
    return new Response(JSON.stringify({
      error: errMsg,
      ...lcdPayload('CHARRMPASS', '----------------', 'SYSTEM ERROR', 'TRY AGAIN')
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 })
  }
})
