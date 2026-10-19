/* ============================================================
 * CHARRMPASS — Entry Gate App Logic (entry-app.js)
 * Direction filter: ENTRY
 * ============================================================ */

'use strict';

const GATE_DIRECTION = 'ENTRY';

// ─── STATE ───────────────────────────────────────────────────
let guardName       = 'Guard';
let recentEntries   = [];
let currentScanUID  = null;
let scanTimeout     = null;

// ─── INIT ─────────────────────────────────────────────────────
(function init() {
  initSupabase();
  updateConnBadge();
  document.getElementById('manualUID').addEventListener('keydown', e => {
    if (e.key === 'Enter') processManual();
  });
  document.getElementById('btnProcess').addEventListener('click', processManual);
  document.getElementById('btnDeny').addEventListener('click', denyLast);
})();

// ─── CONNECTION BADGE ─────────────────────────────────────────
function updateConnBadge() {
  updateDBBadge();
  const ind  = document.getElementById('connIndicator');
  const txt  = document.getElementById('connText');
  if (ind && txt) {
    if (isConnected) {
      ind.className = 'hdr-online';
      txt.textContent = 'ONLINE';
    } else {
      ind.className = 'hdr-online offline';
      txt.textContent = 'OFFLINE';
    }
  }
}

// ─── LOGIN ─────────────────────────────────────────────────────
async function doLogin() {
  const user = document.getElementById('loginUser').value.trim();
  const pass = document.getElementById('loginPass').value;
  const errEl = document.getElementById('loginError');
  errEl.textContent = '';

  if (!user || !pass) { errEl.textContent = 'Please enter credentials.'; return; }

  const btn = document.getElementById('btnLogin');
  btn.textContent = 'Signing in…';
  btn.disabled = true;

  try {
    let account = null;
    let isOfflineAuth = false;
    const client = typeof supabaseClient !== 'undefined' ? supabaseClient : null;
    if (client && isConnected) {
      try {
        const { data, error } = await client
          .from('system_accounts')
          .select('*')
          .eq('username', user)
          .eq('password', pass)
          .maybeSingle();
        if (!error && data) {
          account = data;
          try {
            const cached = JSON.parse(localStorage.getItem('charrmpass_cached_accounts') || '{}');
            cached[user] = { username: data.username, password: pass, role: data.role, id: data.id };
            localStorage.setItem('charrmpass_cached_accounts', JSON.stringify(cached));
          } catch (_) {}
        }
      } catch (dbErr) {
        console.warn('Online auth check failed, checking offline credentials:', dbErr);
      }
    }

    // Offline / fallback authentication
    if (!account) {
      try {
        const cached = JSON.parse(localStorage.getItem('charrmpass_cached_accounts') || '{}');
        if (cached[user] && cached[user].password === pass) {
          account = cached[user];
          isOfflineAuth = true;
        }
      } catch (_) {}

      // Built-in emergency accounts if offline or database unreachable
      if (!account) {
        if ((user === 'guard' && pass === 'guard123') || (user === 'admin' && pass === 'admin123')) {
          account = {
            username: user,
            role: user === 'admin' ? 'ADMIN' : 'GUARD',
            id: 'local-' + user
          };
          isOfflineAuth = true;
        }
      }
    }

    if (!account) {
      errEl.textContent = 'Invalid username or password.';
      btn.textContent = 'SIGN IN'; btn.disabled = false;
      return;
    }

    guardName = account.username;
    document.getElementById('guardNameDisplay').textContent = guardName;
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('dashboard').classList.remove('hidden');

    try {
      sessionStorage.setItem('charrmpass_session', JSON.stringify({
        id: account.id,
        username: account.username,
        role: account.role,
        loginTime: Date.now(),
        timestamp: Date.now()
      }));
    } catch (_) {}

    showToast(isOfflineAuth ? 'Welcome, ' + guardName + '! (Offline Mode)' : 'Welcome, ' + guardName + '!', 'success');
    await loadRecentEntries();
    setupRealtime();

  } catch (e) {
    errEl.textContent = 'Login error. Try again.';
    btn.textContent = 'SIGN IN'; btn.disabled = false;
  }
}

