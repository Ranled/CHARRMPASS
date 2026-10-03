/**
 * CHARRMPASS - Guard Dashboard Logic
 * Live scan processing, manual RFID entry, visitor pass, and live activity log
 */
if (typeof initSupabase === 'function') initSupabase();
if (typeof startClock === 'function') startClock();
if (typeof updateDBBadge === 'function') updateDBBadge();
if (window.lucide) lucide.createIcons();

// State
let appState = {
    totalVehicles: 0, entriesToday: 0, exitsToday: 0, vehiclesInside: 0,
    recentScans: [], users: [], specialTags: [], activeVehicles: []
};

// Demo users (fallback when Supabase is offline)
const mockUsers = {
    'B7 78 96 31': { uid:'B7 78 96 31', cpass_id:'2022-00123', name:'Juan Dela Cruz', role:'Student', program:'BSIT', section:'3A', type:'Car', model:'Honda Civic', plate:'XYZ-123', color:'Black', status:'AUTHORIZED' },
    'UID67890': { uid:'UID67890', cpass_id:'CP00', name:'Maria Santos', role:'Faculty', program:'Engineering', section:'--', type:'SUV', model:'Toyota Fortuner', plate:'ABC-789', color:'White', status:'AUTHORIZED' },
    'UID55555': { uid:'UID55555', cpass_id:'CP01', name:'Carlos Reyes', role:'Staff', program:'Admin', section:'--', type:'Motorcycle', model:'Yamaha NMAX', plate:'DEF-456', color:'Silver', status:'AUTHORIZED' },
};



// =====================
// INIT STATE
// =====================
async function initState() {
    if (isConnected) {
        try {
            // Load users with vehicles and rfid_cards
            const { data: users, error: ue } = await supabaseClient
                .from('users')
                .select(`
                    *,
                    vehicles ( id, vehicle_type, vehicle_model, plate_number, vehicle_color, motorcycle_image ),
                    rfid_cards ( id, rfid_uid, authorization_status )
                `);
            if (ue) console.error('Users fetch error:', ue);
            if (users) {
                appState.users = users.map(u => ({
                    ...u,
                    vehicle_type:     u.vehicles?.[0]?.vehicle_type     || null,
                    vehicle_model:    u.vehicles?.[0]?.vehicle_model    || null,
                    plate_number:     u.vehicles?.[0]?.plate_number     || null,
                    vehicle_color:    u.vehicles?.[0]?.vehicle_color    || null,
                    motorcycle_image: u.vehicles?.[0]?.motorcycle_image || null,
                    rfid_uid:         u.rfid_cards?.[0]?.rfid_uid       || null,
                    rfid_card_id:     u.rfid_cards?.[0]?.id             || null,
                    authorization_status: u.rfid_cards?.[0]?.authorization_status || 'PENDING',
                }));
                appState.totalVehicles = users.length;
            }

            // Load special tags first
            const { data: st, error: ste } = await supabaseClient.from('special_tags').select('*');
            if (ste) console.error('Special tags fetch error:', ste);
            if (st) appState.specialTags = st;

            // Load recent access logs
            const today = new Date().toISOString().split('T')[0];
            const { data: logs, error: le } = await supabaseClient
                .from('transactions')
                .select(`
                    *,
                    users ( full_name, role, role_detail, program, section, profile_image, cpass_id, student_id ),
                    vehicles ( plate_number, vehicle_type, vehicle_model, vehicle_color )
                `)
                .order('timestamp', { ascending: false })
                .limit(500);
            if (le) console.error('Logs fetch error:', le);
            if (logs) {
                appState.recentScans = logs.map(l => {
                    const cleanUid = (l.rfid_uid || '').replace(/\s+/g, '').toUpperCase();
                    const special = appState.specialTags.find(s => 
                        s.rfid_uid === l.rfid_uid || 
                        (s.rfid_uid && s.rfid_uid.replace(/\s+/g, '').toUpperCase() === cleanUid)
                    );

                    let name = l.users?.full_name;
                    let plate = l.vehicles?.plate_number;
                    let role = l.users?.role === 'OTHERS' && l.users?.role_detail ? l.users.role_detail : l.users?.role;
                    let cpass_id = l.users?.cpass_id || l.users?.student_id || null;

                    // 1. Check remarks for Visitor or Emergency details
                    if (l.remarks) {
                        if (l.remarks.includes('Visitor')) {
                            const match = l.remarks.match(/Visitor (?:Exit|Entry):\s*([^|]+)(?:\s*\|\s*Plate:\s*([^|]+))?/i);
                            if (match) {
                                name = match[1]?.trim();
                                if (match[2]?.trim() && match[2].trim() !== 'N/A') plate = match[2].trim();
                            } else {
                                name = 'Visitor';
                            }
                            role = 'VISITOR';
                            cpass_id = 'VISITOR';
                        } else if (l.remarks.includes('Emergency') || l.remarks.includes('EMERGENCY')) {
                            const match = l.remarks.match(/Emergency (?:tag|Response):\s*(.+)/i);
                            name = match ? match[1].trim() : 'Emergency Response';
                            plate = 'EMERGENCY';
                            role = 'EMERGENCY';
                            cpass_id = 'EMERGENCY';
                        }
                    }

                    // 2. Fallback to special_tags
                    if (!name && special) {
                        if (special.type === 'EMERGENCY') {
                            name = special.label || 'Emergency Response';
                            plate = 'EMERGENCY';
                            role = 'EMERGENCY';
                            cpass_id = 'EMERGENCY';
                        } else if (special.type === 'VISITOR') {
                            name = (special.label && special.label !== 'Reusable Visitor Tag') ? special.label : 'Visitor';
                            plate = special.description?.match(/Plate:\s*([^|]+)/)?.[1]?.trim() || 'VISITOR PASS';
                            role = 'VISITOR';
                            cpass_id = 'VISITOR';
                        }
                    }

                    if (!name) name = l.status === 'DENIED' ? 'Unregistered Card' : 'Authorized User';
                    if (!plate) plate = l.rfid_uid ? l.rfid_uid.substring(0, 12) : '--';
                    if (!role) role = '--';

                    return {
                        uid:      l.rfid_uid,
                        cpass_id: cpass_id,
                        name:     name,
                        role:     role,
                        plate:    plate,
                        status:   l.status === 'DENIED' ? 'DENIED' : 'AUTHORIZED',
                        event:    l.direction || 'ENTRY',
                        duration: '--',
                        time:     new Date(l.timestamp).toLocaleTimeString('en-US',{hour12:false,hour:'2-digit',minute:'2-digit'}),
                        rawTimestamp: l.timestamp
                    };
                });

                // Active inside = ENTRY - EXIT (authorized)
                const entries = logs.filter(l => l.direction === 'ENTRY' && l.status === 'AUTHORIZED').length;
                const exits   = logs.filter(l => l.direction === 'EXIT'  && l.status === 'AUTHORIZED').length;
                appState.vehiclesInside = Math.max(0, entries - exits);

                const todayLogs = logs.filter(l => l.timestamp?.startsWith(today));
                appState.entriesToday = todayLogs.filter(l => l.direction === 'ENTRY').length;
                appState.exitsToday   = todayLogs.filter(l => l.direction === 'EXIT').length;
            }

            console.log('✅ Guard data loaded from Supabase:', appState.totalVehicles, 'vehicles,', appState.vehiclesInside, 'inside');
        } catch(e) { console.error('Init error:', e); }
    } else {
        appState.totalVehicles = 103;
        appState.entriesToday = 42; appState.exitsToday = 18; appState.vehiclesInside = 24;
        const mockArr = Object.values(mockUsers);
        for (let i = 0; i < 6; i++) {
            const u = mockArr[i % 3];
            appState.recentScans.push({ uid: u.uid, cpass_id: u.cpass_id, name: u.name, role: u.role, plate: u.plate, status: u.status, event: i%2===0?'ENTRY':'EXIT', duration: i%2===0?'INSIDE':'15m', time: new Date(Date.now()-i*900000).toLocaleTimeString('en-US',{hour12:false,hour:'2-digit',minute:'2-digit'}) });
        }
    }
    renderAll();
    loadGuardInfo();
}

