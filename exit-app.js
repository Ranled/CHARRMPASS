/* ============================================================
 * CHARRMPASS — Exit Gate App Logic (exit-app.js)
 * Direction filter: EXIT
 * Key extra feature: checks if vehicle has a prior ENTRY record
 * ============================================================ */

'use strict';

const GATE_DIRECTION = 'EXIT';

// ─── STATE ───────────────────────────────────────────────────
let guardName       = 'Guard';
let recentExits     = [];
let currentScanData = null;
let scanTimeout     = null;
let insideCount     = 0;

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
  const ind = document.getElementById('connIndicator');
  const txt = document.getElementById('connText');
  if (isConnected) { ind.className = 'hdr-online'; txt.textContent = 'ONLINE'; }
  else             { ind.className = 'hdr-online offline'; txt.textContent = 'OFFLINE'; }
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
    if (isConnected) {
      const { data } = await supabaseClient
        .from('system_accounts').select('*')
        .eq('username', user).eq('password', pass).maybeSingle();
      account = data;
    } else {
      if (user === 'guard' && pass === 'guard123') account = { username: 'guard' };
      if (user === 'admin' && pass === 'admin123') account = { username: 'admin' };
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
    await loadRecentExits();
    await refreshInsideCount();
    setupRealtime();

  } catch (e) {
    errEl.textContent = 'Connection error.';
    btn.textContent = 'SIGN IN'; btn.disabled = false;
  }
}

function doLogout() {
  if (!confirm('Sign out?')) return;
  document.getElementById('loginScreen').style.display = 'flex';
  document.getElementById('dashboard').classList.add('hidden');
  resetScanPanel();
}

// ─── LOAD RECENT EXITS ───────────────────────────────────────
async function loadRecentExits() {
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

  if (error) { console.error('Load exits error:', error); return; }
  recentExits = data || [];
  renderRecentList();
}

// ─── CURRENTLY INSIDE COUNT ────────────────────────────────────
// inside = total ENTRY transactions - total EXIT transactions
async function refreshInsideCount() {
  if (!isConnected) return;

  const { count: entries } = await supabaseClient
    .from('transactions').select('id', { count: 'exact', head: true })
    .eq('direction', 'ENTRY').eq('status', 'AUTHORIZED');

  const { count: exits } = await supabaseClient
    .from('transactions').select('id', { count: 'exact', head: true })
    .eq('direction', 'EXIT').eq('status', 'AUTHORIZED');

  insideCount = Math.max(0, (entries || 0) - (exits || 0));
  const el = document.getElementById('insideCount');
  if (el) el.textContent = insideCount;
}

// ─── CHECK PRIOR ENTRY for a UID ─────────────────────────────
// Returns: 'valid' (has open entry), 'ghost' (already exited), 'none' (never entered)
async function checkPriorEntry(uid) {
  if (!isConnected) return 'unknown';

  // Get the most recent transaction for this UID
  const { data } = await supabaseClient
    .from('transactions')
    .select('direction, status, timestamp')
    .eq('rfid_uid', uid)
    .eq('status', 'AUTHORIZED')
    .order('timestamp', { ascending: false })
    .limit(1);

  if (!data || data.length === 0) return 'none';       // Never entered
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
      }
    }

    if (!name) name = ok ? 'Authorized Driver' : 'Unregistered RFID';
    if (!plate) plate = t.rfid_uid?.substring(0, 12) || '--';
    const timeStr = new Date(t.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    const dotClass = ok ? 'ok' : 'deny';
    return `
      <div class="scan-row">
        <div class="scan-row-dot ${dotClass}"></div>
        <div class="scan-row-info">
          <div class="scan-row-name">${htmlEsc(name)}</div>
          <div class="scan-row-plate">${htmlEsc(plate)}</div>
        </div>
        <div class="scan-row-time">${timeStr}</div>
        <div style="font-size:14px;flex-shrink:0;${ok ? 'color:#3b82f6' : 'color:#ef4444'}">${ok ? '◄' : '✕'}</div>
      </div>`;
  }).join('');
}