function doLogout() {
  if (!confirm('Sign out?')) return;
  document.getElementById('loginScreen').style.display = 'flex';
  document.getElementById('dashboard').classList.add('hidden');
  resetScanPanel();
}

// ─── TRAFFIC LIGHT STATE CONTROLLER ───────────────────────────
function setTrafficLightUI(state) {
  // state: 'standby' (Red) | 'scanning' (Yellow) | 'done' (Green) | 'denied' (Red) | 'offline' (Blinking Yellow) | 'connected' (3 Green Blinks)
  const red = document.getElementById('tlLampRed');
  const yellow = document.getElementById('tlLampYellow');
  const green = document.getElementById('tlLampGreen');
  if (!red || !yellow || !green) return;

  red.classList.remove('active');
  yellow.classList.remove('active');
  green.classList.remove('active');

  if (state === 'offline') {
    yellow.classList.add('active'); // CSS tl-blink animates yellow
  } else if (state === 'connected') {
    let count = 0;
    const interval = setInterval(() => {
      green.classList.toggle('active');
      count++;
      if (count >= 6) {
        clearInterval(interval);
        green.classList.remove('active');
        red.classList.add('active'); // Return to Standby RED
      }
    }, 150);
  } else if (state === 'scanning') {
    yellow.classList.add('active');
  } else if (state === 'done') {
    green.classList.add('active');
  } else {
    // 'standby' or 'denied'
    red.classList.add('active');
  }
}

window.addEventListener('supabase:connected', () => setTrafficLightUI('connected'));
window.addEventListener('supabase:disconnected', () => setTrafficLightUI('offline'));
window.addEventListener('offline', () => setTrafficLightUI('offline'));
window.addEventListener('online', () => setTrafficLightUI('connected'));

// ─── DATE HELPER ──────────────────────────────────────────────
function getLocalStartOfDayIso() {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  return startOfDay.toISOString();
}

// ─── LOAD RECENT ENTRIES ─────────────────────────────────────
async function loadRecentEntries() {
  if (!isConnected) return;
  const todayStart = getLocalStartOfDayIso();
  const { data, error } = await supabaseClient
    .from('transactions')
    .select(`
      id, rfid_uid, direction, status, timestamp, remarks, user_type, rfid_type,
      users   ( full_name, role, program, section ),
      vehicles( plate_number, vehicle_type, vehicle_model, vehicle_color )
    `)
    .eq('direction', GATE_DIRECTION)
    .gte('timestamp', todayStart)
    .order('timestamp', { ascending: false })
    .limit(30);

  if (error) { console.error('Load entries error:', error); return; }
  recentEntries = data || [];
  renderRecentList();
}