function loadGuardInfo() {
    const saved = localStorage.getItem('charrmpass_guard');
    if (saved) {
        const info = JSON.parse(saved);
        if (info.name) {
            document.getElementById('guardName').textContent = info.name;
            document.getElementById('guardAvatar').src = `https://ui-avatars.com/api/?name=${encodeURIComponent(info.name)}&background=0E4B3A&color=fff`;
        }
        if (info.role) document.getElementById('guardRole').textContent = info.role;
    }
}

// =====================
// VIEW SWITCHING
// =====================
let currentActiveView = 'dual';

function switchView(view) {
    currentActiveView = view;
    document.querySelectorAll('.app-view').forEach(v => { v.classList.add('hidden'); v.classList.remove('flex'); });
    const target = document.getElementById('view-' + view);
    if (target) { target.classList.remove('hidden'); target.classList.add('flex'); }
    
    // Update sidebar
    document.querySelectorAll('.sidebar-item').forEach(s => s.classList.remove('active'));
    const nav = document.getElementById('nav-' + view);
    if (nav) nav.classList.add('active');

    // Update header quick tabs
    document.querySelectorAll('.guard-view-tab').forEach(b => {
        b.className = 'guard-view-tab px-3 py-1.5 rounded-xl text-xs font-bold transition-all text-slate-600 hover:text-slate-900 flex items-center gap-1.5';
    });
    const headerTab = document.getElementById('tabBtn-' + view);
    if (headerTab) {
        headerTab.className = 'guard-view-tab px-3 py-1.5 rounded-xl text-xs font-bold transition-all bg-charm-dark text-white shadow-sm flex items-center gap-1.5';
    }

    renderAll();
}
window.switchView = switchView;

// =====================
// LOGS FILTERING
// =====================
let currentLogFilter = 'ALL';
let guardLogsPreset = 'today';
let guardLogsCustomFrom = null;
let guardLogsCustomTo = null;

window.setGuardLogsPreset = function(preset) {
    guardLogsPreset = preset;
    document.querySelectorAll('.guard-log-tab').forEach(b => {
        b.classList.remove('active-range');
        b.classList.add('text-slate-600');
    });
    const btn = document.getElementById(`guardLogTab-${preset}`);
    if (btn) {
        btn.classList.add('active-range');
        btn.classList.remove('text-slate-600');
    }
    const panel = document.getElementById('guardLogsCustomPanel');
    if (panel) panel.classList.add('hidden');

    const label = document.getElementById('guardLogsActiveRangeLabel');
    if (label) {
        const labels = {
            today: 'Showing: Today',
            yesterday: 'Showing: Yesterday',
            '7days': 'Showing: Last 7 Days',
            '30days': 'Showing: Last 30 Days',
            thisMonth: 'Showing: This Month',
            lastMonth: 'Showing: Last Month'
        };
        label.textContent = labels[preset] || 'Showing: Filtered Logs';
    }
    renderLogsTable();
};

window.toggleGuardLogsCustomRange = function() {
    const panel = document.getElementById('guardLogsCustomPanel');
    if (!panel) return;
    const isHidden = panel.classList.contains('hidden');
    if (isHidden) {
        panel.classList.remove('hidden');
        const now = new Date();
        const past = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        if (document.getElementById('guardLogsFromDate') && !document.getElementById('guardLogsFromDate').value) {
            document.getElementById('guardLogsFromDate').value = past.toISOString().split('T')[0];
        }
        if (document.getElementById('guardLogsToDate') && !document.getElementById('guardLogsToDate').value) {
            document.getElementById('guardLogsToDate').value = now.toISOString().split('T')[0];
        }
    } else {
        panel.classList.add('hidden');
    }
};

window.applyGuardLogsCustomRange = function() {
    const fromVal = document.getElementById('guardLogsFromDate')?.value;
    const toVal = document.getElementById('guardLogsToDate')?.value;
    if (!fromVal || !toVal) {
        showToast('Please select both From and To dates', 'warning');
        return;
    }
    guardLogsPreset = 'custom';
    guardLogsCustomFrom = fromVal;
    guardLogsCustomTo = toVal;
    document.querySelectorAll('.guard-log-tab').forEach(b => {
        b.classList.remove('active-range');
        b.classList.add('text-slate-600');
    });
    document.getElementById('guardLogTab-custom')?.classList.add('active-range');
    document.getElementById('guardLogTab-custom')?.classList.remove('text-slate-600');

    if (document.getElementById('guardLogsActiveRangeLabel')) {
        document.getElementById('guardLogsActiveRangeLabel').textContent = `Showing: ${fromVal} to ${toVal}`;
    }
    renderLogsTable();
};

function getFilteredGuardLogs() {
    const scans = appState.recentScans || [];
    const now = new Date();

    if (guardLogsPreset === 'today') {
        const todayStr = now.toISOString().split('T')[0];
        return scans.filter(s => s.rawTimestamp && s.rawTimestamp.startsWith(todayStr));
    }
    if (guardLogsPreset === 'yesterday') {
        const y = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        const yStr = y.toISOString().split('T')[0];
        return scans.filter(s => s.rawTimestamp && s.rawTimestamp.startsWith(yStr));
    }
    if (guardLogsPreset === '7days') {
        const past7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        return scans.filter(s => s.rawTimestamp && new Date(s.rawTimestamp) >= past7);
    }
    if (guardLogsPreset === '30days') {
        const past30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        return scans.filter(s => s.rawTimestamp && new Date(s.rawTimestamp) >= past30);
    }
    if (guardLogsPreset === 'thisMonth') {
        const prefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        return scans.filter(s => s.rawTimestamp && s.rawTimestamp.startsWith(prefix));
    }
    if (guardLogsPreset === 'lastMonth') {
        const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const prefix = `${lastMonthDate.getFullYear()}-${String(lastMonthDate.getMonth() + 1).padStart(2, '0')}`;
        return scans.filter(s => s.rawTimestamp && s.rawTimestamp.startsWith(prefix));
    }
    if (guardLogsPreset === 'custom' && guardLogsCustomFrom && guardLogsCustomTo) {
        const fromDate = new Date(guardLogsCustomFrom + 'T00:00:00');
        const toDate = new Date(guardLogsCustomTo + 'T23:59:59');
        return scans.filter(s => {
            if (!s.rawTimestamp) return false;
            const t = new Date(s.rawTimestamp);
            return t >= fromDate && t <= toDate;
        });
    }
    return scans;
}

window.filterLogs = function(type) {
    currentLogFilter = type;
    const btnAll = document.getElementById('btnLogAll');
    const btnEntry = document.getElementById('btnLogEntry');
    const btnExit = document.getElementById('btnLogExit');

    [btnAll, btnEntry, btnExit].forEach(b => {
        if (!b) return;
        b.className = 'px-4 py-2 rounded-xl text-xs font-bold bg-white text-slate-600 border border-slate-200 hover:bg-slate-50 transition-colors';
    });

    if (type === 'ALL' && btnAll) btnAll.className = 'px-4 py-2 rounded-xl text-xs font-bold bg-charm-dark text-white shadow-sm';
    if (type === 'ENTRY' && btnEntry) btnEntry.className = 'px-4 py-2 rounded-xl text-xs font-bold bg-green-600 text-white shadow-sm';
    if (type === 'EXIT' && btnExit) btnExit.className = 'px-4 py-2 rounded-xl text-xs font-bold bg-blue-600 text-white shadow-sm';

    renderLogsTable();
};

