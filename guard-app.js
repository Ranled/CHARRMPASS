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
    'B7 78 96 31': { uid:'B7 78 96 31', name:'Juan Dela Cruz', role:'Student', program:'BSIT', section:'3A', type:'Car', model:'Honda Civic', plate:'XYZ-123', color:'Black', status:'AUTHORIZED' },
    'UID67890': { uid:'UID67890', name:'Maria Santos', role:'Faculty', program:'Engineering', section:'--', type:'SUV', model:'Toyota Fortuner', plate:'ABC-789', color:'White', status:'AUTHORIZED' },
    'UID55555': { uid:'UID55555', name:'Carlos Reyes', role:'Staff', program:'Admin', section:'--', type:'Motorcycle', model:'Yamaha NMAX', plate:'DEF-456', color:'Silver', status:'AUTHORIZED' },
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
                    users ( full_name, role, program, section, profile_image ),
                    vehicles ( plate_number, vehicle_type, vehicle_model, vehicle_color )
                `)
                .order('timestamp', { ascending: false })
                .limit(50);
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
                    let role = l.users?.role;

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
                        } else if (l.remarks.includes('Emergency') || l.remarks.includes('EMERGENCY')) {
                            const match = l.remarks.match(/Emergency (?:tag|Response):\s*(.+)/i);
                            name = match ? match[1].trim() : 'Emergency Response';
                            plate = 'EMERGENCY';
                            role = 'EMERGENCY';
                        }
                    }

                    // 2. Fallback to special_tags
                    if (!name && special) {
                        if (special.type === 'EMERGENCY') {
                            name = special.label || 'Emergency Response';
                            plate = 'EMERGENCY';
                            role = 'EMERGENCY';
                        } else if (special.type === 'VISITOR') {
                            name = (special.label && special.label !== 'Reusable Visitor Tag') ? special.label : 'Visitor';
                            plate = special.description?.match(/Plate:\s*([^|]+)/)?.[1]?.trim() || 'VISITOR PASS';
                            role = 'VISITOR';
                        }
                    }

                    if (!name) name = l.status === 'DENIED' ? 'Unregistered Card' : 'Authorized User';
                    if (!plate) plate = l.rfid_uid ? l.rfid_uid.substring(0, 12) : '--';
                    if (!role) role = '--';

                    return {
                        uid:    l.rfid_uid,
                        name:   name,
                        role:   role,
                        plate:  plate,
                        status: l.status === 'DENIED' ? 'DENIED' : 'AUTHORIZED',
                        event:  l.direction || 'ENTRY',
                        duration: '--',
                        time:   new Date(l.timestamp).toLocaleTimeString('en-US',{hour12:false,hour:'2-digit',minute:'2-digit'})
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
            appState.recentScans.push({ uid: u.uid, name: u.name, role: u.role, plate: u.plate, status: u.status, event: i%2===0?'ENTRY':'EXIT', duration: i%2===0?'INSIDE':'15m', time: new Date(Date.now()-i*900000).toLocaleTimeString('en-US',{hour12:false,hour:'2-digit',minute:'2-digit'}) });
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
let currentActiveView = 'entry';

function switchView(view) {
    currentActiveView = view;
    document.querySelectorAll('.app-view').forEach(v => { v.classList.add('hidden'); v.classList.remove('flex'); });
    const target = document.getElementById('view-' + view);
    if (target) { target.classList.remove('hidden'); target.classList.add('flex'); }
    document.querySelectorAll('.sidebar-item').forEach(s => s.classList.remove('active'));
    const nav = document.getElementById('nav-' + view);
    if (nav) nav.classList.add('active');
    renderAll();
}
window.switchView = switchView;

// =====================
// LOGS FILTERING
// =====================
let currentLogFilter = 'ALL';

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

    let filtered = appState.recentScans || [];
    if (currentLogFilter === 'ENTRY') filtered = filtered.filter(s => s.event === 'ENTRY');
    if (currentLogFilter === 'EXIT') filtered = filtered.filter(s => s.event === 'EXIT');

    if (filtered.length > 0) {
        table.innerHTML = filtered.map(s => `
            <tr class="hover:bg-white/60 border-b border-slate-100/50 transition-colors">
                <td class="p-4 text-slate-500 font-medium">${s.time}</td>
                <td class="p-4 text-xs font-mono font-bold text-slate-600">${s.uid || '--'}</td>
                <td class="p-4 font-bold text-slate-800">${s.name || '--'}</td>
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
    if(el('statTotal'))     el('statTotal').textContent     = appState.totalVehicles || appState.users.length;
    if(el('statEntries'))   el('statEntries').textContent   = appState.entriesToday;
    if(el('statExits'))     el('statExits').textContent     = appState.exitsToday;
    if(el('statAvailable')) el('statAvailable').textContent = inside + ' inside';

    renderLogsTable();

    // Render Recent Entries List
    const entryContainer = el('recentScansContainerEntry');
    if (entryContainer) {
        const entries = (appState.recentScans || []).filter(s => s.event === 'ENTRY').slice(0, 8);
        if (entries.length > 0) {
            entryContainer.innerHTML = entries.map(s => renderRecentScanCard(s, 'ENTRY')).join('');
        } else {
            entryContainer.innerHTML = `<div class="text-center text-slate-400 text-sm py-8"><i data-lucide="inbox" class="w-8 h-8 mx-auto mb-2 text-slate-300"></i>No entries yet</div>`;
        }
    }

    // Render Recent Exits List
    const exitContainer = el('recentScansContainerExit');
    if (exitContainer) {
        const exits = (appState.recentScans || []).filter(s => s.event === 'EXIT').slice(0, 8);
        if (exits.length > 0) {
            exitContainer.innerHTML = exits.map(s => renderRecentScanCard(s, 'EXIT')).join('');
        } else {
            exitContainer.innerHTML = `<div class="text-center text-slate-400 text-sm py-8"><i data-lucide="inbox" class="w-8 h-8 mx-auto mb-2 text-slate-300"></i>No exits yet</div>`;
        }
    }

    try { lucide.createIcons(); } catch(e){}
}