// ─── RENDER RECENT LIST ───────────────────────────────────────
function renderRecentList() {
  const body = document.getElementById('recentBody');
  if (!recentEntries.length) {
    body.innerHTML = '<div class="scan-empty">No entries yet today</div>';
    return;
  }
  body.innerHTML = recentEntries.slice(0, 20).map(t => {
    const ok        = t.status === 'AUTHORIZED';
    const isPending = t.status === 'PENDING_CONFIRMATION';
    let name    = t.users?.full_name;
    let plate   = t.vehicles?.plate_number;
    const vtype = t.vehicles?.vehicle_type;

    if (!name && t.remarks) {
      if (t.remarks.includes('Visitor')) {
        const match = t.remarks.match(/Visitor (?:Exit|Entry):\s*([^|]+)(?:\s*\|\s*Plate:\s*([^|]+))?/i);
        if (match) {
          name = match[1]?.trim();
          if (match[2]?.trim() && match[2].trim() !== 'N/A') plate = match[2].trim();
        } else {
          name = 'Visitor Pass';
        }
      } else if (t.remarks.includes('Emergency') || t.remarks.includes('EMERGENCY')) {
        const match = t.remarks.match(/Emergency (?:tag|Response):\s*(.+)/i);
        name = match ? match[1].trim() : 'Emergency Response';
        plate = 'EMERGENCY';
      }
    }

    // Determine whether this entry transaction is a Vehicle
    const hasRealPlate = plate && plate !== '--' && plate !== 'PEDESTRIAN' && plate !== 'NONE' && plate !== 'N/A' && plate !== '—' && plate !== t.rfid_uid?.substring(0, 12);
    const hasVehType   = vtype && vtype !== 'None' && vtype !== 'Walking / Pedestrian' && vtype !== 'PEDESTRIAN';
    const isPed        = t.user_type === 'PEDESTRIAN' || t.rfid_type === 'CLOSE_RANGE' || (!hasRealPlate && !hasVehType);
    const isVehicle    = !isPed && (hasRealPlate || hasVehType);

    if (!name) name = ok ? (isVehicle ? 'Authorized Driver' : 'Authorized Pedestrian') : (isPending ? 'Duplicate Entry Scan' : 'Unregistered RFID');
    if (!plate) plate = isVehicle ? (t.rfid_uid?.substring(0, 12) || '--') : 'PEDESTRIAN';
    const timeStr = new Date(t.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    const dotColor = ok ? 'ok' : (isPending ? 'pending' : 'deny');
    const badgeIcon = ok ? '✓' : (isPending ? '⚠' : '✕');
    const badgeColor = ok ? 'color:#22c55e' : (isPending ? 'color:#d97706' : 'color:#ef4444');

    const modeBadge = isVehicle
      ? '<span class="scan-row-badge vehicle">🚗 VEHICLE</span>'
      : '<span class="scan-row-badge pedestrian">🚶 PEDESTRIAN</span>';

    return `
      <div class="scan-row">
        <div class="scan-row-dot ${dotColor}"></div>
        <div class="scan-row-info">
          <div class="scan-row-name">${htmlEsc(name)}${ok || isPending ? modeBadge : ''}</div>
          <div class="scan-row-plate">${htmlEsc(plate)}</div>
        </div>
        <div class="scan-row-time">${timeStr}</div>
        <div style="font-size:14px; flex-shrink:0; ${badgeColor}">${badgeIcon}</div>
      </div>`;
  }).join('');
}

// ─── REALTIME SUBSCRIPTION ────────────────────────────────────
function setupRealtime() {
  if (!isConnected) return;

  supabaseClient.channel('entry-txn-live')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'transactions' }, payload => {
      const row = payload.new;
      if (row.direction !== GATE_DIRECTION) return; // Ignore EXIT transactions
      console.log('[RT] New ENTRY transaction:', row);
      handleNewTransaction(row);
    })
    .subscribe(status => console.log('[RT] Entry subscription:', status));
}

// ─── HANDLE NEW TRANSACTION (from realtime or manual) ─────────
async function handleNewTransaction(txn) {
  // Fetch full joined data if we only have the raw row
  let full = txn;
  if (isConnected && (!txn.users && !txn.vehicles)) {
    const { data } = await supabaseClient
      .from('transactions')
      .select(`
        id, rfid_uid, direction, status, timestamp, remarks, user_type, rfid_type,
        users   ( full_name, role, program, section ),
        vehicles( plate_number, vehicle_type, vehicle_model, vehicle_color )
      `)
      .eq('id', txn.id)
      .maybeSingle();
    if (data) full = data;
  }

  // Deduplicate if already present in recentEntries
  const existingIdx = recentEntries.findIndex(e => e.id && full.id && e.id === full.id);
  if (existingIdx !== -1) {
    recentEntries[existingIdx] = full;
  } else {
    recentEntries.unshift(full);
  }
  renderRecentList();

  // Show in scan panel
  showScanResult(full);
}

