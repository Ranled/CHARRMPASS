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

function generateSlots() {
    const slots = [];
    for (let i = 1; i <= 10; i++) {
        slots.push({ id: `TM${i}`, slot_number: `TM${String(i).padStart(2,'0')}`, status: Math.random() > 0.6 ? 'OCCUPIED' : 'AVAILABLE' });
    }
    return slots;
}

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

            // Load recent parking logs
            const today = new Date().toISOString().split('T')[0];
            const { data: logs, error: le } = await supabaseClient
                .from('parking_logs')
                .select(`
                    *,
                    users ( full_name, role, program, section, profile_image ),
                    vehicles ( plate_number, vehicle_type, vehicle_model, vehicle_color )
                `)
                .order('entry_time', { ascending: false })
                .limit(50);
            if (le) console.error('Logs fetch error:', le);
            if (logs) {
                appState.recentScans = logs.map(l => ({
                    uid:    l.rfid_uid,
                    name:   l.users?.full_name || 'Unknown',
                    role:   l.users?.role || '--',
                    plate:  l.vehicles?.plate_number || l.rfid_uid,
                    status: l.status === 'DENIED' ? 'DENIED' : 'AUTHORIZED',
                    event:  l.exit_time ? 'EXIT' : (l.status === 'ACTIVE' ? 'ENTRY' : 'ENTRY'),
                    duration: l.duration_minutes != null ? l.duration_minutes + 'm' : (l.exit_time ? '--' : 'INSIDE'),
                    time:   new Date(l.entry_time).toLocaleTimeString('en-US',{hour12:false,hour:'2-digit',minute:'2-digit'})
                }));

                // Active inside = open sessions
                appState.activeVehicles = logs.filter(l => !l.exit_time && l.status === 'ACTIVE');
                appState.vehiclesInside = appState.activeVehicles.length;

                const todayLogs = logs.filter(l => l.entry_time?.startsWith(today));
                appState.entriesToday = todayLogs.length;
                appState.exitsToday   = logs.filter(l => l.exit_time && l.exit_time.startsWith(today)).length;
            }

            const { data: st, error: ste } = await supabaseClient.from('special_tags').select('*');
            if (ste) console.error('Special tags fetch error:', ste);
            if (st) appState.specialTags = st;

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
function switchView(view) {
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
// RENDER ALL
// =====================
function renderAll() {
    const inside = appState.vehiclesInside ?? (appState.activeVehicles?.length || 0);

    const el = (id) => document.getElementById(id);
    if(el('statTotal'))   el('statTotal').textContent   = appState.totalVehicles || appState.users.length;
    if(el('statEntries')) el('statEntries').textContent = appState.entriesToday;
    if(el('statExits'))   el('statExits').textContent   = appState.exitsToday;
    if(el('statAvailable')) el('statAvailable').textContent = inside + ' inside';
    if(el('miniAvail'))   el('miniAvail').textContent   = inside;
    if(el('miniOccup'))   el('miniOccup').textContent   = appState.entriesToday;
    if(el('gridAvail'))   el('gridAvail').textContent   = inside;
    if(el('gridOccup'))   el('gridOccup').textContent   = appState.exitsToday;

    // Slots Monitor - Grouped by Building/Row
    const renderSlots = (containerId) => {
        try {
            const c = el(containerId);
            if (!c) return;
            if (!appState.parkingSlots || appState.parkingSlots.length === 0) {
                c.innerHTML = `<div class="col-span-full text-center p-8 text-slate-400">No parking slots available.</div>`;
                return;
            }

            // Group slots by slot_row
            const groups = {};
            appState.parkingSlots.forEach(s => {
                const row = (s.slot_row || 'Other').toUpperCase();
                if (!groups[row]) groups[row] = [];
                groups[row].push(s);
            });

            const rows = Object.keys(groups).sort();

            c.innerHTML = rows.map(row => {
                const slots = groups[row].sort((a,b) => a.slot_number.localeCompare(b.slot_number, undefined, {numeric:true}));
                
                return `
                    <div class="col-span-full glass-card rounded-2xl p-4 border border-white/60 mb-4">
                        <h4 class="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-4 flex items-center gap-2">
                            <i data-lucide="building-2" class="w-3 h-3"></i> ${row} BUILDING
                        </h4>
                        <div class="grid grid-cols-4 sm:grid-cols-5 md:grid-cols-8 lg:grid-cols-10 gap-2">
                            ${slots.map(s => {
                                const a = s.status === 'AVAILABLE', o = s.status === 'OCCUPIED';
                                const bg = a ? 'bg-charm-light/20 border-charm-light/40 text-charm-dark' : o ? 'bg-red-50 border-red-200 text-red-600' : 'bg-yellow-50 border-yellow-200 text-yellow-700';
                                const dot = a ? 'bg-charm-green' : o ? 'bg-red-500' : 'bg-yellow-400';
                                let occupant = '';
                                if (o && s.current_vehicle) {
                                    const u = (appState.users || []).find(x => x && x.rfid_uid === s.current_vehicle);
                                    occupant = `<div class="text-[9px] font-bold mt-1 text-slate-700 truncate w-full text-center px-1">${u ? u.full_name : s.current_vehicle}</div>`;
                                }
                                return `<div onclick="${o?'showSlotInfo(\''+s.current_vehicle+'\')':''}" class="rounded-xl p-2 border ${bg} flex flex-col items-center justify-center slot-card relative h-20 ${o?'cursor-pointer hover:scale-105 transition-transform':''}"><div class="w-full flex justify-end mb-1"><div class="w-2 h-2 rounded-full ${dot}"></div></div><div class="text-sm font-display font-bold">${s.slot_number}</div><div class="text-[8px] font-bold uppercase mt-1 ${occupant?'hidden':''}">${s.status}</div>${occupant}</div>`;
                            }).join('')}
                        </div>
                    </div>
                `;
            }).join('');
        } catch(e) { console.error('Render slots error:', e); }
    };
    renderSlots('liveScanSlots');
    renderSlots('monitorSlotsContainer');

    // Slot selector options for entry
    const sel = el('slotSelector');
    if (sel) {
        const current = sel.value;
        const available = appState.parkingSlots.filter(s => s.status === 'AVAILABLE')
            .sort((a,b) => a.slot_number.localeCompare(b.slot_number, undefined, {numeric:true}));
        
        sel.innerHTML = '<option value="">-- Choose Parking Slot --</option>' +
            available.map(s => `<option value="${s.id}|${s.slot_number}">${s.slot_number} (${s.slot_row || 'Building'})</option>`).join('');
        if (current) sel.value = current;
    }

    if (el('logsTable')) {
        try {
            if (appState.recentScans && appState.recentScans.length > 0) {
                el('logsTable').innerHTML = appState.recentScans.map(s => `<tr class="hover:bg-white/60 border-b border-slate-100/50"><td class="p-4 text-slate-500">${s.time}</td><td class="p-4 text-xs font-mono text-slate-400">${s.uid || '--'}</td><td class="p-4 font-bold text-slate-800">${s.name || '--'}</td><td class="p-4 text-center"><span class="px-2 py-1 rounded text-[10px] font-bold ${s.event==='ENTRY'?'bg-green-100 text-green-700':'bg-red-100 text-red-700'}">${s.event||s.status||'--'}</span></td><td class="p-4 font-bold">${s.slot||'--'}</td><td class="p-4 text-right"><span class="px-2 py-0.5 rounded text-[10px] font-bold ${s.status==='AUTHORIZED'?'text-green-600 border border-green-200':'text-red-600 border border-red-200'}">●</span></td></tr>`).join('');
            } else {
                el('logsTable').innerHTML = `<tr><td colspan="6" class="p-8 text-center text-slate-400">No scan logs yet</td></tr>`;
            }
        } catch(e) { console.error('Render logs table error:', e); }
    }

    // Recent scans sidebar
    if (el('recentScansContainer')) {
        try {
            if (appState.recentScans && appState.recentScans.length > 0) {
                el('recentScansContainer').innerHTML = appState.recentScans.slice(0,10).map(s => {
                    const isV = s.role === 'VISITOR' || s.isVisitor;
                    const icon = isV ? 'user' : (s.status === 'AUTHORIZED' ? 'check' : 'x');
                    const iconBg = isV ? 'bg-blue-100 text-blue-600' : (s.status === 'AUTHORIZED' ? 'bg-green-100 text-green-600' : 'bg-red-100 text-red-600');
                    return `
                        <div class="bg-white/60 p-3 rounded-xl border border-white shadow-sm flex items-center gap-3">
                            <div class="w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${iconBg}">
                                <i data-lucide="${icon}" class="w-4 h-4"></i>
                            </div>
                            <div class="flex-1 overflow-hidden">
                                <div class="flex justify-between items-center mb-0.5">
                                    <span class="font-bold text-sm text-slate-800 truncate">${s.name||'--'}</span>
                                    <span class="text-[10px] font-bold text-slate-400">${s.time||'--'}</span>
                                </div>
                                <div class="flex items-center gap-2">
                                    <span class="text-xs text-slate-500 font-mono bg-slate-100 px-1.5 rounded">${(s.uid||'--').substring(0,10)}</span>
                                    <span class="text-[10px] font-bold uppercase ${s.status==='AUTHORIZED'?'text-green-600':'text-red-600'}">${s.event||s.status||'--'}</span>
                                </div>
                            </div>
                        </div>`;
                }).join('');
            } else {
                el('recentScansContainer').innerHTML = `<div class="text-center text-slate-400 text-sm py-8"><i data-lucide="inbox" class="w-8 h-8 mx-auto mb-2 text-slate-300"></i>No scans yet</div>`;
            }
        } catch(e) { console.error('Render sidebar error:', e); }
    }
    try { lucide.createIcons(); } catch(e){}
}

function showSlotInfo(uid) {
    if (!uid) return;
    let u = (appState.users || []).find(x => x.rfid_uid === uid);
    const st = appState.specialTags.find(x => x.rfid_uid === uid);

    if (!u && st && st.type === 'VISITOR') {
        u = { full_name: 'Visitor', role: 'VISITOR', program: 'Guest' };
        // Try to find the name from recent logs
        const log = appState.recentScans.find(l => l.uid === uid && (l.visitor_name || l.name));
        if (log) u.full_name = log.visitor_name || log.name;
    }

    if (!u) return;

    document.getElementById('modalName').textContent = u.full_name;
    document.getElementById('modalRole').textContent = u.role;
    document.getElementById('modalProgram').textContent = `${u.program || '--'} • ${u.section || '--'}`;
    document.getElementById('modalPlate').textContent = u.plate_number || '--';
    document.getElementById('modalVehType').textContent = u.vehicle_type || '--';
    document.getElementById('modalVehModel').textContent = u.vehicle_model || '--';
    
    const isV = u.role === 'VISITOR';
    if (isV) {
        document.getElementById('modalIconContainer').classList.remove('hidden');
        document.getElementById('modalProfileImage').classList.add('hidden');
    } else {
        document.getElementById('modalIconContainer').classList.add('hidden');
        document.getElementById('modalProfileImage').classList.remove('hidden');
        document.getElementById('modalProfileImage').src = u.profile_image || `https://ui-avatars.com/api/?name=${encodeURIComponent(u.full_name)}&background=random`;
    }
    document.getElementById('modalVehImage').src = u.motorcycle_image || 'https://images.unsplash.com/photo-1558981403-c5f91cbba527?auto=format&fit=crop&q=80&w=800';

    const m = document.getElementById('slotInfoModal');
    m.classList.remove('hidden');
    setTimeout(() => {
        m.classList.remove('opacity-0');
        document.getElementById('slotInfoContent').classList.remove('scale-95');
    }, 10);
    lucide.createIcons();
}

function closeSlotModal() {
    const m = document.getElementById('slotInfoModal');
    m.classList.add('opacity-0');
    document.getElementById('slotInfoContent').classList.add('scale-95');
    setTimeout(() => m.classList.add('hidden'), 300);
}

window.showSlotInfo = showSlotInfo;
window.closeSlotModal = closeSlotModal;

// =====================
// RFID SCAN — queries Supabase DB for the user
// ================// =====================
// RFID SCAN — queries Supabase DB for the user
// =====================
let pendingLogId = null;
let pendingUserResult = null;

async function processRFIDScan(uid, rawLogId = null) {
    if (!uid) return;
    uid = uid.toUpperCase().trim();
    console.log('🔍 Processing RFID scan:', uid, 'LogID:', rawLogId);
    
    switchView('livescan');
    
    // Show scanning animation
    document.getElementById('radarContainer').classList.add('scanning');
    document.getElementById('scanStatusText').textContent = 'VERIFYING...';
    document.getElementById('scanSubtext').textContent = `UID: ${uid}`;
    document.getElementById('radarCenter').innerHTML = '<i data-lucide="loader-2" id="radarIcon" class="w-10 h-10 text-slate-400 animate-spin"></i>';
    lucide.createIcons();
    document.getElementById('scanResultEmpty').classList.add('hidden');
    const resData = document.getElementById('scanResultData');
    resData.classList.remove('hidden');
    resData.classList.add('opacity-50');

    // Reset UI elements
    document.getElementById('slotAssignmentUI').classList.add('hidden');
    document.getElementById('resSlotNotice').classList.add('hidden');
    document.getElementById('manualOverrideButtons').classList.add('hidden');

    // ---- LOOK UP RFID CARD FROM SUPABASE ----
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
                    name:         card.users?.full_name || 'Unknown',
                    role:         card.users?.role || '--',
                    program:      card.users?.program || '--',
                    section:      card.users?.section || '--',
                    type:         card.vehicles?.vehicle_type || '--',
                    model:        card.vehicles?.vehicle_model || '--',
                    plate:        card.vehicles?.plate_number || '--',
                    color:        card.vehicles?.vehicle_color || '--',
                    vehicle_id:   card.vehicles?.id || null,
                    profileImage: card.users?.profile_image || null,
                    status:       card.authorization_status === 'AUTHORIZED' ? 'AUTHORIZED' : 'UNAUTHORIZED'
                };
                console.log('✅ RFID card found in DB:', result.name, '/', result.status);
            }
        } catch (e) {
            console.error('DB lookup error:', e);
        }
    }
    
    // Fallback to mock users if not found in DB
    if (!result && mockUsers[uid]) {
        result = { ...mockUsers[uid] };
        userId = uid;
    }
    
    // ---- CHECK SPECIAL TAGS ----
    const specialTag = appState.specialTags.find(t => t.rfid_uid === uid);
    if (specialTag) {
        console.log('🚀 Special Tag Detected:', specialTag.type);
        if (specialTag.type === 'EMERGENCY') {
            result = {
                uid, name: specialTag.label || 'Emergency Vehicle',
                role: 'EMERGENCY', status: 'AUTHORIZED', isEmergency: true
            };
        } else if (specialTag.type === 'VISITOR') {
            // Check if already inside via open parking_log
            let isInsideAlready = false;
            if (isConnected) {
                const { data: openLog } = await supabaseClient
                    .from('parking_logs').select('id').eq('rfid_uid', uid).is('exit_time', null).maybeSingle();
                isInsideAlready = !!openLog;
            }
            result = {
                uid, name: specialTag.label || 'Visitor',
                role: 'VISITOR', status: 'AUTHORIZED',
                isVisitor: true, isExit: isInsideAlready, isEntry: !isInsideAlready
            };
        }
    }
    
    if (!result) {
        result = { uid, name: 'Unknown Card', role: '--', program: '--', section: '--', type: '--', model: '--', plate: '--', color: '--', status: 'UNAUTHORIZED' };
    }

    // Small delay for visual effect
    await new Promise(r => setTimeout(r, 800));
    
    document.getElementById('radarContainer').classList.remove('scanning');
    resData.classList.remove('opacity-50');
    
    const isAuth = result.status === 'AUTHORIZED';
    const panel = document.getElementById('radarContainer').parentElement;

    if (isAuth) {
        panel.classList.add('status-authorized'); panel.classList.remove('status-denied');
        document.getElementById('scanStatusText').textContent = 'AUTHORIZED';
        document.getElementById('scanStatusText').className = 'text-xl font-bold font-display text-green-600 mb-2';
        document.getElementById('radarCenter').innerHTML = '<i data-lucide="check" id="radarIcon" class="w-10 h-10 text-white"></i>';

        // 1. EMERGENCY BYPASS (Highest Priority)
        if (result.isEmergency) {
            let isExit = false;
            if (isConnected) {
                const { data: openLog } = await supabaseClient
                    .from('parking_logs').select('id, entry_time').eq('rfid_uid', uid).is('exit_time', null).maybeSingle();
                if (openLog) {
                    isExit = true;
                    const dur = Math.round((new Date() - new Date(openLog.entry_time)) / 60000);
                    await supabaseClient.from('parking_logs').update({ exit_time: new Date().toISOString(), duration_minutes: dur, status: 'COMPLETED' }).eq('id', openLog.id);
                } else {
                    await supabaseClient.from('parking_logs').insert({ rfid_uid: uid, entry_time: new Date().toISOString(), status: 'ACTIVE', remarks: 'EMERGENCY Entry' });
                }
            }
            showToast(`EMERGENCY VEHICLE ${isExit ? 'EXIT' : 'ENTRY'}!`, 'success');
            document.getElementById('scanSubtext').textContent = isExit ? 'Emergency Exit Granted.' : 'Emergency Entry Granted.';
            result.event = isExit ? 'EXIT' : 'ENTRY';
            if (isExit) appState.exitsToday++; else appState.entriesToday++;
            setTimeout(resetScanner, 5000);
            return;
        }

        // 2. CHECK OPEN SESSION (EXIT LOGIC)
        let openSession = null;
        if (isConnected) {
            const { data: os } = await supabaseClient
                .from('parking_logs').select('id, entry_time').eq('rfid_uid', uid).is('exit_time', null).maybeSingle();
            openSession = os || null;
        }

        if (openSession) {
            // EXIT LOGIC — close open session
            document.getElementById('scanSubtext').textContent = 'Goodbye! Safe travels.';
            document.getElementById('resStatusLabel').className = 'px-4 py-2 rounded-xl font-bold text-sm tracking-wide shadow-sm border bg-blue-50 border-blue-200 text-blue-700';
            document.getElementById('resStatusLabel').innerHTML = '✓ EXIT AUTHORIZED';
            document.getElementById('resBadge').className = 'absolute -bottom-2 -right-2 w-8 h-8 rounded-full flex items-center justify-center border-2 border-white text-white shadow-md bg-blue-500';

            if (isConnected) {
                const dur = Math.round((new Date() - new Date(openSession.entry_time)) / 60000);
                await supabaseClient.from('parking_logs').update({
                    exit_time:        new Date().toISOString(),
                    duration_minutes: dur,
                    status:           'COMPLETED'
                }).eq('id', openSession.id);
                appState.vehiclesInside = Math.max(0, (appState.vehiclesInside || 0) - 1);
            }

            document.getElementById('resSlotNotice').classList.remove('hidden');
            document.getElementById('resSlotId').textContent = 'EXIT OK';
            document.getElementById('resSlotNotice').querySelector('.text-charm-dark').textContent = 'Vehicle Logged Out';
            document.getElementById('resSlotNotice').querySelector('.text-slate-700').textContent = 'Session completed.';

            appState.exitsToday++;
            result.event = 'EXIT';
            setTimeout(resetScanner, 5000);
        } else {
            // 3. ENTRY LOGIC — open new session
            document.getElementById('scanSubtext').textContent = 'Welcome! Entry logged.';
            document.getElementById('resStatusLabel').className = 'px-4 py-2 rounded-xl font-bold text-sm tracking-wide shadow-sm border bg-green-50 border-green-200 text-green-700';
            document.getElementById('resStatusLabel').innerHTML = '✓ ENTRY AUTHORIZED';
            document.getElementById('resBadge').className = 'absolute -bottom-2 -right-2 w-8 h-8 rounded-full flex items-center justify-center border-2 border-white text-white shadow-md bg-green-500';

            // VISITOR HANDLING — ask for name before logging
            if (result.isVisitor && result.isEntry) {
                pendingLogId = rawLogId;
                pendingUserResult = { ...result, userId };
                openVisitorModal(uid, rawLogId);
                return;
            }

            // Regular authorized user — auto-log entry
            if (isConnected) {
                await supabaseClient.from('parking_logs').insert({
                    rfid_uid:   uid,
                    vehicle_id: result.vehicle_id || null,
                    user_id:    userId || null,
                    entry_time: new Date().toISOString(),
                    status:     'ACTIVE',
                    remarks:    'Guard station ENTRY'
                });
                appState.vehiclesInside = (appState.vehiclesInside || 0) + 1;
            }

            appState.entriesToday++;
            result.event = 'ENTRY';
            setTimeout(resetScanner, 5000);
        }
    } else {
        // UNAUTHORIZED
        panel.classList.add('status-denied'); panel.classList.remove('status-authorized');
        document.getElementById('scanStatusText').textContent = 'DENIED';
        document.getElementById('scanStatusText').className = 'text-xl font-bold font-display text-red-600 mb-2';
        document.getElementById('scanSubtext').textContent = 'Invalid or unregistered RFID.';
        document.getElementById('radarCenter').innerHTML = '<i data-lucide="x" id="radarIcon" class="w-10 h-10 text-white"></i>';
        document.getElementById('resStatusLabel').className = 'px-4 py-2 rounded-xl font-bold text-sm tracking-wide shadow-sm border bg-red-50 border-red-200 text-red-700';
        document.getElementById('resStatusLabel').innerHTML = '✗ ACCESS DENIED';
        document.getElementById('resBadge').className = 'absolute -bottom-2 -right-2 w-8 h-8 rounded-full flex items-center justify-center border-2 border-white text-white shadow-md bg-red-500';
        document.getElementById('manualOverrideButtons').classList.remove('hidden');
        
        result.event = 'DENIED';
        if (isConnected && rawLogId) {
            supabaseClient.from('parking_logs').update({ scan_type: 'ENTRY', status: 'DENIED', remarks: 'Unregistered RFID' }).eq('id', rawLogId).then();
        }
        
        setTimeout(resetScanner, 5000);
    }

    // Show user info
    const isVisitor = result.role === 'VISITOR' || result.isVisitor;
    if (isVisitor) {
        document.getElementById('resIconContainer').classList.remove('hidden');
        document.getElementById('resProfileImage').classList.add('hidden');
    } else {
        document.getElementById('resIconContainer').classList.add('hidden');
        document.getElementById('resProfileImage').classList.remove('hidden');
        const profileSrc = result.profileImage || `https://ui-avatars.com/api/?name=${encodeURIComponent(result.name)}&background=random&color=fff&size=200`;
        document.getElementById('resProfileImage').src = profileSrc;
    }
    document.getElementById('resName').textContent = result.name;
    document.getElementById('resRole').textContent = result.role;
    document.getElementById('resProgram').textContent = result.program || '--';
    document.getElementById('resUid').textContent = result.uid;
    document.getElementById('resVehType').textContent = result.type;
    document.getElementById('resPlate').textContent = result.plate;
    document.getElementById('resVehModel').textContent = result.model;
    document.getElementById('resColor').textContent = result.color;

    if (result.event) {
        result.time = new Date().toLocaleTimeString('en-US',{hour12:false,hour:'2-digit',minute:'2-digit'});
        appState.recentScans.unshift(result);
    }

    lucide.createIcons();
    renderAll();
}

