/* ============================================================
 * CHARRMPASS — Exit Gate App Logic (exit-app.js)
 * Direction filter: EXIT
 * Key extra feature: checks if vehicle has a prior ENTRY record
 * ============================================================ */

'use strict';

const GATE_DIRECTION = 'EXIT';

// ─── STATE ───────────────────────────────────────────────────
let guardName           = 'Guard';
let recentExits         = [];
let currentScanData     = null;
let scanTimeout         = null;
let insideCount         = 0;
let exitRealtimeChannel = null;
const localInsertedTxnIds = new Set();

function computeOfflineAuthDigest(u, p) {
  const str = 'charrmpass:' + String(u || '').toLowerCase() + ':' + String(p || '');
  let h1 = 0xdeadbeef ^ str.length, h2 = 0x41c6ce57 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

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

function updateConnBadge() {
  updateDBBadge();
  const ind = document.getElementById('connIndicator');
  const txt = document.getElementById('connText');
  if (ind && txt) {
    if (isConnected) { ind.className = 'hdr-online'; txt.textContent = 'ONLINE'; }
    else             { ind.className = 'hdr-online offline'; txt.textContent = 'OFFLINE'; }
  }
}

// ─── LOGIN ─────────────────────────────────────────────────────
async function doLogin() {
  const user  = document.getElementById('loginUser').value.trim();
  const pass  = document.getElementById('loginPass').value;
  const errEl = document.getElementById('loginError');
  errEl.textContent = '';

  if (!user || !pass) { errEl.textContent = 'Please enter credentials.'; return; }

  const btn = document.getElementById('btnLogin');
  btn.textContent = 'Signing in…'; btn.disabled = true;

  try {
    let account = null;
    let isOfflineAuth = false;
    const client = typeof supabaseClient !== 'undefined' ? supabaseClient : null;
    if (client && isConnected) {
      try {
        const { account: verified, error } = typeof verifySystemAccount === 'function'
          ? await verifySystemAccount(user, pass, client)
          : await client.from('system_accounts').select('id, username, role').eq('username', user).eq('password', pass).maybeSingle().then(r => ({ account: r.data, error: r.error }));
        if (!error && verified) {
          account = verified;
          try {
            const cached = JSON.parse(localStorage.getItem('charrmpass_cached_accounts') || '{}');
            cached[user] = {
              username: verified.username,
              digest: computeOfflineAuthDigest(verified.username, pass),
              role: verified.role,
              id: verified.id
            };
            localStorage.setItem('charrmpass_cached_accounts', JSON.stringify(cached));
          } catch (_) {}
        }
      } catch (dbErr) {
        console.warn('Online auth check failed, checking offline credentials:', dbErr);
      }
    }

    // Offline / fallback authentication (only when offline / unreachable)
    if (!account && !isConnected) {
      try {
        const cached = JSON.parse(localStorage.getItem('charrmpass_cached_accounts') || '{}');
        const entry = cached[user];
        if (entry && (entry.digest === computeOfflineAuthDigest(user, pass) || entry.password === pass)) {
          account = entry;
          isOfflineAuth = true;
        }
      } catch (_) {}

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
    await loadRecentExits();
    await refreshInsideCount();
    setupRealtime();

  } catch (e) {
    errEl.textContent = 'Login error. Try again.';
  } finally {
    btn.textContent = 'SIGN IN';
    btn.disabled = false;
  }
}

function doLogout() {
  if (!confirm('Sign out?')) return;
  try { sessionStorage.removeItem('charrmpass_session'); } catch (_) {}
  if (exitRealtimeChannel && typeof supabaseClient !== 'undefined' && supabaseClient) {
    try { supabaseClient.removeChannel(exitRealtimeChannel); } catch (_) {}
    exitRealtimeChannel = null;
  }
  const passEl = document.getElementById('loginPass');
  if (passEl) passEl.value = '';
  const btn = document.getElementById('btnLogin');
  if (btn) { btn.textContent = 'SIGN IN'; btn.disabled = false; }
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
  if (typeof getManilaDayBoundsIso === 'function' && typeof getManilaDateKey === 'function') {
    return getManilaDayBoundsIso(getManilaDateKey()).start;
  }
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  return startOfDay.toISOString();
}

// ─── LOAD RECENT EXITS ───────────────────────────────────────
async function loadRecentExits() {
  if (!isConnected) return;
  const todayStart = getLocalStartOfDayIso();
  const { data, error } = await supabaseClient
    .from('transactions')
    .select(`
      id, rfid_uid, direction, status, timestamp, remarks, gate,
      users   ( full_name, role, program, section ),
      vehicles( plate_number )
    `)
    .eq('direction', GATE_DIRECTION)
    .gte('timestamp', todayStart)
    .order('timestamp', { ascending: false })
    .limit(30);

  if (error) { console.error('Load exits error:', error); return; }
  recentExits = (data || []).filter(r => r.gate !== 'AUTO_RESOLVED_EXIT' && !String(r.remarks || '').includes('[AUTO_RESOLVED_EXIT]'));
  renderRecentList();
}

// ─── CURRENTLY INSIDE COUNT ────────────────────────────────────
// Uses database view/function get_active_inside_entities with fallback to today's net balance
async function refreshInsideCount() {
  if (!isConnected) return;

  try {
    const { data, error } = await supabaseClient.rpc('get_active_inside_entities');
    if (!error && Array.isArray(data)) {
      insideCount = data.length;
      const el = document.getElementById('insideCount');
      if (el) el.textContent = insideCount;
      return;
    }
  } catch (e) {
    console.warn('RPC get_active_inside_entities error, falling back:', e);
  }

  // Fallback: today's local entries minus exits
  try {
    const todayIso = getLocalStartOfDayIso();
    const { count: entries } = await supabaseClient
      .from('transactions').select('id', { count: 'exact', head: true })
      .eq('direction', 'ENTRY').eq('status', 'AUTHORIZED')
      .gte('timestamp', todayIso);

    const { count: exits } = await supabaseClient
      .from('transactions').select('id', { count: 'exact', head: true })
      .eq('direction', 'EXIT').eq('status', 'AUTHORIZED')
      .gte('timestamp', todayIso);

    insideCount = Math.max(0, (entries || 0) - (exits || 0));
    const el = document.getElementById('insideCount');
    if (el) el.textContent = insideCount;
  } catch (err) {
    console.warn('Fallback inside count error:', err);
  }
}

// ─── CHECK PRIOR ENTRY for a UID ─────────────────────────────
// Returns: 'valid' (has open entry), 'ghost' (already exited), 'none' (never entered)
// Excludes current transaction ID to avoid false double-exit warnings on newly inserted rows
async function checkPriorEntry(uid, excludeTxnId, beforeTimestamp) {
  if (!isConnected) return 'unknown';

  let query = supabaseClient
    .from('transactions')
    .select('id, direction, status, timestamp')
    .eq('rfid_uid', uid)
    .eq('status', 'AUTHORIZED');

  if (excludeTxnId && !String(excludeTxnId).startsWith('manual-')) {
    query = query.neq('id', excludeTxnId);
  }
  if (beforeTimestamp) {
    query = query.lte('timestamp', beforeTimestamp);
  }

  const { data, error } = await query
    .order('timestamp', { ascending: false })
    .limit(1);

  if (error || !data || data.length === 0) return 'none';       // Never entered
  if (data[0].direction === 'ENTRY')  return 'valid';  // Entered and not yet exited
  if (data[0].direction === 'EXIT')   return 'ghost';  // Already exited (double exit)
  return 'unknown';
}

// ─── RENDER RECENT LIST ───────────────────────────────────────
function renderRecentList() {
  const body = document.getElementById('recentBody');
  if (!recentExits.length) {
    body.innerHTML = '<div class="scan-empty">No exits yet today</div>';
    return;
  }
  body.innerHTML = recentExits.slice(0, 20).map(t => {
    const ok    = t.status === 'AUTHORIZED';
    let name  = t.users?.full_name;
    let plate = t.vehicles?.plate_number;

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
      } else if (/UHF Vehicle (?:Entry|Exit):/i.test(t.remarks)) {
        const match = t.remarks.match(/UHF Vehicle (?:Entry|Exit):\s*([^|]+?)(?:\s*\|\s*Driver:\s*(.+))?$/i);
        if (match) {
          if (!plate && match[1]?.trim()) plate = match[1].trim();
          if (match[2]?.trim()) name = match[2].trim();
        }
      }
    }

    if (!name) name = ok ? 'Authorized Driver' : (t.status === 'PENDING_CONFIRMATION' ? 'Exit Conflict (Verify)' : 'Unregistered RFID');
    if (!plate) plate = t.rfid_uid?.substring(0, 12) || '--';
    const timeStr = new Date(t.timestamp).toLocaleTimeString('en-US', { timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit', hour12: false });
    const isPending = t.status === 'PENDING_CONFIRMATION';
    const dotClass = ok ? 'ok' : (isPending ? 'pending' : 'deny');
    const badgeColor = ok ? 'color:#3b82f6' : (isPending ? 'color:#d97706' : 'color:#ef4444');
    const badgeIcon = ok ? '◄' : (isPending ? '⚠' : '✕');
    return `
      <div class="scan-row">
        <div class="scan-row-dot ${dotClass}"></div>
        <div class="scan-row-info">
          <div class="scan-row-name">${htmlEsc(name)}</div>
          <div class="scan-row-plate">${htmlEsc(plate)}</div>
        </div>
        <div class="scan-row-time">${timeStr}</div>
        <div style="font-size:14px;flex-shrink:0;${badgeColor}">${badgeIcon}</div>
      </div>`;
  }).join('');
}

// ─── REALTIME ─────────────────────────────────────────────────
function setupRealtime() {
  if (!isConnected || !supabaseClient) return;
  if (exitRealtimeChannel) {
    try { supabaseClient.removeChannel(exitRealtimeChannel); } catch (_) {}
    exitRealtimeChannel = null;
  }

  // Watch EXIT transactions for live feed
  exitRealtimeChannel = supabaseClient.channel('exit-txn-live')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'transactions' }, async payload => {
      const row = payload.new;
      if (row.direction !== GATE_DIRECTION || row.gate === 'AUTO_RESOLVED_EXIT' || String(row.remarks || '').includes('[AUTO_RESOLVED_EXIT]')) {
        // An ENTRY or synthetic self-healing exit happened — refresh inside count only
        await refreshInsideCount();
        return;
      }
      if (row.id && localInsertedTxnIds.has(row.id)) {
        localInsertedTxnIds.delete(row.id);
        return;
      }
      console.log('[RT] New EXIT transaction:', row);
      await refreshInsideCount();
      handleNewTransaction(row);
    })
    .subscribe(s => console.log('[RT] Exit subscription:', s));
}

