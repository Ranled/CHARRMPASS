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
    const client = typeof supabaseClient !== 'undefined' ? supabaseClient : null;
    if (client) {
      const { data } = await client
        .from('system_accounts')
        .select('*')
        .eq('username', user)
        .eq('password', pass)
        .maybeSingle();
      account = data;
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

    showToast('Welcome, ' + guardName + '!', 'success');
    await loadRecentEntries();
    setupRealtime();

  } catch (e) {
    errEl.textContent = 'Connection error. Try again.';
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

// ─── LOAD RECENT ENTRIES ─────────────────────────────────────
async function loadRecentEntries() {
  if (!isConnected) return;
  const today = new Date().toISOString().split('T')[0];
  const { data, error } = await supabaseClient
    .from('transactions')
    .select(`
      id, rfid_uid, direction, status, timestamp, remarks,
      users   ( full_name, role, program, section ),
      vehicles( plate_number )
    `)
    .eq('direction', GATE_DIRECTION)
    .gte('timestamp', today + 'T00:00:00')
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

    if (!name) name = ok ? 'Authorized Driver' : (isPending ? 'Duplicate Entry Scan' : 'Unregistered RFID');
    if (!plate) plate = t.rfid_uid?.substring(0, 12) || '--';
    const timeStr = new Date(t.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    const dotColor = ok ? 'ok' : (isPending ? 'pending' : 'deny');
    const badgeIcon = ok ? '✓' : (isPending ? '⚠' : '✕');
    const badgeColor = ok ? 'color:#22c55e' : (isPending ? 'color:#d97706' : 'color:#ef4444');
    return `
      <div class="scan-row">
        <div class="scan-row-dot ${dotColor}"></div>
        <div class="scan-row-info">
          <div class="scan-row-name">${htmlEsc(name)}</div>
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
        id, rfid_uid, direction, status, timestamp, remarks,
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

  if (!name) name = isPending ? 'Registered User (Duplicate Scan)' : (ok ? 'Authorized User' : 'Unknown Card');
  if (!plate) plate = '—';
  if (!role) role = '--';
  const vtype   = txn.vehicles?.vehicle_type || '';
  const vmodel  = txn.vehicles?.vehicle_model|| '';
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

    <div class="scan-name">${htmlEsc(name)}</div>

    <div class="scan-details">
      ${ok || isPending ? `
        <div class="scan-detail-row"><strong>${htmlEsc(role)}</strong> · ${htmlEsc(program)} ${htmlEsc(section)}</div>
        <div class="scan-plate">${htmlEsc(plate)}</div>
        ${vtype ? `<div class="scan-detail-row">${htmlEsc(vtype)} ${htmlEsc(vmodel)}</div>` : ''}
        ${isPending ? `<div class="scan-detail-row" style="color:#d97706; font-size:12px; font-weight:600;">⚠️ ${htmlEsc(txn.remarks || 'Already logged inside campus')}</div>` : ''}
      ` : `
        <div class="scan-detail-row" style="color: var(--denied)">Not registered or unauthorized</div>
        <div class="scan-detail-row" style="font-family: 'JetBrains Mono', monospace; font-size:12px; color:var(--muted);">${htmlEsc(txn.rfid_uid)}</div>
      `}
    </div>

    <div class="scan-verdict ${ok ? 'ok' : (isPending ? 'warn' : 'deny')}">
      ${ok
        ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> ENTRY GRANTED'
        : (isPending
          ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg> ALREADY ENTERED (AWAITING GUARD)'
          : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg> ACCESS DENIED')
      }
    </div>

    <div class="scan-time">${timeStr}</div>
  `;

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
  const { data: card } = await supabaseClient
    .from('rfid_cards')
    .select(`
      id, rfid_uid, authorization_status, vehicle_id, user_id,
      vehicles ( plate_number, vehicle_type, vehicle_model ),
      users    ( full_name, role, program, section )
    `)
    .eq('rfid_uid', uid)
    .maybeSingle();

  const status  = card?.authorization_status === 'AUTHORIZED' ? 'AUTHORIZED' : 'DENIED';
  const remarks = card ? (status === 'AUTHORIZED' ? 'Manual entry – guard station' : 'Manual entry – not authorized') : 'Manual entry – unregistered';

  // Insert transaction
  const { data: txn, error } = await supabaseClient
    .from('transactions')
    .insert({
      rfid_uid:   uid,
      direction:  GATE_DIRECTION,
      gate:       'CHARRMPASS_GATE_ENTRY',
      vehicle_id: card?.vehicle_id || null,
      user_id:    card?.user_id    || null,
      status,
      remarks
    })
    .select(`
      id, rfid_uid, direction, status, timestamp, remarks,
      users   ( full_name, role, program, section ),
      vehicles( plate_number, vehicle_type, vehicle_model )
    `)
    .single();

  if (error) { showToast('DB error: ' + error.message, 'error'); return; }

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