function resetScanner() {
    const panel = document.getElementById('radarContainer').parentElement;
    panel.classList.remove('status-authorized','status-denied');
    document.getElementById('scanStatusText').textContent = 'READY';
    document.getElementById('scanStatusText').className = 'text-xl font-bold font-display text-slate-600 mb-2';
    document.getElementById('scanSubtext').textContent = 'Place card near reader.';
    document.getElementById('radarCenter').innerHTML = '<i data-lucide="nfc" id="radarIcon" class="w-10 h-10 text-slate-400"></i>';
    lucide.createIcons();
}

// Confirm Visitor Entry Button (slot assignment removed — auto-log)
document.getElementById('btnConfirmAssign')?.addEventListener('click', async () => {
    if (!pendingUserResult) return;
    
    document.getElementById('slotAssignmentUI').classList.add('hidden');
    document.getElementById('slotAssignmentUI').classList.remove('flex');

    if (isConnected) {
        await supabaseClient.from('parking_logs').insert({
            rfid_uid:   pendingUserResult.uid,
            vehicle_id: pendingUserResult.vehicle_id || null,
            user_id:    pendingUserResult.userId || null,
            entry_time: new Date().toISOString(),
            status:     'ACTIVE',
            remarks:    pendingUserResult.isVisitor ? `Visitor: ${pendingUserResult.name}` : 'Guard station ENTRY'
        });
        appState.vehiclesInside = (appState.vehiclesInside || 0) + 1;
    }

    appState.entriesToday++;
    pendingUserResult.event = 'ENTRY';
    pendingUserResult.time = new Date().toLocaleTimeString('en-US',{hour12:false,hour:'2-digit',minute:'2-digit'});
    appState.recentScans.unshift(pendingUserResult);

    pendingLogId = null;
    pendingUserResult = null;

    renderAll();
    setTimeout(resetScanner, 4000);
});