function renderLogsTable() {
    const table = document.getElementById('logsTable');
    if (!table) return;

    let filtered = getFilteredGuardLogs();
    if (currentLogFilter === 'ENTRY') filtered = filtered.filter(s => s.event === 'ENTRY');
    if (currentLogFilter === 'EXIT') filtered = filtered.filter(s => s.event === 'EXIT');

    if (filtered.length > 0) {
        table.innerHTML = filtered.map(s => `
            <tr class="hover:bg-white/60 border-b border-slate-100/50 transition-colors">
                <td class="p-4 text-slate-500 font-medium">${s.time}</td>
                <td class="p-4 text-xs font-mono font-bold text-slate-600">${s.uid || '--'}</td>
                <td class="p-4 font-bold text-slate-800">
                    <div class="flex items-center gap-1.5 flex-wrap">
                        <span>${s.name || '--'}</span>
                        ${s.cpass_id ? `<span class="px-1.5 py-0.5 text-[10px] font-mono font-bold bg-emerald-50 text-emerald-800 border border-emerald-200 rounded">CPASS: ${s.cpass_id}</span>` : ''}
                    </div>
                </td>
                <td class="p-4 text-xs font-mono font-bold text-slate-700">${s.plate || '--'}</td>
                <td class="p-4 text-center">
                    <span class="px-2.5 py-1 rounded-full text-[10px] font-bold ${s.event === 'ENTRY' ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'}">${s.event || '--'}</span>
                </td>
                <td class="p-4 text-right">
                    <span class="px-2 py-0.5 rounded text-[10px] font-bold ${s.status === 'AUTHORIZED' ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'}">${s.status || '--'}</span>
                </td>
            </tr>
        `).join('');
    } else {
        table.innerHTML = `<tr><td colspan="6" class="p-8 text-center text-slate-400">No scan transactions found</td></tr>`;
    }
}

// =====================
// RENDER ALL
// =====================
function renderAll() {
    const inside = appState.vehiclesInside ?? (appState.activeVehicles?.length || 0);

    const el = (id) => document.getElementById(id);
    if(el('statTotal'))       el('statTotal').textContent       = appState.totalVehicles || appState.users.length;
    if(el('statEntries'))     el('statEntries').textContent     = appState.entriesToday;
    if(el('statExits'))       el('statExits').textContent       = appState.exitsToday;
    if(el('statAvailable'))   el('statAvailable').textContent   = inside + ' inside';

    // Dual view counters
    if(el('statDualEntries')) el('statDualEntries').textContent = appState.entriesToday;
    if(el('statDualExits'))   el('statDualExits').textContent   = appState.exitsToday;
    if(el('statDualInside'))  el('statDualInside').textContent  = inside;

    renderLogsTable();

    // Render Recent Entries List (Single & Dual Views)
    const entries = (appState.recentScans || []).filter(s => s.event === 'ENTRY').slice(0, 8);
    const entryHtml = entries.length > 0 
        ? entries.map(s => renderRecentScanCard(s, 'ENTRY')).join('')
        : `<div class="text-center text-slate-400 text-xs py-4"><i data-lucide="inbox" class="w-6 h-6 mx-auto mb-1 text-slate-300"></i>No entries yet</div>`;

    if (el('recentScansContainerEntry'))     el('recentScansContainerEntry').innerHTML = entryHtml;
    if (el('recentScansContainerDualEntry')) el('recentScansContainerDualEntry').innerHTML = entryHtml;

    // Render Recent Exits List (Single & Dual Views)
    const exits = (appState.recentScans || []).filter(s => s.event === 'EXIT').slice(0, 8);
    const exitHtml = exits.length > 0 
        ? exits.map(s => renderRecentScanCard(s, 'EXIT')).join('')
        : `<div class="text-center text-slate-400 text-xs py-4"><i data-lucide="inbox" class="w-6 h-6 mx-auto mb-1 text-slate-300"></i>No exits yet</div>`;

    if (el('recentScansContainerExit'))     el('recentScansContainerExit').innerHTML = exitHtml;
    if (el('recentScansContainerDualExit')) el('recentScansContainerDualExit').innerHTML = exitHtml;

    try { lucide.createIcons(); } catch(e){}
}