// ─── REALTIME ─────────────────────────────────────────────────
function setupRealtime() {
  if (!isConnected) return;

  // Watch EXIT transactions for live feed
  supabaseClient.channel('exit-txn-live')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'transactions' }, async payload => {
      const row = payload.new;
      if (row.direction !== GATE_DIRECTION) {
        // An ENTRY happened — update inside count
        await refreshInsideCount();
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

  // Check prior entry if not already known
  const entryStatus = priorEntryStatus || await checkPriorEntry(full.rfid_uid);

  recentExits.unshift(full);
  renderRecentList();
  showScanResult(full, entryStatus);
}

// ─── SHOW SCAN RESULT ─────────────────────────────────────────
function showScanResult(txn, entryStatus) {
  currentScanData = txn;
  const ok      = txn.status === 'AUTHORIZED';
  const hasWarn = ok && (entryStatus === 'ghost' || entryStatus === 'none');
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
  }

  if (!name) name = 'Unknown Card';
  if (!plate) plate = '—';
  if (!role) role = '--';
  const vtype   = txn.vehicles?.vehicle_type  || '';
  const vmodel  = txn.vehicles?.vehicle_model || '';
  const timeStr = new Date(txn.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

  // Avatar color: blue=ok+valid, warning=ok+no_entry, red=denied
  const avatarColor = !ok ? 'b91c1c' : hasWarn ? 'b45309' : '1d4ed8';
  const avatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=${avatarColor}&color=fff&size=200&bold=true`;

  const panel  = document.getElementById('scanPanel');
  const ready  = document.getElementById('readyState');
  const result = document.getElementById('scanResult');

  ready.style.display = 'none';
  result.classList.remove('hidden');

  let panelClass, resultClass, badgeClass, avatarClass, verdictClass, verdictHTML, warningHTML = '';

  if (!ok) {
    panelClass = 'scan-panel denied'; resultClass = 'scan-result denied';
    badgeClass = 'deny'; avatarClass = 'denied'; verdictClass = 'deny';
    verdictHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg> ACCESS DENIED';
  } else if (hasWarn) {
    panelClass = 'scan-panel warning-mode'; resultClass = 'scan-result warning-mode';
    badgeClass = 'warning'; avatarClass = 'warning'; verdictClass = 'warning';
    verdictHTML = '⚠ VERIFY REQUIRED';
    const warnMsg = entryStatus === 'none'
      ? 'No active entry record found for this vehicle. They may have entered before the system was active, or this may be an unauthorized exit attempt.'
      : 'This vehicle has already recorded an exit. Possible double-exit or system anomaly.';
    warningHTML = `
      <div class="no-entry-warning">
        <div class="no-entry-warning-icon">⚠</div>
        <div class="no-entry-warning-text">
          <div class="no-entry-warning-title">${entryStatus === 'none' ? 'No Entry Record Found' : 'Already Exited'}</div>
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
  lucide.createIcons();
}

// ─── MANUAL PROCESSING ───────────────────────────────────────
async function processManual() {
  const input = document.getElementById('manualUID');
  const uid   = input.value.trim().toUpperCase();
  if (!uid) { showToast('Enter an RFID UID first.', 'error'); return; }
  input.value = '';
  showToast('Processing UID: ' + uid, 'info');

  if (!isConnected) { showToast('No database connection.', 'error'); return; }

  let card = null;
  const { data: c } = await supabaseClient
    .from('rfid_cards')
    .select(`id, rfid_uid, authorization_status, vehicle_id, user_id,
             vehicles ( plate_number, vehicle_type, vehicle_model ),
             users    ( full_name, role, program, section )`)
    .eq('rfid_uid', uid).maybeSingle();
  card = c;

  let isVisitor = false;
  let visitorName = 'Visitor';
  let visitorPlate = 'VISITOR PASS';

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
      }
    }
  }

  const status  = (card?.authorization_status === 'AUTHORIZED' || isVisitor) ? 'AUTHORIZED' : 'DENIED';
  let remarks = card ? (status === 'AUTHORIZED' ? 'Manual exit – guard station' : 'Manual exit – not authorized') : 'Manual exit – unregistered';
  if (isVisitor) {
    remarks = `Visitor Exit: ${visitorName} | Plate: ${visitorPlate}`;
  }

  // Check prior entry BEFORE inserting
  const entryStatus = status === 'AUTHORIZED' ? await checkPriorEntry(uid) : 'n/a';

  const { data: txn, error } = await supabaseClient
    .from('transactions')
    .insert({
      rfid_uid:   uid, direction: GATE_DIRECTION, gate: 'CHARRMPASS_GATE_EXIT',
      vehicle_id: card?.vehicle_id || null, user_id: card?.user_id || null,
      status, remarks
    })
    .select(`id, rfid_uid, direction, status, timestamp, remarks,
             users(full_name,role,program,section), vehicles(plate_number,vehicle_type,vehicle_model)`)
    .single();

  if (error) { showToast('DB error: ' + error.message, 'error'); return; }

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

function denyLast() {
  if (!currentScanData) { showToast('No active scan to deny.', 'error'); return; }
  const fakeRow = {
    id: 'manual-deny', rfid_uid: currentScanData.rfid_uid,
    direction: GATE_DIRECTION, status: 'DENIED',
    timestamp: new Date().toISOString(), remarks: 'Denied by guard',
    users: null, vehicles: null
  };
  showScanResult(fakeRow, 'n/a');
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