// =====================
// TAB SWITCHING
// =====================
const tabSR = document.getElementById('tabScanResult'), tabPG = document.getElementById('tabParkingGrid');
const viewSR = document.getElementById('viewScanResult'), viewPG = document.getElementById('viewParkingGrid');
if (tabSR && tabPG) {
    tabSR.addEventListener('click', () => { tabSR.classList.add('text-charm-dark','border-b-2','border-charm-dark'); tabSR.classList.remove('text-slate-400'); tabPG.classList.remove('text-charm-dark','border-b-2','border-charm-dark'); tabPG.classList.add('text-slate-400'); viewSR.classList.remove('hidden'); viewSR.classList.add('flex'); viewPG.classList.add('hidden'); viewPG.classList.remove('flex'); });
    tabPG.addEventListener('click', () => { tabPG.classList.add('text-charm-dark','border-b-2','border-charm-dark'); tabPG.classList.remove('text-slate-400'); tabSR.classList.remove('text-charm-dark','border-b-2','border-charm-dark'); tabSR.classList.add('text-slate-400'); viewPG.classList.remove('hidden'); viewPG.classList.add('flex'); viewSR.classList.add('hidden'); viewSR.classList.remove('flex'); renderAll(); });
}

// =====================
// BUTTONS
// =====================
document.getElementById('btnDemoScan')?.addEventListener('click', () => {
    const uid = document.getElementById('demoUidInput').value.trim();
    if (uid) {
        // Manual simulation
        processRFIDScan(uid);
        document.getElementById('demoUidInput').value = '';
    } else {
        // Visual waiting state for real hardware scan via Realtime
        switchView('livescan');
        document.getElementById('scanResultData').classList.add('hidden');
        document.getElementById('scanResultEmpty').classList.remove('hidden');
        
        document.getElementById('radarContainer').classList.add('scanning');
        document.getElementById('radarContainer').parentElement.classList.remove('status-authorized', 'status-denied');
        
        document.getElementById('scanStatusText').textContent = 'WAITING FOR HARDWARE...';
        document.getElementById('scanStatusText').className = 'text-xl font-bold font-display text-blue-600 mb-2';
        document.getElementById('scanSubtext').textContent = 'Listening for database updates.';
        document.getElementById('radarCenter').innerHTML = '<i data-lucide="loader-2" id="radarIcon" class="w-10 h-10 text-blue-500 animate-spin"></i>';
        lucide.createIcons();
        showToast('Waiting for RFID card to be tapped on the ESP32 reader...', 'info');
    }
});