function renderRecentScanCard(s, type) {
    const isAuth = s.status === 'AUTHORIZED';
    const isEntry = type === 'ENTRY';
    const icon = isAuth ? (isEntry ? 'log-in' : 'log-out') : 'x';
    const badgeBg = isAuth ? (isEntry ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700') : 'bg-red-100 text-red-700';

    return `
        <div class="bg-white/80 p-2.5 sm:p-3 rounded-2xl border border-white shadow-sm flex items-center gap-2.5 sm:gap-3">
            <div class="w-8 h-8 sm:w-10 sm:h-10 rounded-xl flex items-center justify-center shrink-0 ${badgeBg}">
                <i data-lucide="${icon}" class="w-4 h-4 sm:w-5 sm:h-5"></i>
            </div>
            <div class="flex-1 overflow-hidden">
                <div class="flex justify-between items-center mb-0.5">
                    <span class="font-bold text-xs sm:text-sm text-slate-800 truncate">${s.name || '--'}</span>
                    <span class="text-[10px] font-bold text-slate-400 shrink-0">${s.time || '--'}</span>
                </div>
                <div class="flex items-center gap-1.5 sm:gap-2">
                    <span class="text-[10px] sm:text-xs font-mono font-bold text-slate-700 bg-slate-100 px-1.5 py-0.5 rounded">${s.plate || s.uid?.substring(0, 8) || '--'}</span>
                    ${s.cpass_id ? `<span class="text-[9px] sm:text-[10px] font-mono font-bold text-emerald-800 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded">CPASS: ${s.cpass_id}</span>` : ''}
                    <span class="text-[9px] sm:text-[10px] font-bold uppercase ${isAuth ? (isEntry ? 'text-green-600' : 'text-blue-600') : 'text-red-600'}">${s.status || '--'}</span>
                </div>
            </div>
        </div>
    `;
}

// =====================
// MANUAL GATE SCAN TRIGGER
// =====================
window.processManualGateScan = function(direction) {
    const isExit = direction === 'EXIT';
    let uid = '';
    
    // Check both single view input and dual view input
    const dualInput = document.getElementById(isExit ? 'demoUidInputDualExit' : 'demoUidInputDualEntry');
    const singleInput = document.getElementById(isExit ? 'demoUidInputExit' : 'demoUidInputEntry');

    if (dualInput && dualInput.value.trim()) {
        uid = dualInput.value.trim();
        dualInput.value = '';
    } else if (singleInput && singleInput.value.trim()) {
        uid = singleInput.value.trim();
        singleInput.value = '';
    }

    if (!uid) {
        showToast('Please enter an RFID UID to scan.', 'warning');
        if (dualInput && currentActiveView === 'dual') dualInput.focus();
        else if (singleInput) singleInput.focus();
        return;
    }
    processRFIDScan(uid, null, null, direction);
};

// =====================
// =====================
// RFID SCAN ENGINE (Dual Gate Concurrency Support)
// =====================
const gateResetTimers = { Entry: null, Exit: null };

async function processRFIDScan(uid, rawLogId = null, fromRealtimeTxn = null, forcedDirection = null) {
    if (!uid) return;
    uid = uid.toUpperCase().trim();

    // 1. Determine Gate Direction (ENTRY or EXIT)
    let direction = forcedDirection;
    if (!direction && fromRealtimeTxn) {
        direction = fromRealtimeTxn.direction || 'ENTRY';
    } else if (!direction && isConnected) {
        const { data: lastTxn } = await supabaseClient
            .from('transactions').select('direction').eq('rfid_uid', uid).eq('status', 'AUTHORIZED')
            .order('timestamp', { ascending: false }).limit(1).maybeSingle();
        direction = lastTxn?.direction === 'ENTRY' ? 'EXIT' : 'ENTRY';
    } else if (!direction) {
        direction = currentActiveView === 'exit' ? 'EXIT' : 'ENTRY';
    }

    const isEntry = direction === 'ENTRY';
    const gateKey = isEntry ? 'Entry' : 'Exit';

    // Clear any pending cooldown reset timer for THIS gate specifically
    if (gateResetTimers[gateKey]) {
        clearTimeout(gateResetTimers[gateKey]);
        gateResetTimers[gateKey] = null;
    }

    // Set UI to Scanning state for both single and dual view
    ['', 'Dual'].forEach(prefix => {
        const radar = document.getElementById(`radarContainer${prefix}${gateKey}`);
        const scanStatusText = document.getElementById(`scanStatusText${prefix}${gateKey}`);
        const scanSubtext = document.getElementById(`scanSubtext${prefix}${gateKey}`);
        const radarCenter = document.getElementById(`radarCenter${prefix}${gateKey}`);
        const scanEmpty = document.getElementById(`scanResultEmpty${prefix}${gateKey}`);
        const scanData = document.getElementById(`scanResultData${prefix}${gateKey}`);

        if (radar) {
            radar.classList.add('scanning');
            radar.parentElement.classList.remove('status-authorized', 'status-denied');
        }
        if (scanStatusText) {
            scanStatusText.textContent = `SCANNING ${direction}...`;
            scanStatusText.className = 'text-sm sm:text-xl font-bold font-display text-blue-600 mb-1 sm:mb-2';
        }
        if (scanSubtext) scanSubtext.textContent = `UID: ${uid}`;
        if (radarCenter) radarCenter.innerHTML = '<i data-lucide="loader-2" class="w-6 h-6 sm:w-10 sm:h-10 text-blue-500 animate-spin"></i>';

        if (scanEmpty) scanEmpty.classList.add('hidden');
        if (scanData) {
            scanData.classList.remove('hidden');
            scanData.classList.add('opacity-70');
        }

        const el = (id) => document.getElementById(id);
        if(el(`resUid${prefix}${gateKey}`)) el(`resUid${prefix}${gateKey}`).textContent = uid;
        if(el(`resCpassId${prefix}${gateKey}`)) el(`resCpassId${prefix}${gateKey}`).textContent = '...';
        if(el(`resName${prefix}${gateKey}`)) el(`resName${prefix}${gateKey}`).textContent = 'Verifying credentials...';
        if(el(`resRole${prefix}${gateKey}`)) el(`resRole${prefix}${gateKey}`).textContent = 'READING...';
        if(el(`resProgram${prefix}${gateKey}`)) el(`resProgram${prefix}${gateKey}`).textContent = 'Fetching vehicle and driver record...';
        if(el(`resPlate${prefix}${gateKey}`)) el(`resPlate${prefix}${gateKey}`).textContent = '...';
        if(el(`resVehType${prefix}${gateKey}`)) el(`resVehType${prefix}${gateKey}`).textContent = '...';
        if(el(`resVehModel${prefix}${gateKey}`)) el(`resVehModel${prefix}${gateKey}`).textContent = '...';
        if(el(`resColor${prefix}${gateKey}`)) el(`resColor${prefix}${gateKey}`).textContent = '...';
        if(el(`resStatusLabel${prefix}${gateKey}`)) {
            el(`resStatusLabel${prefix}${gateKey}`).className = 'px-2.5 sm:px-4 py-1 sm:py-2 rounded-xl font-bold text-xs sm:text-sm tracking-wide shadow-sm border bg-amber-50 border-amber-200 text-amber-700 animate-pulse';
            el(`resStatusLabel${prefix}${gateKey}`).textContent = 'VERIFYING...';
        }
    });
    lucide.createIcons();

    // 2. Query Supabase for RFID Card and User
    let result = null;
    let userId = null;

    if (isConnected) {
        try {
            const { data: card, error } = await supabaseClient
                .from('rfid_cards')
                .select(`
                    id, rfid_uid, authorization_status,
                    vehicles ( id, vehicle_type, vehicle_model, plate_number, vehicle_color ),
                    users ( id, full_name, role, role_detail, program, section, profile_image, cpass_id, student_id )
                `)
                .eq('rfid_uid', uid)
                .maybeSingle();

            if (card && !error) {
                userId = card.users?.id;
                result = {
                    uid:          uid,
                    cpass_id:     card.users?.cpass_id || card.users?.student_id || '--',
                    name:         card.users?.full_name || 'Registered Driver',
                    role:         card.users?.role === 'OTHERS' && card.users?.role_detail ? card.users.role_detail : (card.users?.role || '--'),
                    program:      card.users?.program || '--',
                    section:      card.users?.section || '--',
                    type:         card.vehicles?.vehicle_type || '--',
                    model:        card.vehicles?.vehicle_model || '--',
                    plate:        card.vehicles?.plate_number || '--',
                    color:        card.vehicles?.vehicle_color || '--',
                    vehicle_id:   card.vehicles?.id || null,
                    profileImage: card.users?.profile_image || null,
                    status:       card.authorization_status === 'AUTHORIZED' ? 'AUTHORIZED' : 'DENIED'
                };
            }
        } catch(e) { console.error('DB Lookup error:', e); }
    }

    // Fallback to mock data if offline
    if (!result && mockUsers[uid]) {
        result = { ...mockUsers[uid] };
        userId = uid;
    }

    // Check Special Tags (Visitor & Emergency) - flexible space matching
    const cleanUid = uid.replace(/\s+/g, '').toUpperCase();
    let specialTag = appState.specialTags.find(t => 
        t.rfid_uid === uid || 
        (t.rfid_uid && t.rfid_uid.replace(/\s+/g, '').toUpperCase() === cleanUid)
    );
    if (!specialTag && isConnected) {
        try {
            const { data: st } = await supabaseClient
                .from('special_tags')
                .select('*')
                .or(`rfid_uid.eq.${uid},rfid_uid.eq.${cleanUid}`)
                .maybeSingle();
            if (st) {
                specialTag = st;
                if (!appState.specialTags.some(x => x.id === st.id)) appState.specialTags.push(st);
            }
        } catch (e) {
            console.error('Special tag lookup error:', e);
        }
    }

    if (specialTag) {
        if (specialTag.type === 'EMERGENCY') {
            result = { 
                uid, 
                name: specialTag.label || 'Emergency Vehicle', 
                role: 'EMERGENCY', 
                plate: 'EMERGENCY', 
                type: 'Emergency Response', 
                model: specialTag.description || 'Authorized Emergency', 
                program: 'Emergency Service',
                section: '--',
                color: 'Red', 
                status: 'AUTHORIZED', 
                isEmergency: true 
            };
        } else if (specialTag.type === 'VISITOR') {
            const isAssigned = specialTag.label && specialTag.label !== 'Reusable Visitor Tag';
            let visitorName = isAssigned ? specialTag.label : 'Visitor';
            let visitorPlate = specialTag.description?.match(/Plate:\s*([^|]+)/)?.[1]?.trim() || 'VISITOR PASS';

            if (isEntry) {
                // Check if visitor is already inside
                let lastTxn = null;
                if (isConnected) {
                    const { data: lt } = await supabaseClient
                        .from('transactions').select('direction, timestamp, status')
                        .eq('rfid_uid', uid).eq('status', 'AUTHORIZED')
                        .order('timestamp', { ascending: false }).limit(1).maybeSingle();
                    lastTxn = lt;
                }

                if (lastTxn && lastTxn.direction === 'ENTRY' && !fromRealtimeTxn) {
                    // Duplicate entry warning for visitor
                    const prevTime = new Date(lastTxn.timestamp);
                    const formattedString = `${prevTime.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} at ${prevTime.toLocaleTimeString('en-US', { hour12: true, hour: 'numeric', minute: '2-digit' })}`;
                    
                    result = {
                        uid,
                        name: visitorName,
                        role: 'VISITOR',
                        plate: visitorPlate,
                        type: 'Visitor Vehicle',
                        model: 'Campus Visitor',
                        program: 'Campus Visitor',
                        section: '--',
                        color: '--',
                        status: 'AUTHORIZED',
                        isVisitor: true
                    };
                    
                    pendingDuplicate = { uid, result, userId: null, prevTimestamp: lastTxn.timestamp, gateKey };
                    openDuplicateModal(result, formattedString, uid);
                    populateScanResultCard(result, gateKey);
                    return;
                }

                // If unassigned visitor tag, open the registration modal for guard input
                if (!isAssigned) {
                    openVisitorModal(uid, 'Entry');
                }

                result = {
                    uid,
                    name: visitorName,
                    role: 'VISITOR',
                    plate: visitorPlate,
                    type: 'Visitor Vehicle',
                    model: 'Campus Visitor',
                    program: 'Campus Visitor',
                    section: '--',
                    color: '--',
                    status: 'AUTHORIZED',
                    isVisitor: true
                };
            } else {
                // EXIT GATE: AUTOMATICALLY IDENTIFY VISITOR!
                if ((!isAssigned) && isConnected) {
                    const { data: lastEntry } = await supabaseClient
                        .from('transactions').select('remarks')
                        .eq('rfid_uid', uid).eq('direction', 'ENTRY').eq('status', 'AUTHORIZED')
                        .order('timestamp', { ascending: false }).limit(1).maybeSingle();
                    if (lastEntry?.remarks) {
                        const match = lastEntry.remarks.match(/Visitor Entry:\s*([^|]+)\s*\|\s*Plate:\s*(.+)/);
                        if (match) {
                            visitorName = match[1].trim();
                            visitorPlate = match[2].trim();
                        }
                    }
                }

                result = {
                    uid: uid,
                    name: visitorName,
                    role: 'VISITOR',
                    plate: visitorPlate,
                    type: visitorPlate !== 'N/A' && visitorPlate !== 'VISITOR PASS' ? 'Visitor Vehicle' : 'Walk-in / Visitor',
                    model: 'Campus Visitor',
                    program: 'Campus Visitor',
                    section: '--',
                    color: '--',
                    status: 'AUTHORIZED',
                    isVisitor: true
                };

                // Visual pause for radar feel
                await new Promise(r => setTimeout(r, 600));

                ['', 'Dual'].forEach(prefix => {
                    const radar = document.getElementById(`radarContainer${prefix}Exit`);
                    const scanStatusText = document.getElementById(`scanStatusText${prefix}Exit`);
                    const radarCenter = document.getElementById(`radarCenter${prefix}Exit`);
                    const scanSubtext = document.getElementById(`scanSubtext${prefix}Exit`);
                    const statusLabel = document.getElementById(`resStatusLabel${prefix}Exit`);

                    if (radar) {
                        radar.classList.remove('scanning');
                        radar.parentElement.classList.add('status-authorized');
                    }
                    if (scanStatusText) {
                        scanStatusText.textContent = 'EXIT AUTHORIZED';
                        scanStatusText.className = 'text-sm sm:text-xl font-bold font-display text-blue-600 mb-1 sm:mb-2';
                    }
                    if (radarCenter) radarCenter.innerHTML = '<i data-lucide="check" class="w-6 h-6 sm:w-10 sm:h-10 text-white"></i>';
                    if (scanSubtext) scanSubtext.textContent = `Visitor ${visitorName} departure logged. Safe travels!`;

                    if (statusLabel) {
                        statusLabel.className = 'px-2.5 sm:px-4 py-1 sm:py-2 rounded-xl font-bold text-xs sm:text-sm tracking-wide shadow-sm border bg-blue-50 border-blue-200 text-blue-700';
                        statusLabel.innerHTML = '✓ EXIT AUTHORIZED';
                    }
                });

                // Log exit transaction & clear tag for new visitors
                if (!fromRealtimeTxn && isConnected) {
                    await supabaseClient.from('transactions').insert({
                        rfid_uid: uid,
                        direction: 'EXIT',
                        gate: 'EXIT_GATE',
                        status: 'AUTHORIZED',
                        remarks: `Visitor Exit: ${visitorName} | Plate: ${visitorPlate}`
                    });

                    // Clear/reset reusable visitor tag so it's immediately available for next vehicle/visitor!
                    await supabaseClient.from('special_tags').update({
                        label: 'Reusable Visitor Tag',
                        description: null
                    }).eq('rfid_uid', uid);
                    
                    showToast(`Visitor "${visitorName}" checked out. Tag ${uid} is now available for new visitors!`, 'success');
                }

                appState.exitsToday++;
                appState.vehiclesInside = Math.max(0, (appState.vehiclesInside || 0) - 1);

                // Populate Exit card
                populateScanResultCard(result, 'Exit');
                result.event = 'EXIT';
                result.time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
                appState.recentScans.unshift(result);
                renderAll();
                lucide.createIcons();

                setTimeout(() => resetGateScanner('Exit'), 7000);
                return;
            }
        }
    }

    if (!result) {
        result = { uid, name: 'Unregistered RFID', role: 'UNREGISTERED', program: '--', section: '--', type: '--', model: '--', plate: 'UNREGISTERED', color: '--', status: 'DENIED' };
    }

    // Visual pause for radar feel
    await new Promise(r => setTimeout(r, 600));

    ['', 'Dual'].forEach(prefix => {
        const radar = document.getElementById(`radarContainer${prefix}${gateKey}`);
        const scanData = document.getElementById(`scanResultData${prefix}${gateKey}`);
        if (radar) radar.classList.remove('scanning');
        if (scanData) scanData.classList.remove('opacity-70');
    });

    const isAuth = result.status === 'AUTHORIZED' || (fromRealtimeTxn && fromRealtimeTxn.status === 'AUTHORIZED');

    if (isAuth) {
        // Check for DUPLICATE ENTRY (User is already inside)
        let lastEntryTxn = null;
        if (isEntry && isConnected) {
            const { data: lastTxn } = await supabaseClient
                .from('transactions')
                .select('id, direction, timestamp, status')
                .eq('rfid_uid', uid)
                .eq('status', 'AUTHORIZED')
                .order('timestamp', { ascending: false })
                .limit(1)
                .maybeSingle();
            if (lastTxn && lastTxn.direction === 'ENTRY') {
                lastEntryTxn = lastTxn;
            }
        }

        if (isEntry && lastEntryTxn && !fromRealtimeTxn) {
            // DUPLICATE ENTRY DETECTED!
            const prevTime = new Date(lastEntryTxn.timestamp);
            const formattedDate = prevTime.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            const formattedTime = prevTime.toLocaleTimeString('en-US', { hour12: true, hour: 'numeric', minute: '2-digit' });
            const formattedString = `${formattedDate} at ${formattedTime}`;

            pendingDuplicate = {
                uid,
                result,
                userId,
                prevTimestamp: lastEntryTxn.timestamp,
                gateKey
            };

            ['', 'Dual'].forEach(prefix => {
                const radar = document.getElementById(`radarContainer${prefix}${gateKey}`);
                const scanStatusText = document.getElementById(`scanStatusText${prefix}${gateKey}`);
                const scanSubtext = document.getElementById(`scanSubtext${prefix}${gateKey}`);
                const radarCenter = document.getElementById(`radarCenter${prefix}${gateKey}`);
                const statusLabel = document.getElementById(`resStatusLabel${prefix}${gateKey}`);

                if (radar) radar.parentElement.classList.add('status-authorized');
                if (scanStatusText) {
                    scanStatusText.textContent = 'ALREADY ENTERED';
                    scanStatusText.className = 'text-sm sm:text-xl font-bold font-display text-amber-600 mb-1 sm:mb-2';
                }
                if (scanSubtext) scanSubtext.textContent = `Entered ${formattedString}. Awaiting guard confirmation.`;
                if (radarCenter) radarCenter.innerHTML = '<i data-lucide="alert-triangle" class="w-6 h-6 sm:w-10 sm:h-10 text-amber-500"></i>';

                if (statusLabel) {
                    statusLabel.className = 'px-2.5 sm:px-4 py-1 sm:py-2 rounded-xl font-bold text-xs sm:text-sm tracking-wide shadow-sm border bg-amber-50 border-amber-300 text-amber-800 animate-pulse';
                    statusLabel.innerHTML = '⚠️ ALREADY ENTERED';
                }
            });

            // Populate data card
            populateScanResultCard(result, gateKey);
            openDuplicateModal(result, formattedString, uid);
            return;
        }

        ['', 'Dual'].forEach(prefix => {
            const radar = document.getElementById(`radarContainer${prefix}${gateKey}`);
            const scanStatusText = document.getElementById(`scanStatusText${prefix}${gateKey}`);
            const radarCenter = document.getElementById(`radarCenter${prefix}${gateKey}`);
            const scanSubtext = document.getElementById(`scanSubtext${prefix}${gateKey}`);
            const statusLabel = document.getElementById(`resStatusLabel${prefix}${gateKey}`);

            if (radar) radar.parentElement.classList.add('status-authorized');
            if (scanStatusText) {
                scanStatusText.textContent = isEntry ? 'ENTRY AUTHORIZED' : 'EXIT AUTHORIZED';
                scanStatusText.className = `text-sm sm:text-xl font-bold font-display ${isEntry ? 'text-green-600' : 'text-blue-600'} mb-1 sm:mb-2`;
            }
            if (radarCenter) radarCenter.innerHTML = '<i data-lucide="check" class="w-6 h-6 sm:w-10 sm:h-10 text-white"></i>';

            if (statusLabel) {
                statusLabel.className = isEntry
                    ? 'px-2.5 sm:px-4 py-1 sm:py-2 rounded-xl font-bold text-xs sm:text-sm tracking-wide shadow-sm border bg-green-50 border-green-200 text-green-700'
                    : 'px-2.5 sm:px-4 py-1 sm:py-2 rounded-xl font-bold text-xs sm:text-sm tracking-wide shadow-sm border bg-blue-50 border-blue-200 text-blue-700';
                statusLabel.innerHTML = isEntry ? '✓ ENTRY AUTHORIZED' : '✓ EXIT AUTHORIZED';
            }

            if (scanSubtext) scanSubtext.textContent = isEntry ? 'Welcome to campus! Entry logged.' : 'Vehicle departure recorded. Safe travels!';
        });

        // Log transaction if manual scan
        if (!fromRealtimeTxn && isConnected) {
            const isPed = result.type === 'None' || result.plate === 'PEDESTRIAN' || result.type === 'Walking / Pedestrian' || result.role === 'PEDESTRIAN';
            const userType = isPed ? 'PEDESTRIAN' : 'VEHICLE';
            const rfidType = isPed ? 'CLOSE_RANGE' : 'LONG_RANGE';

            await supabaseClient.from('transactions').insert({
                rfid_uid: uid,
                direction: direction,
                gate: isEntry ? (isPed ? 'PEDESTRIAN_ENTRY' : 'ENTRY_GATE') : (isPed ? 'PEDESTRIAN_EXIT' : 'EXIT_GATE'),
                vehicle_id: result.vehicle_id || null,
                user_id: userId || null,
                user_type: userType,
                rfid_type: rfidType,
                status: 'AUTHORIZED',
                remarks: `Guard station ${direction} (${isPed ? 'Pedestrian Close-Range' : 'Vehicle Long-Range UHF'})`
            });
            if (isEntry) {
                appState.entriesToday++;
                appState.vehiclesInside = (appState.vehiclesInside || 0) + 1;
            } else {
                appState.exitsToday++;
                appState.vehiclesInside = Math.max(0, (appState.vehiclesInside || 0) - 1);
            }
        }
        result.event = direction;
    } else {
        ['', 'Dual'].forEach(prefix => {
            const radar = document.getElementById(`radarContainer${prefix}${gateKey}`);
            const scanStatusText = document.getElementById(`scanStatusText${prefix}${gateKey}`);
            const radarCenter = document.getElementById(`radarCenter${prefix}${gateKey}`);
            const scanSubtext = document.getElementById(`scanSubtext${prefix}${gateKey}`);
            const statusLabel = document.getElementById(`resStatusLabel${prefix}${gateKey}`);

            if (radar) radar.parentElement.classList.add('status-denied');
            if (scanStatusText) {
                scanStatusText.textContent = 'ACCESS DENIED';
                scanStatusText.className = 'text-sm sm:text-xl font-bold font-display text-red-600 mb-1 sm:mb-2';
            }
            if (radarCenter) radarCenter.innerHTML = '<i data-lucide="x" class="w-6 h-6 sm:w-10 sm:h-10 text-white"></i>';
            if (scanSubtext) scanSubtext.textContent = 'Unauthorized or unregistered RFID card.';

            if (statusLabel) {
                statusLabel.className = 'px-2.5 sm:px-4 py-1 sm:py-2 rounded-xl font-bold text-xs sm:text-sm tracking-wide shadow-sm border bg-red-50 border-red-200 text-red-700';
                statusLabel.innerHTML = '✗ ACCESS DENIED';
            }
        });

        if (!fromRealtimeTxn && isConnected) {
            await supabaseClient.from('transactions').insert({
                rfid_uid: uid,
                direction: direction,
                gate: isEntry ? 'ENTRY_GATE' : 'EXIT_GATE',
                status: 'DENIED',
                remarks: 'Unauthorized RFID UID scan attempt'
            });
        }
        result.event = direction;
    }

    // Populate data card
    populateScanResultCard(result, gateKey);

    // Add to recent scans
    result.time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
    appState.recentScans.unshift(result);

    renderAll();
    lucide.createIcons();

    gateResetTimers[gateKey] = setTimeout(() => {
        resetGateScanner(gateKey);
        gateResetTimers[gateKey] = null;
    }, 7000);
}

function populateScanResultCard(result, gateKey) {
    const el = (id) => document.getElementById(id);
    const isVisitor = result.role === 'VISITOR' || result.isVisitor;

    ['', 'Dual'].forEach(prefix => {
        if (el(`resIconContainer${prefix}${gateKey}`) && el(`resProfileImage${prefix}${gateKey}`)) {
            if (isVisitor) {
                el(`resIconContainer${prefix}${gateKey}`).classList.remove('hidden');
                el(`resProfileImage${prefix}${gateKey}`).classList.add('hidden');
            } else {
                el(`resIconContainer${prefix}${gateKey}`).classList.add('hidden');
                el(`resProfileImage${prefix}${gateKey}`).classList.remove('hidden');
                el(`resProfileImage${prefix}${gateKey}`).src = result.profileImage || `https://ui-avatars.com/api/?name=${encodeURIComponent(result.name)}&background=0E4B3A&color=fff&size=200`;
            }
        }

        if(el(`resName${prefix}${gateKey}`))     el(`resName${prefix}${gateKey}`).textContent = result.name;
        if(el(`resRole${prefix}${gateKey}`))     el(`resRole${prefix}${gateKey}`).textContent = result.role;
        if(el(`resProgram${prefix}${gateKey}`))  el(`resProgram${prefix}${gateKey}`).textContent = `${result.program || '--'} • ${result.section || '--'}`;
        if(el(`resUid${prefix}${gateKey}`))      el(`resUid${prefix}${gateKey}`).textContent = result.uid;
        if(el(`resCpassId${prefix}${gateKey}`))  el(`resCpassId${prefix}${gateKey}`).textContent = result.cpass_id || '--';
        if(el(`resVehType${prefix}${gateKey}`))  el(`resVehType${prefix}${gateKey}`).textContent = result.type;
        if(el(`resPlate${prefix}${gateKey}`))    el(`resPlate${prefix}${gateKey}`).textContent = result.plate;
        if(el(`resVehModel${prefix}${gateKey}`)) el(`resVehModel${prefix}${gateKey}`).textContent = result.model;
        if(el(`resColor${prefix}${gateKey}`))    el(`resColor${prefix}${gateKey}`).textContent = result.color;

        if(el(`scanResultEmpty${prefix}${gateKey}`)) el(`scanResultEmpty${prefix}${gateKey}`).classList.add('hidden');
        if(el(`scanResultData${prefix}${gateKey}`))  el(`scanResultData${prefix}${gateKey}`).classList.remove('hidden');
    });
}

// =====================
// DUPLICATE ENTRY CONFIRMATION
// =====================
let pendingDuplicate = null;

window.openDuplicateModal = function(result, formattedTime, uid) {
    const m = document.getElementById('duplicateEntryModal');
    if (!m) return;
    document.getElementById('dupModalDriver').textContent = result.name || '--';
    document.getElementById('dupModalPlate').textContent = result.plate || '--';
    document.getElementById('dupModalUid').textContent = uid || '--';
    document.getElementById('dupModalPrevTime').textContent = formattedTime;
    document.getElementById('dupModalMessage').textContent = `This user (${result.name}) has already been granted entry on ${formattedTime}.`;

    m.classList.remove('hidden');
    setTimeout(() => {
        m.classList.remove('opacity-0');
        m.firstElementChild.classList.remove('scale-95');
    }, 10);
    lucide.createIcons();
};

window.closeDuplicateModal = function(isConfirmed = false) {
    const m = document.getElementById('duplicateEntryModal');
    if (!m) return;
    m.classList.add('opacity-0');
    m.firstElementChild.classList.add('scale-95');
    setTimeout(() => {
        m.classList.add('hidden');
        if (!isConfirmed) {
            showToast('Duplicate entry cancelled.', 'info');
            resetGateScanner('Entry');
            pendingDuplicate = null;
        }
    }, 300);
};

window.confirmDuplicateEntry = async function() {
    if (!pendingDuplicate) return;
    const { uid, result, userId, gateKey } = pendingDuplicate;

    try {
        if (isConnected) {
            await supabaseClient.from('transactions').insert({
                rfid_uid: uid,
                direction: 'ENTRY',
                gate: 'ENTRY_GATE',
                vehicle_id: result.vehicle_id || null,
                user_id: userId || null,
                status: 'AUTHORIZED',
                remarks: 'Re-entry confirmed by guard'
            });
        }

        appState.entriesToday++;
        result.event = 'ENTRY';
        result.time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
        appState.recentScans.unshift(result);

        showToast(`Re-entry stored and allowed for ${result.name}!`, 'success');
        closeDuplicateModal(true);
        renderAll();
        setTimeout(() => resetGateScanner('Entry'), 5000);
        pendingDuplicate = null;
    } catch(err) {
        showToast('Error storing re-entry: ' + err.message, 'error');
    }
};

function resetGateScanner(gateKey) {
    ['', 'Dual'].forEach(prefix => {
        const radar = document.getElementById(`radarContainer${prefix}${gateKey}`);
        if (radar) radar.parentElement.classList.remove('status-authorized', 'status-denied');
        const statusText = document.getElementById(`scanStatusText${prefix}${gateKey}`);
        if (statusText) {
            statusText.textContent = `${gateKey.toUpperCase()} READY`;
            statusText.className = 'text-sm sm:text-base font-bold font-display text-slate-600 mb-1';
        }
        const subtext = document.getElementById(`scanSubtext${prefix}${gateKey}`);
        if (subtext) subtext.textContent = `Tap card on ${gateKey} reader.`;
        const radarCenter = document.getElementById(`radarCenter${prefix}${gateKey}`);
        if (radarCenter) radarCenter.innerHTML = '<i data-lucide="nfc" class="w-6 h-6 sm:w-8 sm:h-8 text-slate-400"></i>';

        const scanEmpty = document.getElementById(`scanResultEmpty${prefix}${gateKey}`);
        const scanData = document.getElementById(`scanResultData${prefix}${gateKey}`);
        if (scanEmpty) scanEmpty.classList.remove('hidden');
        if (scanData) scanData.classList.add('hidden');
    });
    lucide.createIcons();
}

document.getElementById('btnDenyEntryAlt')?.addEventListener('click', () => {
    document.getElementById('btnDeny').click();
});

document.getElementById('btnDeny')?.addEventListener('click', () => {
    showToast('Entry explicitly denied by guard.', 'error');
    
    if (pendingUserResult) {
        // Record in database if connected
        if (isConnected) {
            supabaseClient.from('transactions').insert({
                rfid_uid: pendingUserResult.uid,
                direction: 'ENTRY',
                gate: 'CHARRMPASS_GUARD_STATION',
                user_id: pendingUserResult.userId || null,
                status: 'DENIED',
                remarks: 'Denied by Guard'
            }).then();
        }

        // Add to local history list
        pendingUserResult.event = 'DENIED';
        pendingUserResult.time = new Date().toLocaleTimeString('en-US',{hour12:false,hour:'2-digit',minute:'2-digit'});
        appState.recentScans.unshift({ ...pendingUserResult });
        
        pendingUserResult = null;
        pendingLogId = null;
        renderAll();
    }

    // Reset scanner to READY state
    document.getElementById('scanResultData').classList.add('hidden');
    document.getElementById('scanResultEmpty').classList.remove('hidden');
    
    document.getElementById('scanStatusText').textContent = 'READY';
    document.getElementById('scanStatusText').className = 'text-xl font-bold font-display text-slate-600 mb-2';
    document.getElementById('scanSubtext').textContent = 'Place card near reader.';
    document.getElementById('radarCenter').innerHTML = '<i data-lucide="nfc" id="radarIcon" class="w-10 h-10 text-slate-400"></i>';
    document.getElementById('radarContainer').classList.remove('scanning');
    lucide.createIcons();
});

// =====================
// SUPABASE REALTIME — Listen for new scans from ESP32
// =====================
if (isConnected) {
    console.log('🔌 Setting up Supabase Realtime subscriptions...');

    // Listen for new transactions (ESP32 ENTRY/EXIT events)
    supabaseClient.channel('guard-txn-insert')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'transactions' }, async (payload) => {
            console.log('📡 New transaction INSERT from DB:', payload.new);
            const txn = payload.new;
            if (txn && txn.rfid_uid) {
                // Instantly update the Live Scan monitor with what was scanned
                await processRFIDScan(txn.rfid_uid, txn.id, txn);
            }
            await initState();
        })
        .subscribe((status) => console.log('Realtime transactions INSERT:', status));

    // Listen for transaction UPDATES
    supabaseClient.channel('guard-txn-update')
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'transactions' }, async (payload) => {
            console.log('📡 Transaction UPDATE from DB:', payload.new);
            await initState();
        })
        .subscribe((status) => console.log('Realtime transactions UPDATE:', status));

    // Listen for new user registrations
    supabaseClient.channel('guard-users')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'users' }, (payload) => {
            console.log('👤 New user registered:', payload.new.full_name);
            appState.totalVehicles++;
            renderAll();
            showToast(`New registration: ${payload.new.full_name}`, 'info');
        })
        .subscribe();

    // Listen for rfid_cards changes (authorization updates)
    supabaseClient.channel('guard-rfid-cards')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'rfid_cards' }, async () => {
            await initState();
        })
        .subscribe();

    // Listen for special tags
    supabaseClient.channel('guard-special')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'special_tags' }, async () => {
            const { data: st } = await supabaseClient.from('special_tags').select('*');
            if (st) appState.specialTags = st;
        })
        .subscribe();
}

