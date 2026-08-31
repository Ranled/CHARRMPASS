// supabase/functions/rfid-scan/index.ts
// CHARRMPASS — Edge Function v3.0
// Handles ENTRY / EXIT logic using the transactions table.
// Authorization: AUTHORIZED / PENDING / DENIED
// Special tags: VISITOR / EMERGENCY
// Uses SERVICE_ROLE_KEY for safe atomic writes.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.7.1"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// LCD payload helper — 4 lines for the physical LCD display
function lcdPayload(line1: string, line2: string, line3: string, line4: string) {
  return { lcd_line1: line1, lcd_line2: line2, lcd_line3: line3, lcd_line4: line4 }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // Use SERVICE_ROLE to bypass RLS for atomic operations
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const { rfid_uid, device_id, gate_type } = await req.json()

    if (!rfid_uid) {
      return new Response(JSON.stringify({
        status: 'ERROR',
        message: 'Missing rfid_uid',
        ...lcdPayload('CHARRMPASS', '-----------', 'SCAN ERROR', 'NO UID')
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

      if (specialTag.type === 'VISITOR') {
        if (action === 'EXIT') {
          // Automatic Visitor Identification & Exit
          const visitorName = specialTag.label || 'Visitor'
          const visitorPlate = specialTag.description?.match(/Plate:\s*([^|]+)/)?.[1]?.trim() || 'N/A'

          await supabase.from('transactions').insert({
            rfid_uid:  uid,
            direction: 'EXIT',
            gate:      device_id || 'EXIT_GATE',
            status:    'AUTHORIZED',
            remarks:   `Visitor Exit: ${visitorName} | Plate: ${visitorPlate}`
          })

          // Reset the reusable tag so it's immediately available for next visitor
          await supabase.from('special_tags').update({
            label: 'Reusable Visitor Tag',
            description: null
          }).eq('rfid_uid', uid)

          return new Response(JSON.stringify({
            status:   'AUTHORIZED',
            action:   'EXIT',
            tag_type: 'VISITOR',
            label:    visitorName,
            plate:    visitorPlate,
            message:  `Visitor ${visitorName} exited. Tag ${uid} is now available for reuse.`,
            ...lcdPayload('VISITOR EXIT', 'SAFE TRAVELS!', visitorName.substring(0, 16).toUpperCase(), 'TAG RETURNED')
          }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
        } else {
          // Visitor Entry
          const isAssigned = specialTag.label && specialTag.label !== 'Reusable Visitor Tag'
          if (!isAssigned) {
            return new Response(JSON.stringify({
              status:   'VISITOR_PROMPT',
              action:   'ENTRY',
              tag_type: 'VISITOR',
              message:  'Please register visitor name and plate at Guard Station.',
              ...lcdPayload('VISITOR ENTRY', 'PLEASE WAIT', 'GUARD REGISTER', 'NAME & PLATE')
            }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
          }

          // Already assigned visitor entry
          await supabase.from('transactions').insert({
            rfid_uid:  uid,
            direction: 'ENTRY',
            gate:      device_id || 'ENTRY_GATE',
            status:    'AUTHORIZED',
            remarks:   `Visitor Entry: ${specialTag.label} | ${specialTag.description || 'N/A'}`
          })

          return new Response(JSON.stringify({
            status:   'AUTHORIZED',
            action:   'ENTRY',
            tag_type: 'VISITOR',
            label:    specialTag.label,
            ...lcdPayload('VISITOR ENTRY', 'AUTHORIZED', specialTag.label.substring(0, 16).toUpperCase(), `ENTRY  ${timeStr}`)
          }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
        }
      }

      // Emergency Tag
      await supabase.from('transactions').insert({
        rfid_uid:  uid,
        direction: action,
        gate:      device_id || direction,
        status:    'AUTHORIZED',
        remarks:   `${specialTag.type} tag: ${specialTag.label || 'Emergency Response'}`
      })

      return new Response(JSON.stringify({
        status:   'AUTHORIZED',
        action:   action,
        tag_type: specialTag.type,
        label:    specialTag.label || specialTag.type,
        ...lcdPayload('EMERGENCY PASS', 'AUTHORIZED', (specialTag.label || specialTag.type).substring(0, 16), `${action}  ${timeStr}`)
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    // ─── 3. LOOK UP RFID CARD → VEHICLE → USER ────────────────────────────────
    const { data: card } = await supabase
      .from('rfid_cards')
      .select(`
        id, rfid_uid, authorization_status,
        vehicles ( id, plate_number, vehicle_type, vehicle_model, vehicle_color ),
        users ( id, full_name, role, program, section, profile_image )
      `)
      .eq('rfid_uid', uid)
      .maybeSingle()

    // ─── 4. NOT REGISTERED ────────────────────────────────────────────────────
    if (!card) {
      await supabase.from('transactions').insert({
        rfid_uid:  uid,
        direction: direction,
        gate:      device_id || direction,
        status:    'DENIED',
        remarks:   'RFID not registered in system'
      })

      return new Response(JSON.stringify({
        status:  'UNAUTHORIZED',
        message: 'RFID not registered.',
        ...lcdPayload('CHARRMPASS', '-----------', 'ACCESS DENIED', 'INVALID CARD')
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    // ─── 5. PENDING STATUS ────────────────────────────────────────────────────
    if (card.authorization_status === 'PENDING') {
      await supabase.from('transactions').insert({
        rfid_uid:   uid,
        vehicle_id: (card.vehicles as any)?.id || null,
        user_id:    (card.users as any)?.id    || null,
        direction:  direction,
        gate:       device_id || direction,
        status:     'DENIED',
        remarks:    'Registration pending admin approval'
      })

      return new Response(JSON.stringify({
        status:  'PENDING',
        message: 'Account pending admin approval.',
        user:    { name: (card.users as any)?.full_name },
        ...lcdPayload('CHARRMPASS', (card.users as any)?.full_name?.split(' ')[0] || 'USER', 'PENDING', 'NOT APPROVED')
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    // ─── 6. DENIED STATUS ─────────────────────────────────────────────────────
    if (card.authorization_status === 'DENIED') {
      await supabase.from('transactions').insert({
        rfid_uid:   uid,
        vehicle_id: (card.vehicles as any)?.id || null,
        user_id:    (card.users as any)?.id    || null,
        direction:  direction,
        gate:       device_id || direction,
        status:     'DENIED',
        remarks:    'Registration denied by admin'
      })

      return new Response(JSON.stringify({
        status:  'DENIED',
        message: 'Access denied by administrator.',
        user:    { name: (card.users as any)?.full_name },
        ...lcdPayload('CHARRMPASS', (card.users as any)?.full_name?.split(' ')[0] || 'USER', 'DENIED', 'SEE ADMIN')
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    // ─── 7. AUTHORIZED (Check for Duplicate Entry) ──────────────────────────
    const vehicle = card.vehicles as any
    const user    = card.users    as any
    const plate   = vehicle?.plate_number || uid

    if (direction === 'ENTRY') {
      const { data: lastTxn } = await supabase
        .from('transactions')
        .select('id, direction, timestamp, status')
        .eq('rfid_uid', uid)
        .eq('status', 'AUTHORIZED')
        .order('timestamp', { ascending: false })
        .limit(1)
        .maybeSingle()

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
          gate:       device_id  || direction,
          status:     'PENDING_CONFIRMATION',
          remarks:    `Duplicate entry scan - already inside since ${formattedStamp}`
        })

        return new Response(JSON.stringify({
          status:          'ALREADY_INSIDE',
          action:          'ENTRY_ALERT',
          message:         `Already granted entry at ${formattedStamp}. Guard confirmation needed.`,
          previous_entry:  lastTxn.timestamp,
          plate:           plate,
          user: {
            name:          user?.full_name,
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
          ...lcdPayload('ALREADY GRANTED', 'ENTRY AT:', formattedStamp, 'WAIT FOR GUARD')
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
      }
    }

    await supabase.from('transactions').insert({
      rfid_uid:   uid,
      vehicle_id: vehicle?.id || null,
      user_id:    user?.id    || null,
      direction:  direction,
      gate:       device_id  || direction,
      status:     'AUTHORIZED',
      remarks:    `${direction} scan — ${user?.full_name || uid}`
    })

    return new Response(JSON.stringify({
      status:  'AUTHORIZED',
      action:  direction,
      plate:   plate,
      user: {
        name:          user?.full_name,
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
      ...lcdPayload('CHARRMPASS', 'AUTHORIZED', plate, `${direction} ${timeStr}`)
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

  } catch (error) {
    console.error('RFID Scan Error:', error)
    return new Response(JSON.stringify({
      error: error.message,
      ...lcdPayload('CHARRMPASS', '-----------', 'SYSTEM ERROR', 'TRY AGAIN')
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 })
  }
})