// ─── SHOW SCAN RESULT IN PANEL ────────────────────────────────
function showScanResult(txn) {
  currentScanUID = txn.rfid_uid;
  const ok        = txn.status === 'AUTHORIZED';
  const isPending = txn.status === 'PENDING_CONFIRMATION';
  let name    = txn.users?.full_name;
  let plate   = txn.vehicles?.plate_number;
  let role    = txn.users?.role;
  let program = txn.users?.program   || '--';
  let section = txn.users?.section   || '--';

  if (!name && txn.remarks?.includes('Visitor')) {
    const match = txn.remarks.match(/Visitor (?:Exit|Entry):\s*([^|]+)(?:\s*\|\s*Plate:\s*([^|]+))?/i);
    if (match) {
      name = match[1]?.trim();
      plate = match[2]?.trim() || 'VISITOR PASS';
      role = 'VISITOR';
      program = 'Campus Visitor';
      section = 'Visitor Entry';
    }
  } else if (!name && (txn.remarks?.includes('Emergency') || txn.remarks?.includes('EMERGENCY') || txn.remarks?.includes('Emergency tag'))) {
    name = 'Emergency Response';
    plate = 'EMERGENCY';
    role = 'EMERGENCY';
    program = 'Emergency Response';
    section = 'Priority Pass';
  }

  const vtype   = txn.vehicles?.vehicle_type || '';
  const vmodel  = txn.vehicles?.vehicle_model|| '';

  // Determine whether this entrant is a Vehicle
  const hasRealPlate = plate && plate !== '—' && plate !== '--' && plate !== 'PEDESTRIAN' && plate !== 'NONE' && plate !== 'N/A';
  const hasVehType   = vtype && vtype !== 'None' && vtype !== 'Walking / Pedestrian' && vtype !== 'PEDESTRIAN';
  const isPed        = txn.user_type === 'PEDESTRIAN' || txn.rfid_type === 'CLOSE_RANGE' || (!hasRealPlate && !hasVehType);
  const isVehicle    = !isPed && (hasRealPlate || hasVehType);

  if (!name) name = isPending ? 'Registered User (Duplicate Scan)' : (ok ? (isVehicle ? 'Authorized Driver' : 'Authorized Pedestrian') : 'Unknown Card');
  if (!plate) plate = isVehicle ? '—' : 'PEDESTRIAN';
  if (!role) role = '--';
  const timeStr = new Date(txn.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const avatarBg = ok ? '16a34a' : (isPending ? 'd97706' : 'b91c1c');
  const avatar  = `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=${avatarBg}&color=fff&size=200&bold=true`;

  const panel  = document.getElementById('scanPanel');
  const ready  = document.getElementById('readyState');
  const result = document.getElementById('scanResult');

  ready.style.display  = 'none';
  result.classList.remove('hidden');
  panel.className = `scan-panel ${ok ? 'authorized' : (isPending ? 'pending' : 'denied')}`;

  // Update Traffic Light: Done (Green) or Denied/Standby (Red)
  setTrafficLightUI(ok ? 'done' : (isPending ? 'scanning' : 'denied'));

  result.className = `scan-result ${ok ? 'authorized' : (isPending ? 'pending' : 'denied')}`;
  result.innerHTML = `
    <div class="scan-profile-wrap">
      <img class="scan-avatar ${ok ? '' : (isPending ? 'pending' : 'denied')}" src="${avatar}" alt="${htmlEsc(name)}" />
      <div class="scan-status-badge ${ok ? 'ok' : (isPending ? 'warn' : 'deny')}">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
          ${ok ? '<polyline points="20 6 9 17 4 12"/>' : (isPending ? '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>' : '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>')}
        </svg>
      </div>
    </div>

    ${ok || isPending ? `
      <div class="scan-transit-pill ${isVehicle ? 'vehicle' : 'pedestrian'}">
        <i data-lucide="${isVehicle ? 'car' : 'user'}" style="width:14px; height:14px;"></i>
        <span>${isVehicle ? '🚗 VEHICLE ENTRY' : '🚶 PEDESTRIAN ENTRY'}</span>
      </div>
    ` : ''}

    <div class="scan-name">${htmlEsc(name)}</div>

    <div class="scan-details">
      ${ok || isPending ? `
        <div class="scan-detail-row"><strong>${htmlEsc(role)}</strong> · ${htmlEsc(program)} ${htmlEsc(section)}</div>
        <div class="scan-plate">
          ${isVehicle ? '<span style="display:block; font-size:10px; opacity:0.75; letter-spacing:1px; text-transform:uppercase; margin-bottom:2px;">Vehicle Plate</span>' : ''}
          ${htmlEsc(plate)}
        </div>
        ${vtype ? `<div class="scan-detail-row"><strong>Vehicle:</strong> ${htmlEsc(vtype)} ${htmlEsc(vmodel)}</div>` : (isVehicle ? '<div class="scan-detail-row"><strong>Vehicle:</strong> Registered Campus Vehicle</div>' : '<div class="scan-detail-row" style="color:var(--muted)">Foot / Turnstile Passage</div>')}
        ${isPending ? `<div class="scan-detail-row" style="color:#d97706; font-size:12px; font-weight:600;">⚠️ ${htmlEsc(txn.remarks || 'Already logged inside campus')}</div>` : ''}
      ` : `
        <div class="scan-detail-row" style="color: var(--denied)">Not registered or unauthorized</div>
        <div class="scan-detail-row" style="font-family: 'JetBrains Mono', monospace; font-size:12px; color:var(--muted);">${htmlEsc(txn.rfid_uid)}</div>
      `}
    </div>

    <div class="scan-verdict ${ok ? 'ok' : (isPending ? 'warn' : 'deny')}">
      ${ok
        ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> ${isVehicle ? 'VEHICLE ENTRY GRANTED' : 'ENTRY GRANTED'}`
        : (isPending
          ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg> ${isVehicle ? 'ALREADY ENTERED (VEHICLE)' : 'ALREADY ENTERED (AWAITING GUARD)'}`
          : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg> ACCESS DENIED')
      }
    </div>

    <div class="scan-time">${timeStr}</div>
  `;

  if (window.lucide && typeof lucide.createIcons === 'function') {
    lucide.createIcons();
  }

  // Auto-reset after 10 seconds
  clearTimeout(scanTimeout);
  scanTimeout = setTimeout(resetScanPanel, 10000);
}

// ─── RESET SCAN PANEL ─────────────────────────────────────────
function resetScanPanel() {
  const panel  = document.getElementById('scanPanel');
  const ready  = document.getElementById('readyState');
  const result = document.getElementById('scanResult');
  panel.className = 'scan-panel';
  result.classList.add('hidden');
  result.innerHTML = '';
  ready.style.display = 'flex';
  currentScanUID = null;
  // Return traffic light to RED STANDBY
  setTrafficLightUI('standby');
  lucide.createIcons();
}

// ─── MANUAL UID PROCESSING ────────────────────────────────────
async function processManual() {
  const input = document.getElementById('manualUID');
  const uid   = input.value.trim().toUpperCase();
  if (!uid) { showToast('Enter an RFID UID first.', 'error'); return; }
  input.value = '';

  // Set Traffic Light to YELLOW SCANNING
  setTrafficLightUI('scanning');

  showToast('Processing UID: ' + uid, 'info');

  if (!isConnected) {
    showToast('No database connection.', 'error');
    setTrafficLightUI('standby');
    return;
  }

  // Look up rfid_card
  let card = null;
  const { data: c } = await supabaseClient
    .from('rfid_cards')
    .select(`
      id, rfid_uid, authorization_status, vehicle_id, user_id,
      vehicles ( plate_number, vehicle_type, vehicle_model ),
      users    ( full_name, role, program, section )
    `)
    .eq('rfid_uid', uid)
    .maybeSingle();
  card = c;

  let isVisitor = false;
  let isEmergency = false;
  let visitorName = 'Visitor';
  let visitorPlate = 'VISITOR PASS';
  let emergencyLabel = 'Emergency Response';

  if (!card) {
    const { data: spec } = await supabaseClient
      .from('special_tags')
      .select('*')
      .eq('rfid_uid', uid)
      .maybeSingle();
    if (spec) {
      if (spec.type === 'VISITOR') {
        isVisitor = true;
        visitorName = spec.label || 'Visitor';
        visitorPlate = spec.description?.match(/Plate:\s*([^|]+)/)?.[1]?.trim() || 'VISITOR PASS';
      } else if (spec.type === 'EMERGENCY') {
        isEmergency = true;
        emergencyLabel = spec.label || 'Emergency Response';
      }
    }
  }

  const isSpecial = isVisitor || isEmergency;
  const status  = (card?.authorization_status === 'AUTHORIZED' || isSpecial) ? 'AUTHORIZED' : 'DENIED';
  let remarks = card ? (status === 'AUTHORIZED' ? 'Manual entry – guard station' : 'Manual entry – not authorized') : 'Manual entry – unregistered';
  if (isVisitor) {
    remarks = `Visitor Entry: ${visitorName} | Plate: ${visitorPlate}`;
  } else if (isEmergency) {
    remarks = `Emergency Response: ${emergencyLabel}`;
  }

  // Determine whether this manual entry is for a Vehicle
  const isVehicleCard = (card?.vehicles?.plate_number && card.vehicles.plate_number !== 'PEDESTRIAN' && card.vehicles.plate_number !== 'NONE' && card.vehicles.plate_number !== 'N/A') ||
                        (card?.vehicles?.vehicle_type && card.vehicles.vehicle_type !== 'None' && card.vehicles.vehicle_type !== 'Walking / Pedestrian') ||
                        (card?.user_type === 'VEHICLE') ||
                        (isVisitor && visitorPlate && visitorPlate !== 'N/A' && visitorPlate !== 'VISITOR PASS');
  const user_type = isVehicleCard ? 'VEHICLE' : 'PEDESTRIAN';
  const rfid_type = isVehicleCard ? 'LONG_RANGE' : 'CLOSE_RANGE';
  const gateName  = isVehicleCard ? 'ENTRY_GATE' : 'CHARRMPASS_GATE_ENTRY';

  // Insert transaction
  const { data: txn, error } = await supabaseClient
    .from('transactions')
    .insert({
      rfid_uid:   uid,
      direction:  GATE_DIRECTION,
      gate:       gateName,
      user_type:  user_type,
      rfid_type:  rfid_type,
      vehicle_id: card?.vehicle_id || null,
      user_id:    card?.user_id    || null,
      status,
      remarks: card ? `${remarks} (${isVehicleCard ? 'Vehicle' : 'Pedestrian'})` : remarks
    })
    .select(`
      id, rfid_uid, direction, status, timestamp, remarks, user_type, rfid_type,
      users   ( full_name, role, program, section ),
      vehicles( plate_number, vehicle_type, vehicle_model, vehicle_color )
    `)
    .single();

  if (error) {
    showToast('DB error: ' + error.message, 'error');
    setTrafficLightUI('standby');
    return;
  }

  handleNewTransaction(txn);
  showToast(status === 'AUTHORIZED' ? 'Entry granted!' : 'Access denied.', status === 'AUTHORIZED' ? 'success' : 'error');
}

// ─── DENY LAST ────────────────────────────────────────────────
function denyLast() {
  if (!currentScanUID) { showToast('No active scan to deny.', 'error'); return; }
  const fakeRow = {
    id: 'manual-deny', rfid_uid: currentScanUID,
    direction: GATE_DIRECTION, status: 'DENIED',
    timestamp: new Date().toISOString(), remarks: 'Denied by guard',
    users: null, vehicles: null
  };
  showScanResult(fakeRow);
  showToast('Entry denied by guard.', 'error');
}

// ─── HELPERS ─────────────────────────────────────────────────
function htmlEsc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function showToast(msg, type = 'info') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = type;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}

// Expose for HTML onclick
window.doLogin  = doLogin;
window.doLogout = doLogout;