document.getElementById('btnAllow')?.addEventListener('click', () => {
    showToast('Manual Override: Entry Allowed.','success');
    document.getElementById('scanResultData').classList.add('hidden');
    document.getElementById('scanResultEmpty').classList.remove('hidden');
});

document.getElementById('btnDenyEntryAlt')?.addEventListener('click', () => {
    document.getElementById('btnDeny').click();
});

document.getElementById('btnDeny')?.addEventListener('click', () => {
    showToast('Entry explicitly denied by guard.', 'error');
    
    if (pendingUserResult) {
        // Record in database if connected
        if (isConnected) {
            if (pendingLogId) {
                supabaseClient.from('parking_logs').update({ scan_type: 'ENTRY', status: 'DENIED', user_id: pendingUserResult.userId, remarks: 'Denied by Guard' }).eq('id', pendingLogId).then();
            } else {
                supabaseClient.from('parking_logs').insert({ scan_type: 'ENTRY', status: 'DENIED', user_id: pendingUserResult.userId, rfid_uid: pendingUserResult.uid, remarks: 'Manual Deny' }).then();
            }
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

    // Listen for new parking_logs (ESP32 ENTRY events)
    supabaseClient.channel('guard-logs-insert')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'parking_logs' }, async (payload) => {
            console.log('📡 New scan INSERT from DB:', payload.new);
            const uid = payload.new.rfid_uid;
            // Only process if status is ACTIVE (real entry from ESP32 Edge Function)
            if (uid && payload.new.status === 'ACTIVE') {
                await initState(); // Reload all state with fresh data
            }
        })
        .subscribe((status) => console.log('Realtime parking_logs INSERT:', status));

    // Listen for parking_log UPDATES (EXIT events from ESP32)
    supabaseClient.channel('guard-logs-update')
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'parking_logs' }, async (payload) => {
            console.log('📡 Scan UPDATE (likely EXIT) from DB:', payload.new);
            if (payload.new.status === 'COMPLETED') {
                await initState(); // Reload all state
            }
        })
        .subscribe((status) => console.log('Realtime parking_logs UPDATE:', status));

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
let visitorPendingLogId = null;

