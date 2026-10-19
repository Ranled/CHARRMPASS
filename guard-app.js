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

// =====================
// INIT STATE FROM SUPABASE
// =====================
async function initState() {
    if (!supabaseClient && typeof initSupabase === 'function') {
        initSupabase();
    }

    if (supabaseClient) {
        try {
            // Load users with vehicles and rfid_cards (metadata only, no heavy base64 images)
            const { data: users, error: ue } = await supabaseClient
                .from('users')
                .select(`
                    id, full_name, role, role_detail, program, section, cpass_id, student_id, default_transit_mode,
                    vehicles ( id, vehicle_type, vehicle_model, plate_number, vehicle_color ),
                    rfid_cards ( id, rfid_uid, authorization_status )
                `);
            if (ue) console.error('Users fetch error:', ue);
            if (users && Array.isArray(users)) {
                appState.users = users.map(u => ({
                    ...u,
                    vehicle_type:     u.vehicles?.[0]?.vehicle_type     || null,
                    vehicle_model:    u.vehicles?.[0]?.vehicle_model    || null,
                    plate_number:     u.vehicles?.[0]?.plate_number     || null,
                    vehicle_color:    u.vehicles?.[0]?.vehicle_color    || null,
                    motorcycle_image: null,
                    rfid_uid:         u.rfid_cards?.[0]?.rfid_uid       || null,
                    rfid_card_id:     u.rfid_cards?.[0]?.id             || null,
                    authorization_status: u.rfid_cards?.[0]?.authorization_status || 'PENDING',
                }));
                appState.totalVehicles = users.length;
            } else {
                appState.users = [];
                appState.totalVehicles = 0;
            }

            // Load special tags
            const { data: st, error: ste } = await supabaseClient.from('special_tags').select('*');
            if (ste) console.error('Special tags fetch error:', ste);
            appState.specialTags = (st && Array.isArray(st)) ? st : [];

            // Load recent access logs (omit profile_image from batch 500 logs)
            const today = new Date().toISOString().split('T')[0];
            const { data: logs, error: le } = await supabaseClient
                .from('transactions')
                .select(`
                    id, rfid_uid, direction, gate, status, remarks, timestamp, user_type, rfid_type,
                    users ( full_name, role, role_detail, program, section, cpass_id, student_id ),
                    vehicles ( plate_number, vehicle_type, vehicle_model, vehicle_color )
                `)
                .order('timestamp', { ascending: false })
                .limit(500);

            if (le) console.error('Logs fetch error:', le);
            if (logs && Array.isArray(logs)) {
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

                    // Check remarks for Visitor or Emergency details
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

                    // Fallback to special_tags
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

                    const hasRealVehicle = l.vehicles && l.vehicles.plate_number && 
                                           l.vehicles.plate_number !== 'PEDESTRIAN' && 
                                           l.vehicles.plate_number !== 'NONE' && 
                                           l.vehicles.plate_number !== 'N/A' && 
                                           l.vehicles.plate_number !== '--' && 
                                           l.vehicles.vehicle_type !== 'None' && 
                                           l.vehicles.vehicle_type !== 'Walking / Pedestrian';

                    return {
                        id:           l.id,
                        uid:          l.rfid_uid,
                        cpass_id:     cpass_id,
                        name:         name,
                        role:         role,
                        plate:        plate,
                        type:         l.vehicles?.vehicle_type || (hasRealVehicle ? 'Vehicle' : 'Walking / Pedestrian'),
                        user_type:    l.user_type || (hasRealVehicle ? 'VEHICLE' : 'PEDESTRIAN'),
                        rfid_type:    l.rfid_type || (hasRealVehicle ? 'LONG_RANGE' : 'CLOSE_RANGE'),
                        gate:         l.gate,
                        status:       l.status || (l.status === 'DENIED' ? 'DENIED' : 'AUTHORIZED'),
                        event:        l.direction || 'ENTRY',
                        duration:     '--',
                        time:         new Date(l.timestamp).toLocaleTimeString('en-US',{hour12:false,hour:'2-digit',minute:'2-digit'}),
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
            } else {
                appState.recentScans = [];
                appState.vehiclesInside = 0;
                appState.entriesToday = 0;
                appState.exitsToday = 0;
            }

            console.log('🟢 Guard data loaded from Supabase:', appState.totalVehicles, 'vehicles,', appState.vehiclesInside, 'inside');
            setupGuardRealtime();
        } catch(e) { 
            console.error('Guard Init error:', e); 
        }
    }

    renderAll();
    loadGuardInfo();
    updateTrafficLightWidget('Entry', 'standby');
    updateTrafficLightWidget('Exit', 'standby');
}

// Auto-reload data on connection ready
window.addEventListener('supabase:connected', () => {
    console.log('🔄 Re-fetching guard live data after Supabase connection...');
    initState();
});

let guardRealtimeSetup = false;
function setupGuardRealtime() {
    if (!isConnected || !supabaseClient || guardRealtimeSetup) return;
    guardRealtimeSetup = true;

    try {
        console.log('🔌 Setting up Guard Supabase Realtime subscriptions...');

        // Listen for new transactions (ESP32 ENTRY/EXIT and kiosk scans)
        supabaseClient.channel('guard-live-feed')
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'transactions' }, async payload => {
                const txn = payload.new;
                console.log('⚡ [Guard RT] Inbound gate scan:', txn);
                if (txn && txn.rfid_uid) {
                    await processRFIDScan(txn.rfid_uid, txn.id, txn, txn.direction);
                }
            })
            .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'transactions' }, async payload => {
                console.log('📡 [Guard RT] Transaction UPDATE:', payload.new);
                const updTxn = payload.new;
                if (updTxn && updTxn.id) {
                    const idx = appState.recentScans.findIndex(s => s.id === updTxn.id || s.uid === updTxn.rfid_uid);
                    if (idx !== -1) {
                        appState.recentScans[idx].status = updTxn.status || appState.recentScans[idx].status;
                        renderAll();
                    }
                }
            })
            .subscribe((status, err) => {
                console.log('⚡ [Guard RT] Subscription status:', status);
                if (err) console.error('Guard RT error:', err);
            });

        // Listen for new user registrations
        supabaseClient.channel('guard-users')
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'users' }, (payload) => {
                console.log('👤 [Guard RT] New user registered:', payload.new.full_name);
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
    } catch(e) {
        console.warn('Realtime channel initialization error:', e);
    }
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
        table.innerHTML = filtered.map(s => {
            const isPed = s.user_type === 'PEDESTRIAN' || 
                          s.rfid_type === 'CLOSE_RANGE' ||
                          s.plate === 'PEDESTRIAN' || 
                          s.type === 'Walking / Pedestrian' ||
                          (!s.plate || s.plate === '--' || s.plate === s.uid || s.plate === s.uid?.substring(0, 12));
            const isVeh = !isPed && s.user_type === 'VEHICLE';
            const plateHtml = isVeh 
                ? `<span class="font-mono font-bold text-slate-700">${s.plate || '--'}</span>`
                : `<span class="inline-flex items-center gap-1 text-slate-500 font-semibold text-xs"><i data-lucide="user" class="w-3 h-3 text-emerald-600"></i> PEDESTRIAN</span>`;

            return `
            <tr class="hover:bg-white/60 border-b border-slate-100/50 transition-colors">
                <td class="p-4 text-slate-500 font-medium">${s.time}</td>
                <td class="p-4 text-xs font-mono font-bold text-slate-600">${s.uid || '--'}</td>
                <td class="p-4 font-bold text-slate-800">
                    <div class="flex items-center gap-1.5 flex-wrap">
                        <span>${s.name || '--'}</span>
                        ${s.cpass_id ? `<span class="px-1.5 py-0.5 text-[10px] font-mono font-bold bg-emerald-50 text-emerald-800 border border-emerald-200 rounded">CPASS: ${s.cpass_id}</span>` : ''}
                    </div>
                </td>
                <td class="p-4 text-xs">${plateHtml}</td>
                <td class="p-4 text-center">
                    <span class="px-2.5 py-1 rounded-full text-[10px] font-bold ${s.event === 'ENTRY' ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'}">${s.event || '--'}</span>
                </td>
                <td class="p-4 text-right">
                    <span class="px-2 py-0.5 rounded text-[10px] font-bold ${s.status === 'AUTHORIZED' ? 'bg-green-50 text-green-700 border border-green-200' : (s.status === 'PENDING_CONFIRMATION' ? 'bg-amber-50 text-amber-800 border border-amber-300' : 'bg-red-50 text-red-700 border border-red-200')}">${s.status || '--'}</span>
                </td>
            </tr>
            `;
        }).join('');
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
    const isPending = s.status === 'PENDING_CONFIRMATION';
    const isEntry = type === 'ENTRY';
    const icon = isPending ? 'alert-triangle' : (isAuth ? (isEntry ? 'log-in' : 'log-out') : 'x');
    const badgeBg = isPending ? 'bg-amber-100 text-amber-800 border border-amber-300' : (isAuth ? (isEntry ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700') : 'bg-red-100 text-red-700');

    // Robust Pedestrian vs Vehicle check
    const isPed = s.user_type === 'PEDESTRIAN' || 
                  s.rfid_type === 'CLOSE_RANGE' || 
                  s.plate === 'PEDESTRIAN' || 
                  s.type === 'Walking / Pedestrian' || 
                  s.type === 'None' ||
                  (!s.plate || s.plate === '--' || s.plate === 'NONE' || s.plate === 'N/A' || s.plate === s.uid || s.plate === s.uid?.substring(0, 12));
    const isVeh = !isPed && s.user_type === 'VEHICLE';

    // Tag display: show plate for vehicles; show card UID for pedestrians
    const tagDisplay = (isVeh && s.plate && s.plate !== 'PEDESTRIAN') 
        ? s.plate 
        : (s.uid ? (s.uid.length > 14 ? s.uid.substring(0, 11) + '..' : s.uid) : '--');

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
                <div class="flex items-center gap-1.5 sm:gap-2 flex-wrap">
                    <span class="text-[10px] sm:text-xs font-mono font-bold text-slate-700 bg-slate-100 px-1.5 py-0.5 rounded">${tagDisplay}</span>
                    ${isVeh
                        ? '<span class="text-[9px] font-extrabold px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-800 border border-emerald-200">🚗 VEHICLE</span>'
                        : '<span class="text-[9px] font-extrabold px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200">🚶 PEDESTRIAN</span>'
                    }
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

// ─── TRAFFIC LIGHT STATE CONTROLLER ───────────────────────────
function updateTrafficLightWidget(gateKey, state) {
    // gateKey: 'Entry' | 'Exit'
    // state: 'standby' (Red) | 'scanning' (Yellow) | 'done' (Green) | 'denied' (Red) | 'offline' (Blinking Yellow) | 'connected' (3 Green Blinks)
    ['', 'Dual'].forEach(prefix => {
        const dotRed = document.getElementById(`tlDotRed${prefix}${gateKey}`);
        const dotYellow = document.getElementById(`tlDotYellow${prefix}${gateKey}`);
        const dotGreen = document.getElementById(`tlDotGreen${prefix}${gateKey}`);
        const text = document.getElementById(`tlText${prefix}${gateKey}`);
        if (!dotRed || !dotYellow || !dotGreen || !text) return;

        // Reset all dots to dimmed
        dotRed.className = 'w-2.5 h-2.5 rounded-full bg-rose-500/20';
        dotYellow.className = 'w-2.5 h-2.5 rounded-full bg-amber-500/20';
        dotGreen.className = 'w-2.5 h-2.5 rounded-full bg-emerald-500/20';

        if (state === 'offline') {
            dotYellow.className = 'w-2.5 h-2.5 rounded-full bg-amber-500 shadow-[0_0_8px_#f59e0b] animate-pulse';
            text.textContent = 'OFFLINE';
            text.className = 'text-[9px] text-amber-400 font-bold ml-1';
        } else if (state === 'connected') {
            let count = 0;
            const interval = setInterval(() => {
                dotGreen.classList.toggle('bg-emerald-500');
                dotGreen.classList.toggle('bg-emerald-500/20');
                count++;
                if (count >= 6) {
                    clearInterval(interval);
                    dotGreen.className = 'w-2.5 h-2.5 rounded-full bg-emerald-500/20';
                    dotRed.className = 'w-2.5 h-2.5 rounded-full bg-rose-500 shadow-[0_0_8px_#f43f5e]';
                    text.textContent = 'STANDBY';
                    text.className = 'text-[9px] text-rose-400 font-bold ml-1';
                }
            }, 150);
        } else if (state === 'scanning') {
            dotYellow.className = 'w-2.5 h-2.5 rounded-full bg-amber-500 shadow-[0_0_8px_#f59e0b] animate-pulse';
            text.textContent = 'SCANNING';
            text.className = 'text-[9px] text-amber-400 font-bold ml-1';
        } else if (state === 'done') {
            dotGreen.className = 'w-2.5 h-2.5 rounded-full bg-emerald-500 shadow-[0_0_8px_#10b981]';
            text.textContent = 'DONE';
            text.className = 'text-[9px] text-emerald-400 font-bold ml-1';
        } else if (state === 'denied') {
            dotRed.className = 'w-2.5 h-2.5 rounded-full bg-rose-500 shadow-[0_0_8px_#f43f5e] animate-ping';
            text.textContent = 'DENIED';
            text.className = 'text-[9px] text-rose-400 font-bold ml-1';
        } else {
            // Standby
            dotRed.className = 'w-2.5 h-2.5 rounded-full bg-rose-500 shadow-[0_0_8px_#f43f5e]';
            text.textContent = 'STANDBY';
            text.className = 'text-[9px] text-rose-400 font-bold ml-1';
        }
    });
}

window.addEventListener('supabase:connected', () => {
    updateTrafficLightWidget('Entry', 'connected');
    updateTrafficLightWidget('Exit', 'connected');
});
window.addEventListener('supabase:disconnected', () => {
    updateTrafficLightWidget('Entry', 'offline');
    updateTrafficLightWidget('Exit', 'offline');
});
window.addEventListener('offline', () => {
    updateTrafficLightWidget('Entry', 'offline');
    updateTrafficLightWidget('Exit', 'offline');
});
window.addEventListener('online', () => {
    updateTrafficLightWidget('Entry', 'connected');
    updateTrafficLightWidget('Exit', 'connected');
});

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

    // Set Traffic Light to YELLOW SCANNING
    updateTrafficLightWidget(gateKey, 'scanning');

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
            // UHF readers may report the same tag as raw decimal, 8-digit or 10-digit zero-padded.
            // Match all variants so the vehicle is always found.
            const uidVariants = new Set([uid]);
            const strippedUid = uid.replace(/^0+(?=\d)/, '');
            uidVariants.add(strippedUid);
            if (/^\d+$/.test(strippedUid)) {
                uidVariants.add(strippedUid.padStart(8, '0'));
                uidVariants.add(strippedUid.padStart(10, '0'));
            }
            const { data: card, error } = await supabaseClient
                .from('rfid_cards')
                .select(`
                    id, rfid_uid, authorization_status, user_type, rfid_type,
                    vehicles ( id, vehicle_type, vehicle_model, plate_number, vehicle_color ),
                    users ( id, full_name, role, role_detail, program, section, profile_image, cpass_id, student_id, default_transit_mode )
                `)
                .in('rfid_uid', Array.from(uidVariants))
                .limit(1)
                .maybeSingle();

            if (card && !error) {
                userId = card.users?.id;
                const hasVeh = card.vehicles && card.vehicles.plate_number && 
                               card.vehicles.plate_number !== 'PEDESTRIAN' && 
                               card.vehicles.plate_number !== 'NONE' && 
                               card.vehicles.plate_number !== 'N/A' && 
                               card.vehicles.plate_number !== '--' && 
                               card.vehicles.vehicle_type !== 'None' &&
                               card.vehicles.vehicle_type !== 'Walking / Pedestrian';

                result = {
                    uid:          uid,
                    cpass_id:     card.users?.cpass_id || card.users?.student_id || '--',
                    name:         card.users?.full_name || (hasVeh ? 'Registered Driver' : 'Pedestrian User'),
                    role:         card.users?.role === 'OTHERS' && card.users?.role_detail ? card.users.role_detail : (card.users?.role || '--'),
                    program:      card.users?.program || '--',
                    section:      card.users?.section || '--',
                    type:         hasVeh ? (card.vehicles?.vehicle_type || 'Vehicle') : 'Walking / Pedestrian',
                    model:        hasVeh ? (card.vehicles?.vehicle_model || '--') : 'No Vehicle Assigned',
                    plate:        hasVeh ? (card.vehicles?.plate_number || '--') : 'PEDESTRIAN',
                    color:        hasVeh ? (card.vehicles?.vehicle_color || '--') : '--',
                    vehicle_id:   hasVeh ? card.vehicles.id : null,
                    profileImage: card.users?.profile_image || null,
                    status:       card.authorization_status === 'AUTHORIZED' ? 'AUTHORIZED' : 'DENIED',
                    user_type:    hasVeh ? 'VEHICLE' : 'PEDESTRIAN',
                    rfid_type:    card.rfid_type || (hasVeh ? 'LONG_RANGE' : 'CLOSE_RANGE')
                };
            }
        } catch (e) {
            console.error('RFID card lookup error:', e);
        }
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

                // Traffic Light: DONE (Green)
                updateTrafficLightWidget('Exit', 'done');

                // Populate Exit card
                result.historyNotice = `Exit logged at ${new Date().toLocaleTimeString('en-US', { hour12: true, hour: 'numeric', minute: '2-digit' })}`;
                result.historyBadge = 'VERIFIED';
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

    if (!result && fromRealtimeTxn && fromRealtimeTxn.status === 'AUTHORIZED' && fromRealtimeTxn.rfid_type === 'LONG_RANGE') {
        // Card lookup missed (e.g. RLS or UID format) - rebuild vehicle info from the ESP32's own remarks
        const m = String(fromRealtimeTxn.remarks || '').match(/UHF Vehicle Entry:\s*([^|]+?)(?:\s*\|\s*Driver:\s*(.+))?$/i);
        const rtPlate = m?.[1]?.trim() || 'VEHICLE';
        const rtName = m?.[2]?.trim() || 'Registered Driver';
        result = {
            uid, cpass_id: '--', name: rtName, role: '--', program: '--', section: '--',
            type: 'Vehicle', model: '--', plate: rtPlate, color: '--',
            vehicle_id: fromRealtimeTxn.vehicle_id || null,
            status: 'AUTHORIZED', user_type: 'VEHICLE', rfid_type: 'LONG_RANGE'
        };
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

    // Hands-free operation with 30-second anti-passback:
    // If scan came from ESP32 realtime, trust its AUTHORIZED/DENIED verdict directly.
    // If scan was entered manually on the web dashboard (!fromRealtimeTxn), apply the same 30-second anti-passback window.
    let isAuth = (result.status === 'AUTHORIZED' && (!fromRealtimeTxn || fromRealtimeTxn.status === 'AUTHORIZED' || fromRealtimeTxn.status === 'PENDING_CONFIRMATION'));
    let lastTxn = null;

    if (isAuth && !fromRealtimeTxn && isConnected && !result.isEmergency) {
        try {
            const { data: lt } = await supabaseClient
                .from('transactions')
                .select('id, direction, timestamp, status, remarks')
                .eq('rfid_uid', uid)
                .eq('status', 'AUTHORIZED')
                .order('timestamp', { ascending: false })
                .limit(1)
                .maybeSingle();
            lastTxn = lt;
            if (lastTxn && lastTxn.direction === direction && lastTxn.timestamp) {
                const elapsedSec = Math.floor((Date.now() - new Date(lastTxn.timestamp).getTime()) / 1000);
                if (elapsedSec >= 0 && elapsedSec < 30) {
                    isAuth = false;
                    result.status = 'DENIED';
                    result.denialReason = `Passback violation: Already ${isEntry ? 'entered' : 'exited'} (${30 - elapsedSec}s cooldown remaining)`;
                }
            }
        } catch(e) {
            console.warn('Last txn fetch error:', e);
        }
    }

    if (isAuth) {

        // Normal Authorized Pass: attach status confirmation notice
        const passTime = fromRealtimeTxn?.timestamp ? new Date(fromRealtimeTxn.timestamp) : (lastTxn?.timestamp ? new Date(lastTxn.timestamp) : new Date());
        const historyStamp = passTime.toLocaleTimeString('en-US', { hour12: true, hour: 'numeric', minute: '2-digit' });
        result.historyNotice = isEntry ? `Entry logged at ${historyStamp}` : `Exit logged at ${historyStamp}`;
        result.historyBadge = 'VERIFIED';

        ['', 'Dual'].forEach(prefix => {
            const radar = document.getElementById(`radarContainer${prefix}${gateKey}`);
            const scanStatusText = document.getElementById(`scanStatusText${prefix}${gateKey}`);
            const radarCenter = document.getElementById(`radarCenter${prefix}${gateKey}`);
            const scanSubtext = document.getElementById(`scanSubtext${prefix}${gateKey}`);
            const statusLabel = document.getElementById(`resStatusLabel${prefix}${gateKey}`);

            const hasRealVehicle = result.user_type === 'VEHICLE' && 
                                   result.plate && 
                                   result.plate !== '--' && 
                                   result.plate !== 'N/A' && 
                                   result.plate !== 'PEDESTRIAN' && 
                                   result.plate !== 'NONE' &&
                                   result.type !== 'Walking / Pedestrian';

            if (radar) radar.parentElement.classList.add('status-authorized');
            if (scanStatusText) {
                if (isEntry) {
                    scanStatusText.textContent = hasRealVehicle ? 'VEHICLE ENTRY AUTHORIZED' : 'PEDESTRIAN ENTRY AUTHORIZED';
                    scanStatusText.className = 'text-sm sm:text-xl font-bold font-display text-green-600 mb-1 sm:mb-2';
                } else {
                    scanStatusText.textContent = hasRealVehicle ? 'VEHICLE EXIT AUTHORIZED' : 'PEDESTRIAN EXIT AUTHORIZED';
                    scanStatusText.className = 'text-sm sm:text-xl font-bold font-display text-blue-600 mb-1 sm:mb-2';
                }
            }
            if (radarCenter) radarCenter.innerHTML = '<i data-lucide="check" class="w-6 h-6 sm:w-10 sm:h-10 text-white"></i>';

            if (statusLabel) {
                statusLabel.className = isEntry
                    ? 'px-2.5 sm:px-4 py-1 sm:py-2 rounded-xl font-bold text-xs sm:text-sm tracking-wide shadow-sm border bg-green-50 border-green-200 text-green-700'
                    : 'px-2.5 sm:px-4 py-1 sm:py-2 rounded-xl font-bold text-xs sm:text-sm tracking-wide shadow-sm border bg-blue-50 border-blue-200 text-blue-700';
                statusLabel.innerHTML = isEntry 
                    ? (hasRealVehicle ? '✓ VEHICLE ENTRY AUTHORIZED' : '✓ ENTRY AUTHORIZED') 
                    : (hasRealVehicle ? '✓ VEHICLE EXIT AUTHORIZED' : '✓ EXIT AUTHORIZED');
            }

            if (scanSubtext) {
                if (isEntry) {
                    scanSubtext.textContent = hasRealVehicle ? 'Vehicle entry logged. Barrier gate open!' : 'Pedestrian turnstile entry logged. Welcome!';
                } else {
                    scanSubtext.textContent = hasRealVehicle ? 'Vehicle departure recorded. Safe travels!' : 'Pedestrian departure recorded. Have a great day!';
                }
            }
        });

        // Traffic Light: DONE (Green)
        updateTrafficLightWidget(gateKey, 'done');

        // Log transaction if manual scan
        if (!fromRealtimeTxn && isConnected) {
            const hasRealVehicle = result.vehicle_id && result.plate && result.plate !== '--' && result.plate !== 'N/A' && result.plate !== 'PEDESTRIAN' && result.plate !== 'NONE' && result.type !== 'None' && result.type !== 'Walking / Pedestrian';
            const isPed = !hasRealVehicle || result.user_type === 'PEDESTRIAN' || result.rfid_type === 'CLOSE_RANGE' || result.type === 'None' || result.plate === 'PEDESTRIAN' || result.type === 'Walking / Pedestrian' || result.role === 'PEDESTRIAN';
            const userType = isPed ? 'PEDESTRIAN' : 'VEHICLE';
            const rfidType = isPed ? 'CLOSE_RANGE' : 'LONG_RANGE';
            const gateName = isEntry ? (isPed ? 'CHARRMPASS_GATE_ENTRY' : 'ENTRY_GATE') : (isPed ? 'CHARRMPASS_GATE_EXIT' : 'EXIT_GATE');

            await supabaseClient.from('transactions').insert({
                rfid_uid: uid,
                direction: direction,
                gate: gateName,
                vehicle_id: isPed ? null : (result.vehicle_id || null),
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
        } else if (fromRealtimeTxn && !String(fromRealtimeTxn.remarks || '').startsWith('Guard station')) {
            // Scan posted by an ESP32 gate (e.g. long-range UHF): update live counters
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
            if (scanSubtext) scanSubtext.textContent = result.denialReason || 'Unauthorized or unregistered RFID card.';

            if (statusLabel) {
                statusLabel.className = 'px-2.5 sm:px-4 py-1 sm:py-2 rounded-xl font-bold text-xs sm:text-sm tracking-wide shadow-sm border bg-red-50 border-red-200 text-red-700';
                statusLabel.innerHTML = '✗ ACCESS DENIED';
            }
        });

        // Traffic Light: DENIED (Red Alert)
        updateTrafficLightWidget(gateKey, 'denied');

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

        // Transit Mode Badge (VEHICLE vs PEDESTRIAN)
        const tmBadge = el(`resTransitMode${prefix}${gateKey}`);
        const hasRealVehicle = result.user_type === 'VEHICLE' && 
                               result.plate && 
                               result.plate !== '--' && 
                               result.plate !== 'N/A' && 
                               result.plate !== 'PEDESTRIAN' && 
                               result.plate !== 'NONE' &&
                               result.type !== 'Walking / Pedestrian';
        if (tmBadge) {
            if (result.status === 'DENIED' && (!result.name || result.name === 'Unregistered RFID')) {
                tmBadge.classList.add('hidden');
            } else if (hasRealVehicle) {
                tmBadge.classList.remove('hidden');
                tmBadge.className = (prefix === 'Dual' ? 'px-2 py-0.5 text-[10px]' : 'px-2.5 py-0.5 text-xs') + ' rounded-full font-extrabold uppercase bg-emerald-100 text-emerald-800 border border-emerald-300 inline-flex items-center gap-1 shadow-sm';
                tmBadge.innerHTML = '<i data-lucide="car" class="w-3 h-3 inline"></i> VEHICLE';
            } else {
                tmBadge.classList.remove('hidden');
                tmBadge.className = (prefix === 'Dual' ? 'px-2 py-0.5 text-[10px]' : 'px-2.5 py-0.5 text-xs') + ' rounded-full font-extrabold uppercase bg-blue-100 text-blue-800 border border-blue-300 inline-flex items-center gap-1 shadow-sm';
                tmBadge.innerHTML = '<i data-lucide="user" class="w-3 h-3 inline"></i> PEDESTRIAN';
            }
        }

        // Re-login / Scan History Notice Banner
        const banner = el(`resHistoryBanner${prefix}${gateKey}`);
        const text = el(`resHistoryText${prefix}${gateKey}`);
        const badge = el(`resHistoryBadge${prefix}${gateKey}`);
        if (banner && text) {
            if (result.historyNotice) {
                text.textContent = result.historyNotice;
                const icon = banner.querySelector('svg, i');
                if (badge) {
                    badge.textContent = result.historyBadge || 'HISTORY';
                    if (result.historyBadge === 'RE-LOGIN' || result.status === 'PENDING_CONFIRMATION' || result.historyBadge === 'NO ENTRY RECORD' || result.historyBadge === 'RE-EXIT') {
                        banner.className = (prefix === 'Dual' ? 'mt-2 p-2 text-[11px]' : 'mt-3 p-3 text-xs') + ' rounded-xl bg-amber-50 border border-amber-300 flex items-center justify-between text-amber-900';
                        badge.className = (prefix === 'Dual' ? 'px-1.5 py-0.5 text-[9px]' : 'px-2 py-0.5 text-[10px]') + ' shrink-0 rounded font-mono font-bold bg-amber-200 text-amber-900 uppercase';
                        if (icon) {
                            icon.classList.remove('text-emerald-600', 'text-blue-600');
                            icon.classList.add('text-amber-600');
                        }
                    } else if (result.historyBadge === 'VERIFIED') {
                        if (gateKey === 'Entry') {
                            banner.className = (prefix === 'Dual' ? 'mt-2 p-2 text-[11px]' : 'mt-3 p-3 text-xs') + ' rounded-xl bg-emerald-50 border border-emerald-200 flex items-center justify-between text-emerald-900';
                            badge.className = (prefix === 'Dual' ? 'px-1.5 py-0.5 text-[9px]' : 'px-2 py-0.5 text-[10px]') + ' shrink-0 rounded font-mono font-bold bg-emerald-200 text-emerald-800 uppercase';
                            if (icon) {
                                icon.classList.remove('text-amber-600', 'text-blue-600');
                                icon.classList.add('text-emerald-600');
                            }
                        } else {
                            banner.className = (prefix === 'Dual' ? 'mt-2 p-2 text-[11px]' : 'mt-3 p-3 text-xs') + ' rounded-xl bg-blue-50 border border-blue-200 flex items-center justify-between text-blue-900';
                            badge.className = (prefix === 'Dual' ? 'px-1.5 py-0.5 text-[9px]' : 'px-2 py-0.5 text-[10px]') + ' shrink-0 rounded font-mono font-bold bg-blue-200 text-blue-800 uppercase';
                            if (icon) {
                                icon.classList.remove('text-amber-600', 'text-emerald-600');
                                icon.classList.add('text-blue-600');
                            }
                        }
                    } else {
                        banner.className = (prefix === 'Dual' ? 'mt-2 p-2 text-[11px]' : 'mt-3 p-3 text-xs') + ' rounded-xl bg-slate-50 border border-slate-200 flex items-center justify-between text-slate-800';
                        badge.className = (prefix === 'Dual' ? 'px-1.5 py-0.5 text-[9px]' : 'px-2 py-0.5 text-[10px]') + ' shrink-0 rounded font-mono font-bold bg-slate-200 text-slate-800 uppercase';
                        if (icon) {
                            icon.classList.remove('text-amber-600', 'text-emerald-600', 'text-blue-600');
                            icon.classList.add('text-slate-500');
                        }
                    }
                }
                banner.classList.remove('hidden');
            } else {
                banner.classList.add('hidden');
            }
        }

        if(el(`scanResultEmpty${prefix}${gateKey}`)) el(`scanResultEmpty${prefix}${gateKey}`).classList.add('hidden');
        if(el(`scanResultData${prefix}${gateKey}`))  el(`scanResultData${prefix}${gateKey}`).classList.remove('hidden');
    });
}

// =====================
// DUPLICATE ENTRY / RE-LOGIN CONFIRMATION
// =====================
let pendingDuplicate = null;

window.openDuplicateModal = function(result, formattedTime, uid, direction = 'ENTRY', conflictType = 'RE_ENTRY_FORGOT_EXIT') {
    const m = document.getElementById('duplicateEntryModal');
    if (!m) return;

    const el = (id) => document.getElementById(id);
    const isEntry = direction === 'ENTRY';

    if (el('dupModalDriver')) el('dupModalDriver').textContent = result.name || '--';
    if (el('dupModalPlate')) el('dupModalPlate').textContent = result.plate || result.cpass_id || '--';
    if (el('dupModalUid')) el('dupModalUid').textContent = uid || result.uid || '--';
    if (el('dupModalPrevTime')) el('dupModalPrevTime').textContent = formattedTime || '--:--';

    const header = el('dupModalHeader');
    const title = el('dupModalTitle');
    const sub = el('dupModalSub');
    const msg = el('dupModalMessage');
    const histLabel = el('dupModalHistoryLabel');
    const prompt = el('dupModalPrompt');
    const confirmBtn = el('dupModalConfirmBtn');
    const confirmText = el('dupModalConfirmText');

    if (isEntry) {
        if (header) header.className = 'p-6 bg-gradient-to-r from-amber-500 to-orange-500 text-white flex items-center gap-4';
        if (title) title.textContent = 'Re-Login Detected (Inside Campus)';
        if (sub) sub.textContent = 'User entered earlier & forgot to tap exit';
        if (msg) msg.textContent = `This user (${result.name}) already entered campus on ${formattedTime} and has no logged departure. They likely forgot to tap exit.`;
        if (histLabel) histLabel.textContent = 'Previous Entry:';
        if (prompt) prompt.textContent = 'Allow re-login and record a new campus entry?';
        if (confirmText) confirmText.textContent = 'Allow Re-Login';
        if (confirmBtn) confirmBtn.className = 'flex-1 px-4 py-3 rounded-xl bg-amber-600 text-white text-sm font-bold hover:bg-amber-700 shadow-md transition-all flex items-center justify-center gap-1.5';
    } else {
        if (conflictType === 'EXIT_NO_ENTRY') {
            if (header) header.className = 'p-6 bg-gradient-to-r from-blue-600 to-indigo-600 text-white flex items-center gap-4';
            if (title) title.textContent = 'No Prior Entry Record';
            if (sub) sub.textContent = 'Vehicle exiting without entry scan';
            if (msg) msg.textContent = `No entry transaction was recorded for this RFID card today. The user may have entered without scanning in.`;
            if (histLabel) histLabel.textContent = 'Status:';
            if (prompt) prompt.textContent = 'Verify user identity and permit exit departure?';
            if (confirmText) confirmText.textContent = 'Permit Exit';
            if (confirmBtn) confirmBtn.className = 'flex-1 px-4 py-3 rounded-xl bg-blue-600 text-white text-sm font-bold hover:bg-blue-700 shadow-md transition-all flex items-center justify-center gap-1.5';
        } else {
            if (header) header.className = 'p-6 bg-gradient-to-r from-amber-600 to-rose-600 text-white flex items-center gap-4';
            if (title) title.textContent = 'Duplicate Exit Attempt';
            if (sub) sub.textContent = 'Exit departure already recorded';
            if (msg) msg.textContent = `This RFID card already recorded an exit on ${formattedTime}. Duplicate exit scan detected.`;
            if (histLabel) histLabel.textContent = 'Previous Exit:';
            if (prompt) prompt.textContent = 'Allow secondary departure record?';
            if (confirmText) confirmText.textContent = 'Allow Departure';
            if (confirmBtn) confirmBtn.className = 'flex-1 px-4 py-3 rounded-xl bg-rose-600 text-white text-sm font-bold hover:bg-rose-700 shadow-md transition-all flex items-center justify-center gap-1.5';
        }
    }

    m.classList.remove('hidden');
    setTimeout(() => {
        m.classList.remove('opacity-0');
        if (m.firstElementChild) m.firstElementChild.classList.remove('scale-95');
    }, 10);
    lucide.createIcons();
};

window.closeDuplicateModal = function(isConfirmed = false) {
    const m = document.getElementById('duplicateEntryModal');
    if (!m) return;
    m.classList.add('opacity-0');
    if (m.firstElementChild) m.firstElementChild.classList.add('scale-95');
    setTimeout(() => {
        m.classList.add('hidden');
        if (!isConfirmed && pendingDuplicate) {
            const gateKey = pendingDuplicate.gateKey || (pendingDuplicate.direction === 'ENTRY' ? 'Entry' : 'Exit');
            showToast('Scan conflict cancelled/denied by guard.', 'info');
            resetGateScanner(gateKey);
            pendingDuplicate = null;
        }
    }, 300);
};

window.confirmDuplicateEntry = async function() {
    if (!pendingDuplicate) return;
    const { uid, result, userId, gateKey, direction, conflictType, historyDetails } = pendingDuplicate;
    const isEntry = (direction || 'ENTRY') === 'ENTRY';
    const effectiveGateKey = gateKey || (isEntry ? 'Entry' : 'Exit');

    try {
        const hasRealVehicle = result.vehicle_id && result.plate && result.plate !== '--' && result.plate !== 'N/A' && result.plate !== 'PEDESTRIAN' && result.plate !== 'NONE' && result.type !== 'None' && result.type !== 'Walking / Pedestrian';
        const isPed = !hasRealVehicle || result.user_type === 'PEDESTRIAN' || result.rfid_type === 'CLOSE_RANGE' || result.type === 'None' || result.plate === 'PEDESTRIAN' || result.type === 'Walking / Pedestrian' || result.role === 'PEDESTRIAN';
        const userType = isPed ? 'PEDESTRIAN' : 'VEHICLE';
        const rfidType = isPed ? 'CLOSE_RANGE' : 'LONG_RANGE';
        const gate = isEntry ? (isPed ? 'CHARRMPASS_GATE_ENTRY' : 'ENTRY_GATE') : (isPed ? 'CHARRMPASS_GATE_EXIT' : 'EXIT_GATE');

        const remarks = isEntry
            ? `Re-login confirmed by guard (User entered previously at ${historyDetails || 'prior time'} & forgot to tap exit)`
            : (conflictType === 'EXIT_NO_ENTRY'
                ? `Exit confirmed by guard (No prior entry record on file)`
                : `Secondary exit confirmed by guard (Prior exit was ${historyDetails || 'prior time'})`);

        if (isConnected) {
            await supabaseClient.from('transactions').insert({
                rfid_uid: uid,
                direction: isEntry ? 'ENTRY' : 'EXIT',
                gate: gate,
                vehicle_id: result.vehicle_id || null,
                user_id: userId || null,
                user_type: userType,
                rfid_type: rfidType,
                status: 'AUTHORIZED',
                remarks: remarks
            });
        }

        if (isEntry) {
            appState.entriesToday++;
            appState.vehiclesInside = (appState.vehiclesInside || 0) + 1;
        } else {
            appState.exitsToday++;
            appState.vehiclesInside = Math.max(0, (appState.vehiclesInside || 0) - 1);
        }

        result.event = isEntry ? 'ENTRY' : 'EXIT';
        result.status = 'AUTHORIZED';
        result.time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
        result.historyNotice = isEntry
            ? `Re-login allowed (Prior entry: ${historyDetails || 'earlier'})`
            : `Exit allowed (${conflictType === 'EXIT_NO_ENTRY' ? 'Manual override' : 'Prior: ' + historyDetails})`;
        result.historyBadge = 'RE-LOGGED';
        appState.recentScans.unshift(result);

        // Update scanner visual to green/blue authorized state
        ['', 'Dual'].forEach(prefix => {
            const radar = document.getElementById(`radarContainer${prefix}${effectiveGateKey}`);
            const scanStatusText = document.getElementById(`scanStatusText${prefix}${effectiveGateKey}`);
            const radarCenter = document.getElementById(`radarCenter${prefix}${effectiveGateKey}`);
            const scanSubtext = document.getElementById(`scanSubtext${prefix}${effectiveGateKey}`);
            const statusLabel = document.getElementById(`resStatusLabel${prefix}${effectiveGateKey}`);

            if (radar) {
                radar.parentElement.classList.remove('status-denied');
                radar.parentElement.classList.add('status-authorized');
            }
            if (scanStatusText) {
                scanStatusText.textContent = isEntry ? 'RE-LOGIN AUTHORIZED' : 'EXIT AUTHORIZED';
                scanStatusText.className = `text-sm sm:text-xl font-bold font-display ${isEntry ? 'text-green-600' : 'text-blue-600'} mb-1 sm:mb-2`;
            }
            if (radarCenter) radarCenter.innerHTML = '<i data-lucide="check" class="w-6 h-6 sm:w-10 sm:h-10 text-white"></i>';
            if (scanSubtext) scanSubtext.textContent = remarks;

            if (statusLabel) {
                statusLabel.className = isEntry
                    ? 'px-2.5 sm:px-4 py-1 sm:py-2 rounded-xl font-bold text-xs sm:text-sm tracking-wide shadow-sm border bg-green-50 border-green-200 text-green-700'
                    : 'px-2.5 sm:px-4 py-1 sm:py-2 rounded-xl font-bold text-xs sm:text-sm tracking-wide shadow-sm border bg-blue-50 border-blue-200 text-blue-700';
                statusLabel.innerHTML = isEntry ? '✓ RE-LOGIN ALLOWED' : '✓ EXIT ALLOWED';
            }
        });

        populateScanResultCard(result, effectiveGateKey);

        showToast(`${isEntry ? 'Re-login' : 'Exit'} recorded and allowed for ${result.name}!`, 'success');
        closeDuplicateModal(true);
        pendingDuplicate = null;
        renderAll();
        lucide.createIcons();

        if (gateResetTimers[effectiveGateKey]) clearTimeout(gateResetTimers[effectiveGateKey]);
        gateResetTimers[effectiveGateKey] = setTimeout(() => {
            resetGateScanner(effectiveGateKey);
            gateResetTimers[effectiveGateKey] = null;
        }, 7000);
    } catch(err) {
        showToast('Error saving re-login: ' + err.message, 'error');
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

        const banner = document.getElementById(`resHistoryBanner${prefix}${gateKey}`);
        if (banner) banner.classList.add('hidden');

        const tmBadge = document.getElementById(`resTransitMode${prefix}${gateKey}`);
        if (tmBadge) tmBadge.classList.add('hidden');
    });

    // Reset Traffic Light back to RED STANDBY
    updateTrafficLightWidget(gateKey, 'standby');

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