// =====================
// VISITOR ACTIONS
// =====================
let visitorPendingUid = null;
let visitorPendingGateKey = 'Entry';

window.openVisitorModal = function(uid, gateKey = 'Entry') {
    visitorPendingUid = uid;
    visitorPendingGateKey = gateKey;
    if (document.getElementById('visitorModalUid')) document.getElementById('visitorModalUid').textContent = uid;
    if (document.getElementById('visitorNameInput')) document.getElementById('visitorNameInput').value = '';
    if (document.getElementById('visitorPlateInput')) document.getElementById('visitorPlateInput').value = 'N/A';
    if (document.getElementById('visitorPurposeInput')) document.getElementById('visitorPurposeInput').value = 'Campus Visitor';
    
    const m = document.getElementById('visitorModal');
    if (!m) return;
    m.classList.remove('hidden');
    setTimeout(() => { 
        m.classList.remove('opacity-0'); 
        m.firstElementChild.classList.remove('scale-95'); 
        document.getElementById('visitorNameInput')?.focus();
    }, 10);
    lucide.createIcons();
};

window.closeVisitorModal = function() {
    const m = document.getElementById('visitorModal');
    if (!m) return;
    m.classList.add('opacity-0'); 
    m.firstElementChild.classList.add('scale-95');
    setTimeout(() => { 
        m.classList.add('hidden'); 
        if (visitorPendingUid) {
            resetGateScanner(visitorPendingGateKey);
            visitorPendingUid = null;
        }
    }, 300);
};