window.openVisitorModal = function(uid, logId) {
    visitorPendingUid = uid;
    visitorPendingLogId = logId;
    document.getElementById('visitorNameInput').value = '';
    const m = document.getElementById('visitorModal');
    m.classList.remove('hidden');
    setTimeout(() => { m.classList.remove('opacity-0'); m.firstElementChild.classList.remove('scale-95'); }, 10);
};

window.closeVisitorModal = function() {
    const m = document.getElementById('visitorModal');
    m.classList.add('opacity-0'); m.firstElementChild.classList.add('scale-95');
    setTimeout(() => { m.classList.add('hidden'); resetScanner(); }, 300);
};

window.confirmVisitorEntry = async function() {
    const name = document.getElementById('visitorNameInput').value.trim();
    if (!name) { showToast('Please enter visitor name.', 'warning'); return; }
    
    // Now show slot assignment UI
    closeVisitorModal();
    
    // Update pending result name
    if (pendingUserResult) {
        pendingUserResult.name = name;
        document.getElementById('resName').textContent = name;
    }

    document.getElementById('scanSubtext').textContent = `Visitor: ${name}. Assign slot.`;
    document.getElementById('slotAssignmentUI').classList.remove('hidden');
    document.getElementById('slotAssignmentUI').classList.add('flex');
    
    showToast(`Visitor ${name} identified. Now select a parking slot.`, 'info');
};