// ─── HANDLE NEW TRANSACTION ───────────────────────────────────
async function handleNewTransaction(txn, priorEntryStatus) {
  // Fetch full joined data
  let full = txn;
  if (isConnected && txn.id) {
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

  // Check prior entry if not already known, excluding current transaction
  const entryStatus = priorEntryStatus || await checkPriorEntry(full.rfid_uid, full.id, full.timestamp);

  // Deduplicate if already present in recentExits
  const existingIdx = recentExits.findIndex(e => e.id && full.id && e.id === full.id);
  if (existingIdx !== -1) {
    recentExits[existingIdx] = full;
  } else {
    recentExits.unshift(full);
  }
  renderRecentList();
  showScanResult(full, entryStatus);
}

// ─── SHOW SCAN RESULT ─────────────────────────────────────────
function showScanResult(txn, entryStatus) {
  currentScanData = txn;
  const ok        = txn.status === 'AUTHORIZED';
  const isPending = false;
  const hasWarn   = false; // Hands-free operation governed by 30s anti-passback
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
      section = 'Visitor Exit';
    }
  } else if (!name && (txn.remarks?.includes('Emergency') || txn.remarks?.includes('EMERGENCY') || txn.remarks?.includes('Emergency tag'))) {
    name = 'Emergency Response';
    plate = 'EMERGENCY';
    role = 'EMERGENCY';
    program = 'Emergency Response';
    section = 'Priority Pass';
  } else if (!name && /UHF Vehicle (?:Entry|Exit):/i.test(txn.remarks || '')) {
    const match = txn.remarks.match(/UHF Vehicle (?:Entry|Exit):\s*([^|]+?)(?:\s*\|\s*Driver:\s*(.+))?$/i);
    if (match) {
      if (!plate && match[1]?.trim()) plate = match[1].trim();
      if (match[2]?.trim()) name = match[2].trim();
      role = role || 'DRIVER';
      program = 'UHF Long-Range Pass';
      section = 'Vehicle Exit';
    }
  }

  if (!name) name = 'Unknown Card';
  if (!plate) plate = '—';
  if (!role) role = '--';
  const vtype   = txn.vehicles?.vehicle_type  || '';
  const vmodel  = txn.vehicles?.vehicle_model || '';
  const timeStr = new Date(txn.timestamp).toLocaleTimeString('en-US', { timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  if (typeof playGateAudio === 'function') {
    playGateAudio(ok ? 'AUTHORIZED' : 'DENIED');
  }

  // Avatar color: blue=ok+valid, warning=ok+no_entry, red=denied
  const avatarColor = !ok ? 'b91c1c' : hasWarn ? 'b45309' : '1d4ed8';
  const avatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=${avatarColor}&color=fff&size=200&bold=true`;

  const panel  = document.getElementById('scanPanel');
  const ready  = document.getElementById('readyState');
  const result = document.getElementById('scanResult');

  ready.style.display = 'none';
  result.classList.remove('hidden');

  // Update Traffic Light: Done (Green), Warning/Scanning (Yellow), or Denied (Red)
  setTrafficLightUI(ok ? (hasWarn ? 'scanning' : 'done') : 'denied');

  let panelClass, resultClass, badgeClass, avatarClass, verdictClass, verdictHTML, warningHTML = '';

  if (!ok) {
    panelClass = 'scan-panel denied'; resultClass = 'scan-result denied';
    badgeClass = 'deny'; avatarClass = 'denied'; verdictClass = 'deny';
    verdictHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg> ACCESS DENIED';
  } else if (hasWarn) {
    panelClass = 'scan-panel warning-mode'; resultClass = 'scan-result warning-mode';
    badgeClass = 'warning'; avatarClass = 'warning'; verdictClass = 'warning';
    verdictHTML = '⚠ VERIFY REQUIRED';
    const warnMsg = txn.remarks || (entryStatus === 'none'
      ? 'No active entry record found for this vehicle. They may have entered before the system was active, or this may be an unauthorized exit attempt.'
      : 'This vehicle has already recorded an exit. Possible double-exit or system anomaly.');
    const warnTitle = entryStatus === 'none' ? 'No Entry Record Found' : (isPending ? 'Verification Required' : 'Already Exited');
    warningHTML = `
      <div class="no-entry-warning">
        <div class="no-entry-warning-icon">⚠</div>
        <div class="no-entry-warning-text">
          <div class="no-entry-warning-title">${htmlEsc(warnTitle)}</div>
          ${htmlEsc(warnMsg)}
        </div>
      </div>
      <div class="action-btns">
        <button class="btn-manual-verify" onclick="manualVerify()">MANUAL VERIFY</button>
        <button class="btn-allow-exit" onclick="allowExitOverride()">ALLOW EXIT</button>
      </div>`;
  } else {
    panelClass = 'scan-panel authorized'; resultClass = 'scan-result authorized';
    badgeClass = 'ok'; avatarClass = ''; verdictClass = 'ok';
    verdictHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> EXIT AUTHORIZED';
  }

  panel.className  = panelClass;
  result.className = resultClass;

  result.innerHTML = `
    <div class="scan-profile-wrap">
      <img class="scan-avatar ${avatarClass}" src="${avatar}" alt="${htmlEsc(name)}" />
      <div class="scan-status-badge ${badgeClass}">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
          ${badgeClass === 'ok'
            ? '<polyline points="20 6 9 17 4 12"/>'
            : badgeClass === 'warning'
              ? '<line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>'
              : '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'}
        </svg>
      </div>
    </div>

    <div class="scan-name">${htmlEsc(name)}</div>

    <div class="scan-details">
      ${ok ? `
        <div class="scan-detail-row"><strong>${htmlEsc(role)}</strong> · ${htmlEsc(program)} ${htmlEsc(section)}</div>
        <div class="scan-plate">${htmlEsc(plate)}</div>
        ${vtype ? `<div class="scan-detail-row">${htmlEsc(vtype)} ${htmlEsc(vmodel)}</div>` : ''}
      ` : `
        <div class="scan-detail-row" style="color: var(--denied)">Not registered or unauthorized</div>
        <div class="scan-detail-row" style="font-family: 'JetBrains Mono', monospace; font-size:12px; color:var(--muted);">${htmlEsc(txn.rfid_uid)}</div>
      `}
    </div>

    <div class="scan-verdict ${verdictClass}">${verdictHTML}</div>

    ${warningHTML}

    <div class="scan-time">${timeStr}</div>
  `;

  clearTimeout(scanTimeout);
  scanTimeout = setTimeout(resetScanPanel, hasWarn ? 20000 : 10000); // longer for warnings
}

// ─── RESET ───────────────────────────────────────────────────
function resetScanPanel() {
  const panel  = document.getElementById('scanPanel');
  const ready  = document.getElementById('readyState');
  const result = document.getElementById('scanResult');
  panel.className = 'scan-panel';
  result.classList.add('hidden');
  result.innerHTML = '';
  ready.style.display = 'flex';
  currentScanData = null;
  // Return traffic light to RED STANDBY
  setTrafficLightUI('standby');
  lucide.createIcons();
}

// ─── MANUAL PROCESSING ───────────────────────────────────────
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

  let card = null;
  const { data: c } = await supabaseClient
    .from('rfid_cards')
    .select(`id, rfid_uid, authorization_status, vehicle_id, user_id, user_type, rfid_type,
             vehicles ( plate_number, vehicle_type, vehicle_model ),
             users    ( full_name, role, program, section )`)
    .eq('rfid_uid', uid).maybeSingle();
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
  let remarks = card ? (status === 'AUTHORIZED' ? 'Manual exit – guard station' : 'Manual exit – not authorized') : 'Manual exit – unregistered';
  if (isVisitor) {
    remarks = `Visitor Exit: ${visitorName} | Plate: ${visitorPlate}`;
  } else if (isEmergency) {
    remarks = `Emergency Response: ${emergencyLabel}`;
  }

  const isVehicleCard = (card?.vehicles?.plate_number && card.vehicles.plate_number !== 'PEDESTRIAN' && card.vehicles.plate_number !== 'NONE' && card.vehicles.plate_number !== 'N/A') ||
                        (card?.vehicles?.vehicle_type && card.vehicles.vehicle_type !== 'None' && card.vehicles.vehicle_type !== 'Walking / Pedestrian') ||
                        (card?.user_type === 'VEHICLE') ||
                        (isVisitor && visitorPlate && visitorPlate !== 'N/A' && visitorPlate !== 'VISITOR PASS');
  const user_type = isVehicleCard ? 'VEHICLE' : 'PEDESTRIAN';
  const rfid_type = isVehicleCard ? 'LONG_RANGE' : 'CLOSE_RANGE';
  const gateName  = isVehicleCard ? 'EXIT_GATE' : 'CHARRMPASS_GATE_EXIT';

  // Check prior entry BEFORE inserting
  const entryStatus = status === 'AUTHORIZED' ? await checkPriorEntry(uid) : 'n/a';

  const { data: txn, error } = await supabaseClient
    .from('transactions')
    .insert({
      rfid_uid:   uid,
      direction:  GATE_DIRECTION,
      gate:       gateName,
      user_type:  user_type,
      rfid_type:  rfid_type,
      vehicle_id: card?.vehicle_id || null,
      user_id:    card?.user_id || null,
      status,
      remarks: card ? `${remarks} (${isVehicleCard ? 'Vehicle' : 'Pedestrian'})` : remarks
    })
    .select(`id, rfid_uid, direction, status, timestamp, remarks, user_type, rfid_type,
             users(full_name,role,program,section), vehicles(plate_number,vehicle_type,vehicle_model)`)
    .single();

  if (error) {
    showToast('DB error: ' + error.message, 'error');
    setTrafficLightUI('standby');
    return;
  }

  if (txn?.id) localInsertedTxnIds.add(txn.id);

  if (isVisitor) {
    await supabaseClient.from('special_tags').update({
      label: 'Reusable Visitor Tag',
      description: null
    }).eq('rfid_uid', uid);
    showToast(`Visitor "${visitorName}" exit logged. Tag is now vacant for reuse.`, 'success');
  }

  await refreshInsideCount();
  handleNewTransaction(txn, entryStatus);
  showToast(status === 'AUTHORIZED' ? 'Exit logged.' : 'Access denied.', status === 'AUTHORIZED' ? 'success' : 'error');
}

// ─── GUARD ACTIONS ────────────────────────────────────────────
function manualVerify() {
  showToast('Please manually verify identity with student ID.', 'warning');
}

function allowExitOverride() {
  showToast('Override: Exit manually allowed by guard.', 'success');
  resetScanPanel();
}

async function denyLast() {
  if (!currentScanData) { showToast('No active scan to deny.', 'error'); return; }
  const targetTxn = currentScanData;
  if (isConnected && supabaseClient && targetTxn.id && !String(targetTxn.id).startsWith('manual-')) {
    const { error } = await supabaseClient
      .from('transactions')
      .update({ status: 'DENIED', remarks: 'Denied by guard override' })
      .eq('id', targetTxn.id);
    if (error) console.warn('Override update warning:', error);
    const idx = recentExits.findIndex(e => e.id === targetTxn.id);
    if (idx !== -1) {
      recentExits[idx] = { ...recentExits[idx], status: 'DENIED', remarks: 'Denied by guard override' };
      renderRecentList();
    }
    await refreshInsideCount();
  }
  const deniedRow = {
    ...targetTxn,
    id: targetTxn.id || 'manual-deny',
    rfid_uid: targetTxn.rfid_uid,
    direction: GATE_DIRECTION,
    status: 'DENIED',
    timestamp: targetTxn.timestamp || new Date().toISOString(),
    remarks: 'Denied by guard override'
  };
  showScanResult(deniedRow, 'n/a');
  showToast('Exit denied by guard.', 'error');
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
  setTimeout(() => t.classList.remove('show'), 3500);
}

window.doLogin        = doLogin;
window.doLogout       = doLogout;
window.manualVerify   = manualVerify;
window.allowExitOverride = allowExitOverride;