window.confirmVisitorEntry = async function() {
    const name = document.getElementById('visitorNameInput')?.value.trim();
    let plate = document.getElementById('visitorPlateInput')?.value.trim().toUpperCase() || 'N/A';
    const purpose = document.getElementById('visitorPurposeInput')?.value.trim() || 'Campus Visitor';
    
    if (!name) { 
        showToast('Please enter the visitor\'s full name.', 'warning'); 
        return; 
    }
    if (!plate) plate = 'N/A';

    const uid = visitorPendingUid;
    const gateKey = visitorPendingGateKey;
    closeVisitorModal();

    const result = {
        uid: uid,
        name: name,
        role: 'VISITOR',
        plate: plate,
        type: plate !== 'N/A' ? 'Visitor Vehicle' : 'Walk-in / Visitor',
        model: purpose,
        program: 'Campus Visitor',
        section: purpose,
        color: '--',
        status: 'AUTHORIZED',
        isVisitor: true
    };

    try {
        if (isConnected) {
            // Update special_tags so Exit Gate can automatically identify this visitor
            await supabaseClient.from('special_tags').upsert({
                rfid_uid: uid,
                type: 'VISITOR',
                label: name,
                description: `Plate: ${plate} | Purpose: ${purpose}`
            }, { onConflict: 'rfid_uid' });

            // Record entry transaction
            await supabaseClient.from('transactions').insert({
                rfid_uid: uid,
                direction: 'ENTRY',
                gate: 'ENTRY_GATE',
                status: 'AUTHORIZED',
                remarks: `Visitor Entry: ${name} | Plate: ${plate}`
            });
        }

        appState.entriesToday++;
        appState.vehiclesInside = (appState.vehiclesInside || 0) + 1;

        // UI Feedback on Entry Monitor
        const radar = document.getElementById('radarContainerEntry');
        const scanStatusText = document.getElementById('scanStatusTextEntry');
        const scanSubtext = document.getElementById('scanSubtextEntry');
        const radarCenter = document.getElementById('radarCenterEntry');

        if (radar) radar.parentElement.classList.add('status-authorized');
        if (scanStatusText) {
            scanStatusText.textContent = 'ENTRY AUTHORIZED';
            scanStatusText.className = 'text-xl font-bold font-display text-green-600 mb-2';
        }
        if (radarCenter) radarCenter.innerHTML = '<i data-lucide="check" class="w-10 h-10 text-white"></i>';
        if (scanSubtext) scanSubtext.textContent = `Welcome ${name}! Visitor entry logged.`;

        if (el('resStatusLabelEntry')) {
            el('resStatusLabelEntry').className = 'px-4 py-2 rounded-xl font-bold text-sm tracking-wide shadow-sm border bg-green-50 border-green-200 text-green-700';
            el('resStatusLabelEntry').innerHTML = '✓ ENTRY AUTHORIZED';
        }

        populateScanResultCard(result, 'Entry');

        result.event = 'ENTRY';
        result.time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
        appState.recentScans.unshift(result);

        renderAll();
        lucide.createIcons();
        showToast(`Visitor "${name}" (Plate: ${plate}) authorized for entry!`, 'success');

        setTimeout(() => resetGateScanner('Entry'), 7000);
        visitorPendingUid = null;
    } catch(err) {
        showToast('Error authorizing visitor: ' + err.message, 'error');
    }
};