// =====================
// GUARD PROFILE EDIT
// =====================
document.getElementById('profileTrigger')?.addEventListener('click', () => {
    const m = document.getElementById('profileEditModal');
    const name = document.getElementById('guardName').textContent;
    const role = document.getElementById('guardRole').textContent;
    
    document.getElementById('editGuardName').value = name;
    document.getElementById('editGuardRole').value = role;
    
    m.classList.remove('hidden');
    setTimeout(() => {
        m.classList.remove('opacity-0');
        m.firstElementChild.classList.remove('scale-95');
    }, 10);
});

window.closeProfileModal = function() {
    const m = document.getElementById('profileEditModal');
    m.classList.add('opacity-0');
    m.firstElementChild.classList.add('scale-95');
    setTimeout(() => m.classList.add('hidden'), 300);
};

window.saveProfile = function() {
    const name = document.getElementById('editGuardName').value.trim();
    const role = document.getElementById('editGuardRole').value.trim();
    
    if (!name || !role) {
        showToast('Please fill in both fields.', 'warning');
        return;
    }
    
    document.getElementById('guardName').textContent = name;
    document.getElementById('guardRole').textContent = role;
    document.getElementById('guardAvatar').src = `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=0E4B3A&color=fff`;
    
    localStorage.setItem('charrmpass_guard', JSON.stringify({ name, role }));
    showToast('Profile updated successfully!', 'success');
    closeProfileModal();
};

// =====================
// INIT
// =====================
initState();
lucide.createIcons();