function renderRecentScanCard(s, type) {
    const isAuth = s.status === 'AUTHORIZED';
    const isEntry = type === 'ENTRY';
    const icon = isAuth ? (isEntry ? 'log-in' : 'log-out') : 'x';
    const badgeBg = isAuth ? (isEntry ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700') : 'bg-red-100 text-red-700';

    return `
        <div class="bg-white/80 p-3 rounded-2xl border border-white shadow-sm flex items-center gap-3">
            <div class="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${badgeBg}">
                <i data-lucide="${icon}" class="w-5 h-5"></i>
            </div>
            <div class="flex-1 overflow-hidden">
                <div class="flex justify-between items-center mb-0.5">
                    <span class="font-bold text-sm text-slate-800 truncate">${s.name || '--'}</span>
                    <span class="text-[10px] font-bold text-slate-400">${s.time || '--'}</span>
                </div>
                <div class="flex items-center gap-2">
                    <span class="text-xs font-mono font-bold text-slate-700 bg-slate-100 px-1.5 py-0.5 rounded">${s.plate || s.uid?.substring(0, 8) || '--'}</span>
                    <span class="text-[10px] font-bold uppercase ${isAuth ? (isEntry ? 'text-green-600' : 'text-blue-600') : 'text-red-600'}">${s.status || '--'}</span>
                </div>
            </div>
        </div>
    `;
}

// =====================
// MANUAL GATE SCAN TRIGGER
// =====================
window.processManualGateScan = function(direction) {
    const inputId = direction === 'EXIT' ? 'demoUidInputExit' : 'demoUidInputEntry';
    const input = document.getElementById(inputId);
    if (!input) return;
    const uid = input.value.trim();
    if (!uid) {
        showToast('Please enter an RFID UID to scan.', 'warning');
        input.focus();
        return;
    }
    processRFIDScan(uid, null, null, direction);
    input.value = '';
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

    // Smooth tab notification if guard is viewing a different tab
    const targetView = isEntry ? 'entry' : 'exit';
    if (currentActiveView !== targetView && currentActiveView !== 'logs') {
        // Subtle indicator without disrupting current guard work
        const otherNav = document.getElementById(isEntry ? 'nav-entry' : 'nav-exit');
        if (otherNav) {
            otherNav.classList.add('animate-pulse');
            setTimeout(() => otherNav.classList.remove('animate-pulse'), 3000);
        }
    }

    // UI Elements for the active gate
    const radar = document.getElementById(`radarContainer${gateKey}`);
    const scanStatusText = document.getElementById(`scanStatusText${gateKey}`);
    const scanSubtext = document.getElementById(`scanSubtext${gateKey}`);
    const radarCenter = document.getElementById(`radarCenter${gateKey}`);
    const scanEmpty = document.getElementById(`scanResultEmpty${gateKey}`);
    const scanData = document.getElementById(`scanResultData${gateKey}`);

    if (radar) {
        radar.classList.add('scanning');
        radar.parentElement.classList.remove('status-authorized', 'status-denied');
    }
    if (scanStatusText) {
        scanStatusText.textContent = `SCANNING ${direction}...`;
        scanStatusText.className = 'text-xl font-bold font-display text-blue-600 mb-2';
    }
    if (scanSubtext) scanSubtext.textContent = `UID: ${uid}`;
    if (radarCenter) radarCenter.innerHTML = '<i data-lucide="loader-2" class="w-10 h-10 text-blue-500 animate-spin"></i>';

    if (scanEmpty) scanEmpty.classList.add('hidden');
    if (scanData) {
        scanData.classList.remove('hidden');
        scanData.classList.add('opacity-70');
    }

    // Placeholder data
    const el = (id) => document.getElementById(id);
    if(el(`resUid${gateKey}`)) el(`resUid${gateKey}`).textContent = uid;
    if(el(`resName${gateKey}`)) el(`resName${gateKey}`).textContent = 'Verifying credentials...';
    if(el(`resRole${gateKey}`)) el(`resRole${gateKey}`).textContent = 'READING...';
    if(el(`resProgram${gateKey}`)) el(`resProgram${gateKey}`).textContent = 'Fetching vehicle and driver record...';
    if(el(`resPlate${gateKey}`)) el(`resPlate${gateKey}`).textContent = '...';
    if(el(`resVehType${gateKey}`)) el(`resVehType${gateKey}`).textContent = '...';
    if(el(`resVehModel${gateKey}`)) el(`resVehModel${gateKey}`).textContent = '...';
    if(el(`resColor${gateKey}`)) el(`resColor${gateKey}`).textContent = '...';
    if(el(`resStatusLabel${gateKey}`)) {
        el(`resStatusLabel${gateKey}`).className = 'px-4 py-2 rounded-xl font-bold text-sm tracking-wide shadow-sm border bg-amber-50 border-amber-200 text-amber-700 animate-pulse';
        el(`resStatusLabel${gateKey}`).textContent = 'VERIFYING...';
    }
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
                    users ( id, full_name, role, program, section, profile_image )
                `)
                .eq('rfid_uid', uid)
                .maybeSingle();

            if (card && !error) {
                userId = card.users?.id;
                result = {
                    uid:          uid,
                    name:         card.users?.full_name || 'Registered Driver',
                    role:         card.users?.role || '--',
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

                if (radar) {
                    radar.classList.remove('scanning');
                    radar.parentElement.classList.add('status-authorized');
                }
                if (scanStatusText) {
                    scanStatusText.textContent = 'EXIT AUTHORIZED';
                    scanStatusText.className = 'text-xl font-bold font-display text-blue-600 mb-2';
                }
                if (radarCenter) radarCenter.innerHTML = '<i data-lucide="check" class="w-10 h-10 text-white"></i>';
                if (scanSubtext) scanSubtext.textContent = `Visitor ${visitorName} departure logged. Safe travels!`;

                if (el('resStatusLabelExit')) {
                    el('resStatusLabelExit').className = 'px-4 py-2 rounded-xl font-bold text-sm tracking-wide shadow-sm border bg-blue-50 border-blue-200 text-blue-700';
                    el('resStatusLabelExit').innerHTML = '✓ EXIT AUTHORIZED';
                }

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

    if (radar) radar.classList.remove('scanning');
    if (scanData) scanData.classList.remove('opacity-70');

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

            if (radar) radar.parentElement.classList.add('status-authorized');
            if (scanStatusText) {
                scanStatusText.textContent = 'ALREADY ENTERED';
                scanStatusText.className = 'text-xl font-bold font-display text-amber-600 mb-2';
            }
            if (scanSubtext) scanSubtext.textContent = `Entered ${formattedString}. Awaiting guard confirmation.`;
            if (radarCenter) radarCenter.innerHTML = '<i data-lucide="alert-triangle" class="w-10 h-10 text-amber-500"></i>';

            if (el(`resStatusLabel${gateKey}`)) {
                el(`resStatusLabel${gateKey}`).className = 'px-4 py-2 rounded-xl font-bold text-sm tracking-wide shadow-sm border bg-amber-50 border-amber-300 text-amber-800 animate-pulse';
                el(`resStatusLabel${gateKey}`).innerHTML = '⚠️ ALREADY ENTERED';
            }

            // Populate data card
            populateScanResultCard(result, gateKey);
            openDuplicateModal(result, formattedString, uid);
            return;
        }

        if (radar) radar.parentElement.classList.add('status-authorized');
        if (scanStatusText) {
            scanStatusText.textContent = isEntry ? 'ENTRY AUTHORIZED' : 'EXIT AUTHORIZED';
            scanStatusText.className = `text-xl font-bold font-display ${isEntry ? 'text-green-600' : 'text-blue-600'} mb-2`;
        }
        if (radarCenter) radarCenter.innerHTML = '<i data-lucide="check" class="w-10 h-10 text-white"></i>';

        if (el(`resStatusLabel${gateKey}`)) {
            el(`resStatusLabel${gateKey}`).className = isEntry
                ? 'px-4 py-2 rounded-xl font-bold text-sm tracking-wide shadow-sm border bg-green-50 border-green-200 text-green-700'
                : 'px-4 py-2 rounded-xl font-bold text-sm tracking-wide shadow-sm border bg-blue-50 border-blue-200 text-blue-700';
            el(`resStatusLabel${gateKey}`).innerHTML = isEntry ? '✓ ENTRY AUTHORIZED' : '✓ EXIT AUTHORIZED';
        }

        if (scanSubtext) scanSubtext.textContent = isEntry ? 'Welcome to campus! Entry logged.' : 'Vehicle departure recorded. Safe travels!';

        // Log transaction if manual scan
        if (!fromRealtimeTxn && isConnected) {
            await supabaseClient.from('transactions').insert({
                rfid_uid: uid,
                direction: direction,
                gate: isEntry ? 'ENTRY_GATE' : 'EXIT_GATE',
                vehicle_id: result.vehicle_id || null,
                user_id: userId || null,
                status: 'AUTHORIZED',
                remarks: `Guard station ${direction}`
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
        if (radar) radar.parentElement.classList.add('status-denied');
        if (scanStatusText) {
            scanStatusText.textContent = 'ACCESS DENIED';
            scanStatusText.className = 'text-xl font-bold font-display text-red-600 mb-2';
        }
        if (radarCenter) radarCenter.innerHTML = '<i data-lucide="x" class="w-10 h-10 text-white"></i>';
        if (scanSubtext) scanSubtext.textContent = 'Unauthorized or unregistered RFID card.';

        if (el(`resStatusLabel${gateKey}`)) {
            el(`resStatusLabel${gateKey}`).className = 'px-4 py-2 rounded-xl font-bold text-sm tracking-wide shadow-sm border bg-red-50 border-red-200 text-red-700';
            el(`resStatusLabel${gateKey}`).innerHTML = '✗ ACCESS DENIED';
        }

        if (!fromRealtimeTxn && isConnected) {
            await supabaseClient.from('transactions').insert({
                rfid_uid: uid,
                direction: direction,
                gate: isEntry ? 'ENTRY_GATE' : 'EXIT_GATE',
                status: 'DENIED',
                remarks: 'Unauthorized RFID card'
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
    if (el(`resIconContainer${gateKey}`) && el(`resProfileImage${gateKey}`)) {
        if (isVisitor) {
            el(`resIconContainer${gateKey}`).classList.remove('hidden');
            el(`resProfileImage${gateKey}`).classList.add('hidden');
        } else {
            el(`resIconContainer${gateKey}`).classList.add('hidden');
            el(`resProfileImage${gateKey}`).classList.remove('hidden');
            el(`resProfileImage${gateKey}`).src = result.profileImage || `https://ui-avatars.com/api/?name=${encodeURIComponent(result.name)}&background=0E4B3A&color=fff&size=200`;
        }
    }

    if(el(`resName${gateKey}`))    el(`resName${gateKey}`).textContent = result.name;
    if(el(`resRole${gateKey}`))    el(`resRole${gateKey}`).textContent = result.role;
    if(el(`resProgram${gateKey}`)) el(`resProgram${gateKey}`).textContent = `${result.program || '--'} • ${result.section || '--'}`;
    if(el(`resUid${gateKey}`))     el(`resUid${gateKey}`).textContent = result.uid;
    if(el(`resVehType${gateKey}`)) el(`resVehType${gateKey}`).textContent = result.type;
    if(el(`resPlate${gateKey}`))   el(`resPlate${gateKey}`).textContent = result.plate;
    if(el(`resVehModel${gateKey}`))el(`resVehModel${gateKey}`).textContent = result.model;
    if(el(`resColor${gateKey}`))   el(`resColor${gateKey}`).textContent = result.color;
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
    const radar = document.getElementById(`radarContainer${gateKey}`);
    if (radar) radar.parentElement.classList.remove('status-authorized', 'status-denied');
    const statusText = document.getElementById(`scanStatusText${gateKey}`);
    if (statusText) {
        statusText.textContent = `${gateKey.toUpperCase()} READY`;
        statusText.className = 'text-xl font-bold font-display text-slate-600 mb-2';
    }
    const subtext = document.getElementById(`scanSubtext${gateKey}`);
    if (subtext) subtext.textContent = `Tap card on ${gateKey} reader.`;
    const radarCenter = document.getElementById(`radarCenter${gateKey}`);
    if (radarCenter) radarCenter.innerHTML = '<i data-lucide="nfc" class="w-10 h-10 text-slate-400"></i>';
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