// =====================
// GUARD SETTINGS & CREDENTIALS
// =====================
window.openGuardSettingsModal = function() {
    const m = document.getElementById('guardSettingsModal');
    if (!m) return;

    // Load from session and localStorage
    const session = JSON.parse(sessionStorage.getItem('charrmpass_session') || '{}');
    const localGuard = JSON.parse(localStorage.getItem('charrmpass_guard') || '{}');
    const savedSettings = JSON.parse(localStorage.getItem('charrmpass_guard_settings') || '{}');

    const nameEl = document.getElementById('guardDisplayName');
    const userEl = document.getElementById('guardUsernameInput');
    const passEl = document.getElementById('guardPasswordInput');

    if (nameEl) nameEl.value = localGuard.name || document.getElementById('guardName')?.textContent || 'Officer Reyes';
    if (userEl) userEl.value = session.username || 'guard';
    if (passEl) passEl.value = session.password || 'guard123';

    if (savedSettings.sound !== undefined && document.getElementById('guardSoundToggle')) {
        document.getElementById('guardSoundToggle').checked = savedSettings.sound;
    }
    if (savedSettings.denied !== undefined && document.getElementById('guardDeniedToggle')) {
        document.getElementById('guardDeniedToggle').checked = savedSettings.denied;
    }

    m.classList.remove('hidden');
    setTimeout(() => {
        m.classList.remove('opacity-0');
        m.firstElementChild.classList.remove('scale-95');
    }, 10);
    lucide.createIcons();
};

