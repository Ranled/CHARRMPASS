// supabase/functions/rfid-scan/index.ts
// CHARRMPASS — Edge Function v3.5
// Handles Dual-Range ENTRY / EXIT logic with complete transaction auditing,
// anti-passback verification (duplicate entry & unmatched/duplicate exit),
// special tags (Visitor & Emergency passes), and physical LCD payload formatting.
// Uses SERVICE_ROLE_KEY for safe atomic operations.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.7.1"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// LCD payload helper — 4 lines for the physical 16x2 / 20x4 LCD or OLED display
function lcdPayload(line1: string, line2: string, line3: string, line4: string) {
  return { 
    lcd_line1: (line1 || '').substring(0, 20), 
    lcd_line2: (line2 || '').substring(0, 20), 
    lcd_line3: (line3 || '').substring(0, 20), 
    lcd_line4: (line4 || '').substring(0, 20) 
  }
}

serve(async (req) => {
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

    const now     = new Date()
    const timeStr = now.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' })

    // Resolve direction: prefer gate_type sent by the device,
    // fallback to looking up the gate's registered type in the devices table.
    let direction = 'ENTRY'
    if (gate_type && (gate_type === 'ENTRY' || gate_type === 'EXIT')) {
      direction = gate_type
    } else if (device_id) {
      const { data: device } = await supabase
        .from('devices')
        .select('gate_type')
        .eq('esp32_identifier', device_id)
        .maybeSingle()
      if (device?.gate_type) direction = device.gate_type
    }

    // ─── 2. CHECK SPECIAL TAGS (Visitor / Emergency) ──────────────────────────
    const { data: specialTag } = await supabase
      .from('special_tags')
      .select('*')
      .eq('rfid_uid', uid)
      .maybeSingle()

    if (specialTag) {
      // Check last transaction to deduce ENTRY vs EXIT if gate direction is generic
      const { data: lastTxn } = await supabase
        .from('transactions')
        .select('direction, timestamp, remarks')
        .eq('rfid_uid', uid)
        .eq('status', 'AUTHORIZED')
        .order('timestamp', { ascending: false })
        .limit(1)
        .maybeSingle()

      const isExitGate = direction === 'EXIT' || (!direction && lastTxn?.direction === 'ENTRY')
      const action = isExitGate ? 'EXIT' : 'ENTRY'
      const tagUserType = specialTag.user_type || 'PEDESTRIAN'
      const tagRfidType = specialTag.rfid_type || 'CLOSE_RANGE'

      if (specialTag.type === 'VISITOR') {
        if (action === 'EXIT') {
          // Automatic Visitor Identification & Exit
          const visitorName  = specialTag.label || 'Visitor'
          const visitorPlate = specialTag.description?.match(/Plate:\s*([^|]+)/)?.[1]?.trim() || 'N/A'

          await supabase.from('transactions').insert({
            rfid_uid:  uid,
            direction: 'EXIT',
            gate:      device_id || 'EXIT_GATE',
            user_type: tagUserType,
            rfid_type: tagRfidType,
            status:    'AUTHORIZED',
            remarks:   `Visitor Exit: ${visitorName} | Plate: ${visitorPlate}`
          })

          // Reset the reusable tag so it's immediately available for the next visitor
          await supabase.from('special_tags').update({
            label: 'Reusable Visitor Tag',
            description: null
          }).eq('rfid_uid', uid)

          return new Response(JSON.stringify({
            status:    'AUTHORIZED',
            action:    'EXIT',
            tag_type:  'VISITOR',
            user_type: tagUserType,
            rfid_type: tagRfidType,
            label:     visitorName,
            plate:     visitorPlate,
            message:   `Visitor ${visitorName} exited. Tag ${uid} is now available for reuse.`,
            ...lcdPayload('VISITOR EXIT', 'SAFE TRAVELS!', visitorName.toUpperCase(), 'TAG RETURNED')
          }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
        } else {
          // Visitor Entry
          const isAssigned = specialTag.label && specialTag.label !== 'Reusable Visitor Tag'
          if (!isAssigned) {
            return new Response(JSON.stringify({
              status:    'VISITOR_PROMPT',
              action:    'ENTRY',
              tag_type:  'VISITOR',
              user_type: tagUserType,
              rfid_type: tagRfidType,
              message:   'Please register visitor name and plate at Guard Station.',
              ...lcdPayload('VISITOR ENTRY', 'PLEASE WAIT', 'GUARD REGISTER', 'NAME & PLATE')
            }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
          }

          // Already assigned visitor entry
          await supabase.from('transactions').insert({
            rfid_uid:  uid,
            direction: 'ENTRY',
            gate:      device_id || 'ENTRY_GATE',
            user_type: tagUserType,
            rfid_type: tagRfidType,
            status:    'AUTHORIZED',
            remarks:   `Visitor Entry: ${specialTag.label} | ${specialTag.description || 'N/A'}`
          })

          return new Response(JSON.stringify({
            status:    'AUTHORIZED',
            action:    'ENTRY',
            tag_type:  'VISITOR',
            user_type: tagUserType,
            rfid_type: tagRfidType,
            label:     specialTag.label,
            ...lcdPayload('VISITOR ENTRY', 'AUTHORIZED', specialTag.label.toUpperCase(), `ENTRY  ${timeStr}`)
          }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
        }
      }

      // Emergency Tag
      await supabase.from('transactions').insert({
        rfid_uid:  uid,
        direction: action,
        gate:      device_id || direction,
        user_type: tagUserType,
        rfid_type: tagRfidType,
        status:    'AUTHORIZED',
        remarks:   `${specialTag.type} tag: ${specialTag.label || 'Emergency Response'}`
      })

      return new Response(JSON.stringify({
        status:    'AUTHORIZED',
        action:    action,
        tag_type:  specialTag.type,
        user_type: tagUserType,
        rfid_type: tagRfidType,
        label:     specialTag.label || specialTag.type,
        ...lcdPayload('EMERGENCY PASS', 'AUTHORIZED', (specialTag.label || specialTag.type), `${action}  ${timeStr}`)
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    // ─── 3. LOOK UP RFID CARD → VEHICLE → USER ────────────────────────────────
    const { data: card } = await supabase
      .from('rfid_cards')
      .select(`
        id, rfid_uid, authorization_status, user_type, rfid_type,
        vehicles ( id, plate_number, vehicle_type, vehicle_model, vehicle_color ),
        users ( id, full_name, role, role_detail, program, section, profile_image, cpass_id, student_id )
      `)
      .eq('rfid_uid', uid)
      .maybeSingle()

    // ─── 4. NOT REGISTERED ────────────────────────────────────────────────────
    if (!card) {
      await supabase.from('transactions').insert({
        rfid_uid:  uid,
        direction: direction,
        gate:      device_id || direction,
        user_type: 'VEHICLE',
        rfid_type: 'LONG_RANGE',
        status:    'DENIED',
        remarks:   'RFID not registered in system'
      })

      return new Response(JSON.stringify({
        status:  'UNAUTHORIZED',
        message: 'RFID not registered in system.',
        ...lcdPayload('CHARRMPASS', '----------------', 'ACCESS DENIED', 'INVALID CARD')
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    const vehicle  = card.vehicles as any
    const user     = card.users    as any
    const userType = card.user_type || (vehicle ? 'VEHICLE' : 'PEDESTRIAN')
    const rfidType = card.rfid_type || (userType === 'PEDESTRIAN' ? 'CLOSE_RANGE' : 'LONG_RANGE')
    const plate    = vehicle?.plate_number || (userType === 'PEDESTRIAN' ? 'PEDESTRIAN' : uid)

    // ─── 5. PENDING STATUS ────────────────────────────────────────────────────
    if (card.authorization_status === 'PENDING') {
      await supabase.from('transactions').insert({
        rfid_uid:   uid,
        vehicle_id: vehicle?.id || null,
        user_id:    user?.id    || null,
        direction:  direction,
        gate:       device_id || direction,
        user_type:  userType,
        rfid_type:  rfidType,
        status:     'DENIED',
        remarks:    'Registration pending admin approval'
      })

      return new Response(JSON.stringify({
        status:  'PENDING',
        message: 'Account pending admin approval.',
        user:    { name: user?.full_name, cpass_id: user?.cpass_id || user?.student_id },
        ...lcdPayload('CHARRMPASS', user?.full_name?.split(' ')[0] || 'USER', 'PENDING APPROVAL', 'SEE ADMIN')
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    // ─── 6. DENIED STATUS ─────────────────────────────────────────────────────
    if (card.authorization_status === 'DENIED') {
      await supabase.from('transactions').insert({
        rfid_uid:   uid,
        vehicle_id: vehicle?.id || null,
        user_id:    user?.id    || null,
        direction:  direction,
        gate:       device_id || direction,
        user_type:  userType,
        rfid_type:  rfidType,
        status:     'DENIED',
        remarks:    'Registration denied by admin'
      })

      return new Response(JSON.stringify({
        status:  'DENIED',
        message: 'Access denied by administrator.',
        user:    { name: user?.full_name, cpass_id: user?.cpass_id || user?.student_id },
        ...lcdPayload('CHARRMPASS', user?.full_name?.split(' ')[0] || 'USER', 'ACCESS BLOCKED', 'CONTACT ADMIN')
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    // ─── 7. CHECK FOR ANTI-PASSBACK & STATE CONFLICTS ──────────────────────────
    const { data: lastTxn } = await supabase
      .from('transactions')
      .select('id, direction, timestamp, status')
      .eq('rfid_uid', uid)
      .eq('status', 'AUTHORIZED')
      .order('timestamp', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (direction === 'ENTRY') {
      if (lastTxn && lastTxn.direction === 'ENTRY') {
        const prevEntryDate = new Date(lastTxn.timestamp)
        const prevTimeStr = prevEntryDate.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' })
        const prevDateStr = prevEntryDate.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit' })
        const formattedStamp = `${prevTimeStr} ${prevDateStr}`

        await supabase.from('transactions').insert({
          rfid_uid:   uid,
          vehicle_id: vehicle?.id || null,
          user_id:    user?.id    || null,
          direction:  'ENTRY',
          gate:       device_id   || direction,
          user_type:  userType,
          rfid_type:  rfidType,
          status:     'PENDING_CONFIRMATION',
          remarks:    `Duplicate entry scan - already inside since ${formattedStamp}`
        })

        return new Response(JSON.stringify({
          status:          'ALREADY_INSIDE',
          action:          'ENTRY_ALERT',
          message:         `Already granted entry at ${formattedStamp}. Guard confirmation needed.`,
          previous_entry:  lastTxn.timestamp,
          plate:           plate,
          user_type:       userType,
          rfid_type:       rfidType,
          user: {
            name:          user?.full_name,
            cpass_id:      user?.cpass_id || user?.student_id,
            role:          user?.role,
            program:       user?.program,
            section:       user?.section,
            profile_image: user?.profile_image,
          },
          vehicle: {
            type:  vehicle?.vehicle_type,
            model: vehicle?.vehicle_model,
            plate: plate,
            color: vehicle?.vehicle_color,
          },
          ...lcdPayload('ALREADY ENTERED', 'INSIDE SINCE:', formattedStamp, 'WAIT FOR GUARD')
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
      }
    } else if (direction === 'EXIT') {
      if (!lastTxn) {
        // No prior entry logged
        await supabase.from('transactions').insert({
          rfid_uid:   uid,
          vehicle_id: vehicle?.id || null,
          user_id:    user?.id    || null,
          direction:  'EXIT',
          gate:       device_id   || direction,
          user_type:  userType,
          rfid_type:  rfidType,
          status:     'PENDING_CONFIRMATION',
          remarks:    'Exit attempt without prior entry record - verify with guard'
        })

        return new Response(JSON.stringify({
          status:          'NO_ENTRY_RECORD',
          action:          'EXIT_ALERT',
          message:         'No entry record found for this card. Guard verification needed.',
          plate:           plate,
          user_type:       userType,
          rfid_type:       rfidType,
          user: {
            name:          user?.full_name,
            cpass_id:      user?.cpass_id || user?.student_id,
            role:          user?.role,
            program:       user?.program,
            section:       user?.section,
            profile_image: user?.profile_image,
          },
          vehicle: {
            type:  vehicle?.vehicle_type,
            model: vehicle?.vehicle_model,
            plate: plate,
            color: vehicle?.vehicle_color,
          },
          ...lcdPayload('NO ENTRY LOGGED', 'VERIFY W/ GUARD', plate, 'CHECK RECORD')
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
      } else if (lastTxn.direction === 'EXIT') {
        const prevExitDate = new Date(lastTxn.timestamp)
        const prevTimeStr = prevExitDate.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' })
        const prevDateStr = prevExitDate.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit' })
        const formattedStamp = `${prevTimeStr} ${prevDateStr}`

        await supabase.from('transactions').insert({
          rfid_uid:   uid,
          vehicle_id: vehicle?.id || null,
          user_id:    user?.id    || null,
          direction:  'EXIT',
          gate:       device_id   || direction,
          user_type:  userType,
          rfid_type:  rfidType,
          status:     'PENDING_CONFIRMATION',
          remarks:    `Duplicate exit scan - already recorded as exited at ${formattedStamp}`
        })

        return new Response(JSON.stringify({
          status:          'ALREADY_EXITED',
          action:          'EXIT_ALERT',
          message:         `Already recorded as exited at ${formattedStamp}. Guard confirmation needed.`,
          previous_exit:   lastTxn.timestamp,
          plate:           plate,
          user_type:       userType,
          rfid_type:       rfidType,
          user: {
            name:          user?.full_name,
            cpass_id:      user?.cpass_id || user?.student_id,
            role:          user?.role,
            program:       user?.program,
            section:       user?.section,
            profile_image: user?.profile_image,
          },
          vehicle: {
            type:  vehicle?.vehicle_type,
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
      rfid_uid:   uid,
      vehicle_id: vehicle?.id || null,
      user_id:    user?.id    || null,
      direction:  direction,
      gate:       device_id   || direction,
      user_type:  userType,
      rfid_type:  rfidType,
      status:     'AUTHORIZED',
      remarks:    `${direction} scan — ${user?.full_name || uid} (${userType})`
    })

    return new Response(JSON.stringify({
      status:    'AUTHORIZED',
      action:    direction,
      plate:     plate,
      user_type: userType,
      rfid_type: rfidType,
      user: {
        name:          user?.full_name,
        cpass_id:      user?.cpass_id || user?.student_id,
        role:          user?.role,
        program:       user?.program,
        section:       user?.section,
        profile_image: user?.profile_image,
      },
      vehicle: {
        type:  vehicle?.vehicle_type,
        model: vehicle?.vehicle_model,
        plate: plate,
        color: vehicle?.vehicle_color,
      },
      ...lcdPayload('CHARRMPASS', 'AUTHORIZED', plate, `${direction}  ${timeStr}`)
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

  } catch (error) {
    console.error('RFID Scan Error:', error)
    return new Response(JSON.stringify({
      error: error.message,
      ...lcdPayload('CHARRMPASS', '----------------', 'SYSTEM ERROR', 'TRY AGAIN')
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 })
  }
})