window.closeGuardSettingsModal = function() {
    const m = document.getElementById('guardSettingsModal');
    if (!m) return;
    m.classList.add('opacity-0');
    m.firstElementChild.classList.add('scale-95');
    setTimeout(() => m.classList.add('hidden'), 300);
};

window.toggleGuardPass = function(btn) {
    const input = document.getElementById('guardPasswordInput');
    if (!input) return;
    const isPass = input.type === 'password';
    input.type = isPass ? 'text' : 'password';
    btn.innerHTML = isPass ? '<i data-lucide="eye-off" class="w-4 h-4"></i>' : '<i data-lucide="eye" class="w-4 h-4"></i>';
    lucide.createIcons();
};

window.saveGuardSettings = async function() {
    const displayName = document.getElementById('guardDisplayName').value.trim();
    const username = document.getElementById('guardUsernameInput').value.trim();
    const password = document.getElementById('guardPasswordInput').value.trim();
    const sound = document.getElementById('guardSoundToggle')?.checked ?? true;
    const denied = document.getElementById('guardDeniedToggle')?.checked ?? true;

    if (!displayName || !username || !password) {
        showToast('Please fill in all credential fields.', 'warning');
        return;
    }

    // Save display name locally
    if (document.getElementById('guardName')) document.getElementById('guardName').textContent = displayName;
    if (document.getElementById('guardAvatar')) {
        document.getElementById('guardAvatar').src = `https://ui-avatars.com/api/?name=${encodeURIComponent(displayName)}&background=0E4B3A&color=fff`;
    }
    localStorage.setItem('charrmpass_guard', JSON.stringify({ name: displayName }));
    localStorage.setItem('charrmpass_guard_settings', JSON.stringify({ sound, denied }));

    // Save credentials to Supabase
    if (isConnected) {
        try {
            showToast('Updating guard credentials in database...', 'info');
            const now = new Date().toISOString();
            const { error } = await supabaseClient
                .from('system_accounts')
                .upsert({ username, password, role: 'GUARD', updated_at: now }, { onConflict: 'role' });
            
            if (error) throw error;

            // Update active session
            const session = JSON.parse(sessionStorage.getItem('charrmpass_session') || '{}');
            session.username = username;
            session.password = password;
            sessionStorage.setItem('charrmpass_session', JSON.stringify(session));

            showToast('Guard settings and credentials updated successfully!', 'success');
            closeGuardSettingsModal();
        } catch(err) {
            console.error('Error saving guard credentials:', err);
            showToast('Database Error: ' + err.message, 'error');
        }
    } else {
        showToast('Guard settings saved locally (Demo mode).', 'success');
        closeGuardSettingsModal();
    }
};

document.getElementById('profileTrigger')?.addEventListener('click', openGuardSettingsModal);

// =====================
// INIT
// =====================
initState();
lucide.createIcons();
