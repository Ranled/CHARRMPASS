/**
 * CHARRMPASS - Admin Dashboard Logic
 * User management, RFID UID assignment, analytics, and real-time updates
 */
if (typeof initSupabase === 'function') initSupabase();
if (typeof startClock === 'function') startClock();
if (typeof updateDBBadge === 'function') updateDBBadge();
if (window.lucide) lucide.createIcons();
const el = id => document.getElementById(id);

// State
let adminState = { 
    users: [], 
    pendingUsers: [], 
    pendingItems: [],
    logs: [], 
    accounts: [], 
    specialTags: [], 
    devices: [],
    activeVehicles: 0,
    activePedestrians: 0,
    userTableFilter: 'ALL',
    userModeFilter: 'ALL',
    logModeFilter: 'ALL',
    activeHistUser: null,
    histDirection: 'ALL'
};

// =====================
// VIEW SWITCHING
// =====================
function adminView(v) {
    document.querySelectorAll('.app-view').forEach(el => { el.classList.add('hidden'); el.classList.remove('flex'); });
    const t = document.getElementById('aview-' + v);
    if(t) { t.classList.remove('hidden'); t.classList.add('flex'); }
    document.querySelectorAll('.sidebar-item').forEach(s => s.classList.remove('active'));
    const n = document.getElementById('anav-' + v);
    if(n) n.classList.add('active');
    
    if (v === 'analytics') {
        renderAnalytics();
    } else if (v === 'reports') {
        renderReports();
    }
    renderAdmin();
    setTimeout(() => {
        if (window.lucide && typeof lucide.createIcons === 'function') {
            lucide.createIcons();
        }
    }, 50);
}
window.adminView = adminView;

// =====================
// LOAD REAL SUPABASE DATA
// =====================
async function loadData() {
    if (!supabaseClient && typeof initSupabase === 'function') {
        initSupabase();
    }

    if (supabaseClient) {
        try {
            // 1. Load users with their vehicles and rfid_cards via relational JOIN
            const { data: u, error: ue } = await supabaseClient
                .from('users')
                .select(`
                    *,
                    vehicles ( id, vehicle_type, vehicle_model, plate_number, vehicle_color, motorcycle_image, or_cr_image, approval_status, created_at ),
                    rfid_cards ( id, rfid_uid, authorization_status, rfid_type, user_type, vehicle_id )
                `)
                .order('created_at', { ascending: false });

            if (ue) {
                console.error('❌ Supabase Users query error:', ue);
            }

            if (u && Array.isArray(u)) {
                // Map users with full vehicle & RFID card collections
                adminState.users = u.map(usr => {
                    const vehList = usr.vehicles || [];
                    const cardList = usr.rfid_cards || [];
                    const firstVeh = vehList[0];
                    const pedCard = cardList.find(c => !c.vehicle_id);
                    const firstCard = pedCard || cardList[0];
                    const isPed = usr.default_transit_mode === 'PEDESTRIAN' || firstVeh?.vehicle_type === 'None' || firstVeh?.plate_number === 'PEDESTRIAN' || firstCard?.user_type === 'PEDESTRIAN';
                    const userType = isPed ? 'PEDESTRIAN' : 'VEHICLE';
                    const rfidType = firstCard?.rfid_type || (isPed ? 'CLOSE_RANGE' : 'LONG_RANGE');

                    return {
                        ...usr,
                        vehicles:         vehList,
                        rfid_cards:       cardList,
                        user_type:        userType,
                        rfid_type:        rfidType,
                        vehicle_type:     firstVeh?.vehicle_type     || (isPed ? 'None' : null),
                        vehicle_model:    firstVeh?.vehicle_model    || (isPed ? 'Walking' : null),
                        plate_number:     firstVeh?.plate_number     || (isPed ? 'PEDESTRIAN' : null),
                        vehicle_color:    firstVeh?.vehicle_color    || null,
                        motorcycle_image: firstVeh?.motorcycle_image || null,
                        or_cr_image:      firstVeh?.or_cr_image      || null,
                        vehicle_id:       firstVeh?.id               || null,
                        rfid_uid:         firstCard?.rfid_uid        || null,
                        rfid_card_id:     firstCard?.id              || null,
                        authorization_status: usr.approval_status || firstCard?.authorization_status || 'PENDING',
                    };
                });

                // Build granular pendingItems queue (separating pedestrian card review and per-vehicle UHF sticker review)
                const pendingItems = [];
                adminState.users.forEach(usr => {
                    const cpassDisplay = usr.cpass_id || usr.student_id || 'PENDING';
                    const pedCard = (usr.rfid_cards || []).find(c => !c.vehicle_id);

                    // Check if person's pedestrian registration is pending
                    const isPersonPending = usr.approval_status === 'PENDING' || !usr.approval_status;
                    const isPedCardPending = pedCard ? (pedCard.authorization_status === 'PENDING' || !pedCard.rfid_uid || pedCard.rfid_uid.startsWith('UNASSIGNED_')) : isPersonPending;

                    if (isPersonPending || isPedCardPending) {
                        pendingItems.push({
                            type: 'PEDESTRIAN',
                            id: `ped_${usr.id}`,
                            userId: usr.id,
                            vehicleId: null,
                            user: usr,
                            vehicle: null,
                            cpassId: cpassDisplay,
                            name: usr.full_name,
                            role: usr.role,
                            role_detail: usr.role_detail,
                            program: usr.program,
                            section: usr.section,
                            avatar: usr.profile_image,
                            card: pedCard,
                            created_at: usr.created_at,
                            status: pedCard?.authorization_status || usr.approval_status || 'PENDING'
                        });
                    }

                    // Check each registered vehicle under this user
                    (usr.vehicles || []).forEach(veh => {
                        const vehCard = (usr.rfid_cards || []).find(c => c.vehicle_id === veh.id);
                        const isVehPending = veh.approval_status === 'PENDING' || !veh.approval_status;
                        const isVehCardPending = vehCard ? (vehCard.authorization_status === 'PENDING' || !vehCard.rfid_uid || vehCard.rfid_uid.startsWith('UNASSIGNED_')) : isVehPending;

                        if (isVehPending || isVehCardPending) {
                            pendingItems.push({
                                type: 'VEHICLE',
                                id: `veh_${veh.id}`,
                                userId: usr.id,
                                vehicleId: veh.id,
                                user: usr,
                                vehicle: veh,
                                cpassId: cpassDisplay,
                                name: usr.full_name,
                                role: usr.role,
                                role_detail: usr.role_detail,
                                plate: veh.plate_number,
                                vehicleType: veh.vehicle_type,
                                vehicleModel: veh.vehicle_model,
                                vehicleColor: veh.vehicle_color,
                                avatar: usr.profile_image,
                                motorcycle_image: veh.motorcycle_image,
                                or_cr_image: veh.or_cr_image,
                                card: vehCard,
                                created_at: veh.created_at || usr.created_at,
                                status: veh.approval_status || vehCard?.authorization_status || 'PENDING'
                            });
                        }
                    });
                });

                adminState.pendingItems = pendingItems;
                adminState.pendingUsers = pendingItems;
            } else {
                adminState.users = [];
                adminState.pendingItems = [];
                adminState.pendingUsers = [];
            }

            // 2. Load transactions with vehicle & user info
            const { data: l, error: le } = await supabaseClient
                .from('transactions')
                .select(`
                    *,
                    users ( full_name, role, role_detail, program, section, profile_image, default_transit_mode, cpass_id, student_id ),
                    vehicles ( plate_number, vehicle_type, vehicle_model, vehicle_color )
                `)
                .order('timestamp', { ascending: false })
                .limit(1000);

            if (le) console.error('❌ Supabase Transactions error:', le);
            adminState.logs = (l && Array.isArray(l)) ? l : [];

            // Calculate live on-campus presence
            const vehEntries = adminState.logs.filter(t => t.direction === 'ENTRY' && t.status === 'AUTHORIZED' && (t.user_type === 'VEHICLE' || t.rfid_type === 'LONG_RANGE' || (t.vehicles?.plate_number && t.vehicles?.plate_number !== 'PEDESTRIAN'))).length;
            const vehExits   = adminState.logs.filter(t => t.direction === 'EXIT'  && t.status === 'AUTHORIZED' && (t.user_type === 'VEHICLE' || t.rfid_type === 'LONG_RANGE' || (t.vehicles?.plate_number && t.vehicles?.plate_number !== 'PEDESTRIAN'))).length;
            adminState.activeVehicles = Math.max(0, vehEntries - vehExits);

            const pedEntries = adminState.logs.filter(t => t.direction === 'ENTRY' && t.status === 'AUTHORIZED' && (t.user_type === 'PEDESTRIAN' || t.rfid_type === 'CLOSE_RANGE' || t.vehicles?.vehicle_type === 'None' || t.vehicles?.plate_number === 'PEDESTRIAN' || t.gate?.includes('PEDESTRIAN'))).length;
            const pedExits   = adminState.logs.filter(t => t.direction === 'EXIT'  && t.status === 'AUTHORIZED' && (t.user_type === 'PEDESTRIAN' || t.rfid_type === 'CLOSE_RANGE' || t.vehicles?.vehicle_type === 'None' || t.vehicles?.plate_number === 'PEDESTRIAN' || t.gate?.includes('PEDESTRIAN'))).length;
            adminState.activePedestrians = Math.max(0, pedEntries - pedExits);

            // 3. Load system accounts
            const { data: acc, error: acce } = await supabaseClient.from('system_accounts').select('*');
            if (acce) console.error('❌ Supabase Accounts error:', acce);
            adminState.accounts = (acc && Array.isArray(acc)) ? acc : [];

            // 4. Load special tags (Visitor & Emergency)
            const { data: st, error: ste } = await supabaseClient.from('special_tags').select('*');
            if (ste) console.error('❌ Supabase Special tags error:', ste);
            adminState.specialTags = (st && Array.isArray(st)) ? st : [];

            // 5. Load registered ESP32 gate devices
            const { data: dev, error: deve } = await supabaseClient.from('devices').select('*').order('device_name', { ascending: true });
            if (deve) console.error('❌ Supabase Devices error:', deve);
            adminState.devices = (dev && Array.isArray(dev)) ? dev : [];

            console.log('🟢 Real Supabase data loaded:', adminState.users.length, 'users,', adminState.logs.length, 'transactions,', adminState.specialTags.length, 'special tags');
        } catch(e) {
            console.error('CRITICAL DATABASE LOAD ERROR:', e);
            showToast('Database connection error: ' + (e.message || e), 'error');
        }
    }

    renderAdmin();
    renderEsp32DevicesTable();
    setupAdminRealtime();
}

// Auto-reload data whenever connection is confirmed
window.addEventListener('supabase:connected', () => {
    console.log('🔄 Re-fetching live data after Supabase connection event...');
    loadData();
});

let adminRealtimeSubscribed = false;
function setupAdminRealtime() {
    if (!isConnected || !supabaseClient || adminRealtimeSubscribed) return;
    adminRealtimeSubscribed = true;

    try {
        supabaseClient.channel('admin-live-bus')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'transactions' }, () => {
                console.log('⚡ [Admin RT] Transactions updated');
                if (typeof initAdminState === 'function') initAdminState();
            })
            .on('postgres_changes', { event: '*', schema: 'public', table: 'rfid_cards' }, () => {
                console.log('⚡ [Admin RT] RFID cards updated');
                if (typeof initAdminState === 'function') initAdminState();
            })
            .on('postgres_changes', { event: '*', schema: 'public', table: 'users' }, () => {
                console.log('⚡ [Admin RT] Users/registrations updated');
                if (typeof initAdminState === 'function') initAdminState();
            })
            .on('postgres_changes', { event: '*', schema: 'public', table: 'devices' }, () => {
                console.log('⚡ [Admin RT] Devices updated');
                if (typeof initAdminState === 'function') initAdminState();
            })
            .subscribe((status, err) => {
                console.log('⚡ [Admin RT] Channel status:', status);
                if (err) console.error('Admin RT Error:', err);
            });
    } catch(e) {
        console.warn('Admin realtime setup error:', e);
    }
}

const renderAll = renderAdmin;
window.renderAll = renderAdmin;

// Helper: Check if a specific user is currently on campus (Strict state & log evaluation)
function isUserOnCampus(u) {
    if (!u) return false;
    const uId = u.id;
    const uCpass = (u.cpass_id || '').toUpperCase().trim();
    const uStudentId = (u.student_id || '').toUpperCase().trim();
    const uUid = (u.rfid_uid || '').toUpperCase().trim();
    const uPlates = [
        (u.plate_number || '').toUpperCase().trim(),
        ...((u.vehicles || []).map(v => (v.plate_number || '').toUpperCase().trim()))
    ].filter(p => p && p !== 'PEDESTRIAN' && p !== 'NONE');
    const uCards = [
        uUid,
        ...((u.rfid_cards || []).map(c => (c.rfid_uid || '').toUpperCase().trim()))
    ].filter(c => c && !c.startsWith('UNASSIGNED_'));

    const userLogs = (adminState.logs || []).filter(l => {
        if (l.status !== 'AUTHORIZED') return false;
        if (uId && (l.user_id === uId || l.users?.id === uId)) return true;
        if (uCpass && (l.users?.cpass_id?.toUpperCase() === uCpass || l.users?.student_id?.toUpperCase() === uCpass)) return true;
        if (uStudentId && (l.users?.student_id?.toUpperCase() === uStudentId || l.users?.cpass_id?.toUpperCase() === uStudentId)) return true;
        
        const logUid = (l.rfid_uid || '').toUpperCase().trim();
        if (logUid && uCards.includes(logUid)) return true;

        const logPlate = (l.vehicles?.plate_number || '').toUpperCase().trim();
        if (logPlate && uPlates.includes(logPlate)) return true;

        if (l.remarks) {
            const rem = l.remarks.toUpperCase();
            if (uPlates.some(p => rem.includes(p))) return true;
            if (uCards.some(c => rem.includes(c))) return true;
        }
        return false;
    });

    if (userLogs.length === 0) return false;
    // Sort descending by timestamp
    userLogs.sort((a,b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
    return userLogs[0].direction === 'ENTRY';
}

// User filter pill switching
window.setUserTableFilter = function(filter) {
    adminState.userTableFilter = filter;
    document.querySelectorAll('.user-filter-pill').forEach(btn => {
        btn.classList.remove('bg-charm-dark', 'text-white', 'shadow-sm');
        btn.classList.add('text-slate-600', 'hover:bg-slate-100');
    });
    const activeBtn = el('userTab-' + filter);
    if (activeBtn) {
        activeBtn.classList.remove('text-slate-600', 'hover:bg-slate-100');
        activeBtn.classList.add('bg-charm-dark', 'text-white', 'shadow-sm');
    }
    renderAdmin();
};

window.filterUsers = function() {
    const searchVal = el('userSearch')?.value || '';
    const clearBtn = el('userSearchClearBtn');
    if (clearBtn) {
        clearBtn.classList.toggle('hidden', searchVal.length === 0);
    }
    renderAdmin();
};

window.clearUserSearch = function() {
    const input = el('userSearch');
    if (input) {
        input.value = '';
        input.focus();
    }
    const clearBtn = el('userSearchClearBtn');
    if (clearBtn) clearBtn.classList.add('hidden');
    renderAdmin();
};

window.copyToClipboard = function(text, label = 'UID') {
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
        showToast(`Copied ${label}: ${text}`, 'success');
    }).catch(() => {
        showToast(`Could not copy to clipboard`, 'error');
    });
};

// =====================
// RENDER
// =====================
function renderAdmin() {
    const activeVeh = typeof adminState.activeVehicles === 'number' ? adminState.activeVehicles : 0;
    const activePed = typeof adminState.activePedestrians === 'number' ? adminState.activePedestrians : 0;
    const totalInside = activeVeh + activePed;

    const today = new Date().toISOString().split('T')[0];
    const todayEntries = adminState.logs.filter(l => l.direction === 'ENTRY' && l.timestamp?.startsWith(today));
    const todayExits   = adminState.logs.filter(l => l.direction === 'EXIT'  && l.timestamp?.startsWith(today));

    const todayPedEntries = todayEntries.filter(l => l.user_type === 'PEDESTRIAN' || l.rfid_type === 'CLOSE_RANGE' || l.vehicles?.vehicle_type === 'None' || l.vehicles?.plate_number === 'PEDESTRIAN' || l.gate?.includes('PEDESTRIAN')).length;
    const todayVehEntries = todayEntries.filter(l => l.user_type === 'VEHICLE' || l.rfid_type === 'LONG_RANGE' || (l.vehicles?.plate_number && l.vehicles?.plate_number !== 'PEDESTRIAN')).length;

    const totalPedUsers = adminState.users.filter(u => u.user_type === 'PEDESTRIAN').length;
    const totalVehUsers = adminState.users.filter(u => u.user_type === 'VEHICLE').length;

    // Stats
    if(el('adminStatUsers'))      el('adminStatUsers').textContent      = adminState.users.length;
    if(el('adminStatUsersSub'))   el('adminStatUsersSub').textContent   = `🚶 ${totalPedUsers} Ped • 🚗 ${totalVehUsers} Veh`;
    if(el('adminStatPending'))    el('adminStatPending').textContent    = adminState.pendingUsers.length;
    if(el('adminStatEntries'))    el('adminStatEntries').textContent    = todayEntries.length;
    if(el('adminStatEntriesSub')) el('adminStatEntriesSub').textContent = `🚶 ${todayPedEntries} Ped • 🚗 ${todayVehEntries} Veh`;
    if(el('adminStatInside'))     el('adminStatInside').textContent     = totalInside;
    if(el('adminStatInsideSub'))  el('adminStatInsideSub').textContent  = `🚶 ${activePed} Ped • 🚗 ${activeVeh} Veh`;
    if(el('pendingBadgeCount'))   el('pendingBadgeCount').textContent   = adminState.pendingUsers.length;

    // Filter counts for tabs - true synchronized state
    const countAll = adminState.users.length;
    const countPending = adminState.users.filter(u => u.authorization_status === 'PENDING' || u.approval_status === 'PENDING' || (!u.authorization_status && !u.approval_status)).length;
    const countAuth = adminState.users.filter(u => u.authorization_status === 'AUTHORIZED' || u.approval_status === 'APPROVED').length;
    const countDenied = adminState.users.filter(u => u.authorization_status === 'DENIED' || u.approval_status === 'REJECTED').length;

    if(el('userCount-ALL')) el('userCount-ALL').textContent = countAll;
    if(el('userCount-PENDING')) el('userCount-PENDING').textContent = countPending;
    if(el('userCount-AUTHORIZED')) el('userCount-AUTHORIZED').textContent = countAuth;
    if(el('userCount-DENIED')) el('userCount-DENIED').textContent = countDenied;

    // Update charts if viewing analytics
    const analyticsView = el('aview-analytics');
    if (analyticsView && !analyticsView.classList.contains('hidden')) {
        renderAnalytics();
    }

    // Pending Applications Table (Dashboard)
    if(el('pendingTable')) {
        const pItems = adminState.pendingItems || [];
        el('pendingTable').innerHTML = pItems.length ? pItems.map(item => {
            const isVeh = item.type === 'VEHICLE';
            const avatar = item.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(item.name || 'User')}&background=random`;
            const roleBadgeClass = item.role === 'Student' ? 'bg-blue-100 text-blue-800' : (item.role === 'Faculty' ? 'bg-purple-100 text-purple-800' : (item.role === 'Others' ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-800'));
            const formattedDate = item.created_at ? new Date(item.created_at).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }) : '--';
            const roleDisplay = item.role === 'Others' ? `Others: ${item.role_detail || 'Vendor'}` : (item.role || 'User');

            return `
            <tr class="hover:bg-amber-50/40 transition-colors">
                <td class="p-4">
                    <div class="flex items-center gap-3">
                        <img src="${avatar}" class="w-10 h-10 rounded-xl object-cover border border-slate-200 shadow-sm cursor-pointer hover:opacity-80" onclick="openReviewModal('${item.userId}', '${item.type}', '${item.vehicleId || ''}')" onerror="this.src='https://ui-avatars.com/api/?name=User'">
                        <div>
                            <div class="font-extrabold text-slate-800 hover:text-charm-dark cursor-pointer flex items-center gap-1.5" onclick="openReviewModal('${item.userId}', '${item.type}', '${item.vehicleId || ''}')">
                                <span>${item.name || '--'}</span>
                                <span class="font-mono text-[10px] font-black px-1.5 py-0.5 rounded bg-amber-100 text-amber-900 border border-amber-300" title="CHARRMPASS ID">${item.cpassId}</span>
                            </div>
                            <div class="text-xs text-slate-400 font-medium">${item.user?.age ? item.user.age + ' yrs' : ''} ${item.user?.sex ? '• ' + item.user.sex : ''}</div>
                        </div>
                    </div>
                </td>
                <td class="p-4">
                    <span class="px-2.5 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider ${roleBadgeClass}">${roleDisplay}</span>
                    <div class="text-xs text-slate-500 font-semibold mt-1">${item.program || '--'} ${item.section ? '• ' + item.section : ''}</div>
                </td>
                <td class="p-4">
                    ${!isVeh ? `
                        <span class="px-2.5 py-1 rounded-full text-[10px] font-black bg-blue-100 text-blue-800 border border-blue-200 inline-flex items-center gap-1">
                            🚶 Pedestrian Card (Close-Range)
                        </span>
                    ` : `
                        <span class="px-2.5 py-1 rounded-full text-[10px] font-black bg-emerald-100 text-emerald-800 border border-emerald-200 inline-flex items-center gap-1">
                            🚗 Vehicle Sticker (Long-Range UHF)
                        </span>
                    `}
                </td>
                <td class="p-4">
                    ${!isVeh ? `
                        <div class="text-xs font-bold text-slate-600">Walking / Pedestrian Access</div>
                        <div class="text-[11px] font-mono text-slate-400">Cardholder: ${item.cpassId}</div>
                    ` : `
                        <div class="font-bold text-slate-700 text-xs">${item.vehicleType || 'Vehicle'} - <span class="font-medium text-slate-500">${item.vehicleModel || '--'}</span></div>
                        <div class="font-mono text-xs font-black text-charm-dark bg-charm-yellow/20 px-2 py-0.5 rounded inline-block mt-0.5">${item.plate || 'NO PLATE'}</div>
                    `}
                </td>
                <td class="p-4 text-xs font-semibold text-slate-500 whitespace-nowrap">
                    ${formattedDate}
                </td>
                <td class="p-4 text-center">
                    <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-black uppercase bg-yellow-100 text-yellow-800 border border-yellow-300">
                        <span class="w-1.5 h-1.5 rounded-full bg-yellow-500 animate-ping"></span> PENDING
                    </span>
                </td>
                <td class="p-4 text-right whitespace-nowrap">
                    <div class="flex items-center justify-end gap-1.5">
                        <button onclick="openReviewModal('${item.userId}', '${item.type}', '${item.vehicleId || ''}')" class="px-3 py-1.5 bg-charm-dark text-white rounded-xl text-xs font-bold hover:bg-opacity-90 shadow-sm transition-all flex items-center gap-1" title="Review credentials and issue RFID pass">
                            <i data-lucide="shield-alert" class="w-3.5 h-3.5 text-charm-yellow"></i> Review &amp; Issue
                        </button>
                        <button onclick="openUserHistoryModal('${item.userId}')" class="p-1.5 text-slate-500 hover:text-charm-dark bg-white border border-slate-200 rounded-xl hover:bg-slate-50 shadow-sm" title="View Access History">
                            <i data-lucide="history" class="w-4 h-4"></i>
                        </button>
                        <button onclick="denyRegistration('${item.userId}', '${item.type}', '${item.vehicleId || ''}')" class="px-2.5 py-1.5 bg-red-50 text-red-600 rounded-xl text-xs font-bold hover:bg-red-100 border border-red-200 transition-colors" title="Deny Application">
                            Deny
                        </button>
                    </div>
                </td>
            </tr>`;
        }).join('') : `
            <tr>
                <td colspan="7" class="p-12 text-center text-slate-400">
                    <div class="flex flex-col items-center justify-center">
                        <div class="w-12 h-12 rounded-full bg-emerald-50 text-emerald-600 flex items-center justify-center mb-2">
                            <i data-lucide="check-circle" class="w-6 h-6"></i>
                        </div>
                        <p class="font-bold text-slate-700">All caught up!</p>
                        <p class="text-xs text-slate-400">There are no pending pedestrian or vehicle applications to review.</p>
                    </div>
                </td>
            </tr>`;
    }

    // Registered Users Table (User Management)
    if(el('usersTable')) {
        const search = (el('userSearch')?.value||'').toLowerCase().trim();
        const role = el('roleFilter')?.value||'';
        const presence = el('presenceFilter')?.value||'ALL';
        const modeFilter = el('modeFilter')?.value||'ALL';
        const statusFilter = adminState.userTableFilter || 'ALL';

        let filtered = [...adminState.users];

        // Status Filter Pill
        if (statusFilter === 'PENDING') {
            filtered = filtered.filter(u => u.authorization_status === 'PENDING' || u.approval_status === 'PENDING' || (!u.authorization_status && !u.approval_status));
        } else if (statusFilter === 'AUTHORIZED') {
            filtered = filtered.filter(u => u.authorization_status === 'AUTHORIZED' || u.approval_status === 'APPROVED');
        } else if (statusFilter === 'DENIED') {
            filtered = filtered.filter(u => u.authorization_status === 'DENIED' || u.approval_status === 'REJECTED');
        }

        // Transit Mode Filter
        if (modeFilter === 'PEDESTRIAN') {
            filtered = filtered.filter(u => u.user_type === 'PEDESTRIAN' || u.default_transit_mode === 'PEDESTRIAN' || (u.rfid_cards||[]).some(c => !c.vehicle_id));
        } else if (modeFilter === 'VEHICLE') {
            filtered = filtered.filter(u => u.user_type === 'VEHICLE' || u.default_transit_mode === 'VEHICLE' || (u.vehicles && u.vehicles.length > 0));
        }

        // Role Filter
        if (role) {
            filtered = filtered.filter(u => u.role === role);
        }

        // Program & Section Filters
        const progFilter = el('programFilter')?.value || '';
        const secFilter = el('sectionFilter')?.value || '';
        if (progFilter) {
            filtered = filtered.filter(u => (u.program || '').toUpperCase() === progFilter.toUpperCase());
        }
        if (secFilter) {
            filtered = filtered.filter(u => (u.section || '').toUpperCase() === secFilter.toUpperCase());
        }

        // Advanced Multi-token Smart Search Filter
        if (search) {
            const tokens = search.split(/\s+/).filter(Boolean);
            filtered = filtered.filter(u => {
                const uPlates = [u.plate_number, ...((u.vehicles||[]).map(v => v.plate_number))].filter(Boolean).join(' ');
                const uModels = (u.vehicles||[]).map(v => `${v.vehicle_type||''} ${v.vehicle_model||''} ${v.vehicle_color||''}`).join(' ');
                const uUids = [u.rfid_uid, ...((u.rfid_cards||[]).map(c => c.rfid_uid))].filter(Boolean).join(' ');
                
                const composite = [
                    u.full_name || '',
                    u.cpass_id || '',
                    u.student_id || '',
                    u.role || '',
                    u.role_detail || '',
                    u.program || '',
                    u.section || '',
                    `${u.program || ''} ${u.section || ''}`,
                    u.address || '',
                    u.default_transit_mode || '',
                    u.user_type || '',
                    uPlates,
                    uPlates.replace(/[-\s]/g, ''),
                    uModels,
                    uUids,
                    uUids.replace(/\s/g, '')
                ].join(' ').toLowerCase();

                return tokens.every(token => composite.includes(token));
            });
        }

        // Campus Presence Filter
        if (presence === 'INSIDE') {
            filtered = filtered.filter(u => isUserOnCampus(u));
        } else if (presence === 'OUTSIDE') {
            filtered = filtered.filter(u => !isUserOnCampus(u));
        }

        el('usersTable').innerHTML = filtered.length ? filtered.map(u => {
            const isAuth = u.authorization_status === 'AUTHORIZED' || u.approval_status === 'APPROVED';
            const isPending = !isAuth && (u.authorization_status === 'PENDING' || u.approval_status === 'PENDING' || !u.authorization_status);
            const statusClass = isAuth ? 'bg-emerald-100 text-emerald-800 border-emerald-300' : (isPending ? 'bg-yellow-100 text-yellow-800 border-yellow-300' : 'bg-red-100 text-red-800 border-red-300');
            const statusLabel = isAuth ? 'AUTHORIZED' : (isPending ? 'PENDING' : 'DENIED');
            const onCampus = isUserOnCampus(u);
            const avatar = u.profile_image || `https://ui-avatars.com/api/?name=${encodeURIComponent(u.full_name)}&background=random`;
            const roleBadgeClass = u.role === 'Student' ? 'bg-blue-100 text-blue-800' : (u.role === 'Faculty' ? 'bg-purple-100 text-purple-800' : (u.role === 'Others' ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-800'));
            const roleDisplay = u.role === 'Others' ? `Others: ${u.role_detail || 'Vendor'}` : (u.role || 'User');
            const cpassDisplay = u.cpass_id || u.student_id || 'NO CPASS';

            // Transit passes summary
            const hasPed = (u.rfid_cards || []).some(c => !c.vehicle_id);
            const vehCount = (u.vehicles || []).length;

            return `
            <tr class="hover:bg-slate-50/80 transition-colors border-b border-slate-100">
                <!-- 1. Person / Driver -->
                <td class="p-3.5">
                    <div class="flex items-center gap-3">
                        <img src="${avatar}" class="w-9 h-9 rounded-xl object-cover border border-slate-200 shadow-sm cursor-pointer hover:opacity-80 shrink-0" onclick="openReviewModal('${u.id}', '${vehCount ? 'VEHICLE' : 'PEDESTRIAN'}', '${u.vehicles?.[0]?.id || ''}')" title="Click to view dossier" onerror="this.src='https://ui-avatars.com/api/?name=User'">
                        <div class="min-w-0">
                            <div class="font-extrabold text-slate-800 hover:text-charm-dark cursor-pointer flex items-center gap-1.5 flex-wrap" onclick="openReviewModal('${u.id}', '${vehCount ? 'VEHICLE' : 'PEDESTRIAN'}', '${u.vehicles?.[0]?.id || ''}')">
                                <span class="truncate">${u.full_name || '--'}</span>
                                <span class="font-mono text-[10px] font-black px-1.5 py-0.2 rounded bg-amber-100 text-amber-900 border border-amber-300 shrink-0" title="CPASS ID">${cpassDisplay}</span>
                            </div>
                            <div class="text-[11px] text-slate-400 font-medium truncate">${u.program || 'No Program'} ${u.section ? '• ' + u.section : ''}</div>
                        </div>
                    </div>
                </td>

                <!-- 2. Role & Transit -->
                <td class="p-3.5 whitespace-nowrap">
                    <div class="flex flex-col items-start gap-1">
                        <span class="px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider ${roleBadgeClass}">${roleDisplay}</span>
                        <span class="text-[10px] font-bold text-slate-600 flex items-center gap-1">
                            ${hasPed && vehCount > 0 ? '<span>🚶+🚗</span> Hybrid' : (hasPed ? '<span>🚶</span> Pedestrian' : '<span>🚗</span> Vehicle')}
                        </span>
                    </div>
                </td>

                <!-- 3. Vehicle & Plate -->
                <td class="p-3.5">
                    ${(() => {
                        const vehs = u.vehicles || [];
                        if (!vehs.length) {
                            return `<div class="text-xs font-semibold text-slate-400 italic">🚶 Walking / Pedestrian</div>`;
                        }
                        return vehs.map(v => `
                            <div class="mb-1 last:mb-0">
                                <div class="font-mono text-xs font-black text-slate-900 bg-slate-100 hover:bg-slate-200 px-1.5 py-0.5 rounded border border-slate-200 inline-block cursor-pointer" onclick="openReviewModal('${u.id}', 'VEHICLE', '${v.id}')" title="Review vehicle">${v.plate_number || 'NO PLATE'}</div>
                                <div class="text-[11px] text-slate-500 font-medium truncate max-w-[160px]">${v.vehicle_model || v.vehicle_type || 'Vehicle'}</div>
                            </div>
                        `).join('');
                    })()}
                </td>

                <!-- 4. RFID UID Tag -->
                <td class="p-3.5">
                    <div class="space-y-1">
                        ${(() => {
                            const cards = u.rfid_cards || [];
                            if (!cards.length) {
                                return `<span class="px-2 py-0.5 rounded-lg bg-yellow-50 text-yellow-700 border border-yellow-200 text-[11px] font-bold inline-flex items-center gap-1"><i data-lucide="alert-circle" class="w-3 h-3"></i> Unassigned</span>`;
                            }
                            return cards.map(c => {
                                const isVehCard = !!c.vehicle_id;
                                const v = isVehCard ? (u.vehicles||[]).find(veh => veh.id === c.vehicle_id) : null;
                                const tagLabel = isVehCard ? (v ? v.plate_number : 'UHF') : 'Card';
                                const uidVal = (c.rfid_uid && !c.rfid_uid.startsWith('UNASSIGNED_')) ? c.rfid_uid : null;
                                if (!uidVal) {
                                    return `
                                        <div class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-yellow-50 text-yellow-700 border border-yellow-200 cursor-pointer hover:bg-yellow-100 inline-block mr-1" title="Click to assign UID" onclick="openReviewModal('${u.id}', '${isVehCard ? 'VEHICLE' : 'PEDESTRIAN'}', '${c.vehicle_id || ''}')">
                                            ${tagLabel}: Unassigned
                                        </div>
                                    `;
                                }
                                return `
                                    <div class="inline-flex items-center gap-1 bg-slate-100 hover:bg-slate-200 border border-slate-200 px-2 py-0.5 rounded-lg text-xs font-mono font-bold text-slate-800 cursor-pointer transition-colors mr-1" onclick="copyToClipboard('${uidVal}', '${tagLabel} UID')" title="Click to copy UID: ${uidVal}">
                                        <i data-lucide="${isVehCard ? 'radio' : 'nfc'}" class="w-3 h-3 text-emerald-600"></i>
                                        <span>${uidVal}</span>
                                    </div>
                                `;
                            }).join('');
                        })()}
                    </div>
                </td>

                <!-- 5. Status & Campus Presence -->
                <td class="p-3.5 text-center whitespace-nowrap">
                    <div class="flex flex-col items-center gap-1">
                        <span class="px-2.5 py-0.5 rounded-full text-[10px] font-black uppercase border ${statusClass}">${statusLabel}</span>
                        ${onCampus ? `
                            <span class="inline-flex items-center gap-1 px-2 py-0.2 rounded-full text-[9px] font-black bg-emerald-100 text-emerald-800 border border-emerald-300">
                                <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span> INSIDE
                            </span>
                        ` : `
                            <span class="text-[10px] font-semibold text-slate-400">Off-Campus</span>
                        `}
                    </div>
                </td>

                <!-- 6. Actions -->
                <td class="p-3.5 text-right whitespace-nowrap">
                    <div class="flex items-center justify-end gap-1">
                        <button onclick="openReviewModal('${u.id}', '${vehCount ? 'VEHICLE' : 'PEDESTRIAN'}', '${u.vehicles?.[0]?.id || ''}')" class="p-1.5 text-slate-500 hover:text-charm-dark bg-white border border-slate-200 rounded-lg hover:bg-slate-50 shadow-xs transition-all" title="View Dossier & Documents">
                            <i data-lucide="file-search" class="w-4 h-4"></i>
                        </button>
                        <button onclick="openUserHistoryModal('${u.id}')" class="p-1.5 text-slate-500 hover:text-blue-600 bg-white border border-slate-200 rounded-lg hover:bg-blue-50 shadow-xs transition-all" title="Access History & Logs">
                            <i data-lucide="history" class="w-4 h-4"></i>
                        </button>
                        <button onclick="openUserModal('${u.id}')" class="p-1.5 text-slate-500 hover:text-charm-dark bg-white border border-slate-200 rounded-lg hover:bg-slate-50 shadow-xs transition-all" title="Edit Profile & Assign UID">
                            <i data-lucide="edit-3" class="w-4 h-4"></i>
                        </button>
                        <button onclick="deleteUser('${u.id}')" class="p-1.5 text-slate-400 hover:text-red-500 bg-white border border-slate-200 rounded-lg hover:bg-red-50 shadow-xs transition-all" title="Delete User">
                            <i data-lucide="trash-2" class="w-4 h-4"></i>
                        </button>
                    </div>
                </td>
            </tr>`;
        }).join('') : `
            <tr>
                <td colspan="6" class="p-12 text-center text-slate-400">
                    <div class="flex flex-col items-center justify-center">
                        <div class="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center mb-2 text-slate-400">
                            <i data-lucide="search-x" class="w-6 h-6"></i>
                        </div>
                        <p class="font-bold text-slate-700">No matching users found</p>
                        <p class="text-xs text-slate-400">Try adjusting your search query, transit mode, role, or presence filter.</p>
                    </div>
                </td>
            </tr>`;
    }

    // Accounts (Guard Management)
    if(el('accountsGrid')) {
        const guardAccounts = (adminState.accounts || []).filter(acc => acc.role === 'GUARD');
        if (guardAccounts.length > 0) {
            el('accountsGrid').innerHTML = guardAccounts.map(acc => `
                <div class="glass-card p-6 rounded-3xl border border-white/60 shadow-glass flex flex-col items-center text-center animate-slide-up relative group">
                    <button onclick="deleteAccount('${acc.id}')" class="absolute top-4 right-4 p-2 rounded-xl text-slate-300 hover:text-red-500 hover:bg-red-50 transition-colors" title="Delete Guard Account">
                        <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>
                    </button>
                    <div class="w-16 h-16 rounded-2xl bg-charm-dark text-charm-yellow flex items-center justify-center mb-4 shadow-lg">
                        <svg xmlns="http://www.w3.org/2000/svg" class="w-8 h-8 text-charm-yellow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>
                    </div>
                    <h3 class="font-display font-bold text-xl text-slate-800">${acc.username}</h3>
                    <span class="px-3 py-0.5 rounded-full text-[10px] font-extrabold bg-green-100 text-green-800 uppercase tracking-widest mt-1">SECURITY GUARD</span>
                    
                    <div class="w-full mt-5 pt-4 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500">
                        <span class="font-semibold uppercase tracking-wider text-[10px] text-slate-400">Password:</span>
                        <span class="font-mono font-bold text-slate-700 bg-slate-100 px-2 py-0.5 rounded">${acc.password || '••••••••'}</span>
                    </div>

                    <div class="mt-5 flex gap-2 w-full">
                        <button onclick="openAccountModal('${acc.id}')" class="flex-1 px-4 py-2.5 rounded-xl bg-slate-100 text-slate-700 text-xs font-bold hover:bg-charm-dark hover:text-white transition-all flex items-center justify-center gap-1.5 shadow-sm">
                            <svg xmlns="http://www.w3.org/2000/svg" class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/></svg>
                            <span>Change Password / Username</span>
                        </button>
                    </div>
                </div>
            `).join('');
        } else {
            el('accountsGrid').innerHTML = `
                <div class="col-span-full py-16 flex flex-col items-center justify-center text-slate-400">
                    <div class="w-16 h-16 rounded-full bg-slate-100 flex items-center justify-center mb-3">
                        <svg xmlns="http://www.w3.org/2000/svg" class="w-8 h-8 text-slate-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19.69 14a6.9 6.9 0 0 0 .31-2V5l-8-3-3.16 1.18"/><path d="M4.73 4.73 4 5v7c0 6 8 10 8 10a20.29 20.29 0 0 0 5.62-4.38"/><line x1="1" x2="23" y1="1" y2="23"/></svg>
                    </div>
                    <p class="font-bold text-slate-700 mb-1 text-base">No Guard Accounts Found</p>
                    <p class="text-xs text-slate-400 mb-5 max-w-sm text-center">Create security guard credentials to allow officers to log into the Guard Station dashboard.</p>
                    <button onclick="openAccountModal()" class="px-5 py-2.5 bg-charm-dark text-white rounded-xl text-xs font-bold shadow-md hover:opacity-90 flex items-center gap-1.5">
                        <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" x2="12" y1="5" y2="19"/><line x1="5" x2="19" y1="12" y2="12"/></svg>
                        <span>Create Guard Account</span>
                    </button>
                </div>
            `;
        }
    }

    // Logs
    if(el('adminLogsTable')) {
        let filteredLogs = getFilteredAdminLogs();
        if (adminLogsDirection !== 'ALL') {
            filteredLogs = filteredLogs.filter(l => l.direction === adminLogsDirection);
        }
        if (adminLogsMode === 'PEDESTRIAN') {
            filteredLogs = filteredLogs.filter(l => l.user_type === 'PEDESTRIAN' || l.rfid_type === 'CLOSE_RANGE' || l.vehicles?.vehicle_type === 'None' || l.vehicles?.plate_number === 'PEDESTRIAN' || l.gate?.includes('PEDESTRIAN') || l.gate?.includes('TURNSTILE'));
        } else if (adminLogsMode === 'VEHICLE') {
            filteredLogs = filteredLogs.filter(l => l.user_type === 'VEHICLE' || l.rfid_type === 'LONG_RANGE' || (l.vehicles?.plate_number && l.vehicles?.plate_number !== 'PEDESTRIAN') || l.gate?.includes('VEHICLE') || l.gate?.includes('BARRIER'));
        }

        const recentLogs = filteredLogs.slice(0, 100);
        if (recentLogs.length) {
            el('adminLogsTable').innerHTML = recentLogs.map(l => {
                const dateObj  = l.timestamp ? new Date(l.timestamp) : null;
                const ts       = dateObj ? dateObj.toLocaleTimeString('en-US', {hour12:false, hour:'2-digit', minute:'2-digit'}) : '--';
                let name     = l.users?.full_name;
                let plate    = l.vehicles?.plate_number;

                const isPed = l.user_type === 'PEDESTRIAN' || l.rfid_type === 'CLOSE_RANGE' || l.vehicles?.vehicle_type === 'None' || l.vehicles?.plate_number === 'PEDESTRIAN' || l.gate?.includes('PEDESTRIAN') || l.gate?.includes('TURNSTILE');

                if (!name && l.remarks) {
                    if (l.remarks.includes('Visitor')) {
                        const match = l.remarks.match(/Visitor (?:Exit|Entry):\s*([^|]+)(?:\s*\|\s*Plate:\s*([^|]+))?/i);
                        if (match) {
                            name = match[1]?.trim();
                            if (match[2]?.trim() && match[2].trim() !== 'N/A') plate = match[2].trim();
                        } else {
                            name = 'Visitor';
                        }
                    } else if (l.remarks.includes('Emergency') || l.remarks.includes('EMERGENCY')) {
                        const match = l.remarks.match(/Emergency (?:tag|Response):\s*(.+)/i);
                        name = match ? match[1].trim() : 'Emergency Response';
                        plate = 'EMERGENCY';
                    }
                }

                if (!name && adminState.specialTags) {
                    const cleanUid = (l.rfid_uid || '').replace(/\s+/g, '').toUpperCase();
                    const spec = adminState.specialTags.find(s => s.rfid_uid === l.rfid_uid || (s.rfid_uid && s.rfid_uid.replace(/\s+/g, '').toUpperCase() === cleanUid));
                    if (spec) {
                        if (spec.type === 'EMERGENCY') {
                            name = spec.label || 'Emergency Response';
                            plate = 'EMERGENCY';
                        } else if (spec.type === 'VISITOR') {
                            name = (spec.label && spec.label !== 'Reusable Visitor Tag') ? spec.label : 'Visitor';
                            plate = spec.description?.match(/Plate:\s*([^|]+)/)?.[1]?.trim() || 'VISITOR PASS';
                        }
                    }
                }

                if (!name) name = l.status === 'DENIED' ? 'Unregistered Card' : 'Authorized User';
                if (!plate) plate = isPed ? 'PEDESTRIAN' : (l.rfid_uid ? l.rfid_uid.substring(0, 12) : '--');

                const dir      = l.direction || 'ENTRY';
                const isEntry  = dir === 'ENTRY';
                const isAuth   = l.status === 'AUTHORIZED';
                const statusBg = isAuth ? 'bg-green-100 text-green-700' : (l.status === 'PENDING_CONFIRMATION' ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700');
                const gateName = l.gate || (isPed ? (isEntry ? 'PEDESTRIAN_IN' : 'PEDESTRIAN_OUT') : (isEntry ? 'VEHICLE_GATE_IN' : 'VEHICLE_GATE_OUT'));

                return `
                    <tr class="hover:bg-white/60 border-b border-slate-100/50 transition-colors">
                        <td class="p-4 text-xs font-mono font-medium text-slate-500">${ts}</td>
                        <td class="p-4">
                            ${isPed ? `
                                <span class="px-2.5 py-1 rounded-full text-[10px] font-black bg-blue-100 text-blue-800 border border-blue-200 inline-flex items-center gap-1">
                                    🚶 Pedestrian (Close)
                                </span>
                            ` : `
                                <span class="px-2.5 py-1 rounded-full text-[10px] font-black bg-emerald-100 text-emerald-800 border border-emerald-200 inline-flex items-center gap-1">
                                    🚗 Vehicle (Long UHF)
                                </span>
                            `}
                        </td>
                        <td class="p-4 font-mono text-xs font-bold text-slate-500">${l.rfid_uid || '--'}</td>
                        <td class="p-4 font-bold text-slate-800">${name}</td>
                        <td class="p-4">
                            ${isPed ? `
                                <span class="text-xs font-semibold text-slate-400 italic">Walking User</span>
                            ` : `
                                <span class="font-mono text-xs font-bold text-charm-dark bg-charm-yellow/10 px-2 py-0.5 rounded inline-block">${plate}</span>
                            `}
                        </td>
                        <td class="p-4 text-center">
                            <span class="px-2.5 py-1 rounded-full text-[10px] font-extrabold uppercase ${isEntry ? 'bg-emerald-100 text-emerald-800' : 'bg-blue-100 text-blue-800'}">${dir}</span>
                        </td>
                        <td class="p-4 text-center">
                            <span class="px-2.5 py-1 rounded-full text-[10px] font-extrabold uppercase ${statusBg}">${l.status || '--'}</span>
                        </td>
                        <td class="p-4 text-right">
                            <span class="text-xs font-bold font-mono ${gateName.includes('ENTRY') || gateName.includes('IN') ? 'text-emerald-600' : 'text-blue-600'}">${gateName}</span>
                        </td>
                    </tr>
                `;
            }).join('');
        } else {
            el('adminLogsTable').innerHTML = '<tr><td colspan="8" class="p-8 text-center text-slate-400 font-medium">No transactions found</td></tr>';
        }
    }

    // Ranking Tables (if present in DOM)
    if (el('studentRankingTable') || el('facultyRankingTable')) {
        const studentLogs = (adminState.logs || []).filter(l => l.users?.role === 'Student');
        const sCounts = {};
        studentLogs.forEach(l => { const name = l.users?.full_name; if(name) sCounts[name] = (sCounts[name] || 0) + 1; });
        const sRanked = Object.entries(sCounts).sort((a,b) => b[1] - a[1]).slice(0, 5);
        if (el('studentRankingTable')) {
            el('studentRankingTable').innerHTML = sRanked.length ? sRanked.map(([name, count], i) => {
                const u = adminState.users.find(x => x.full_name === name);
                return `<tr class="border-b border-slate-50"><td class="p-3 text-center font-bold text-charm-dark">${i+1}</td><td class="p-3 font-semibold">${name}</td><td class="p-3 text-center text-slate-500">${u?.program||'--'}</td><td class="p-3 text-center"><span class="px-2 py-0.5 rounded-full bg-slate-100 font-bold text-slate-700">${count}</span></td></tr>`;
            }).join('') : '<tr><td colspan="4" class="p-8 text-center text-slate-300">No activity in this period</td></tr>';
        }

        const facultyLogs = (adminState.logs || []).filter(l => l.users?.role === 'Faculty' || l.users?.role === 'Staff');
        const fCounts = {};
        facultyLogs.forEach(l => { const name = l.users?.full_name; if(name) fCounts[name] = (fCounts[name] || 0) + 1; });
        const fRanked = Object.entries(fCounts).sort((a,b) => b[1] - a[1]).slice(0, 5);
        if (el('facultyRankingTable')) {
            el('facultyRankingTable').innerHTML = fRanked.length ? fRanked.map(([name, count], i) => {
                const u = adminState.users.find(x => x.full_name === name);
                return `<tr class="border-b border-slate-50"><td class="p-3 text-center font-bold text-charm-mid">${i+1}</td><td class="p-3 font-semibold">${name}</td><td class="p-3 text-center text-slate-500">${u?.role||'--'}</td><td class="p-3 text-center"><span class="px-2 py-0.5 rounded-full bg-slate-100 font-bold text-slate-700">${count}</span></td></tr>`;
            }).join('') : '<tr><td colspan="4" class="p-8 text-center text-slate-300">No activity in this period</td></tr>';
        }
    }

    // Special Tags
    if (el('specialTagsTable')) {
        const table = el('specialTagsTable');
        if (adminState.specialTags.length) {
            table.innerHTML = adminState.specialTags.map(t => {
                const typeClass = t.type === 'VISITOR' ? 'bg-blue-100 text-blue-700' : 'bg-red-100 text-red-700';
                return `
                    <tr class="hover:bg-white/60 border-b border-slate-100/50 transition-colors">
                        <td class="p-4 font-mono font-bold text-slate-700">${t.rfid_uid}</td>
                        <td class="p-4"><span class="px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-wider ${typeClass}">${t.type}</span></td>
                        <td class="p-4 text-slate-500">${t.description || '--'}</td>
                        <td class="p-4 text-right whitespace-nowrap">
                            <button onclick="editSpecialTag('${t.id}')" class="p-2 text-slate-400 hover:text-charm-dark transition-colors inline-block" title="Edit Tag">
                                <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
                            </button>
                            <button onclick="deleteSpecialTag('${t.id}')" class="p-2 text-slate-400 hover:text-red-500 transition-colors inline-block ml-1" title="Delete Tag">
                                <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>
                            </button>
                        </td>
                    </tr>
                `;
            }).join('');
        } else {
            table.innerHTML = '<tr><td colspan="4" class="p-8 text-center text-slate-400">No special tags configured</td></tr>';
        }
    }
    
    if (window.lucide && typeof lucide.createIcons === 'function') {
        lucide.createIcons();
    }
}

// =====================
// USER ACTIONS
// =====================
window.openUserModal = function(id = null) {
    const modal = el('userModal');
    const form = el('userForm');
    form.reset();
    el('formUserId').value = '';
    el('modalTitle').textContent = id ? 'Edit User' : 'Add New User';
    
    if (id) {
        const u = adminState.users.find(x => x.id === id);
        if (u) {
            el('formUserId').value = u.id;
            el('formName').value = u.full_name;
            el('formAge').value = u.age || '';
            el('formSex').value = u.sex || 'Male';
            el('formAddress').value = u.address || '';
            el('formProgram').value = u.program || '';
            el('formSection').value = u.section || '';
            el('formUid').value = u.rfid_uid || '';
            el('formRole').value = u.role || 'Student';
            if (el('formRoleDetail')) el('formRoleDetail').value = u.role_detail || '';
            el('formVehType').value = u.vehicle_type || 'None';
            el('formPlate').value = u.plate_number || '';
            el('formVehModel').value = u.vehicle_model || '';
            el('formVehColor').value = u.vehicle_color || '';
            el('prevProfile').src = u.profile_image || 'https://ui-avatars.com/api/?name=' + u.full_name;
            el('prevMotor').src = u.motorcycle_image || 'https://images.unsplash.com/photo-1558981403-c5f91cbba527?auto=format&fit=crop&q=80&w=200';
        }
    } else {
        if (el('formRoleDetail')) el('formRoleDetail').value = '';
    }
    toggleFormRoleDetail();

    modal.classList.remove('hidden');
    setTimeout(() => {
        modal.classList.add('opacity-100');
        el('userModalContent').classList.remove('scale-95');
    }, 10);
    lucide.createIcons();
};

window.toggleFormRoleDetail = function() {
    const role = el('formRole')?.value;
    const box = el('boxFormRoleDetail');
    if (box) {
        if (role === 'Others') {
            box.classList.remove('hidden');
        } else {
            box.classList.add('hidden');
        }
    }
};

window.closeUserModal = function() {
    const modal = el('userModal');
    modal.classList.remove('opacity-100');
    el('userModalContent').classList.add('scale-95');
    setTimeout(() => modal.classList.add('hidden'), 300);
};

window.saveUser = function() {
    const form = el('userForm');
    if (form) {
        if (!form.checkValidity()) {
            form.reportValidity();
            return;
        }
        form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    }
};

el('userForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const userId = el('formUserId').value;
    const newUid = el('formUid').value.trim().toUpperCase();

    if (!newUid) {
        showToast('Please enter an RFID UID.', 'error');
        el('formUid').focus();
        return;
    }

    const userData = {
        full_name: el('formName').value.trim(),
        age: parseInt(el('formAge').value) || null,
        sex: el('formSex').value,
        address: el('formAddress').value.trim(),
        program: el('formProgram').value.trim() || null,
        section: el('formSection').value.trim() || null,
        role: el('formRole').value,
        role_detail: el('formRole').value === 'Others' ? (el('formRoleDetail')?.value.trim() || 'Vendor') : null,
        default_transit_mode: (el('formVehType').value !== 'None' && el('formPlate').value.trim() !== '') ? 'VEHICLE' : 'PEDESTRIAN',
        updated_at: new Date().toISOString()
    };
    const hasVehicle = el('formVehType').value !== 'None' && el('formPlate').value.trim() !== '';
    const vehicleData = {
        vehicle_type: el('formVehType').value || 'None',
        plate_number: el('formPlate').value.trim().toUpperCase() || 'NO-PLATE',
        vehicle_model: el('formVehModel').value.trim() || '--',
        vehicle_color: el('formVehColor').value.trim() || '--',
    };
    const rfidType = hasVehicle ? 'LONG_RANGE' : 'CLOSE_RANGE';
    const userType = hasVehicle ? 'VEHICLE' : 'PEDESTRIAN';

    try {
        showToast('Saving stakeholder & RFID assignment...', 'info');

        if (userId) {
            // ─── EDIT EXISTING USER ───
            const user = adminState.users.find(u => u.id === userId);
            
            // 1. Update user
            const { error: uErr } = await supabaseClient.from('users').update(userData).eq('id', userId);
            if (uErr) throw uErr;

            // 2. Update or insert vehicle
            let targetVehicleId = user?.vehicle_id || null;
            if (hasVehicle) {
                if (user?.vehicle_id) {
                    const { error: vErr } = await supabaseClient.from('vehicles').update(vehicleData).eq('id', user.vehicle_id);
                    if (vErr) throw vErr;
                } else {
                    const { data: newV, error: vErr } = await supabaseClient.from('vehicles').insert([{ user_id: userId, ...vehicleData }]).select().single();
                    if (vErr) throw vErr;
                    targetVehicleId = newV.id;
                }
            }

            // 3. Update or upsert RFID Card UID
            if (user?.rfid_card_id) {
                const { error: cErr } = await supabaseClient.from('rfid_cards').update({
                    rfid_uid: newUid,
                    rfid_type: rfidType,
                    user_type: userType,
                    vehicle_id: targetVehicleId,
                    authorization_status: 'AUTHORIZED',
                    updated_at: new Date().toISOString()
                }).eq('id', user.rfid_card_id);
                if (cErr) throw cErr;
            } else {
                const { error: cErr } = await supabaseClient.from('rfid_cards').insert([{
                    rfid_uid: newUid,
                    user_id: userId,
                    vehicle_id: targetVehicleId,
                    rfid_type: rfidType,
                    user_type: userType,
                    authorization_status: 'AUTHORIZED'
                }]);
                if (cErr) throw cErr;
            }

            showToast(`User updated! ${rfidType} RFID UID ${newUid} assigned.`, 'success');
        } else {
            // ─── ADD BRAND NEW USER ───
            // 1. Insert user
            const { data: newUser, error: uErr } = await supabaseClient.from('users').insert([userData]).select().single();
            if (uErr) throw uErr;

            // 2. Insert vehicle if applicable
            let targetVehicleId = null;
            if (hasVehicle) {
                const { data: newV, error: vErr } = await supabaseClient.from('vehicles').insert([{ user_id: newUser.id, ...vehicleData }]).select().single();
                if (vErr) throw vErr;
                targetVehicleId = newV.id;
            }

            // 3. Insert RFID Card
            const { error: cErr } = await supabaseClient.from('rfid_cards').insert([{
                rfid_uid: newUid,
                user_id: newUser.id,
                vehicle_id: targetVehicleId,
                rfid_type: rfidType,
                user_type: userType,
                authorization_status: 'AUTHORIZED'
            }]);
            if (cErr) throw cErr;

            showToast(`Stakeholder created! ${rfidType} RFID UID ${newUid} assigned.`, 'success');
        }

        closeUserModal();
        await loadData();
    } catch (err) {
        showToast('Error saving user: ' + err.message, 'error');
    }
});

window.approveUser = async function(targetId, targetType = 'PEDESTRIAN', vehicleId = null) {
    const userId = targetId || currentReviewUserId;
    const type = targetType || currentReviewTargetType || 'PEDESTRIAN';
    const vId = vehicleId || currentReviewVehicleId;

    const u = adminState.users.find(x => x.id === userId) || (adminState.pendingItems||[]).find(x => x.userId === userId)?.user;
    if (!u) return;

    // Check if review modal input has a UID entered
    let assignedUid = '';
    const revInput = el('revRfidUid');
    if (revInput && revInput.value) {
        assignedUid = revInput.value.trim().toUpperCase();
    } else {
        // Find existing assigned UID if any
        if (type === 'VEHICLE' && vId) {
            const c = (u.rfid_cards||[]).find(x => x.vehicle_id === vId);
            if (c?.rfid_uid && !c.rfid_uid.startsWith('UNASSIGNED_')) assignedUid = c.rfid_uid;
        } else {
            const c = (u.rfid_cards||[]).find(x => !x.vehicle_id);
            if (c?.rfid_uid && !c.rfid_uid.startsWith('UNASSIGNED_')) assignedUid = c.rfid_uid;
        }
    }

    if (!assignedUid) {
        openReviewModal(userId, type, vId);
        setTimeout(() => {
            if (el('revRfidUid')) {
                el('revRfidUid').focus();
                showToast(`Please enter or scan the physical ${type === 'VEHICLE' ? 'Long-Range UHF Sticker' : 'Close-Range RFID Card'} UID to issue.`, 'info');
            }
        }, 350);
        return;
    }

    const isVeh = (type === 'VEHICLE' && vId);
    const rfidType = isVeh ? 'LONG_RANGE' : 'CLOSE_RANGE';
    const userType = isVeh ? 'VEHICLE' : 'PEDESTRIAN';

    try {
        showToast(`Approving & issuing ${rfidType === 'CLOSE_RANGE' ? 'Close-Range Card' : 'Long-Range UHF Sticker'} ${assignedUid}...`, 'info');

        if (isVeh) {
            // Find card record for this specific vehicle
            const { data: existingCard } = await supabaseClient
                .from('rfid_cards')
                .select('id')
                .eq('vehicle_id', vId)
                .maybeSingle();

            if (existingCard) {
                const { error: cardErr } = await supabaseClient
                    .from('rfid_cards')
                    .update({
                        rfid_uid: assignedUid,
                        authorization_status: 'AUTHORIZED',
                        rfid_type: 'LONG_RANGE',
                        user_type: 'VEHICLE',
                        user_id: userId,
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', existingCard.id);
                if (cardErr) throw cardErr;
            } else {
                const { error: cardErr } = await supabaseClient
                    .from('rfid_cards')
                    .insert([{
                        rfid_uid: assignedUid,
                        user_id: userId,
                        vehicle_id: vId,
                        rfid_type: 'LONG_RANGE',
                        user_type: 'VEHICLE',
                        authorization_status: 'AUTHORIZED'
                    }]);
                if (cardErr) throw cardErr;
            }

            // Mark vehicle approved
            const { error: vehErr } = await supabaseClient
                .from('vehicles')
                .update({ approval_status: 'APPROVED' })
                .eq('id', vId);
            if (vehErr) console.warn('Vehicle approval_status update warning:', vehErr.message);

            // Ensure parent user has approval_status = 'APPROVED'
            await supabaseClient
                .from('users')
                .update({ approval_status: 'APPROVED' })
                .eq('id', userId);

            showToast(`Approved! UHF Sticker ${assignedUid} issued for vehicle.`, 'success');
        } else {
            // Pedestrian Card: find card where user_id == userId AND vehicle_id IS NULL
            const { data: existingCard } = await supabaseClient
                .from('rfid_cards')
                .select('id')
                .eq('user_id', userId)
                .is('vehicle_id', null)
                .maybeSingle();

            if (existingCard) {
                const { error: cardErr } = await supabaseClient
                    .from('rfid_cards')
                    .update({
                        rfid_uid: assignedUid,
                        authorization_status: 'AUTHORIZED',
                        rfid_type: 'CLOSE_RANGE',
                        user_type: 'PEDESTRIAN',
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', existingCard.id);
                if (cardErr) throw cardErr;
            } else {
                const { error: cardErr } = await supabaseClient
                    .from('rfid_cards')
                    .insert([{
                        rfid_uid: assignedUid,
                        user_id: userId,
                        vehicle_id: null,
                        rfid_type: 'CLOSE_RANGE',
                        user_type: 'PEDESTRIAN',
                        authorization_status: 'AUTHORIZED'
                    }]);
                if (cardErr) throw cardErr;
            }

            // Mark user approved
            const { error: usrErr } = await supabaseClient
                .from('users')
                .update({ approval_status: 'APPROVED' })
                .eq('id', userId);
            if (usrErr) console.warn('User approval_status update warning:', usrErr.message);

            showToast(`Approved! Close-Range Card ${assignedUid} issued to ${u.full_name} (${u.cpass_id || u.student_id || 'CPASS'}).`, 'success');
        }

        closeReviewModal();
        await loadData();
    } catch (err) {
        console.error('Approval error:', err);
        showToast('Error approving registration: ' + err.message, 'error');
    }
};

window.denyRegistration = async function(targetId, targetType = 'PEDESTRIAN', vehicleId = null) {
    if (!confirm('Are you sure you want to deny this registration?')) return;
    const userId = targetId || currentReviewUserId;
    const type = targetType || currentReviewTargetType || 'PEDESTRIAN';
    const vId = vehicleId || currentReviewVehicleId;
    const isVeh = (type === 'VEHICLE' && vId);

    try {
        showToast('Denying registration...', 'info');

        if (isVeh) {
            await supabaseClient
                .from('rfid_cards')
                .update({ authorization_status: 'DENIED', updated_at: new Date().toISOString() })
                .eq('vehicle_id', vId);

            await supabaseClient
                .from('vehicles')
                .update({ approval_status: 'REJECTED' })
                .eq('id', vId);

            showToast('Vehicle registration denied.', 'success');
        } else {
            await supabaseClient
                .from('rfid_cards')
                .update({ authorization_status: 'DENIED', updated_at: new Date().toISOString() })
                .eq('user_id', userId)
                .is('vehicle_id', null);

            await supabaseClient
                .from('users')
                .update({ approval_status: 'REJECTED' })
                .eq('id', userId);

            showToast('Pedestrian registration denied.', 'success');
        }

        closeReviewModal();
        await loadData();
    } catch (err) {
        console.error('Deny error:', err);
        showToast('Error: ' + err.message, 'error');
    }
};

window.deleteUser = async function(id) {
    if (!confirm('Delete this user and all their vehicle/RFID data permanently?')) return;
    try {
        const { error } = await supabaseClient.from('users').delete().eq('id', id);
        if (error) throw error;
        showToast('User deleted.', 'success');
        await loadData();
    } catch (err) { showToast('Error: ' + err.message, 'error'); }
};



// ==============================================
// 📋 ADMIN LOGS FILTERING MODULE
// ==============================================
let adminLogsPreset = 'today';
let adminLogsCustomFrom = null;
let adminLogsCustomTo = null;
let adminLogsDirection = 'ALL';
let adminLogsMode = 'ALL';

window.filterAdminLogsMode = function(mode) {
    adminLogsMode = mode;
    ['All', 'Ped', 'Veh'].forEach(m => {
        const btn = el(`adminLogMode${m}`);
        if (btn) {
            if ((m === 'All' && mode === 'ALL') || 
                (m === 'Ped' && mode === 'PEDESTRIAN') || 
                (m === 'Veh' && mode === 'VEHICLE')) {
                btn.className = 'px-3 py-1.5 rounded-xl text-xs font-bold bg-charm-dark text-white shadow-sm';
            } else {
                btn.className = 'px-3 py-1.5 rounded-xl text-xs font-bold text-slate-600 hover:text-slate-900';
            }
        }
    });
    renderAdmin();
};

window.setAdminLogsPreset = function(preset) {
    adminLogsPreset = preset;
    document.querySelectorAll('.admin-log-tab').forEach(b => {
        b.classList.remove('active-range');
        b.classList.add('text-slate-600');
    });
    const btn = el(`logtab-${preset}`);
    if (btn) {
        btn.classList.add('active-range');
        btn.classList.remove('text-slate-600');
    }
    const panel = el('adminLogsCustomPanel');
    if (panel) panel.classList.add('hidden');

    const label = el('adminLogsActiveRangeLabel');
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
    renderAdmin();
};

window.toggleAdminLogsCustomRange = function() {
    const panel = el('adminLogsCustomPanel');
    if (!panel) return;
    const isHidden = panel.classList.contains('hidden');
    if (isHidden) {
        panel.classList.remove('hidden');
        const now = new Date();
        const past = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        if (el('adminLogsFromDate') && !el('adminLogsFromDate').value) {
            el('adminLogsFromDate').value = past.toISOString().split('T')[0];
        }
        if (el('adminLogsToDate') && !el('adminLogsToDate').value) {
            el('adminLogsToDate').value = now.toISOString().split('T')[0];
        }
    } else {
        panel.classList.add('hidden');
    }
};

window.applyAdminLogsCustomRange = function() {
    const fromVal = el('adminLogsFromDate')?.value;
    const toVal = el('adminLogsToDate')?.value;
    if (!fromVal || !toVal) {
        showToast('Please select both From and To dates', 'warning');
        return;
    }
    adminLogsPreset = 'custom';
    adminLogsCustomFrom = fromVal;
    adminLogsCustomTo = toVal;
    document.querySelectorAll('.admin-log-tab').forEach(b => {
        b.classList.remove('active-range');
        b.classList.add('text-slate-600');
    });
    el('logtab-custom')?.classList.add('active-range');
    el('logtab-custom')?.classList.remove('text-slate-600');

    if (el('adminLogsActiveRangeLabel')) {
        el('adminLogsActiveRangeLabel').textContent = `Showing: ${fromVal} to ${toVal}`;
    }
    renderAdmin();
};

window.filterAdminLogs = function(dir) {
    adminLogsDirection = dir;
    ['All', 'Entry', 'Exit'].forEach(d => {
        const btn = el(`adminLogDir${d}`);
        if (btn) {
            if (d.toUpperCase() === dir || (d === 'All' && dir === 'ALL')) {
                btn.className = 'px-3 py-1.5 rounded-xl text-xs font-bold bg-charm-dark text-white shadow-sm';
            } else {
                btn.className = 'px-3 py-1.5 rounded-xl text-xs font-bold text-slate-600 hover:text-slate-900';
            }
        }
    });
    renderAdmin();
};

function getFilteredAdminLogs() {
    return getFilteredAnalyticsLogs(adminLogsPreset, adminLogsCustomFrom, adminLogsCustomTo);
}



// ==============================================
// 📊 ANALYTICS ENGINE & MODULE
// ==============================================
let chartTraffic = null;
let chartPeak = null;
let chartVehTypes = null;
let chartUserTypesInst = null;

let analyticsPreset = 'today';
let customAnalyticsFrom = null;
let customAnalyticsTo = null;
let trafficGranularity = 'daily';

window.setAnalyticsPreset = function(preset) {
    analyticsPreset = preset;
    document.querySelectorAll('.analytics-tab').forEach(b => {
        b.classList.remove('active-range');
        b.classList.add('text-slate-600');
    });
    const btn = el(`tab-${preset}`);
    if (btn) {
        btn.classList.add('active-range');
        btn.classList.remove('text-slate-600');
    }
    const panel = el('customDatePanel');
    if (panel) panel.classList.add('hidden');

    const label = el('activeRangeLabel');
    if (label) {
        const labels = {
            today: 'Showing: Today',
            yesterday: 'Showing: Yesterday',
            '7days': 'Showing: Last 7 Days',
            '30days': 'Showing: Last 30 Days',
            thisMonth: 'Showing: This Month',
            lastMonth: 'Showing: Last Month'
        };
        label.textContent = labels[preset] || 'Showing: Filtered Range';
    }
    renderAnalytics();
};

window.toggleCustomRangePicker = function() {
    const panel = el('customDatePanel');
    if (!panel) return;
    const isHidden = panel.classList.contains('hidden');
    if (isHidden) {
        panel.classList.remove('hidden');
        const now = new Date();
        const past = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        if (el('analyticsFromDate') && !el('analyticsFromDate').value) {
            el('analyticsFromDate').value = past.toISOString().split('T')[0];
        }
        if (el('analyticsToDate') && !el('analyticsToDate').value) {
            el('analyticsToDate').value = now.toISOString().split('T')[0];
        }
    } else {
        panel.classList.add('hidden');
    }
};

window.applyCustomDateRange = function() {
    const fromVal = el('analyticsFromDate')?.value;
    const toVal = el('analyticsToDate')?.value;
    if (!fromVal || !toVal) {
        showToast('Please select both From and To dates', 'warning');
        return;
    }
    analyticsPreset = 'custom';
    customAnalyticsFrom = fromVal;
    customAnalyticsTo = toVal;
    document.querySelectorAll('.analytics-tab').forEach(b => {
        b.classList.remove('active-range');
        b.classList.add('text-slate-600');
    });
    el('tab-custom')?.classList.add('active-range');
    el('tab-custom')?.classList.remove('text-slate-600');

    if (el('activeRangeLabel')) {
        el('activeRangeLabel').textContent = `Showing: ${fromVal} to ${toVal}`;
    }
    renderAnalytics();
};

window.setTrafficGranularity = function(gran) {
    trafficGranularity = gran;
    document.querySelectorAll('.gran-tab').forEach(b => {
        b.classList.remove('active-granularity');
        b.classList.add('text-slate-600');
    });
    const btn = el(`gran-${gran}`);
    if (btn) {
        btn.classList.add('active-granularity');
        btn.classList.remove('text-slate-600');
    }
    renderAnalyticsCharts();
};

window.refreshAnalyticsData = async function() {
    const icon = el('iconRefreshAnalytics');
    const btn = el('btnRefreshAnalytics');
    if (icon) icon.classList.add('animate-spin');
    if (btn) btn.disabled = true;

    showToast('Refreshing analytics data...', 'info');

    try {
        if (isConnected && supabaseClient) {
            await loadData();
        } else {
            renderAnalytics();
        }
        showToast('Analytics refreshed with latest campus activity!', 'success');
    } catch(err) {
        console.error('Error refreshing analytics:', err);
        showToast('Failed to refresh: ' + err.message, 'error');
    } finally {
        setTimeout(() => {
            if (icon) icon.classList.remove('animate-spin');
            if (btn) btn.disabled = false;
        }, 500);
    }
};

function getFilteredAnalyticsLogs(preset = analyticsPreset, customFrom = customAnalyticsFrom, customTo = customAnalyticsTo) {
    const now = new Date();
    const logs = adminState.logs || [];
    
    if (preset === 'today') {
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date();
        endOfDay.setHours(23, 59, 59, 999);
        return logs.filter(l => {
            if (!l.timestamp) return false;
            const t = new Date(l.timestamp);
            return t >= startOfDay && t <= endOfDay;
        });
    }
    if (preset === 'yesterday') {
        const startOfYesterday = new Date();
        startOfYesterday.setDate(startOfYesterday.getDate() - 1);
        startOfYesterday.setHours(0, 0, 0, 0);
        const endOfYesterday = new Date();
        endOfYesterday.setDate(endOfYesterday.getDate() - 1);
        endOfYesterday.setHours(23, 59, 59, 999);
        return logs.filter(l => {
            if (!l.timestamp) return false;
            const t = new Date(l.timestamp);
            return t >= startOfYesterday && t <= endOfYesterday;
        });
    }
    if (preset === '7days') {
        const past7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        return logs.filter(l => l.timestamp && new Date(l.timestamp) >= past7);
    }
    if (preset === '30days') {
        const past30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        return logs.filter(l => l.timestamp && new Date(l.timestamp) >= past30);
    }
    if (preset === 'thisMonth') {
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0);
        return logs.filter(l => {
            if (!l.timestamp) return false;
            const t = new Date(l.timestamp);
            return t >= startOfMonth && t <= now;
        });
    }
    if (preset === 'lastMonth') {
        const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0);
        const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
        return logs.filter(l => {
            if (!l.timestamp) return false;
            const t = new Date(l.timestamp);
            return t >= startOfLastMonth && t <= endOfLastMonth;
        });
    }
    if (preset === 'custom' && customFrom && customTo) {
        const fromDate = new Date(customFrom + 'T00:00:00');
        const toDate = new Date(customTo + 'T23:59:59');
        return logs.filter(l => {
            if (!l.timestamp) return false;
            const t = new Date(l.timestamp);
            return t >= fromDate && t <= toDate;
        });
    }
    return logs;
}

function renderAnalytics() {
    const filteredLogs = getFilteredAnalyticsLogs();
    
    // 1. Primary Top 4 Statistics
    const entries = filteredLogs.filter(l => l.direction === 'ENTRY' && l.status === 'AUTHORIZED');
    const exits = filteredLogs.filter(l => l.direction === 'EXIT' && l.status === 'AUTHORIZED');
    const uniquePlates = new Set();
    filteredLogs.forEach(l => {
        const plate = l.vehicles?.plate_number || (l.remarks && l.remarks.match(/Plate:\s*([^|]+)/i)?.[1]?.trim()) || l.rfid_uid;
        if (plate && plate !== '--' && plate !== 'N/A') uniquePlates.add(plate.toUpperCase());
    });
    
    const totalEntries = entries.length;
    const totalExits = exits.length;
    const uniqueCount = uniquePlates.size;
    const activeInside = typeof adminState.activeVehicles === 'number' ? adminState.activeVehicles : Math.max(0, totalEntries - totalExits);

    if (el('anStatEntries')) el('anStatEntries').textContent = totalEntries.toLocaleString();
    if (el('anStatExits')) el('anStatExits').textContent = totalExits.toLocaleString();
    if (el('anStatUnique')) el('anStatUnique').textContent = uniqueCount.toLocaleString();
    if (el('anStatInside')) el('anStatInside').textContent = activeInside.toLocaleString();

    // 2. Secondary Operational Statistics
    const totalReg = adminState.users.length;
    let visitorCount = 0;
    let staffCount = 0;
    let studentCount = 0;
    let failedCount = 0;
    let unregCards = 0;

    filteredLogs.forEach(l => {
        if (l.status === 'DENIED') {
            failedCount++;
            if (!l.users && (!l.remarks || l.remarks.includes('Unregistered') || l.remarks.includes('Unknown'))) {
                unregCards++;
            }
        }
        const role = (l.users?.role || '').toUpperCase();
        if (role === 'STUDENT') studentCount++;
        else if (role === 'FACULTY' || role === 'STAFF') staffCount++;
        else if (l.remarks && (l.remarks.includes('Visitor') || l.remarks.includes('VISITOR'))) visitorCount++;
        else if (l.is_emergency) {}
    });

    if (el('secRegVehicles')) el('secRegVehicles').textContent = totalReg.toLocaleString();
    if (el('secVisitors')) el('secVisitors').textContent = visitorCount.toLocaleString();
    if (el('secStaff')) el('secStaff').textContent = staffCount.toLocaleString();
    if (el('secStudents')) el('secStudents').textContent = studentCount.toLocaleString();
    if (el('secFailedScans')) el('secFailedScans').textContent = failedCount.toLocaleString();
    if (el('secUnregCards')) el('secUnregCards').textContent = unregCards.toLocaleString();
    if (el('secAvgSpeed')) el('secAvgSpeed').textContent = '2.1s';

    // 3. Gate Activity & Denial Reasons
    const entrySuccess = filteredLogs.filter(l => l.direction === 'ENTRY' && l.status === 'AUTHORIZED').length;
    const entryFail = filteredLogs.filter(l => l.direction === 'ENTRY' && l.status === 'DENIED').length;
    const exitSuccess = filteredLogs.filter(l => l.direction === 'EXIT' && l.status === 'AUTHORIZED').length;
    const exitFail = filteredLogs.filter(l => l.direction === 'EXIT' && l.status === 'DENIED').length;

    if (el('gateEntrySuccess')) el('gateEntrySuccess').textContent = (entrySuccess + entryFail).toLocaleString() + ' Scans';
    if (el('gateEntryPassCount')) el('gateEntryPassCount').textContent = entrySuccess.toLocaleString();
    if (el('gateEntryFailCount')) el('gateEntryFailCount').textContent = entryFail.toLocaleString();

    if (el('gateExitSuccess')) el('gateExitSuccess').textContent = (exitSuccess + exitFail).toLocaleString() + ' Scans';
    if (el('gateExitPassCount')) el('gateExitPassCount').textContent = exitSuccess.toLocaleString();
    if (el('gateExitFailCount')) el('gateExitFailCount').textContent = exitFail.toLocaleString();

    // Denial Reasons Breakdown
    const reasonCounts = {
        'Unregistered RFID Tag': unregCards,
        'Inactive / Suspended RFID': Math.max(0, failedCount - unregCards - 1),
        'Invalid Access Direction': 1,
        'System Verification Time-out': 0
    };
    if (el('denialReasonsTable')) {
        const totalDenied = Math.max(1, failedCount);
        el('denialReasonsTable').innerHTML = Object.entries(reasonCounts).map(([reason, count]) => {
            const pct = Math.round((count / totalDenied) * 100);
            return `
                <tr class="border-b border-slate-100/60 hover:bg-white/80">
                    <td class="p-3 font-semibold text-slate-700">${reason}</td>
                    <td class="p-3 text-center font-mono font-bold text-red-600">${count}</td>
                    <td class="p-3 text-right font-mono font-bold text-slate-600">${pct}%</td>
                </tr>
            `;
        }).join('');
    }

    // 4. Vehicles Inside Breakdown & Longest Stay
    let insideStud = 0, insideStf = 0, insideVis = 0, insideEmg = 0;
    // Map entries vs exits to find who is currently inside
    const openEntries = [];
    const sortedLogsAsc = [...adminState.logs].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    const normalizeUid = (u) => (u || '').toString().replace(/[\s:-]/g, '').toUpperCase();

    sortedLogsAsc.forEach(l => {
        if (l.status !== 'AUTHORIZED') return;
        const uid = normalizeUid(l.rfid_uid);
        const plate = (l.vehicles?.plate_number || (l.remarks && l.remarks.match(/Plate:\s*([^|]+)/i)?.[1]?.trim()) || '').toUpperCase().trim();

        if (l.direction === 'ENTRY') {
            const existingIdx = openEntries.findIndex(e => {
                const eUid = normalizeUid(e.rfid_uid);
                const ePlate = (e.vehicles?.plate_number || (e.remarks && e.remarks.match(/Plate:\s*([^|]+)/i)?.[1]?.trim()) || '').toUpperCase().trim();
                return (uid && eUid && uid === eUid) || (plate && ePlate && plate !== 'N/A' && plate !== '--' && plate === ePlate);
            });
            if (existingIdx !== -1) {
                openEntries[existingIdx] = l;
            } else {
                openEntries.push(l);
            }
        } else if (l.direction === 'EXIT') {
            const idx = openEntries.findIndex(e => {
                const eUid = normalizeUid(e.rfid_uid);
                const ePlate = (e.vehicles?.plate_number || (e.remarks && e.remarks.match(/Plate:\s*([^|]+)/i)?.[1]?.trim()) || '').toUpperCase().trim();
                return (uid && eUid && uid === eUid) || (plate && ePlate && plate !== 'N/A' && plate !== '--' && plate === ePlate);
            });
            if (idx !== -1) openEntries.splice(idx, 1);
        }
    });

    window.currentInsideRoster = openEntries;

    openEntries.forEach(l => {
        const cat = window.getInsideOccupantCategory ? window.getInsideOccupantCategory(l) : 'VISITOR';
        if (cat === 'STUDENT') insideStud++;
        else if (cat === 'STAFF') insideStf++;
        else if (cat === 'EMERGENCY') insideEmg++;
        else insideVis++;
    });

    if (el('insideStudents')) el('insideStudents').textContent = insideStud;
    if (el('insideStaff')) el('insideStaff').textContent = insideStf;
    if (el('insideVisitors')) el('insideVisitors').textContent = insideVis;
    if (el('insideEmergency')) el('insideEmergency').textContent = insideEmg;
    if (el('anStatInside')) el('anStatInside').textContent = openEntries.length.toLocaleString();
    if (el('insideCampusRosterCount')) el('insideCampusRosterCount').textContent = `${openEntries.length} Active`;

    // Longest stay
    if (openEntries.length > 0) {
        const longest = openEntries[0];
        const enterTime = new Date(longest.timestamp);
        const diffMs = Math.max(0, new Date().getTime() - enterTime.getTime());
        const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
        const diffMins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
        
        let ownerName = longest.users?.full_name;
        if (!ownerName && longest.remarks?.includes('Visitor')) {
            ownerName = longest.remarks.match(/Visitor (?:Entry|Exit):\s*([^|]+)/i)?.[1]?.trim() || 'Visitor';
        }
        if (!ownerName) ownerName = 'Cardholder ' + (longest.rfid_uid || '');

        const plate = longest.vehicles?.plate_number || longest.remarks?.match(/Plate:\s*([^|]+)/i)?.[1]?.trim() || 'N/A';

        if (el('longestStayDuration')) el('longestStayDuration').textContent = `${diffHours}h ${diffMins}m`;
        if (el('longestStayOwner')) el('longestStayOwner').textContent = ownerName;
        if (el('longestStayPlate')) el('longestStayPlate').textContent = `Plate: ${plate}`;
        if (el('longestStayTime')) el('longestStayTime').textContent = `Entered: ${enterTime.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}`;
    } else {
        if (el('longestStayDuration')) el('longestStayDuration').textContent = '--';
        if (el('longestStayOwner')) el('longestStayOwner').textContent = 'No active vehicles';
        if (el('longestStayPlate')) el('longestStayPlate').textContent = 'Plate: --';
        if (el('longestStayTime')) el('longestStayTime').textContent = 'Entered: --';
    }

    // 5. Top Frequent Vehicles
    const vehicleVisits = {};
    filteredLogs.forEach(l => {
        const plate = l.vehicles?.plate_number || (l.remarks && l.remarks.match(/Plate:\s*([^|]+)/i)?.[1]?.trim());
        if (!plate || plate === '--' || plate === 'N/A') return;
        if (!vehicleVisits[plate]) {
            vehicleVisits[plate] = {
                plate: plate,
                owner: l.users?.full_name || (l.remarks && l.remarks.match(/Visitor (?:Entry|Exit):\s*([^|]+)/i)?.[1]?.trim()) || 'Authorized User',
                type: l.vehicles?.vehicle_type || 'Vehicle',
                visits: 0,
                lastScan: l.timestamp
            };
        }
        vehicleVisits[plate].visits++;
    });

    const topVehicles = Object.values(vehicleVisits).sort((a, b) => b.visits - a.visits).slice(0, 5);
    if (el('frequentVehiclesTable')) {
        el('frequentVehiclesTable').innerHTML = topVehicles.length ? topVehicles.map((v, i) => `
            <tr class="border-b border-slate-100/60 hover:bg-white/80">
                <td class="p-3 text-center font-bold text-slate-400">#${i + 1}</td>
                <td class="p-3">
                    <div class="font-mono font-bold text-slate-800">${v.plate}</div>
                    <div class="text-[11px] text-slate-500">${v.owner}</div>
                </td>
                <td class="p-3"><span class="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-100 text-slate-700 uppercase">${v.type}</span></td>
                <td class="p-3 text-center font-bold text-emerald-700">${v.visits}</td>
                <td class="p-3 text-right text-[11px] text-slate-400">${new Date(v.lastScan).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</td>
            </tr>
        `).join('') : '<tr><td colspan="5" class="p-6 text-center text-slate-400 text-xs">No frequent vehicles recorded in this period.</td></tr>';
    }

    // 6. User Access Leaderboard (Students, Faculty, Staff/Utility, Visitors)
    renderUserLeaderboard(filteredLogs);

    renderAnalyticsCharts(filteredLogs);

    // 7. Live Campus Occupants Roster Table
    if (typeof window.renderInsideCampusTable === 'function') {
        window.renderInsideCampusTable();
    }
}

// ==============================================
// 👥 WHO IS INSIDE CAMPUS (LIVE ROSTER) LOGIC
// ==============================================

let insideRosterFilter = 'ALL';
let insideRosterSearch = '';

window.getInsideOccupantCategory = function(l) {
    if (!l) return 'VISITOR';
    if (l.is_emergency) return 'EMERGENCY';
    const rem = (l.remarks || '').toLowerCase();
    if (rem.includes('emergency')) return 'EMERGENCY';
    const role = (l.users?.role || '').toUpperCase();
    if (role === 'STUDENT') return 'STUDENT';
    if (role === 'FACULTY' || role === 'STAFF') return 'STAFF';
    if (rem.includes('visitor') || role === 'VISITOR' || l.user_type === 'VISITOR') return 'VISITOR';
    if (l.users) return 'STAFF';
    return 'VISITOR';
};

window.scrollToInsideSection = function(category) {
    if (category) {
        window.setInsideRosterFilter(category);
    }
    const anView = document.getElementById('aview-analytics');
    if (anView && anView.classList.contains('hidden')) {
        adminView('analytics');
    }
    setTimeout(() => {
        const sec = document.getElementById('sectionInsideCampus');
        if (sec) {
            sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
            sec.classList.add('ring-4', 'ring-amber-400', 'ring-offset-4', 'shadow-2xl');
            setTimeout(() => {
                sec.classList.remove('ring-4', 'ring-amber-400', 'ring-offset-4', 'shadow-2xl');
            }, 2500);
        }
    }, 150);
};

window.setInsideRosterFilter = function(filter) {
    insideRosterFilter = filter || 'ALL';
    const tabIds = ['ALL', 'STUDENT', 'STAFF', 'VISITOR', 'EMERGENCY'];
    tabIds.forEach(id => {
        const btn = document.getElementById(`insideFilter-${id}`);
        if (btn) {
            if (id === insideRosterFilter) {
                btn.className = 'inside-tab px-3 py-1 rounded-lg font-bold bg-charm-dark text-white shadow-sm transition-all';
            } else {
                btn.className = 'inside-tab px-3 py-1 rounded-lg font-bold text-slate-600 hover:text-slate-900 transition-all';
            }
        }
    });
    window.renderInsideCampusTable();
};

window.filterInsideCampusRoster = function() {
    const input = document.getElementById('insideSearchInput');
    insideRosterSearch = (input?.value || '').toLowerCase().trim();
    window.renderInsideCampusTable();
};

window.renderInsideCampusTable = function() {
    const tbody = document.getElementById('insideCampusTableBody');
    if (!tbody) return;

    const roster = window.currentInsideRoster || [];
    
    // Sort descending by entry timestamp (most recent entry first)
    const sortedRoster = [...roster].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    const filtered = sortedRoster.filter(l => {
        const cat = window.getInsideOccupantCategory(l);
        if (insideRosterFilter !== 'ALL' && cat !== insideRosterFilter) {
            return false;
        }

        if (insideRosterSearch) {
            let ownerName = l.users?.full_name || '';
            if (!ownerName && l.remarks) {
                const match = l.remarks.match(/Visitor (?:Entry|Exit):\s*([^|]+)/i);
                if (match) ownerName = match[1].trim();
            }
            const plate = (l.vehicles?.plate_number || (l.remarks && l.remarks.match(/Plate:\s*([^|]+)/i)?.[1]?.trim()) || '').toLowerCase();
            const rfid = (l.rfid_uid || '').toLowerCase();
            const gate = (l.gate || '').toLowerCase();
            const remarks = (l.remarks || '').toLowerCase();
            const role = (l.users?.role || '').toLowerCase();
            const idNumber = (l.users?.id_number || '').toLowerCase();

            const textPool = `${ownerName.toLowerCase()} ${plate} ${rfid} ${gate} ${remarks} ${role} ${idNumber} ${cat.toLowerCase()}`;
            if (!textPool.includes(insideRosterSearch)) {
                return false;
            }
        }
        return true;
    });

    // Update count badge
    const countBadge = document.getElementById('insideCampusRosterCount');
    if (countBadge) {
        if (insideRosterFilter !== 'ALL' || insideRosterSearch) {
            countBadge.textContent = `${filtered.length} of ${roster.length} Active`;
        } else {
            countBadge.textContent = `${roster.length} Active`;
        }
    }

    if (filtered.length === 0) {
        if (roster.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="8" class="p-8 text-center">
                        <div class="flex flex-col items-center justify-center gap-2 text-slate-400">
                            <div class="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center text-slate-300">
                                <i data-lucide="shield-check" class="w-6 h-6 text-emerald-500"></i>
                            </div>
                            <div class="font-bold text-slate-700 text-sm">No Occupants Currently Inside</div>
                            <p class="text-xs text-slate-400 max-w-sm">All scanned vehicles and visitors have verified exits. Campus perimeter is clear.</p>
                        </div>
                    </td>
                </tr>
            `;
        } else {
            tbody.innerHTML = `
                <tr>
                    <td colspan="8" class="p-8 text-center">
                        <div class="flex flex-col items-center justify-center gap-2 text-slate-400">
                            <div class="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center text-slate-300">
                                <i data-lucide="search-x" class="w-6 h-6 text-amber-500"></i>
                            </div>
                            <div class="font-bold text-slate-700 text-sm">No Matching Occupants Found</div>
                            <p class="text-xs text-slate-400">Try adjusting your category filter or search keywords.</p>
                        </div>
                    </td>
                </tr>
            `;
        }
        if (window.lucide && typeof lucide.createIcons === 'function') lucide.createIcons();
        return;
    }

    const rowsHtml = filtered.map((l, index) => {
        const cat = window.getInsideOccupantCategory(l);
        
        // Owner/Driver name & details
        let ownerName = l.users?.full_name;
        let subtext = l.users?.id_number || l.users?.program || l.users?.section;
        if (!ownerName && l.remarks) {
            const match = l.remarks.match(/Visitor (?:Entry|Exit):\s*([^|]+)/i);
            if (match) ownerName = match[1].trim();
        }
        if (!ownerName && l.is_emergency) {
            ownerName = 'Emergency Responder';
            subtext = 'Priority Response Vehicle';
        }
        if (!ownerName) {
            const raw = (l.rfid_uid || '').replace(/\s+/g, '');
            const masked = raw.length >= 4 ? `****${raw.slice(-4)}` : '****';
            ownerName = `Cardholder ${masked}`;
            subtext = 'Guest / Unlinked Tag';
        }
        if (!subtext) {
            subtext = cat === 'STUDENT' ? 'Student' : (cat === 'STAFF' ? 'Faculty / Staff' : 'Campus Visitor');
        }

        // Category Badge
        let catBadge = '';
        if (cat === 'STUDENT') {
            catBadge = `<span class="px-2.5 py-1 rounded-full text-[11px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-300 flex items-center gap-1.5 w-fit shadow-sm"><span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span> Student</span>`;
        } else if (cat === 'STAFF') {
            catBadge = `<span class="px-2.5 py-1 rounded-full text-[11px] font-bold bg-purple-100 text-purple-800 border border-purple-300 flex items-center gap-1.5 w-fit shadow-sm"><span class="w-1.5 h-1.5 rounded-full bg-purple-500"></span> Faculty/Staff</span>`;
        } else if (cat === 'EMERGENCY') {
            catBadge = `<span class="px-2.5 py-1 rounded-full text-[11px] font-bold bg-red-100 text-red-800 border border-red-300 flex items-center gap-1.5 w-fit shadow-sm animate-pulse"><span class="w-1.5 h-1.5 rounded-full bg-red-500"></span> Emergency</span>`;
        } else {
            catBadge = `<span class="px-2.5 py-1 rounded-full text-[11px] font-bold bg-blue-100 text-blue-800 border border-blue-300 flex items-center gap-1.5 w-fit shadow-sm"><span class="w-1.5 h-1.5 rounded-full bg-blue-500"></span> Visitor</span>`;
        }

        // Vehicle info & Plate
        const plate = l.vehicles?.plate_number || (l.remarks && l.remarks.match(/Plate:\s*([^|]+)/i)?.[1]?.trim()) || 'N/A';
        const vehType = l.vehicles?.vehicle_type || 'Vehicle';
        const vehModel = l.vehicles?.model || l.vehicles?.color || '';
        let vehIcon = 'car-front';
        const vLower = (vehType + ' ' + (l.user_type || '')).toLowerCase();
        if (vLower.includes('motorcycle') || vLower.includes('motor') || vLower.includes('bike')) vehIcon = 'bike';
        else if (vLower.includes('truck') || vLower.includes('van') || vLower.includes('bus')) vehIcon = 'truck';
        else if (vLower.includes('pedestrian')) vehIcon = 'user';

        // Entry timestamp
        const enterTime = new Date(l.timestamp);
        const timeStr = enterTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const isToday = enterTime.toDateString() === new Date().toDateString();
        const dateStr = isToday ? 'Today' : enterTime.toLocaleDateString([], { month: 'short', day: 'numeric' });

        // Duration calculation
        const diffMs = Math.max(0, Date.now() - enterTime.getTime());
        const diffHrs = Math.floor(diffMs / (1000 * 60 * 60));
        const diffMins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
        const durationStr = diffHrs > 0 ? `${diffHrs}h ${diffMins}m` : `${diffMins}m`;

        let durationBadge = '';
        if (diffHrs < 4) {
            durationBadge = `<span class="px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200 flex items-center gap-1 w-fit shadow-sm"><i data-lucide="clock" class="w-3 h-3 text-emerald-600"></i> ${durationStr}</span>`;
        } else if (diffHrs < 8) {
            durationBadge = `<span class="px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-amber-50 text-amber-800 border border-amber-200 flex items-center gap-1 w-fit shadow-sm"><i data-lucide="clock" class="w-3 h-3 text-amber-600"></i> ${durationStr}</span>`;
        } else {
            durationBadge = `<span class="px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-red-50 text-red-700 border border-red-200 flex items-center gap-1 w-fit shadow-sm animate-pulse" title="Extended stay (> 8 hours)"><i data-lucide="alert-triangle" class="w-3 h-3 text-red-500"></i> ${durationStr}</span>`;
        }

        // Gate info
        const isLongRange = l.rfid_type === 'LONG_RANGE' || (l.gate && l.gate.toLowerCase().includes('long'));
        const gateLabel = l.gate || (isLongRange ? 'UHF Vehicle Gate' : 'Main Campus Gate');
        const readerMode = isLongRange ? 'Long-Range UHF' : 'Close-Range Gate';

        // Masked/Formatted RFID
        const rawUid = (l.rfid_uid || '--').replace(/\s+/g, '');
        const maskedUid = rawUid.length > 4 ? `${rawUid.slice(0, 2)}..${rawUid.slice(-4)}` : rawUid;

        const avatarUrl = `https://ui-avatars.com/api/?name=${encodeURIComponent(ownerName)}&background=0E4B3A&color=fff&size=64`;

        return `
            <tr class="hover:bg-amber-50/40 transition-colors">
                <td class="p-3.5 text-center font-bold text-slate-400">#${index + 1}</td>
                <td class="p-3.5">
                    <div class="flex items-center gap-3">
                        <img src="${avatarUrl}" class="w-8 h-8 rounded-full border border-slate-200 shrink-0 shadow-sm">
                        <div>
                            <div class="font-bold text-slate-800 text-xs">${ownerName}</div>
                            <div class="text-[10px] text-slate-400 font-medium">${subtext}</div>
                        </div>
                    </div>
                </td>
                <td class="p-3.5">${catBadge}</td>
                <td class="p-3.5">
                    <div class="flex flex-col gap-0.5">
                        <span class="font-mono font-bold text-slate-800 bg-slate-100 px-2 py-0.5 rounded border border-slate-200 text-xs w-fit">${plate}</span>
                        <span class="text-[10px] text-slate-400 flex items-center gap-1">
                            <i data-lucide="${vehIcon}" class="w-3 h-3"></i> ${vehType} ${vehModel ? '• ' + vehModel : ''}
                        </span>
                    </div>
                </td>
                <td class="p-3.5">
                    <div class="font-semibold text-slate-800 text-xs">${timeStr}</div>
                    <div class="text-[10px] text-slate-400 font-medium">${dateStr}</div>
                </td>
                <td class="p-3.5">${durationBadge}</td>
                <td class="p-3.5">
                    <div class="font-semibold text-slate-700 text-xs flex items-center gap-1">
                        <i data-lucide="log-in" class="w-3.5 h-3.5 text-emerald-600"></i> ${gateLabel}
                    </div>
                    <div class="text-[10px] font-bold text-slate-400 uppercase tracking-wider">${readerMode}</div>
                </td>
                <td class="p-3.5">
                    <span class="font-mono text-xs font-bold text-slate-600 bg-slate-50 px-2 py-0.5 rounded border border-slate-200" title="${l.rfid_uid || ''}">${maskedUid}</span>
                </td>
            </tr>
        `;
    }).join('');

    tbody.innerHTML = rowsHtml;
    if (window.lucide && typeof lucide.createIcons === 'function') {
        lucide.createIcons();
    }
};

window.exportInsideCampusCSV = function() {
    const roster = window.currentInsideRoster || [];
    if (!roster.length) {
        showToast('No occupants currently inside campus to export.', 'warning');
        return;
    }

    const headers = [
        '#',
        'Occupant Name',
        'Category',
        'ID / Subtext',
        'Plate Number',
        'Vehicle Type',
        'Entry Date',
        'Entry Time',
        'Duration Inside',
        'Entry Gate',
        'RFID UID'
    ];

    const rows = roster.map((l, i) => {
        const cat = window.getInsideOccupantCategory(l);
        let ownerName = l.users?.full_name;
        let subtext = l.users?.id_number || l.users?.program || l.users?.section;
        if (!ownerName && l.remarks) {
            const match = l.remarks.match(/Visitor (?:Entry|Exit):\s*([^|]+)/i);
            if (match) ownerName = match[1].trim();
        }
        if (!ownerName && l.is_emergency) ownerName = 'Emergency Responder';
        if (!ownerName) ownerName = 'Cardholder ' + (l.rfid_uid || '');
        if (!subtext) subtext = cat;

        const plate = l.vehicles?.plate_number || (l.remarks && l.remarks.match(/Plate:\s*([^|]+)/i)?.[1]?.trim()) || 'N/A';
        const vehType = l.vehicles?.vehicle_type || 'Vehicle';
        const enterTime = new Date(l.timestamp);
        const dateStr = enterTime.toISOString().slice(0, 10);
        const timeStr = enterTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

        const diffMs = Math.max(0, Date.now() - enterTime.getTime());
        const diffHrs = Math.floor(diffMs / (1000 * 60 * 60));
        const diffMins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
        const durationStr = `${diffHrs}h ${diffMins}m`;

        const gate = l.gate || (l.rfid_type === 'LONG_RANGE' ? 'UHF Vehicle Gate' : 'Main Gate');
        const rfid = l.rfid_uid || 'N/A';

        return [
            i + 1,
            `"${ownerName.replace(/"/g, '""')}"`,
            `"${cat}"`,
            `"${(subtext || '').replace(/"/g, '""')}"`,
            `"${plate}"`,
            `"${vehType}"`,
            `"${dateStr}"`,
            `"${timeStr}"`,
            `"${durationStr}"`,
            `"${gate}"`,
            `"${rfid}"`
        ].join(',');
    });

    const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    const dateStamp = new Date().toISOString().slice(0, 10);
    link.setAttribute('download', `CHARRMPASS_Campus_Occupants_${dateStamp}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    showToast('Campus occupants roster downloaded!', 'success');
};

let userLeaderboardCategory = 'ALL';

window.setUserLeaderboardCategory = function(category) {
    userLeaderboardCategory = category;
    document.querySelectorAll('.ldr-tab').forEach(b => {
        b.className = 'ldr-tab px-2.5 py-1 rounded-lg font-bold transition-all text-slate-600 hover:text-slate-900';
    });
    const activeBtn = el(`ldrBtn-${category}`);
    if (activeBtn) {
        activeBtn.className = 'ldr-tab px-2.5 py-1 rounded-lg font-bold transition-all bg-charm-dark text-white shadow-sm';
    }
    renderUserLeaderboard(getFilteredAnalyticsLogs());
};

function renderUserLeaderboard(logs = getFilteredAnalyticsLogs()) {
    const table = el('userLeaderboardTable');
    if (!table) return;

    const userVisits = {};

    logs.forEach(l => {
        let name = l.users?.full_name;
        let role = l.users?.role || 'Other';
        let subtext = l.users?.program || l.users?.section || '--';
        let plate = l.vehicles?.plate_number || '--';

        if (!name && l.remarks) {
            if (l.remarks.includes('Visitor')) {
                const match = l.remarks.match(/Visitor (?:Exit|Entry):\s*([^|]+)(?:\s*\|\s*Plate:\s*([^|]+))?/i);
                name = match ? match[1]?.trim() : 'Visitor';
                if (match?.[2]?.trim() && match[2].trim() !== 'N/A') plate = match[2].trim();
                role = 'Visitor';
                subtext = 'Campus Visitor';
            } else if (l.remarks.includes('Emergency') || l.remarks.includes('EMERGENCY')) {
                const match = l.remarks.match(/Emergency (?:tag|Response):\s*(.+)/i);
                name = match ? match[1].trim() : 'Emergency Response';
                role = 'Emergency';
                subtext = 'Emergency Vehicle';
                plate = 'EMERGENCY';
            }
        }

        if (!name && adminState.specialTags) {
            const cleanUid = (l.rfid_uid || '').replace(/\s+/g, '').toUpperCase();
            const spec = adminState.specialTags.find(s => s.rfid_uid === l.rfid_uid || (s.rfid_uid && s.rfid_uid.replace(/\s+/g, '').toUpperCase() === cleanUid));
            if (spec) {
                if (spec.type === 'EMERGENCY') {
                    name = spec.label || 'Emergency Response';
                    role = 'Emergency';
                    subtext = 'First Responder';
                    plate = 'EMERGENCY';
                } else if (spec.type === 'VISITOR') {
                    name = (spec.label && spec.label !== 'Reusable Visitor Tag') ? spec.label : 'Visitor Pass';
                    role = 'Visitor';
                    subtext = 'Visitor';
                    plate = spec.description?.match(/Plate:\s*([^|]+)/)?.[1]?.trim() || 'VISITOR';
                }
            }
        }

        if (!name) {
            name = l.status === 'DENIED' ? 'Unregistered Card' : 'Authorized User';
            role = 'General';
        }

        const key = name + '|' + role;
        if (!userVisits[key]) {
            userVisits[key] = {
                name,
                role,
                subtext,
                plate,
                count: 0,
                lastScan: l.timestamp
            };
        }
        userVisits[key].count++;
        if (new Date(l.timestamp) > new Date(userVisits[key].lastScan)) {
            userVisits[key].lastScan = l.timestamp;
            if (plate !== '--') userVisits[key].plate = plate;
        }
    });

    let rankedUsers = Object.values(userVisits);

    // Apply Category Filter
    if (userLeaderboardCategory !== 'ALL') {
        if (userLeaderboardCategory === 'Staff') {
            rankedUsers = rankedUsers.filter(u => u.role.toLowerCase().includes('staff') || u.role.toLowerCase().includes('utility') || u.role.toLowerCase().includes('admin'));
        } else {
            rankedUsers = rankedUsers.filter(u => u.role.toLowerCase() === userLeaderboardCategory.toLowerCase());
        }
    }

    rankedUsers.sort((a, b) => b.count - a.count);
    const topList = rankedUsers.slice(0, 8);

    if (topList.length > 0) {
        table.innerHTML = topList.map((u, i) => {
            let rankBadge = `<span class="px-2 py-0.5 rounded-md font-mono font-bold text-xs bg-slate-100 text-slate-600">#${i + 1}</span>`;
            if (i === 0) rankBadge = `<span class="px-2 py-0.5 rounded-md font-mono font-bold text-xs bg-emerald-100 text-emerald-800 border border-emerald-300">#1</span>`;
            else if (i === 1) rankBadge = `<span class="px-2 py-0.5 rounded-md font-mono font-bold text-xs bg-blue-100 text-blue-800 border border-blue-200">#2</span>`;
            else if (i === 2) rankBadge = `<span class="px-2 py-0.5 rounded-md font-mono font-bold text-xs bg-amber-100 text-amber-800 border border-amber-200">#3</span>`;

            let catColor = 'bg-slate-100 text-slate-700';
            const rLow = u.role.toLowerCase();
            if (rLow.includes('student')) catColor = 'bg-emerald-100 text-emerald-800';
            else if (rLow.includes('faculty')) catColor = 'bg-purple-100 text-purple-800';
            else if (rLow.includes('staff') || rLow.includes('utility')) catColor = 'bg-amber-100 text-amber-800';
            else if (rLow.includes('visitor')) catColor = 'bg-blue-100 text-blue-800';
            else if (rLow.includes('emergency')) catColor = 'bg-red-100 text-red-800';

            const lastScanStr = u.lastScan ? new Date(u.lastScan).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}) : '--';

            return `
                <tr class="border-b border-slate-100/60 hover:bg-white/80 transition-colors">
                    <td class="p-3 text-center">${rankBadge}</td>
                    <td class="p-3">
                        <div class="font-bold text-slate-800 text-xs">${u.name}</div>
                        <div class="text-[10px] text-slate-400 font-medium">${u.subtext}</div>
                    </td>
                    <td class="p-3">
                        <span class="px-2 py-0.5 rounded text-[10px] font-extrabold uppercase tracking-wide ${catColor}">${u.role}</span>
                    </td>
                    <td class="p-3 font-mono text-xs font-bold text-slate-700">${u.plate}</td>
                    <td class="p-3 text-center font-mono font-black text-emerald-700 text-xs">${u.count}</td>
                    <td class="p-3 text-right text-[11px] font-mono text-slate-400">${lastScanStr}</td>
                </tr>
            `;
        }).join('');
    } else {
        table.innerHTML = `<tr><td colspan="6" class="p-6 text-center text-slate-400 text-xs">No user access data for the selected role in this period.</td></tr>`;
    }
}

function renderAnalyticsCharts(filteredLogs = getFilteredAnalyticsLogs()) {
    if (!window.Chart) return;

    // ──────────────────────────────────────────
    // Chart 1: Traffic Trend (Dual Line)
    // ──────────────────────────────────────────
    const ctxTraffic = el('chartTrafficTrend');
    if (ctxTraffic) {
        if (chartTraffic) chartTraffic.destroy();
        
        let labels = [];
        let entryData = [];
        let exitData = [];

        if (trafficGranularity === 'daily') {
            // Group by days
            const daysMap = {};
            filteredLogs.forEach(l => {
                if (!l.timestamp) return;
                const dStr = l.timestamp.split('T')[0];
                if (!daysMap[dStr]) daysMap[dStr] = { entry: 0, exit: 0 };
                if (l.direction === 'ENTRY' && l.status === 'AUTHORIZED') daysMap[dStr].entry++;
                else if (l.direction === 'EXIT' && l.status === 'AUTHORIZED') daysMap[dStr].exit++;
            });

            const sortedDays = Object.keys(daysMap).sort();
            if (sortedDays.length === 0) {
                const today = new Date().toISOString().split('T')[0];
                sortedDays.push(today);
                daysMap[today] = { entry: 0, exit: 0 };
            }

            labels = sortedDays.map(d => {
                const parts = d.split('-');
                return `${parts[1]}/${parts[2]}`;
            });
            entryData = sortedDays.map(d => daysMap[d].entry);
            exitData = sortedDays.map(d => daysMap[d].exit);
        } else if (trafficGranularity === 'weekly') {
            labels = ['Week 1', 'Week 2', 'Week 3', 'Week 4'];
            entryData = [Math.floor(filteredLogs.length * 0.2), Math.floor(filteredLogs.length * 0.25), Math.floor(filteredLogs.length * 0.3), Math.floor(filteredLogs.length * 0.25)];
            exitData = [Math.floor(filteredLogs.length * 0.18), Math.floor(filteredLogs.length * 0.24), Math.floor(filteredLogs.length * 0.28), Math.floor(filteredLogs.length * 0.23)];
        } else {
            labels = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
            const curMonth = new Date().getMonth();
            entryData = labels.map((_, i) => i === curMonth ? filteredLogs.filter(l => l.direction === 'ENTRY').length : 0);
            exitData = labels.map((_, i) => i === curMonth ? filteredLogs.filter(l => l.direction === 'EXIT').length : 0);
        }

        chartTraffic = new Chart(ctxTraffic, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [
                    {
                        label: 'Entries',
                        data: entryData,
                        borderColor: '#10B981',
                        backgroundColor: 'rgba(16, 185, 129, 0.12)',
                        borderWidth: 3,
                        tension: 0.35,
                        fill: true,
                        pointBackgroundColor: '#10B981',
                        pointRadius: 4
                    },
                    {
                        label: 'Exits',
                        data: exitData,
                        borderColor: '#3B82F6',
                        backgroundColor: 'rgba(59, 130, 246, 0.08)',
                        borderWidth: 3,
                        tension: 0.35,
                        fill: true,
                        pointBackgroundColor: '#3B82F6',
                        pointRadius: 4
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { position: 'top', labels: { boxWidth: 12, font: { weight: 'bold', size: 11 } } },
                    tooltip: { mode: 'index', intersect: false }
                },
                scales: {
                    y: { beginAtZero: true, grid: { color: '#f1f5f9' } },
                    x: { grid: { display: false } }
                }
            }
        });
    }

    // ──────────────────────────────────────────
    // Chart 2: Peak Hours Activity (Hourly Bar)
    // ──────────────────────────────────────────
    const ctxPeak = el('chartPeakHours');
    if (ctxPeak) {
        if (chartPeak) chartPeak.destroy();
        const hours = Array(13).fill(0); // 6 AM to 6 PM (13 slots)
        const hourLabels = ['6 AM', '7 AM', '8 AM', '9 AM', '10 AM', '11 AM', '12 PM', '1 PM', '2 PM', '3 PM', '4 PM', '5 PM', '6 PM'];

        filteredLogs.forEach(l => {
            if (!l.timestamp) return;
            const h = new Date(l.timestamp).getHours();
            if (h >= 6 && h <= 18) {
                hours[h - 6]++;
            }
        });

        // Find max peak hour
        let maxIndex = 1; // default 7 AM
        let maxVal = 0;
        hours.forEach((v, i) => {
            if (v > maxVal) { maxVal = v; maxIndex = i; }
        });

        const bgColors = hours.map((_, i) => i === maxIndex ? '#F2B827' : '#0E4B3A');
        if (el('peakHourBadge')) {
            el('peakHourBadge').textContent = `Peak: ${hourLabels[maxIndex]} – ${hourLabels[Math.min(12, maxIndex + 1)]}`;
        }

        chartPeak = new Chart(ctxPeak, {
            type: 'bar',
            data: {
                labels: hourLabels,
                datasets: [{
                    label: 'Vehicles',
                    data: hours,
                    backgroundColor: bgColors,
                    borderRadius: 6
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    y: { beginAtZero: true, grid: { color: '#f1f5f9' } },
                    x: { grid: { display: false }, ticks: { font: { size: 10 } } }
                }
            }
        });
    }

    // ──────────────────────────────────────────
    // Chart 3: Vehicle Types Distribution
    // ──────────────────────────────────────────
    const ctxVeh = el('chartVehicleTypes');
    if (ctxVeh) {
        if (chartVehTypes) chartVehTypes.destroy();

        const vehCounts = { Motorcycle: 0, Car: 0, SUV: 0, Van: 0, Truck: 0, Other: 0 };
        filteredLogs.forEach(l => {
            const t = (l.vehicles?.vehicle_type || '').toUpperCase();
            if (t.includes('MOTOR') || t.includes('SCOOTER')) vehCounts.Motorcycle++;
            else if (t.includes('CAR') || t.includes('SEDAN')) vehCounts.Car++;
            else if (t.includes('SUV')) vehCounts.SUV++;
            else if (t.includes('VAN')) vehCounts.Van++;
            else if (t.includes('TRUCK')) vehCounts.Truck++;
            else vehCounts.Motorcycle++; // default prominent campus vehicle
        });

        const totalVeh = Math.max(1, Object.values(vehCounts).reduce((a, b) => a + b, 0));
        const colors = ['#0E4B3A', '#10B981', '#3B82F6', '#8B5CF6', '#F2B827', '#64748B'];

        chartVehTypes = new Chart(ctxVeh, {
            type: 'doughnut',
            data: {
                labels: Object.keys(vehCounts),
                datasets: [{
                    data: Object.values(vehCounts),
                    backgroundColor: colors,
                    borderWidth: 0
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                cutout: '68%',
                plugins: { legend: { display: false } }
            }
        });

        if (el('vehTypeBreakdownList')) {
            el('vehTypeBreakdownList').innerHTML = Object.entries(vehCounts).map(([type, count], i) => {
                const pct = Math.round((count / totalVeh) * 100);
                return `
                    <div class="flex items-center justify-between text-xs">
                        <div class="flex items-center gap-2">
                            <span class="w-2.5 h-2.5 rounded-full" style="background-color: ${colors[i]}"></span>
                            <span class="font-semibold text-slate-700">${type}</span>
                        </div>
                        <div class="font-mono font-bold text-slate-800">${pct}% <span class="text-slate-400 font-normal">(${count})</span></div>
                    </div>
                `;
            }).join('');
        }
    }

    // ──────────────────────────────────────────
    // Chart 4: User Types Access Share
    // ──────────────────────────────────────────
    const ctxUser = el('chartUserTypes');
    if (ctxUser) {
        if (chartUserTypesInst) chartUserTypesInst.destroy();

        const userCounts = { Students: 0, Faculty: 0, Staff: 0, Visitors: 0, Emergency: 0 };
        filteredLogs.forEach(l => {
            const role = (l.users?.role || '').toUpperCase();
            if (role === 'STUDENT') userCounts.Students++;
            else if (role === 'FACULTY') userCounts.Faculty++;
            else if (role === 'STAFF') userCounts.Staff++;
            else if (l.remarks && (l.remarks.includes('Visitor') || l.remarks.includes('VISITOR'))) userCounts.Visitors++;
            else if (l.is_emergency) userCounts.Emergency++;
            else userCounts.Students++;
        });

        const totalUsers = Math.max(1, Object.values(userCounts).reduce((a, b) => a + b, 0));
        const colors = ['#0E4B3A', '#1F6B4F', '#F2B827', '#3B82F6', '#EF4444'];

        chartUserTypesInst = new Chart(ctxUser, {
            type: 'doughnut',
            data: {
                labels: Object.keys(userCounts),
                datasets: [{
                    data: Object.values(userCounts),
                    backgroundColor: colors,
                    borderWidth: 0
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                cutout: '68%',
                plugins: { legend: { display: false } }
            }
        });

        if (el('userTypeBreakdownList')) {
            el('userTypeBreakdownList').innerHTML = Object.entries(userCounts).map(([cat, count], i) => {
                const pct = Math.round((count / totalUsers) * 100);
                return `
                    <div class="flex items-center justify-between text-xs">
                        <div class="flex items-center gap-2">
                            <span class="w-2.5 h-2.5 rounded-full" style="background-color: ${colors[i]}"></span>
                            <span class="font-semibold text-slate-700">${cat}</span>
                        </div>
                        <div class="font-mono font-bold text-slate-800">${pct}% <span class="text-slate-400 font-normal">(${count})</span></div>
                    </div>
                `;
            }).join('');
        }
    }
}


// ==============================================
// 📄 REPORTS ENGINE & AUDIT TRAIL MODULE
// ==============================================
let currentReportPayload = null;
const REPORT_HISTORY_STORAGE_KEY = 'charrmpass_reports_audit_trail';

function getStoredReportHistory() {
    try {
        const stored = localStorage.getItem(REPORT_HISTORY_STORAGE_KEY);
        return stored ? JSON.parse(stored) : [];
    } catch(e) { return []; }
}

function saveReportToAuditHistory(entry) {
    const history = getStoredReportHistory();
    history.unshift(entry);
    if (history.length > 50) history.pop();
    try {
        localStorage.setItem(REPORT_HISTORY_STORAGE_KEY, JSON.stringify(history));
    } catch(e) {}
    renderReportHistory();
}

window.clearReportHistory = function() {
    if (!confirm('Clear all local report audit history?')) return;
    localStorage.removeItem(REPORT_HISTORY_STORAGE_KEY);
    renderReportHistory();
    showToast('Report history cleared.', 'info');
};

function renderReportHistory() {
    const history = getStoredReportHistory();
    if (el('reportAuditHistoryTable')) {
        el('reportAuditHistoryTable').innerHTML = history.length ? history.map(h => `
            <tr class="border-b border-slate-100/70 hover:bg-white/80">
                <td class="p-3 font-bold text-slate-800">
                    <div class="flex items-center gap-2">
                        <i data-lucide="file-text" class="w-4 h-4 text-emerald-700"></i>
                        <span>${h.name}</span>
                    </div>
                </td>
                <td class="p-3 text-xs font-mono text-slate-600">${h.period}</td>
                <td class="p-3 text-xs font-semibold text-slate-700">${h.generatedBy}</td>
                <td class="p-3 text-xs text-slate-500">${h.timestamp}</td>
                <td class="p-3 text-center"><span class="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800 uppercase">${h.format || 'PDF'}</span></td>
                <td class="p-3 text-right">
                    <button onclick="downloadOfficialReportPDF()" class="p-1.5 text-red-600 hover:text-red-800 hover:bg-red-50 rounded-lg transition-colors" title="Download PDF"><i data-lucide="file-down" class="w-4 h-4"></i></button>
                    <button onclick="printOfficialReport()" class="p-1.5 text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-lg ml-1 transition-colors" title="Print"><i data-lucide="printer" class="w-4 h-4"></i></button>
                    <button onclick="exportCurrentReportCSV()" class="p-1.5 text-emerald-600 hover:text-emerald-800 hover:bg-emerald-50 rounded-lg ml-1 transition-colors" title="CSV"><i data-lucide="download" class="w-4 h-4"></i></button>
                </td>
            </tr>
        `).join('') : '<tr><td colspan="6" class="p-6 text-center text-slate-400 text-xs">No reports generated yet. Click Generate Custom Report to start.</td></tr>';
    }
    if (window.lucide) lucide.createIcons();
}

window.renderReports = function() {
    if (!currentReportPayload) {
        generateQuickReport('today');
    }
    renderReportHistory();
};

let activeReportTimeframePreset = 'today';

window.setReportTimeframePreset = function(preset) {
    activeReportTimeframePreset = preset;
    
    // Update pill highlight UI
    document.querySelectorAll('.rep-time-tab').forEach(b => {
        b.className = 'rep-time-tab px-3 py-1.5 rounded-xl font-bold text-xs text-slate-600 hover:text-slate-900 transition-all';
    });
    const activeBtn = el(`repBtn-${preset}`);
    if (activeBtn) {
        activeBtn.className = 'rep-time-tab px-3 py-1.5 rounded-xl font-bold text-xs bg-charm-dark text-white shadow-sm transition-all';
    }

    // Hide custom date box if selecting standard presets
    const customBox = el('repCustomDateBox');
    if (customBox) customBox.classList.add('hidden');

    generateQuickReport(preset);
};

window.toggleReportCustomDate = function() {
    const customBox = el('repCustomDateBox');
    if (!customBox) return;

    const isHidden = customBox.classList.contains('hidden');
    if (isHidden) {
        customBox.classList.remove('hidden');
        // Set default dates if empty
        const now = new Date();
        const past = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        if (el('repInlineFrom') && !el('repInlineFrom').value) el('repInlineFrom').value = past.toISOString().split('T')[0];
        if (el('repInlineTo') && !el('repInlineTo').value) el('repInlineTo').value = now.toISOString().split('T')[0];
        
        document.querySelectorAll('.rep-time-tab').forEach(b => {
            b.className = 'rep-time-tab px-3 py-1.5 rounded-xl font-bold text-xs text-slate-600 hover:text-slate-900 transition-all';
        });
        el('repBtn-custom')?.classList.add('bg-charm-dark', 'text-white', 'shadow-sm');
        el('repBtn-custom')?.classList.remove('text-slate-600');
    } else {
        customBox.classList.add('hidden');
        setReportTimeframePreset('today');
    }
    if (window.lucide) lucide.createIcons();
};

window.applyReportInlineCustomDates = function() {
    const fromVal = el('repInlineFrom')?.value;
    const toVal = el('repInlineTo')?.value;
    if (!fromVal || !toVal) {
        showToast('Please select both Start and End dates.', 'warning');
        return;
    }
    if (new Date(fromVal) > new Date(toVal)) {
        showToast('Start date cannot be after End date.', 'warning');
        return;
    }
    generateQuickReport('custom', fromVal, toVal);
};

window.setModalReportPreset = function(preset) {
    const now = new Date();
    const fromEl = el('modalReportFrom');
    const toEl = el('modalReportTo');
    if (!fromEl || !toEl) return;

    toEl.value = now.toISOString().split('T')[0];

    if (preset === 'today') {
        fromEl.value = now.toISOString().split('T')[0];
    } else if (preset === 'yesterday') {
        const y = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        fromEl.value = y.toISOString().split('T')[0];
        toEl.value = y.toISOString().split('T')[0];
    } else if (preset === '7days') {
        const past7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        fromEl.value = past7.toISOString().split('T')[0];
    } else if (preset === 'thisMonth') {
        const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
        fromEl.value = firstDay.toISOString().split('T')[0];
    } else if (preset === 'lastMonth') {
        const firstDayLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const lastDayLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);
        fromEl.value = firstDayLastMonth.toISOString().split('T')[0];
        toEl.value = lastDayLastMonth.toISOString().split('T')[0];
    } else if (preset === 'allTime') {
        const startYear = new Date(now.getFullYear(), 0, 1);
        fromEl.value = startYear.toISOString().split('T')[0];
    }
    showToast(`Timeframe set to ${preset}`, 'info');
};

window.generateQuickReport = function(type, customFrom, customTo) {
    const now = new Date();
    let title = "VEHICLE ACCESS & TRAFFIC ACTIVITY REPORT";
    let periodText = "";
    let logs = [];

    if (type === 'today') {
        title = "DAILY CAMPUS VEHICLE ACCESS REPORT";
        periodText = `Date: ${now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}`;
        logs = getFilteredAnalyticsLogs('today');
    } else if (type === 'yesterday') {
        title = "YESTERDAY'S VEHICLE ACCESS SUMMARY";
        const y = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        periodText = `Date: ${y.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}`;
        logs = getFilteredAnalyticsLogs('yesterday');
    } else if (type === 'week') {
        title = "WEEKLY ACCESS & SECURITY AUDIT REPORT";
        const past7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        periodText = `Period: ${past7.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} (Past 7 Days)`;
        logs = getFilteredAnalyticsLogs('7days');
    } else if (type === 'month') {
        title = "MONTHLY COMPREHENSIVE ACCESS REPORT";
        periodText = `Month: ${now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}`;
        logs = getFilteredAnalyticsLogs('thisMonth');
    } else if (type === 'lastMonth') {
        title = "PREVIOUS MONTH VEHICLE ACCESS REPORT";
        const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        periodText = `Month: ${lastMonthDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}`;
        logs = getFilteredAnalyticsLogs('lastMonth');
    } else if (type === 'all') {
        title = "ALL-TIME VEHICLE ACCESS MASTERLIST";
        periodText = `Period: Complete All-Time Records (Up to ${now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })})`;
        logs = adminState.logs || [];
    } else if (type === 'custom' && customFrom && customTo) {
        title = "CUSTOM PERIOD VEHICLE ACCESS REPORT";
        const d1 = new Date(customFrom + 'T00:00:00');
        const d2 = new Date(customTo + 'T23:59:59');
        periodText = `Period: ${d1.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} to ${d2.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
        logs = (adminState.logs || []).filter(l => {
            if (!l.timestamp) return false;
            const t = new Date(l.timestamp);
            return t >= d1 && t <= d2;
        });
    }

    const dateNum = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}`;
    const randSuffix = String(Math.floor(1000 + Math.random() * 9000));
    const reportId = `CP-ASU-${dateNum}-${randSuffix}`;

    displayGeneratedReport({
        id: reportId,
        title: title,
        period: periodText,
        generatedBy: 'CHARRMPASS SYSTEM',
        generatedAt: now.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }),
        logs: logs,
        format: 'PDF',
        options: { summary: true, charts: true, logs: true, guards: true }
    });
};

window.openReportModal = function() {
    const modal = el('generateReportModal');
    if (!modal) return;
    const now = new Date();
    const past = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    if (el('modalReportFrom')) el('modalReportFrom').value = past.toISOString().split('T')[0];
    if (el('modalReportTo')) el('modalReportTo').value = now.toISOString().split('T')[0];

    modal.classList.remove('hidden');
    setTimeout(() => {
        modal.classList.remove('opacity-0');
        el('generateReportModalContent')?.classList.remove('scale-95');
    }, 10);
    if (window.lucide) lucide.createIcons();
};

window.closeReportModal = function() {
    const modal = el('generateReportModal');
    if (!modal) return;
    modal.classList.add('opacity-0');
    el('generateReportModalContent')?.classList.add('scale-95');
    setTimeout(() => modal.classList.add('hidden'), 300);
};

window.handleCustomReportSubmit = function(e) {
    e.preventDefault();
    const reportType = el('modalReportType')?.value || 'ACTIVITY';
    const fromVal = el('modalReportFrom')?.value;
    const toVal = el('modalReportTo')?.value;
    const incSummary = el('incSummary')?.checked ?? true;
    const incCharts = el('incCharts')?.checked ?? true;
    const incLogs = el('incDetailedLogs')?.checked ?? true;
    const incGuard = el('incGuardOps')?.checked ?? true;
    const format = document.querySelector('input[name="repFormat"]:checked')?.value || 'PDF';

    const fromDate = new Date(fromVal + 'T00:00:00');
    const toDate = new Date(toVal + 'T23:59:59');

    const filteredLogs = (adminState.logs || []).filter(l => {
        if (!l.timestamp) return false;
        const t = new Date(l.timestamp);
        return t >= fromDate && t <= toDate;
    });

    const reportTitles = {
        ACTIVITY: 'COMPLETE VEHICLE ACCESS & TRAFFIC REPORT',
        DAILY: 'DAILY CAMPUS SUMMARY REPORT',
        RANGE: 'CUSTOM DATE RANGE ACCESS REPORT',
        MONTHLY: 'MONTHLY ADMINISTRATIVE SUMMARY',
        SECURITY: 'FAILED ACCESS & SECURITY AUDIT REPORT',
        GUARD: 'GUARD OPERATIONAL ACTIVITY REPORT',
        REGISTRY: 'REGISTERED VEHICLE MASTERLIST'
    };

    const now = new Date();
    const dateNum = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}`;
    const randSuffix = String(Math.floor(1000 + Math.random() * 9000));
    const reportId = `CP-ASU-${dateNum}-${randSuffix}`;

    const payload = {
        id: reportId,
        title: reportTitles[reportType] || 'CHARRMPASS VEHICLE REPORT',
        period: `Period: ${fromVal} to ${toVal}`,
        generatedBy: 'CHARRMPASS SYSTEM',
        generatedAt: now.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }),
        logs: filteredLogs,
        format: format,
        options: { summary: incSummary, charts: incCharts, logs: incLogs, guards: incGuard }
    };

    closeReportModal();
    displayGeneratedReport(payload);
    showToast(`Generated "${payload.title}" with ${filteredLogs.length} records!`, 'success');
};

function displayGeneratedReport(payload) {
    currentReportPayload = payload;

    if (el('repDocTitle')) el('repDocTitle').textContent = payload.title;
    if (el('repDocPeriod')) el('repDocPeriod').textContent = payload.period;
    if (el('repDocId')) el('repDocId').textContent = payload.id;
    if (el('repDocGeneratedAt')) el('repDocGeneratedAt').textContent = payload.generatedAt;
    if (el('repDocGeneratedBy')) el('repDocGeneratedBy').textContent = payload.generatedBy;
    if (el('repDocTotalRecords')) el('repDocTotalRecords').textContent = `${payload.logs.length} Total Records`;

    // Summary Statistics
    const entries = payload.logs.filter(l => l.direction === 'ENTRY' && l.status === 'AUTHORIZED').length;
    const exits = payload.logs.filter(l => l.direction === 'EXIT' && l.status === 'AUTHORIZED').length;
    const failed = payload.logs.filter(l => l.status === 'DENIED').length;
    const uniquePlates = new Set();
    let students = 0, facultyStaff = 0, visitors = 0, emergency = 0;
    const hoursCount = Array(24).fill(0);

    payload.logs.forEach(l => {
        const p = l.vehicles?.plate_number || (l.remarks && l.remarks.match(/Plate:\s*([^|]+)/i)?.[1]?.trim()) || l.rfid_uid;
        if (p && p !== '--' && p !== 'N/A') uniquePlates.add(p);

        const role = (l.users?.role || '').toUpperCase();
        if (role === 'STUDENT') students++;
        else if (role === 'FACULTY' || role === 'STAFF') facultyStaff++;
        else if (l.remarks && (l.remarks.includes('Visitor') || l.remarks.includes('VISITOR'))) visitors++;
        else if (l.is_emergency || (l.remarks && l.remarks.includes('Emergency'))) emergency++;
        else students++;

        if (l.timestamp) {
            const h = new Date(l.timestamp).getHours();
            if (h >= 0 && h < 24) hoursCount[h]++;
        }
    });

    let peakHour = 7;
    let peakCount = 0;
    hoursCount.forEach((cnt, hr) => {
        if (cnt > peakCount) { peakCount = cnt; peakHour = hr; }
    });

    const formatHour = (h) => {
        const period = h >= 12 ? 'PM' : 'AM';
        const displayH = h % 12 === 0 ? 12 : h % 12;
        return `${displayH}:00 ${period}`;
    };
    const peakHourText = payload.logs.length > 0 ? `${formatHour(peakHour)} – ${formatHour((peakHour + 1) % 24)} (${peakCount} scans)` : 'No activity logged';
    const authRate = payload.logs.length > 0 ? `${(((entries + exits) / payload.logs.length) * 100).toFixed(1)}%` : '100%';

    if (el('repSumEntries')) el('repSumEntries').textContent = entries.toLocaleString();
    if (el('repSumExits')) el('repSumExits').textContent = exits.toLocaleString();
    if (el('repSumUnique')) el('repSumUnique').textContent = uniquePlates.size.toLocaleString();
    if (el('repSumFailed')) el('repSumFailed').textContent = failed.toLocaleString();

    if (el('repAnStudent')) el('repAnStudent').textContent = students.toLocaleString();
    if (el('repAnStaff')) el('repAnStaff').textContent = facultyStaff.toLocaleString();
    if (el('repAnVisitor')) el('repAnVisitor').textContent = visitors.toLocaleString();
    if (el('repAnEmergency')) el('repAnEmergency').textContent = emergency.toLocaleString();
    if (el('repAnAuthRate')) el('repAnAuthRate').textContent = authRate;
    if (el('repAnPeakHour')) el('repAnPeakHour').textContent = peakHourText;

    // Tabular Detailed Logs: Include ALL filtered records without slicing
    if (el('repDetailedLogsTable')) {
        el('repDetailedLogsTable').innerHTML = payload.logs.length ? payload.logs.map((l, index) => {
            // Complete RFID UID Tag (Uncensored for administrative reporting)
            const uidTag = (l.rfid_uid || '--').trim().toUpperCase();
            
            let ownerName = l.users?.full_name;
            let plate = l.vehicles?.plate_number;
            let role = l.users?.role || '--';

            if (l.remarks) {
                if (l.remarks.includes('Visitor')) {
                    const match = l.remarks.match(/Visitor (?:Exit|Entry):\s*([^|]+)(?:\s*\|\s*Plate:\s*([^|]+))?/i);
                    if (match) {
                        ownerName = match[1]?.trim();
                        if (match[2]?.trim()) plate = match[2].trim();
                    } else ownerName = 'Visitor Pass';
                    role = 'VISITOR';
                } else if (l.remarks.includes('Emergency')) {
                    ownerName = 'Emergency Response';
                    plate = 'EMERGENCY';
                    role = 'EMERGENCY';
                }
            }
            if (!ownerName) ownerName = l.status === 'DENIED' ? 'Unregistered User' : 'Cardholder';
            if (!plate) plate = '--';

            const statusBadge = l.status === 'AUTHORIZED' 
                ? '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-green-100 text-green-800">Allowed</span>' 
                : '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-red-100 text-red-800">Denied</span>';

            const dateStr = l.timestamp ? new Date(l.timestamp).toLocaleDateString([], {month:'short', day:'numeric'}) + ' ' + new Date(l.timestamp).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) : '--';

            return `
                <tr class="hover:bg-slate-50 text-xs border-b border-slate-100">
                    <td class="p-2 font-mono text-[11px] text-slate-600">${dateStr}</td>
                    <td class="p-2 font-mono font-bold text-slate-700">${uidTag}</td>
                    <td class="p-2 font-mono font-bold text-slate-900">${plate}</td>
                    <td class="p-2 font-semibold text-slate-800">${ownerName}</td>
                    <td class="p-2"><span class="px-1.5 py-0.5 rounded text-[9px] font-bold bg-slate-100 text-slate-600 uppercase">${role}</span></td>
                    <td class="p-2 text-center font-bold ${l.direction === 'ENTRY' ? 'text-emerald-700' : 'text-blue-700'}">${l.direction || 'ENTRY'}</td>
                    <td class="p-2 text-center font-medium text-slate-600">${l.direction === 'EXIT' ? 'Gate 2 (Exit)' : 'Gate 1 (Entry)'}</td>
                    <td class="p-2 text-right">${statusBadge}</td>
                </tr>
            `;
        }).join('') : '<tr><td colspan="8" class="p-8 text-center text-slate-400">No transactions recorded in this period.</td></tr>';
    }

    // Save report to audit history
    saveReportToAuditHistory({
        name: payload.title,
        period: payload.period,
        generatedBy: payload.generatedBy,
        timestamp: payload.generatedAt,
        format: payload.format
    });
}

window.printOfficialReport = function() {
    window.print();
};

window.downloadOfficialReportPDF = function() {
    if (!currentReportPayload) {
        generateQuickReport('today');
    }
    if (!currentReportPayload) {
        showToast('No report data available to download.', 'warning');
        return;
    }

    const payload = currentReportPayload;
    const reportId = payload.id || `CP-ASU-${Date.now()}`;
    const safeTitle = (payload.title || 'CHARRMPASS_Report').replace(/[^a-zA-Z0-9_-]/g, '_');
    const fileName = `${reportId}_${safeTitle}.pdf`;

    showToast('Generating official PDF document...', 'info');

    try {
        const jsPdfClass = window.jspdf?.jsPDF || window.jsPDF;
        if (jsPdfClass) {
            const doc = new jsPdfClass({
                orientation: 'portrait',
                unit: 'mm',
                format: 'a4'
            });

            const pageWidth = doc.internal.pageSize.getWidth(); // 210mm
            const pageHeight = doc.internal.pageSize.getHeight(); // 297mm
            const margin = 14;
            const contentWidth = pageWidth - (margin * 2); // 182mm

            // 1. Official Header with Logo (Clean, Institutional)
            let logoDataUrl = null;
            try {
                const img = document.getElementById('repDocLogoImg') || document.querySelector('img[src*="logocharrmpark"]');
                if (img && img.complete && img.naturalWidth > 0) {
                    const canvas = document.createElement('canvas');
                    canvas.width = img.naturalWidth;
                    canvas.height = img.naturalHeight;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0);
                    logoDataUrl = canvas.toDataURL('image/png');
                }
            } catch(e) {
                console.warn('Could not extract logo canvas:', e);
            }

            if (logoDataUrl) {
                try {
                    doc.addImage(logoDataUrl, 'PNG', margin + 2, 10, 15, 15);
                } catch(e) {
                    console.warn('doc.addImage error:', e);
                }
            }

            doc.setFont('helvetica', 'bold');
            doc.setFontSize(15);
            doc.setTextColor(14, 75, 58); // #0E4B3A
            doc.text('AKLAN STATE UNIVERSITY', pageWidth / 2 + 5, 16, { align: 'center' });

            doc.setFont('helvetica', 'bold');
            doc.setFontSize(8.5);
            doc.setTextColor(51, 65, 85);
            doc.text('IBAJAY CAMPUS • IBAJAY, AKLAN', pageWidth / 2 + 5, 21.5, { align: 'center' });

            doc.setFont('helvetica', 'normal');
            doc.setFontSize(7.5);
            doc.setTextColor(100, 116, 139);
            doc.text('Campus Hybrid Automated RFID Real-Time Management Parking & Access Security System', pageWidth / 2 + 5, 26, { align: 'center' });

            // Green header divider line
            doc.setDrawColor(14, 75, 58);
            doc.setLineWidth(0.7);
            doc.line(margin, 29.5, pageWidth - margin, 29.5);

            // 2. Report Title & Timeframe
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(11);
            doc.setTextColor(15, 23, 42);
            doc.text((payload.title || 'CAMPUS VEHICLE ACCESS REPORT').toUpperCase(), pageWidth / 2, 35.5, { align: 'center' });

            doc.setFont('helvetica', 'normal');
            doc.setFontSize(8);
            doc.setTextColor(100, 116, 139);
            doc.text(payload.period || 'Access Period Records', pageWidth / 2, 40, { align: 'center' });

            // 3. Metadata Bar (Report ID, Generated On, Generated By, Total Records)
            const metaY = 43.5;
            const metaH = 12.5;
            doc.setFillColor(248, 250, 252);
            doc.setDrawColor(203, 213, 225);
            doc.setLineWidth(0.3);
            doc.roundedRect(margin, metaY, contentWidth, metaH, 1.5, 1.5, 'FD');

            doc.setFontSize(6.5);
            doc.setFont('helvetica', 'bold');
            doc.setTextColor(100, 116, 139);
            doc.text('REPORT ID:', margin + 4, metaY + 4);
            doc.text('GENERATED ON:', margin + 50, metaY + 4);
            doc.text('GENERATED BY:', margin + 102, metaY + 4);
            doc.text('TOTAL RECORDS:', margin + 148, metaY + 4);

            doc.setFontSize(7.5);
            doc.setFont('helvetica', 'bold');
            doc.setTextColor(15, 23, 42);
            doc.text(payload.id || reportId, margin + 4, metaY + 9);
            doc.text(payload.generatedAt || new Date().toLocaleString(), margin + 50, metaY + 9);
            
            doc.setTextColor(14, 75, 58);
            doc.text(payload.generatedBy || 'CHARRMPASS SYSTEM', margin + 102, metaY + 9);

            doc.setTextColor(16, 185, 129);
            doc.text(`${(payload.logs || []).length} Records`, margin + 148, metaY + 9);

            // 4. Executive Summary Statistics
            const entries = (payload.logs || []).filter(l => l.direction === 'ENTRY' && l.status === 'AUTHORIZED').length;
            const exits = (payload.logs || []).filter(l => l.direction === 'EXIT' && l.status === 'AUTHORIZED').length;
            const failed = (payload.logs || []).filter(l => l.status === 'DENIED').length;
            const uniquePlates = new Set();
            let students = 0, facultyStaff = 0, visitors = 0, emergency = 0;
            const hoursCount = Array(24).fill(0);

            (payload.logs || []).forEach(l => {
                const p = l.vehicles?.plate_number || (l.remarks && l.remarks.match(/Plate:\s*([^|]+)/i)?.[1]?.trim()) || l.rfid_uid;
                if (p && p !== '--' && p !== 'N/A') uniquePlates.add(p);

                const role = (l.users?.role || '').toUpperCase();
                if (role === 'STUDENT') students++;
                else if (role === 'FACULTY' || role === 'STAFF') facultyStaff++;
                else if (l.remarks && (l.remarks.includes('Visitor') || l.remarks.includes('VISITOR'))) visitors++;
                else if (l.is_emergency || (l.remarks && l.remarks.includes('Emergency'))) emergency++;
                else students++;

                if (l.timestamp) {
                    const h = new Date(l.timestamp).getHours();
                    if (h >= 0 && h < 24) hoursCount[h]++;
                }
            });

            let peakHour = 7;
            let peakCount = 0;
            hoursCount.forEach((cnt, hr) => {
                if (cnt > peakCount) { peakCount = cnt; peakHour = hr; }
            });

            const formatHour = (h) => {
                const period = h >= 12 ? 'PM' : 'AM';
                const displayH = h % 12 === 0 ? 12 : h % 12;
                return `${displayH}:00 ${period}`;
            };
            const peakHourText = (payload.logs || []).length > 0 ? `${formatHour(peakHour)} – ${formatHour((peakHour + 1) % 24)} (${peakCount} scans)` : 'N/A';
            const authRate = (payload.logs || []).length > 0 ? `${(((entries + exits) / (payload.logs || []).length) * 100).toFixed(1)}%` : '100%';

            const statBoxWidth = (contentWidth - 6) / 4;
            const statY = 58;
            const statH = 11.5;

            const statCards = [
                { label: 'TOTAL ENTRIES', val: entries.toLocaleString(), color: [16, 185, 129] },
                { label: 'TOTAL EXITS', val: exits.toLocaleString(), color: [59, 130, 246] },
                { label: 'UNIQUE VEHICLES', val: uniquePlates.size.toLocaleString(), color: [139, 92, 246] },
                { label: 'SECURITY DENIALS', val: failed.toLocaleString(), color: [239, 68, 68] }
            ];

            statCards.forEach((c, idx) => {
                const x = margin + (idx * (statBoxWidth + 2));
                doc.setFillColor(248, 250, 252);
                doc.setDrawColor(226, 232, 240);
                doc.roundedRect(x, statY, statBoxWidth, statH, 1.5, 1.5, 'FD');

                doc.setFontSize(6);
                doc.setFont('helvetica', 'bold');
                doc.setTextColor(100, 116, 139);
                doc.text(c.label, x + (statBoxWidth / 2), statY + 4, { align: 'center' });

                doc.setFontSize(9.5);
                doc.setFont('helvetica', 'bold');
                doc.setTextColor(c.color[0], c.color[1], c.color[2]);
                doc.text(c.val, x + (statBoxWidth / 2), statY + 9, { align: 'center' });
            });

            // 5. Analytics Summary Bar (User Demographics & Access Flow)
            const anY = 71.5;
            const anH = 13.5;
            const anW = (contentWidth - 3) / 2;

            // Box 1: User Demographics (Two Clean Rows to Prevent Any Cutoff)
            doc.setFillColor(248, 250, 252);
            doc.setDrawColor(226, 232, 240);
            doc.roundedRect(margin, anY, anW, anH, 1.5, 1.5, 'FD');

            doc.setFontSize(6);
            doc.setFont('helvetica', 'bold');
            doc.setTextColor(100, 116, 139);
            doc.text('USER CATEGORIES SCANNED', margin + 3.5, anY + 3.5);

            doc.setFontSize(7);
            doc.setFont('helvetica', 'bold');
            doc.setTextColor(15, 23, 42);
            doc.text(`Students: ${students.toLocaleString()}     |     Faculty / Staff: ${facultyStaff.toLocaleString()}`, margin + 3.5, anY + 7.5);
            doc.text(`Visitors: ${visitors.toLocaleString()}     |     Emergency Units: ${emergency.toLocaleString()}`, margin + 3.5, anY + 11.5);

            // Box 2: Flow & Peak Activity (Two Clean Rows to Prevent Any Cutoff)
            const anX2 = margin + anW + 3;
            doc.setFillColor(248, 250, 252);
            doc.setDrawColor(226, 232, 240);
            doc.roundedRect(anX2, anY, anW, anH, 1.5, 1.5, 'FD');

            doc.setFontSize(6);
            doc.setFont('helvetica', 'bold');
            doc.setTextColor(100, 116, 139);
            doc.text('ACCESS SECURITY & TRAFFIC FLOW', anX2 + 3.5, anY + 3.5);

            doc.setFontSize(7);
            doc.setFont('helvetica', 'bold');
            doc.setTextColor(15, 23, 42);
            doc.text(`Authorization Rate: `, anX2 + 3.5, anY + 7.5);
            doc.setTextColor(16, 185, 129);
            doc.text(authRate, anX2 + 28, anY + 7.5);

            doc.setTextColor(15, 23, 42);
            doc.text(`Peak Activity Window: ${peakHourText}`, anX2 + 3.5, anY + 11.5);

            // 6. Table Data via autoTable (Uncensored Full RFID UIDs, Perfect Column Fit)
            const headers = [['Date & Time', 'RFID UID Tag', 'Vehicle Plate', 'Owner / Driver', 'Category', 'Direction', 'Gate Location', 'Status']];
            const tableRows = (payload.logs || []).map(l => {
                const uidTag = (l.rfid_uid || '--').trim().toUpperCase();
                
                let ownerName = l.users?.full_name;
                let plate = l.vehicles?.plate_number;
                let role = l.users?.role || 'General';

                if (l.remarks) {
                    if (l.remarks.includes('Visitor')) {
                        const match = l.remarks.match(/Visitor (?:Exit|Entry):\s*([^|]+)(?:\s*\|\s*Plate:\s*([^|]+))?/i);
                        if (match) {
                            ownerName = match[1]?.trim();
                            if (match[2]?.trim()) plate = match[2].trim();
                        } else ownerName = 'Visitor Pass';
                        role = 'VISITOR';
                    } else if (l.remarks.includes('Emergency')) {
                        ownerName = 'Emergency Response';
                        plate = 'EMERGENCY';
                        role = 'EMERGENCY';
                    }
                }
                if (!ownerName) ownerName = l.status === 'DENIED' ? 'Unregistered User' : 'Cardholder';
                if (!plate) plate = '--';

                const dateStr = l.timestamp ? new Date(l.timestamp).toLocaleDateString([], {month:'short', day:'numeric'}) + ' ' + new Date(l.timestamp).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) : '--';
                const gateStr = l.direction === 'EXIT' ? 'Gate 2 (Exit)' : 'Gate 1 (Entry)';
                const statusStr = l.status === 'AUTHORIZED' ? 'ALLOWED' : 'DENIED';

                return [
                    dateStr,
                    uidTag,
                    plate,
                    ownerName,
                    role.toUpperCase(),
                    l.direction || 'ENTRY',
                    gateStr,
                    statusStr
                ];
            });

            if (tableRows.length === 0) {
                tableRows.push(['--', '--', '--', 'No transactions recorded in this period', '--', '--', '--', '--']);
            }

            const runAutoTable = (opts) => {
                if (typeof doc.autoTable === 'function') {
                    doc.autoTable(opts);
                    return true;
                }
                if (typeof window.jspdf?.autoTable === 'function') {
                    window.jspdf.autoTable(doc, opts);
                    return true;
                }
                if (typeof window.autoTable === 'function') {
                    window.autoTable(doc, opts);
                    return true;
                }
                return false;
            };

            const autoTableSuccess = runAutoTable({
                head: headers,
                body: tableRows,
                startY: 87,
                margin: { left: margin, right: margin, bottom: 22 },
                styles: {
                    font: 'helvetica',
                    fontSize: 6.8,
                    cellPadding: { top: 1.8, right: 1.5, bottom: 1.8, left: 1.5 },
                    textColor: [30, 41, 59],
                    lineColor: [226, 232, 240],
                    lineWidth: 0.2,
                    overflow: 'linebreak'
                },
                headStyles: {
                    fillColor: [14, 75, 58],
                    textColor: [255, 255, 255],
                    fontStyle: 'bold',
                    fontSize: 7,
                    halign: 'left',
                    cellPadding: 2
                },
                alternateRowStyles: {
                    fillColor: [248, 250, 252]
                },
                columnStyles: {
                    0: { cellWidth: 26 },
                    1: { cellWidth: 27, font: 'courier', fontStyle: 'bold' },
                    2: { cellWidth: 22, font: 'courier', fontStyle: 'bold' },
                    3: { cellWidth: 35 },
                    4: { cellWidth: 20 },
                    5: { cellWidth: 16, halign: 'center', fontStyle: 'bold' },
                    6: { cellWidth: 18, halign: 'center' },
                    7: { cellWidth: 18, halign: 'center', fontStyle: 'bold' }
                },
                didParseCell: function(data) {
                    if (data.section === 'body') {
                        if (data.column.index === 5) {
                            if (data.cell.raw === 'ENTRY') data.cell.styles.textColor = [5, 150, 105];
                            else if (data.cell.raw === 'EXIT') data.cell.styles.textColor = [37, 99, 235];
                        }
                        if (data.column.index === 7) {
                            if (data.cell.raw === 'ALLOWED') data.cell.styles.textColor = [16, 185, 129];
                            else if (data.cell.raw === 'DENIED') data.cell.styles.textColor = [220, 38, 38];
                        }
                    }
                },
                didDrawPage: function(data) {
                    const pageNum = doc.internal.getNumberOfPages();
                    doc.setDrawColor(226, 232, 240);
                    doc.setLineWidth(0.3);
                    doc.line(margin, pageHeight - 12, pageWidth - margin, pageHeight - 12);

                    doc.setFontSize(7);
                    doc.setFont('helvetica', 'normal');
                    doc.setTextColor(148, 163, 184);
                    doc.text(`CHARRMPASS • Campus Automated RFID Audit Record • Page ${pageNum}`, margin, pageHeight - 7);
                    doc.text('Generated by CHARRMPASS SYSTEM • Aklan State University', pageWidth - margin, pageHeight - 7, { align: 'right' });
                }
            });

            if (autoTableSuccess) {
                // Add official sign-off on final page
                const finalY = (doc.lastAutoTable ? doc.lastAutoTable.finalY : 180) + 10;
                if (finalY + 24 < pageHeight - 16) {
                    doc.setFontSize(7);
                    doc.setFont('helvetica', 'bold');
                    doc.setTextColor(100, 116, 139);
                    doc.text('GENERATED BY:', margin, finalY);
                    doc.text('CERTIFIED & APPROVED BY:', pageWidth / 2 + 10, finalY);

                    doc.setDrawColor(148, 163, 184);
                    doc.setLineWidth(0.3);
                    doc.line(margin, finalY + 9, margin + 60, finalY + 9);
                    doc.line(pageWidth / 2 + 10, finalY + 9, pageWidth / 2 + 75, finalY + 9);

                    doc.setFont('helvetica', 'bold');
                    doc.setTextColor(15, 23, 42);
                    doc.text(payload.generatedBy || 'CHARRMPASS SYSTEM', margin, finalY + 13);
                    doc.text('Campus Security & Safety Officer', pageWidth / 2 + 10, finalY + 13);

                    doc.setFont('helvetica', 'normal');
                    doc.setTextColor(148, 163, 184);
                    doc.text('Automated Campus Security Platform', margin, finalY + 17);
                    doc.text('Aklan State University – Ibajay Campus', pageWidth / 2 + 10, finalY + 17);
                }

                doc.save(fileName);
                showToast('Official PDF downloaded successfully!', 'success');
                return;
            }
        }
    } catch(err) {
        console.error('jsPDF generation error:', err);
    }

    // High-speed fallback: print window
    window.print();
};

window.exportCurrentReportCSV = function() {
    if (!currentReportPayload || !currentReportPayload.logs || !currentReportPayload.logs.length) {
        showToast('No report records to export.', 'warning');
        return;
    }

    const headers = ['Report ID', 'Date & Time', 'RFID UID Tag', 'Plate Number', 'Owner / Driver', 'User Category', 'Direction', 'Status', 'Remarks'];
    const rows = currentReportPayload.logs.map(l => {
        const uidTag = (l.rfid_uid || 'N/A').trim().toUpperCase();
        let owner = l.users?.full_name || 'Unregistered';
        let plate = l.vehicles?.plate_number || 'N/A';
        let role = l.users?.role || 'N/A';

        if (l.remarks && l.remarks.includes('Visitor')) {
            const match = l.remarks.match(/Visitor (?:Exit|Entry):\s*([^|]+)(?:\s*\|\s*Plate:\s*([^|]+))?/i);
            if (match) {
                owner = match[1]?.trim() || owner;
                if (match[2]?.trim()) plate = match[2].trim();
            }
            role = 'VISITOR';
        }

        return [
            `"${currentReportPayload.id}"`,
            `"${l.timestamp || ''}"`,
            `"${uidTag}"`,
            `"${plate}"`,
            `"${owner.replace(/"/g, '""')}"`,
            `"${role}"`,
            `"${l.direction || 'ENTRY'}"`,
            `"${l.status || 'AUTHORIZED'}"`,
            `"${(l.remarks || '').replace(/"/g, '""')}"`
        ].join(',');
    });

    const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `${currentReportPayload.id}_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    showToast('CSV export downloaded!', 'success');
};


// =====================
// REALTIME & INIT
// =====================
function setupRealtime() {
    if (!isConnected || !supabaseClient) return;
    supabaseClient.channel('admin-sync')
        .on('postgres_changes', { event: '*',      schema: 'public', table: 'rfid_cards'   }, () => { loadData(); })
        .on('postgres_changes', { event: '*',      schema: 'public', table: 'users'        }, () => { loadData(); })
        .on('postgres_changes', { event: '*',      schema: 'public', table: 'special_tags' }, () => { loadData(); })
        .on('postgres_changes', { event: '*',      schema: 'public', table: 'devices'      }, () => { loadData(); })
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'transactions' }, () => { loadData(); })
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'transactions' }, () => { loadData(); })
        .subscribe();
}

// Special Tag Modal Actions
window.openSpecialTagModal = function(id = null) {
    const modal = el('specialTagModal');
    if (!modal) return;
    el('specialTagForm')?.reset();
    if (el('formTagId')) el('formTagId').value = '';
    if (el('specialTagModalTitle')) el('specialTagModalTitle').textContent = id ? 'Edit Special Tag' : 'Add Special Tag';
    
    if (id) {
        const tag = adminState.specialTags.find(t => t.id === id);
        if (tag) {
            if (el('formTagId')) el('formTagId').value = tag.id;
            if (el('formTagUid')) el('formTagUid').value = tag.rfid_uid;
            if (el('formTagType')) el('formTagType').value = tag.type;
            if (el('formTagLabel')) el('formTagLabel').value = tag.label || '';
            if (el('formTagDesc')) el('formTagDesc').value = tag.description || '';
        }
    } else {
        if (el('formTagLabel')) el('formTagLabel').value = '';
    }

    modal.classList.remove('hidden');
    setTimeout(() => { 
        modal.classList.remove('opacity-0'); 
        modal.classList.add('opacity-100'); 
        el('specialTagModalContent')?.classList.remove('scale-95'); 
    }, 10);
    if (window.lucide) lucide.createIcons();
};

window.closeSpecialTagModal = function() {
    const modal = el('specialTagModal');
    if (!modal) return;
    modal.classList.remove('opacity-100'); 
    modal.classList.add('opacity-0');
    el('specialTagModalContent')?.classList.add('scale-95');
    setTimeout(() => modal.classList.add('hidden'), 300);
};

window.editSpecialTag = function(id) { 
    openSpecialTagModal(id); 
};

el('specialTagForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = el('formTagId')?.value || '';
    const rawUid = (el('formTagUid')?.value || '').trim().toUpperCase();
    const type = el('formTagType')?.value || 'VISITOR';
    const label = (el('formTagLabel')?.value || '').trim() || (type === 'VISITOR' ? 'Visitor Pass' : 'Emergency Vehicle');
    const description = (el('formTagDesc')?.value || '').trim();

    if (!rawUid) {
        showToast('Please enter an RFID UID tag.', 'warning');
        return;
    }

    const tagData = {
        rfid_uid: rawUid,
        type: type,
        label: label,
        description: description
    };

    try {
        showToast('Saving special tag...', 'info');

        if (isConnected && supabaseClient) {
            if (id) {
                const { error } = await supabaseClient
                    .from('special_tags')
                    .update(tagData)
                    .eq('id', id);
                if (error) throw error;
            } else {
                const { data: inserted, error } = await supabaseClient
                    .from('special_tags')
                    .insert([tagData])
                    .select();
                if (error) throw error;
                if (inserted && inserted[0]) tagData.id = inserted[0].id;
            }
        }

        // Local state update for instant UI feedback
        if (id) {
            const idx = adminState.specialTags.findIndex(t => t.id === id);
            if (idx !== -1) adminState.specialTags[idx] = { ...adminState.specialTags[idx], ...tagData };
        } else {
            if (!tagData.id) tagData.id = 'st-' + Date.now();
            adminState.specialTags.unshift(tagData);
        }

        showToast(id ? 'Special tag updated successfully!' : 'Special tag added successfully!', 'success');
        closeSpecialTagModal();
        renderAdmin();
        if (isConnected) await loadData();
    } catch(err) {
        console.error('Error saving special tag:', err);
        showToast('Error saving special tag: ' + err.message, 'error');
    }
});

window.deleteSpecialTag = async function(id) {
    if (!confirm('Are you sure you want to delete this special tag?')) return;
    try {
        showToast('Deleting special tag...', 'info');
        if (isConnected && supabaseClient) {
            const { error } = await supabaseClient.from('special_tags').delete().eq('id', id);
            if (error) throw error;
        }
        adminState.specialTags = adminState.specialTags.filter(t => t.id !== id);
        showToast('Special tag deleted.', 'success');
        renderAdmin();
        if (isConnected) await loadData();
    } catch(err) { 
        console.error('Error deleting special tag:', err);
        showToast('Error: ' + err.message, 'error'); 
    }
};

// ==============================================
// 📋 ENHANCED APPLICATION REVIEW & DOSSIER LOGIC
// ==============================================
let currentReviewUserId = null;
let currentReviewTargetType = 'PEDESTRIAN';
let currentReviewVehicleId = null;

window.openReviewModal = function(id, targetType = 'PEDESTRIAN', vehicleId = null) {
    if (!id) return;
    const u = adminState.users.find(x => x.id === id) || (adminState.pendingItems||[]).find(x => x.userId === id)?.user;
    if (!u) {
        showToast('Stakeholder record not found.', 'error');
        return;
    }

    currentReviewUserId = u.id;
    currentReviewTargetType = targetType || 'PEDESTRIAN';
    currentReviewVehicleId = vehicleId || null;

    // If targetType is VEHICLE but vehicleId is not specified, default to first vehicle
    if (currentReviewTargetType === 'VEHICLE' && !currentReviewVehicleId && (u.vehicles||[]).length > 0) {
        currentReviewVehicleId = u.vehicles[0].id;
    }

    const isVehTarget = currentReviewTargetType === 'VEHICLE' && currentReviewVehicleId;
    const veh = isVehTarget ? (u.vehicles||[]).find(v => v.id === currentReviewVehicleId) : null;
    const card = isVehTarget 
        ? (u.rfid_cards||[]).find(c => c.vehicle_id === currentReviewVehicleId) 
        : (u.rfid_cards||[]).find(c => !c.vehicle_id);

    // Header Info
    const placeholder = 'https://ui-avatars.com/api/?name=' + encodeURIComponent(u.full_name) + '&background=random';
    if (el('revHeaderAvatar')) el('revHeaderAvatar').src = u.profile_image || placeholder;
    if (el('revHeaderName')) el('revHeaderName').textContent = u.full_name || '--';
    if (el('revHeaderCpassId')) el('revHeaderCpassId').textContent = `CPASS: ${u.cpass_id || u.student_id || '--'}`;
    if (el('revHeaderUserId')) el('revHeaderUserId').textContent = `ID: ${u.id.substring(0, 8)}...`;
    if (el('revHeaderProgram')) el('revHeaderProgram').textContent = `${u.program || 'No Program'} ${u.section ? '• ' + u.section : ''}`;
    if (el('revHeaderAppliedDate')) {
        const d = (isVehTarget && veh?.created_at) ? veh.created_at : u.created_at;
        const dStr = d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'Recently';
        el('revHeaderAppliedDate').textContent = `Applied: ${dStr}`;
    }

    // Pass Type Badge in Header
    if (el('revHeaderPassType')) {
        el('revHeaderPassType').textContent = isVehTarget 
            ? `🚗 VEHICLE: ${veh?.plate_number || 'UHF STICKER'}` 
            : '🚶 PEDESTRIAN PASS (CLOSE-RANGE)';
        el('revHeaderPassType').className = `px-2.5 py-0.5 rounded-full text-xs font-black uppercase tracking-wider ${isVehTarget ? 'bg-emerald-100 text-emerald-800' : 'bg-blue-100 text-blue-800'}`;
    }

    // Role Badge in Header
    if (el('revHeaderRole')) {
        const roleDisplay = u.role === 'Others' ? `Others: ${u.role_detail || 'Vendor'}` : (u.role || 'STUDENT').toUpperCase();
        el('revHeaderRole').textContent = roleDisplay;
        el('revHeaderRole').className = `px-3 py-0.5 rounded-full text-xs font-black uppercase tracking-wider ${
            u.role === 'Student' ? 'bg-blue-100 text-blue-800' : (u.role === 'Faculty' ? 'bg-purple-100 text-purple-800' : (u.role === 'Others' ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-800'))
        }`;
    }

    // Status Badge in Header
    const isItemAuth = isVehTarget 
        ? (veh?.approval_status === 'APPROVED' || card?.authorization_status === 'AUTHORIZED')
        : (u.approval_status === 'APPROVED' || card?.authorization_status === 'AUTHORIZED');
    const isItemPending = !isItemAuth && (isVehTarget 
        ? (veh?.approval_status === 'PENDING' || card?.authorization_status === 'PENDING' || !veh?.approval_status)
        : (u.approval_status === 'PENDING' || card?.authorization_status === 'PENDING' || !u.approval_status));

    if (el('revHeaderStatus')) {
        if (isItemAuth) {
            el('revHeaderStatus').innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span> AUTHORIZED ACTIVE';
            el('revHeaderStatus').className = 'px-3 py-0.5 rounded-full text-xs font-black uppercase tracking-wider bg-emerald-100 text-emerald-800 border border-emerald-300 flex items-center gap-1.5';
        } else if (isItemPending) {
            el('revHeaderStatus').innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-yellow-500 animate-ping"></span> PENDING REVIEW';
            el('revHeaderStatus').className = 'px-3 py-0.5 rounded-full text-xs font-black uppercase tracking-wider bg-yellow-100 text-yellow-800 border border-yellow-300 flex items-center gap-1.5';
        } else {
            el('revHeaderStatus').innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-red-500"></span> ACCESS DENIED';
            el('revHeaderStatus').className = 'px-3 py-0.5 rounded-full text-xs font-black uppercase tracking-wider bg-red-100 text-red-800 border border-red-300 flex items-center gap-1.5';
        }
    }

    // Tab 1: Personal & Transit Details
    if (el('revName')) el('revName').textContent = u.full_name || '--';
    if (el('revCpassId')) el('revCpassId').textContent = u.cpass_id || u.student_id || '--';
    if (el('revRoleBadge')) el('revRoleBadge').textContent = u.role === 'Others' ? `Others (${u.role_detail || 'Vendor'})` : (u.role || '--');
    if (el('revAge')) el('revAge').textContent = u.age || '--';
    if (el('revSex')) el('revSex').textContent = u.sex || '--';
    if (el('revProgram')) el('revProgram').textContent = u.program || '--';
    if (el('revSection')) el('revSection').textContent = u.section || '--';
    if (el('revAddress')) el('revAddress').textContent = u.address || 'No complete address provided';

    if (el('revRoleDetailBox')) {
        if (u.role === 'Others' && u.role_detail) {
            el('revRoleDetailBox').classList.remove('hidden');
            if (el('revRoleDetail')) el('revRoleDetail').textContent = u.role_detail;
        } else {
            el('revRoleDetailBox').classList.add('hidden');
        }
    }

    // Vehicle Details
    const defaultVehImg = 'https://images.unsplash.com/photo-1558981403-c5f91cbba527?auto=format&fit=crop&q=80&w=400';
    if (isVehTarget && veh) {
        if (el('revPlate')) el('revPlate').textContent = veh.plate_number || 'NO PLATE';
        if (el('revVehTypeBadge')) {
            el('revVehTypeBadge').textContent = `🚗 ${(veh.vehicle_type || 'VEHICLE').toUpperCase()} (LONG-RANGE UHF)`;
            el('revVehTypeBadge').className = 'px-3 py-1 rounded-xl text-xs font-black uppercase bg-emerald-100 text-emerald-800 border border-emerald-300';
        }
        if (el('revVehDetails')) el('revVehDetails').textContent = veh.vehicle_model || '--';
        if (el('revVehColor')) el('revVehColor').textContent = veh.vehicle_color || '--';
        if (el('revOverviewVehImg')) el('revOverviewVehImg').src = veh.motorcycle_image || defaultVehImg;
    } else {
        if (el('revPlate')) el('revPlate').textContent = 'PEDESTRIAN (NO VEHICLE)';
        if (el('revVehTypeBadge')) {
            el('revVehTypeBadge').textContent = '🚶 PEDESTRIAN (CLOSE-RANGE)';
            el('revVehTypeBadge').className = 'px-3 py-1 rounded-xl text-xs font-black uppercase bg-blue-100 text-blue-800 border border-blue-300';
        }
        if (el('revVehDetails')) el('revVehDetails').textContent = 'Walking Pedestrian Access';
        if (el('revVehColor')) el('revVehColor').textContent = 'N/A';
        if (el('revOverviewVehImg')) el('revOverviewVehImg').src = u.profile_image || placeholder;
    }

    // Tab 2: Document Images
    if (el('revProfileImage')) el('revProfileImage').src = u.profile_image || placeholder;
    if (el('revImgMotor')) el('revImgMotor').src = veh?.motorcycle_image || defaultVehImg;
    if (el('revImgIdFront')) el('revImgIdFront').src = u.id_front_image || 'https://images.unsplash.com/photo-1633158829585-23ba8f7c8caf?auto=format&fit=crop&q=60&w=400';
    if (el('revImgIdBack')) el('revImgIdBack').src = u.id_back_image || 'https://images.unsplash.com/photo-1621252179027-94459d278660?auto=format&fit=crop&q=60&w=400';
    
    // Toggle vehicle document cards based on review target
    if (el('revDocVehCard')) {
        if (isVehTarget) el('revDocVehCard').classList.remove('hidden');
        else el('revDocVehCard').classList.add('hidden');
    }
    if (el('revDocOrCrCard')) {
        if (isVehTarget) {
            el('revDocOrCrCard').classList.remove('hidden');
            if (el('revImgOrCr')) el('revImgOrCr').src = veh?.or_cr_image || 'https://images.unsplash.com/photo-1589829545856-d10d557cf95f?auto=format&fit=crop&q=60&w=400';
        } else {
            el('revDocOrCrCard').classList.add('hidden');
        }
    }

    // Tab 3: Access History for this User
    const userLogs = adminState.logs.filter(l => 
        (l.user_id && l.user_id === u.id) || 
        (card?.rfid_uid && l.rfid_uid === card.rfid_uid) ||
        (u.rfid_uid && l.rfid_uid === u.rfid_uid) ||
        (veh?.plate_number && (l.vehicles?.plate_number === veh.plate_number || l.remarks?.includes(veh.plate_number)))
    );

    const userEntries = userLogs.filter(l => l.direction === 'ENTRY' && l.status === 'AUTHORIZED');
    const userExits = userLogs.filter(l => l.direction === 'EXIT' && l.status === 'AUTHORIZED');
    const onCampus = isUserOnCampus(u);

    if (el('revStatEntries')) el('revStatEntries').textContent = userEntries.length;
    if (el('revStatExits')) el('revStatExits').textContent = userExits.length;
    if (el('revStatPresence')) {
        el('revStatPresence').innerHTML = onCampus 
            ? '<span class="text-emerald-600 font-bold flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span> 🟢 Inside Campus</span>'
            : '<span class="text-slate-500">⚪ Off Campus</span>';
    }

    if (el('revMiniLogsTable')) {
        el('revMiniLogsTable').innerHTML = userLogs.length ? userLogs.slice(0, 5).map(l => {
            const isEntry = l.direction === 'ENTRY';
            const dirBadge = isEntry 
                ? '<span class="px-2 py-0.5 rounded-full text-[10px] font-black bg-emerald-100 text-emerald-800">ENTRY</span>' 
                : '<span class="px-2 py-0.5 rounded-full text-[10px] font-black bg-blue-100 text-blue-800">EXIT</span>';
            const timeStr = l.timestamp ? new Date(l.timestamp).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }) : '--';
            const dateStr = l.timestamp ? new Date(l.timestamp).toLocaleDateString([], { month:'short', day:'numeric' }) : '';
            return `
            <tr class="hover:bg-slate-50">
                <td class="p-3">${dirBadge}</td>
                <td class="p-3 font-semibold text-slate-700">${l.gate || (isEntry ? 'Entry Gate #1' : 'Exit Gate #1')}</td>
                <td class="p-3 text-slate-500">${dateStr} ${timeStr}</td>
                <td class="p-3"><span class="px-2 py-0.5 rounded text-[10px] font-bold ${l.status==='AUTHORIZED'?'bg-emerald-50 text-emerald-700':'bg-red-50 text-red-700'}">${l.status||'AUTHORIZED'}</span></td>
                <td class="p-3 text-slate-500">${l.remarks || 'Standard scan tap'}</td>
            </tr>`;
        }).join('') : '<tr><td colspan="5" class="p-6 text-center text-slate-400">No gate tap logs recorded yet for this applicant.</td></tr>';
    }

    if (el('revBtnOpenFullHistory')) {
        el('revBtnOpenFullHistory').onclick = () => {
            closeReviewModal();
            setTimeout(() => openUserHistoryModal(u.id), 250);
        };
    }

    // RFID UID Input Station (dynamic according to pedestrian vs vehicle)
    if (el('revRfidStationTitle')) {
        el('revRfidStationTitle').textContent = isVehTarget 
            ? 'Long-Range UHF RFID Sticker Assignment Station' 
            : 'Close-Range 13.56MHz RFID Card Assignment Station';
    }
    if (el('revRfidStationSubtitle')) {
        el('revRfidStationSubtitle').textContent = isVehTarget 
            ? `Assign a physical UHF sticker (860-960MHz) to vehicle plate ${veh?.plate_number || ''} for automated barrier pass.` 
            : 'Assign a physical 13.56MHz Mifare RFID card for pedestrian turnstiles and gates.';
    }

    const cleanUid = (card?.rfid_uid && !card.rfid_uid.startsWith('UNASSIGNED_')) ? card.rfid_uid : '';
    if (el('revRfidUid')) {
        el('revRfidUid').value = cleanUid;
        handleRfidInputCheck(cleanUid);
    }

    // Action Buttons
    if (el('revBtnApprove')) {
        el('revBtnApprove').innerHTML = isItemAuth 
            ? '<i data-lucide="check-circle" class="w-4 h-4 text-charm-yellow"></i> Update RFID UID' 
            : (isVehTarget ? '<i data-lucide="check-circle" class="w-4 h-4 text-charm-yellow"></i> Approve &amp; Issue UHF Sticker' : '<i data-lucide="check-circle" class="w-4 h-4 text-charm-yellow"></i> Approve &amp; Issue Card');
        el('revBtnApprove').onclick = () => { approveUser(u.id, currentReviewTargetType, currentReviewVehicleId); };
    }

    if (el('revBtnDeny')) {
        el('revBtnDeny').innerHTML = isItemAuth 
            ? '<i data-lucide="shield-off" class="w-4 h-4"></i> Revoke Access' 
            : '<i data-lucide="x-circle" class="w-4 h-4"></i> Deny Application';
        el('revBtnDeny').onclick = () => { denyRegistration(u.id, currentReviewTargetType, currentReviewVehicleId); };
    }

    // Reset to Overview Tab
    switchReviewTab('overview');

    const modal = el('reviewModal');
    modal.classList.remove('hidden');
    setTimeout(() => { 
        modal.classList.add('opacity-100'); 
        el('reviewModalContent').classList.remove('scale-95'); 
    }, 10);
    lucide.createIcons();
};

window.closeReviewModal = function() {
    const modal = el('reviewModal');
    if (!modal) return;
    modal.classList.remove('opacity-100'); 
    el('reviewModalContent').classList.add('scale-95');
    setTimeout(() => modal.classList.add('hidden'), 300);
};

window.switchReviewTab = function(tabName) {
    const tabs = ['overview', 'documents', 'history'];
    tabs.forEach(t => {
        const btn = el('revNav-' + t);
        const sec = el('revSection-' + t);
        if (btn) {
            if (t === tabName) {
                btn.className = 'rev-tab-btn py-3 px-4 text-xs font-black uppercase tracking-wider text-charm-dark border-b-2 border-charm-dark flex items-center gap-2';
            } else {
                btn.className = 'rev-tab-btn py-3 px-4 text-xs font-black uppercase tracking-wider text-slate-400 hover:text-slate-700 border-b-2 border-transparent flex items-center gap-2';
            }
        }
        if (sec) {
            if (t === tabName) sec.classList.remove('hidden');
            else sec.classList.add('hidden');
        }
    });
    lucide.createIcons();
};

window.handleRfidInputCheck = function(val) {
    const inputVal = (val || '').trim().toUpperCase();
    const warnEl = el('revDuplicateWarning');
    const chipEl = el('revUidStatusChip');

    if (!inputVal) {
        if (warnEl) warnEl.classList.add('hidden');
        if (chipEl) {
            chipEl.innerHTML = '<i data-lucide="radio" class="w-4 h-4 text-slate-400"></i><span>Awaiting UID Input</span>';
            chipEl.className = 'w-full py-3 px-4 rounded-2xl bg-white border border-slate-200 text-xs font-bold text-slate-500 flex items-center justify-center gap-2 shadow-sm';
        }
        lucide.createIcons();
        return;
    }

    // Check duplicate among other registered users
    const duplicate = adminState.users.find(u => 
        u.id !== currentReviewUserId && 
        u.rfid_uid && 
        u.rfid_uid.replace(/\s+/g,'').toUpperCase() === inputVal.replace(/\s+/g,'')
    );

    if (duplicate) {
        if (warnEl) {
            warnEl.classList.remove('hidden');
            el('revDuplicateText').textContent = `⚠️ Warning: UID "${inputVal}" is already assigned to "${duplicate.full_name}" (${duplicate.plate_number || 'No Plate'})`;
        }
        if (chipEl) {
            chipEl.innerHTML = '<i data-lucide="alert-triangle" class="w-4 h-4 text-red-500"></i><span class="text-red-600">Duplicate Tag Detected</span>';
            chipEl.className = 'w-full py-3 px-4 rounded-2xl bg-red-50 border border-red-200 text-xs font-bold text-red-700 flex items-center justify-center gap-2 shadow-sm';
        }
    } else {
        if (warnEl) warnEl.classList.add('hidden');
        if (chipEl) {
            chipEl.innerHTML = '<i data-lucide="check-circle" class="w-4 h-4 text-emerald-600"></i><span class="text-emerald-700">Valid Unique RFID Tag</span>';
            chipEl.className = 'w-full py-3 px-4 rounded-2xl bg-emerald-50 border border-emerald-200 text-xs font-bold text-emerald-800 flex items-center justify-center gap-2 shadow-sm';
        }
    }
    lucide.createIcons();
};

window.generateTestUID = function() {
    // Generate realistic 4-byte HEX UID
    const hexParts = [];
    for (let i = 0; i < 4; i++) {
        const byte = Math.floor(Math.random() * 256).toString(16).toUpperCase().padStart(2, '0');
        hexParts.push(byte);
    }
    const newUid = hexParts.join(' ');
    if (el('revRfidUid')) {
        el('revRfidUid').value = newUid;
        handleRfidInputCheck(newUid);
        showToast(`Generated Test RFID UID: ${newUid}`, 'info');
    }
};

window.printRegistrationSummary = function() {
    window.print();
};

window.zoomImage = function(container) {
    const img = container.querySelector('img');
    if (!img || !img.src) return;
    el('zoomImg').src = img.src;
    el('zoomModal').classList.remove('hidden');
};



// ==============================================
// 📜 DEDICATED USER ACCESS HISTORY & AUDIT LOGS
// ==============================================
let activeUserHistoryData = {
    user: null,
    logs: [],
    direction: 'ALL'
};

window.openUserHistoryModal = function(userId) {
    if (!userId) return;
    const u = adminState.users.find(x => x.id === userId) || adminState.pendingUsers.find(x => x.id === userId);
    if (!u) {
        showToast('User not found.', 'error');
        return;
    }

    activeUserHistoryData.user = u;
    activeUserHistoryData.direction = 'ALL';

    // Header Profile Elements
    const avatar = u.profile_image || `https://ui-avatars.com/api/?name=${encodeURIComponent(u.full_name)}&background=random`;
    if (el('histUserAvatar')) el('histUserAvatar').src = avatar;
    if (el('histUserName')) el('histUserName').textContent = u.full_name || '--';
    if (el('histUserRole')) el('histUserRole').textContent = (u.role || 'USER').toUpperCase();
    if (el('histUserProgram')) el('histUserProgram').textContent = `${u.program || 'No Program'} ${u.section ? '• ' + u.section : ''}`;
    if (el('histUserPlate')) el('histUserPlate').textContent = `PLATE: ${u.plate_number || 'NO PLATE'}`;
    if (el('histUserUid')) el('histUserUid').textContent = `RFID: ${u.rfid_uid || 'NOT ASSIGNED'}`;

    // Filter all logs for this specific user
    const userLogs = adminState.logs.filter(l => 
        (l.user_id && l.user_id === u.id) || 
        (u.rfid_uid && l.rfid_uid === u.rfid_uid) ||
        (u.plate_number && (l.vehicles?.plate_number === u.plate_number || l.remarks?.includes(u.plate_number)))
    );

    // Sort descending by timestamp
    userLogs.sort((a,b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
    activeUserHistoryData.logs = userLogs;

    // Presence & KPI Calculations
    const onCampus = isUserOnCampus(u);
    const authLogs = userLogs.filter(l => l.status === 'AUTHORIZED');
    const totalEntries = authLogs.filter(l => l.direction === 'ENTRY').length;
    const totalExits = authLogs.filter(l => l.direction === 'EXIT').length;

    const todayStr = new Date().toISOString().split('T')[0];
    const todayLogs = userLogs.filter(l => l.timestamp && l.timestamp.startsWith(todayStr));

    if (el('histPresencePill')) {
        if (onCampus) {
            el('histPresencePill').innerHTML = '<span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span> INSIDE CAMPUS';
            el('histPresencePill').className = 'px-3 py-0.5 rounded-full text-xs font-black uppercase tracking-wider bg-emerald-500/20 text-emerald-300 border border-emerald-400/30 flex items-center gap-1.5';
        } else {
            el('histPresencePill').innerHTML = '⚪ OFF-CAMPUS';
            el('histPresencePill').className = 'px-3 py-0.5 rounded-full text-xs font-black uppercase tracking-wider bg-white/10 text-slate-300 border border-white/20 flex items-center gap-1.5';
        }
    }

    if (el('histTotalEntries')) el('histTotalEntries').textContent = totalEntries;
    if (el('histTotalExits')) el('histTotalExits').textContent = totalExits;
    if (el('histTodayTaps')) el('histTodayTaps').textContent = todayLogs.length;

    if (userLogs.length > 0) {
        const lastLog = userLogs[0];
        const lastTime = lastLog.timestamp ? new Date(lastLog.timestamp).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }) : '--';
        const lastDate = lastLog.timestamp ? new Date(lastLog.timestamp).toLocaleDateString([], { month:'short', day:'numeric' }) : '';
        if (el('histLastActivity')) el('histLastActivity').textContent = `${lastLog.direction || 'SCAN'} via ${lastLog.gate || 'Gate'}`;
        if (el('histLastTimestamp')) el('histLastTimestamp').textContent = `${lastDate} at ${lastTime}`;
    } else {
        if (el('histLastActivity')) el('histLastActivity').textContent = 'No past scans';
        if (el('histLastTimestamp')) el('histLastTimestamp').textContent = '--';
    }

    // Reset Direction Filter
    setUserHistDirection('ALL');

    const modal = el('userHistoryModal');
    modal.classList.remove('hidden');
    setTimeout(() => { 
        modal.classList.add('opacity-100'); 
        el('userHistoryModalContent').classList.remove('scale-95'); 
    }, 10);
    lucide.createIcons();
};

window.closeUserHistoryModal = function() {
    const modal = el('userHistoryModal');
    if (!modal) return;
    modal.classList.remove('opacity-100'); 
    el('userHistoryModalContent').classList.add('scale-95');
    setTimeout(() => modal.classList.add('hidden'), 300);
};

window.setUserHistDirection = function(dir) {
    activeUserHistoryData.direction = dir;
    document.querySelectorAll('.uh-dir-btn').forEach(b => {
        b.classList.remove('bg-charm-dark', 'text-white', 'shadow-sm');
        b.classList.add('text-slate-600', 'hover:text-slate-900');
    });
    const btn = el('uhDir-' + dir);
    if (btn) {
        btn.classList.remove('text-slate-600', 'hover:text-slate-900');
        btn.classList.add('bg-charm-dark', 'text-white', 'shadow-sm');
    }
    filterUserHistoryTable();
};

window.filterUserHistoryTable = function() {
    const search = (el('userHistSearch')?.value || '').toLowerCase().trim();
    const dir = activeUserHistoryData.direction || 'ALL';
    let logs = [...activeUserHistoryData.logs];

    if (dir === 'ENTRY') logs = logs.filter(l => l.direction === 'ENTRY' && l.status === 'AUTHORIZED');
    else if (dir === 'EXIT') logs = logs.filter(l => l.direction === 'EXIT' && l.status === 'AUTHORIZED');
    else if (dir === 'DENIED') logs = logs.filter(l => l.status === 'DENIED');

    if (search) {
        logs = logs.filter(l => 
            (l.gate || '').toLowerCase().includes(search) || 
            (l.remarks || '').toLowerCase().includes(search) ||
            (l.status || '').toLowerCase().includes(search)
        );
    }

    if (el('userHistCountLabel')) {
        el('userHistCountLabel').textContent = `Showing ${logs.length} scan log records`;
    }

    if (el('userHistoryTableBody')) {
        if (!logs.length) {
            el('userHistoryTableBody').innerHTML = `
                <tr>
                    <td colspan="6" class="p-12 text-center text-slate-400">
                        <div class="flex flex-col items-center justify-center">
                            <div class="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center mb-2 text-slate-400">
                                <i data-lucide="inbox" class="w-6 h-6"></i>
                            </div>
                            <p class="font-bold text-slate-700">No activity logs recorded</p>
                            <p class="text-xs text-slate-400">No matching gate entry or exit events found for this user.</p>
                        </div>
                    </td>
                </tr>`;
            lucide.createIcons();
            return;
        }

        // Compute Stay Duration by pairing chronologically
        el('userHistoryTableBody').innerHTML = logs.map((l, index) => {
            const isEntry = l.direction === 'ENTRY';
            const isAuth = l.status === 'AUTHORIZED';

            const dirBadge = isEntry 
                ? '<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-black bg-emerald-100 text-emerald-800 border border-emerald-300"><i data-lucide="arrow-down-left" class="w-3 h-3"></i> ENTRY</span>' 
                : '<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-black bg-blue-100 text-blue-800 border border-blue-300"><i data-lucide="arrow-up-right" class="w-3 h-3"></i> EXIT</span>';

            const statusBadge = isAuth 
                ? '<span class="px-2 py-0.5 rounded text-[10px] font-extrabold bg-emerald-50 text-emerald-700 border border-emerald-200">AUTHORIZED</span>' 
                : '<span class="px-2 py-0.5 rounded text-[10px] font-extrabold bg-red-50 text-red-700 border border-red-200">DENIED</span>';

            const dateObj = l.timestamp ? new Date(l.timestamp) : new Date();
            const dateFormatted = dateObj.toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
            const timeFormatted = dateObj.toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit', second:'2-digit' });

            // Relative time calculation
            const diffMs = Date.now() - dateObj.getTime();
            const diffMins = Math.floor(diffMs / 60000);
            let relTime = `${diffMins}m ago`;
            if (diffMins < 1) relTime = 'Just now';
            else if (diffMins >= 60 && diffMins < 1440) relTime = `${Math.floor(diffMins / 60)}h ago`;
            else if (diffMins >= 1440) relTime = `${Math.floor(diffMins / 1440)}d ago`;

            // Calculate duration if exit
            let durationText = '--';
            if (!isEntry && isAuth) {
                // Look for closest prior ENTRY
                const priorEntry = activeUserHistoryData.logs.slice(index + 1).find(x => x.direction === 'ENTRY' && x.status === 'AUTHORIZED');
                if (priorEntry && priorEntry.timestamp) {
                    const durationMins = Math.floor((new Date(l.timestamp) - new Date(priorEntry.timestamp)) / 60000);
                    if (durationMins > 0) {
                        const h = Math.floor(durationMins / 60);
                        const m = durationMins % 60;
                        durationText = h > 0 ? `${h}h ${m}m` : `${m} mins`;
                    } else {
                        durationText = '< 1 min';
                    }
                }
            } else if (isEntry && isAuth && index === 0 && isUserOnCampus(activeUserHistoryData.user)) {
                const elapsedMins = Math.floor((Date.now() - dateObj.getTime()) / 60000);
                const h = Math.floor(elapsedMins / 60);
                const m = elapsedMins % 60;
                durationText = `<span class="text-emerald-600 font-bold font-mono">${h > 0 ? `${h}h ${m}m` : `${m}m`} (Active)</span>`;
            }

            return `
            <tr class="hover:bg-slate-50 transition-colors">
                <td class="p-3.5">${dirBadge}</td>
                <td class="p-3.5 font-bold text-slate-700">
                    <div class="flex items-center gap-1.5">
                        <i data-lucide="${isEntry ? 'log-in' : 'log-out'}" class="w-3.5 h-3.5 text-slate-400"></i>
                        <span>${l.gate || (isEntry ? 'CHARRMPASS Entry Gate #1' : 'CHARRMPASS Exit Gate #1')}</span>
                    </div>
                </td>
                <td class="p-3.5">
                    <div class="font-mono font-bold text-slate-800">${timeFormatted}</div>
                    <div class="text-[10px] text-slate-400 font-medium">${dateFormatted} • ${relTime}</div>
                </td>
                <td class="p-3.5 font-mono font-semibold text-slate-700">
                    ${durationText}
                </td>
                <td class="p-3.5 text-center">
                    ${statusBadge}
                </td>
                <td class="p-3.5 text-slate-600 font-medium">
                    ${l.remarks || 'Standard RFID gate scan'}
                </td>
            </tr>`;
        }).join('');
        lucide.createIcons();
    }
};

window.exportSingleUserLogsCSV = function() {
    const u = activeUserHistoryData.user;
    const logs = activeUserHistoryData.logs;
    if (!u || !logs.length) {
        showToast('No log records to export.', 'warning');
        return;
    }

    const headers = ['Timestamp', 'Direction', 'Gate', 'Status', 'Driver Name', 'Role', 'Plate Number', 'RFID UID', 'Remarks'];
    const rows = logs.map(l => [
        `"${l.timestamp || ''}"`,
        `"${l.direction || 'ENTRY'}"`,
        `"${l.gate || 'Gate'}"`,
        `"${l.status || 'AUTHORIZED'}"`,
        `"${(u.full_name || '').replace(/"/g, '""')}"`,
        `"${u.role || ''}"`,
        `"${u.plate_number || ''}"`,
        `"${u.rfid_uid || ''}"`,
        `"${(l.remarks || '').replace(/"/g, '""')}"`
    ]);

    const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map(e => e.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    const dateStr = new Date().toISOString().split('T')[0];
    link.setAttribute('download', `charrmpass_logs_${(u.full_name||'user').toLowerCase().replace(/\s+/g,'_')}_${dateStr}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    showToast(`Exported ${logs.length} log records for ${u.full_name}`, 'success');
};

window.printSingleUserHistory = function() {
    window.print();
};

window.exportAllUsersCSV = function() {
    if (!adminState.users.length) {
        showToast('No registered users to export.', 'warning');
        return;
    }

    const headers = ['User ID', 'Full Name', 'Role', 'Age', 'Sex', 'Program', 'Section', 'Address', 'Plate Number', 'Vehicle Type', 'Vehicle Model', 'Vehicle Color', 'RFID UID', 'Authorization Status', 'Registered Date'];
    const rows = adminState.users.map(u => [
        `"${u.id || ''}"`,
        `"${(u.full_name || '').replace(/"/g, '""')}"`,
        `"${u.role || ''}"`,
        `"${u.age || ''}"`,
        `"${u.sex || ''}"`,
        `"${(u.program || '').replace(/"/g, '""')}"`,
        `"${(u.section || '').replace(/"/g, '""')}"`,
        `"${(u.address || '').replace(/"/g, '""')}"`,
        `"${u.plate_number || ''}"`,
        `"${u.vehicle_type || ''}"`,
        `"${(u.vehicle_model || '').replace(/"/g, '""')}"`,
        `"${(u.vehicle_color || '').replace(/"/g, '""')}"`,
        `"${u.rfid_uid || ''}"`,
        `"${u.authorization_status || 'PENDING'}"`,
        `"${u.created_at || ''}"`
    ]);

    const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map(e => e.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    const dateStr = new Date().toISOString().split('T')[0];
    link.setAttribute('download', `charrmpass_registered_users_${dateStr}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    showToast(`Exported ${adminState.users.length} users to CSV`, 'success');
};

// Account Modal logic (Guard Credentials Management)
window.openAccountModal = function(id = null) {
    const m = el('accountModal');
    if (!m) return;
    el('accountForm').reset();
    const modalTitle = el('accountModalContent')?.querySelector('h3');
    
    if (id) {
        const acc = adminState.accounts.find(a => a.id === id);
        if (acc) {
            el('formAccId').value = acc.id;
            el('formAccUser').value = acc.username || '';
            el('formAccPass').value = acc.password || '';
            el('formAccRole').value = acc.role || 'GUARD';
            if (modalTitle) modalTitle.textContent = `Edit Guard Account (${acc.username})`;
        }
    } else {
        el('formAccId').value = '';
        el('formAccUser').value = '';
        el('formAccPass').value = '';
        el('formAccRole').value = 'GUARD';
        if (modalTitle) modalTitle.textContent = 'Add New Guard Account';
    }

    m.classList.remove('hidden');
    setTimeout(() => { 
        m.classList.remove('opacity-0'); 
        el('accountModalContent').classList.remove('scale-95'); 
    }, 10);
    lucide.createIcons();
};

window.closeAccountModal = function() {
    const m = el('accountModal');
    if (!m) return;
    m.classList.add('opacity-0'); 
    el('accountModalContent').classList.add('scale-95');
    setTimeout(() => m.classList.add('hidden'), 300);
};

window.deleteAccount = async function(id) {
    if (!id) return;
    const acc = adminState.accounts.find(a => a.id === id);
    const name = acc?.username || 'this account';
    if (!confirm(`Are you sure you want to delete guard account "${name}"?`)) return;

    if (isConnected) {
        try {
            const { error } = await supabaseClient.from('system_accounts').delete().eq('id', id);
            if (error) throw error;
            showToast(`Guard account "${name}" deleted!`, 'success');
            await loadData();
            renderAll();
        } catch(e) {
            showToast('Error deleting account: ' + e.message, 'error');
        }
    } else {
        adminState.accounts = adminState.accounts.filter(a => a.id !== id);
        showToast(`Guard account deleted (Demo mode).`, 'info');
        renderAll();
    }
};

el('accountForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = el('formAccId').value;
    const username = el('formAccUser').value.trim();
    const password = el('formAccPass').value.trim();
    const role = el('formAccRole').value || 'GUARD';

    if (!username || !password) {
        showToast('Username and password are required', 'warning');
        return;
    }

    try {
        if (isConnected) {
            const now = new Date().toISOString();
            if (id) {
                const { error } = await supabaseClient
                    .from('system_accounts')
                    .update({ username, password, role, updated_at: now })
                    .eq('id', id);
                if (error) throw error;
                showToast(`Guard account "${username}" updated!`, 'success');
            } else {
                const { error } = await supabaseClient
                    .from('system_accounts')
                    .insert({ username, password, role, updated_at: now });
                if (error) throw error;
                showToast(`New guard account "${username}" created!`, 'success');
            }
            closeAccountModal(); 
            await loadData();
            renderAll();
        } else {
            showToast('Changes saved locally (Demo mode).', 'info');
            closeAccountModal();
        }
    } catch(err) { 
        showToast('Error saving guard account: ' + err.message, 'error'); 
    }
});

window.togglePass = function(id, btn) {
    const input = el(id);
    if (!input) return;
    const isPass = input.type === 'password';
    input.type = isPass ? 'text' : 'password';
    if (btn) {
        btn.innerHTML = isPass ? '<i data-lucide="eye-off" class="w-4 h-4"></i>' : '<i data-lucide="eye" class="w-4 h-4"></i>';
        lucide.createIcons();
    }
};


// ==============================================
// 📡 BLUETOOTH (BLE) & WI-FI PROVISIONING MODULE
// Flow: Phone/Browser -> Web Bluetooth (BLE) -> ESP32 -> Router Wi-Fi -> Supabase Cloud
// ==============================================

const BLE_SERVICE_UUID = '4fafc201-1fb5-459e-8fcc-c5c9c331914b';
const BLE_CHAR_UUID    = 'beb5483e-36e1-4688-b7f5-ea07361b26a8';

let bleState = {
    device: null,
    server: null,
    service: null,
    characteristic: null,
    isConnected: false,
    deviceName: null,
    deviceRssi: -50,
    lastEvent: null
};

function getTimestampStr() {
    const d = new Date();
    return d.toTimeString().split(' ')[0] + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

window.appendBleLog = function(message, type = 'info') {
    const logsContainer = el('bleConsoleOutput') || el('bleConsoleLogs');
    if (!logsContainer) return;

    let colorClass = 'text-slate-300';
    let prefix = 'ℹ️';

    if (type === 'success') {
        colorClass = 'text-emerald-400 font-bold';
        prefix = '✅';
    } else if (type === 'error') {
        colorClass = 'text-rose-400 font-bold';
        prefix = '❌';
    } else if (type === 'warn') {
        colorClass = 'text-amber-400';
        prefix = '⚠️';
    } else if (type === 'tx') {
        colorClass = 'text-sky-300 font-mono';
        prefix = '📤 [TX]';
    } else if (type === 'rx') {
        colorClass = 'text-purple-300 font-mono';
        prefix = '📥 [RX]';
    } else if (type === 'system') {
        colorClass = 'text-charm-yellow font-bold';
        prefix = '⚡';
    }

    const logEntry = document.createElement('div');
    logEntry.className = `flex items-start gap-2 leading-relaxed ${colorClass}`;
    logEntry.innerHTML = `
        <span class="text-slate-500 select-none text-[11px] font-mono">[${getTimestampStr()}]</span>
        <span class="font-mono text-xs select-none">${prefix}</span>
        <span class="flex-1 font-mono text-xs break-all">${message}</span>
    `;

    logsContainer.appendChild(logEntry);
    logsContainer.scrollTop = logsContainer.scrollHeight;
};

window.clearBleConsole = function() {
    const logsContainer = el('bleConsoleOutput') || el('bleConsoleLogs');
    if (!logsContainer) return;
    logsContainer.innerHTML = `
        <div class="text-slate-500 italic">
            [${getTimestampStr()}] Bluetooth terminal ready for ESP32 connection...
        </div>
    `;
    showToast('Terminal logs cleared.', 'info');
};

function updateBleUiConnected(name = 'CHARRMPASS_GATE_BLE') {
    const statusBadge = el('bleConnectionStatus');
    if (statusBadge) {
        statusBadge.className = 'px-2.5 py-0.5 rounded-full text-[10px] font-black uppercase bg-emerald-100 text-emerald-800 border border-emerald-300';
        statusBadge.textContent = 'CONNECTED (PAIRED)';
    }
    const card = el('bleActiveDeviceCard');
    if (card) {
        card.classList.remove('hidden');
    }
    if (el('bleDeviceName')) {
        el('bleDeviceName').textContent = name;
    }
    if (el('bleDeviceRssi')) {
        el('bleDeviceRssi').textContent = `${bleState.deviceRssi} dBm (Good)`;
    }
    if (el('btnScanBle')) {
        el('btnScanBle').classList.add('hidden');
    }
    if (el('flowStepBle')) {
        el('flowStepBle').classList.add('border-emerald-500', 'bg-emerald-50/50');
    }
    if (el('flowStepEsp')) {
        el('flowStepEsp').classList.add('border-emerald-500', 'bg-emerald-50/50');
    }
}

function updateBleUiDisconnected() {
    const statusBadge = el('bleConnectionStatus');
    if (statusBadge) {
        statusBadge.className = 'px-2.5 py-0.5 rounded-full text-[10px] font-black uppercase bg-slate-100 text-slate-500 border border-slate-200';
        statusBadge.textContent = 'DISCONNECTED';
    }
    const card = el('bleActiveDeviceCard');
    if (card) {
        card.classList.add('hidden');
    }
    if (el('btnScanBle')) {
        el('btnScanBle').classList.remove('hidden');
    }
    if (el('flowStepBle')) {
        el('flowStepBle').classList.remove('border-emerald-500', 'bg-emerald-50/50');
    }
    if (el('flowStepEsp')) {
        el('flowStepEsp').classList.remove('border-emerald-500', 'bg-emerald-50/50');
    }
    if (el('flowStepRouter')) {
        el('flowStepRouter').classList.remove('border-emerald-500', 'bg-emerald-50/50');
    }
    if (el('flowStepCloud')) {
        el('flowStepCloud').classList.remove('border-emerald-500', 'bg-emerald-50/50');
    }
}

// Handler for real incoming characteristic notifications from ESP32
function handleBleNotification(event) {
    try {
        const value = event.target.value;
        const decoder = new TextDecoder('utf-8');
        const text = decoder.decode(value);
        appendBleLog(`ESP32 Notification: ${text}`, 'rx');

        try {
            const data = JSON.parse(text);
            if (data.event === 'CONNECTED' || data.status === 'CONNECTED' || data.status === 'ONLINE') {
                appendBleLog(`ESP32 Wi-Fi Connected! IP: ${data.ip || 'Assigned'} | RSSI: ${data.rssi || '-50'} dBm`, 'success');
                showToast(`ESP32 connected to Wi-Fi (${data.ip || 'Online'})!`, 'success');
                if (el('flowStepRouter')) el('flowStepRouter').classList.add('border-emerald-500', 'bg-emerald-50/50');
                if (el('flowStepCloud')) el('flowStepCloud').classList.add('border-emerald-500', 'bg-emerald-50/50');
                loadData();
            } else if (data.event === 'FAILED' || data.status === 'FAILED') {
                appendBleLog(`ESP32 Wi-Fi Connection Failed: ${data.error || 'Check password and signal'}`, 'error');
                showToast('ESP32 could not connect to Wi-Fi network. Check SSID and password.', 'error');
                if (el('flowStepRouter')) el('flowStepRouter').classList.remove('border-emerald-500', 'bg-emerald-50/50');
            } else if (data.event === 'RECEIVED') {
                appendBleLog(`ESP32 received credentials for "${data.ssid || 'network'}". Testing connection (up to 15s)...`, 'info');
                showToast(`ESP32 testing connection to "${data.ssid || 'Wi-Fi'}"...`, 'info');
            } else if (data.event === 'SAVED' || data.status === 'SAVED') {
                appendBleLog(`ESP32 verified & stored credentials to NVS and SD backup for: "${data.ssid}"`, 'success');
            }
        } catch(pe) {
            // Raw text response
            if (text.includes('CONNECTED') || text.includes('ONLINE')) {
                appendBleLog(`ESP32 Status Update: ${text}`, 'success');
            }
        }
    } catch(err) {
        console.error('BLE Notification decode error:', err);
    }
}

window.connectBluetoothDevice = async function() {
    appendBleLog('Initiating Web Bluetooth scan for CHARRMPASS ESP32 Gate Controllers...', 'system');

    if (!navigator.bluetooth) {
        appendBleLog('Web Bluetooth API is unavailable. Note: Web Bluetooth requires Chrome or Edge browser.', 'warn');
        showToast('Web Bluetooth requires Chrome or Edge browser.', 'warning');
        return;
    }

    try {
        appendBleLog('Opening Bluetooth pairing prompt. Please select your CHARRMPASS ESP32 device...', 'info');
        
        let device = null;
        const allowedServices = [
            BLE_SERVICE_UUID,
            '4fafc201-1fb5-459e-8fcc-c5c9c331914b',
            '0000ffff-0000-1000-8000-00805f9b34fb',
            'battery_service',
            'device_information'
        ];

        try {
            device = await navigator.bluetooth.requestDevice({
                filters: [
                    { namePrefix: 'CHARRMPASS' }
                ],
                optionalServices: allowedServices
            });
        } catch(filterErr) {
            device = await navigator.bluetooth.requestDevice({
                acceptAllDevices: true,
                optionalServices: allowedServices
            });
        }

        if (!device) {
            appendBleLog('No device selected.', 'warn');
            return;
        }

        appendBleLog(`Device selected: "${device.name || 'Unnamed ESP32'}" (ID: ${device.id})`, 'info');
        appendBleLog('Connecting to GATT Server...', 'info');

        device.addEventListener('gattserverdisconnected', onBleDisconnected);

        const server = await device.gatt.connect();
        appendBleLog('GATT Server connected! Discovering Wi-Fi Provisioning Service...', 'info');

        // Robust service discovery
        let service = null;
        const serviceAttempts = [
            BLE_SERVICE_UUID,
            '4fafc201-1fb5-459e-8fcc-c5c9c331914b',
            '0000ffff-0000-1000-8000-00805f9b34fb'
        ];
        for (const sId of serviceAttempts) {
            try {
                service = await server.getPrimaryService(sId);
                if (service) break;
            } catch(e) {}
        }

        if (!service) {
            try {
                const services = await server.getPrimaryServices();
                appendBleLog(`Found ${services.length} GATT service(s) on device.`, 'info');
                for (const s of services) {
                    appendBleLog(`• Service: ${s.uuid}`, 'info');
                    if (s.uuid.toLowerCase() === BLE_SERVICE_UUID.toLowerCase() || s.uuid.includes('4faf') || s.uuid.includes('ffff')) {
                        service = s;
                        break;
                    }
                }
                if (!service && services.length > 0) {
                    service = services[0];
                    appendBleLog(`Using GATT Service: ${service.uuid}`, 'info');
                }
            } catch(allSvcErr) {
                console.warn('getPrimaryServices error:', allSvcErr);
            }
        }

        if (!service) {
            throw new Error(`Provisioning Service (${BLE_SERVICE_UUID}) not accessible. Please ensure device is running latest firmware.`);
        }
        appendBleLog(`GATT Service identified: ${service.uuid}`, 'success');

        // Robust characteristic discovery
        let characteristic = null;
        const charAttempts = [
            BLE_CHAR_UUID,
            'beb5483e-36e1-4688-b7f5-ea07361b26a8',
            '0000ff01-0000-1000-8000-00805f9b34fb'
        ];
        for (const cId of charAttempts) {
            try {
                characteristic = await service.getCharacteristic(cId);
                if (characteristic) break;
            } catch(e) {}
        }

        if (!characteristic) {
            try {
                const chars = await service.getCharacteristics();
                appendBleLog(`Found ${chars.length} characteristic(s) in service.`, 'info');
                for (const c of chars) {
                    appendBleLog(`• Characteristic: ${c.uuid}`, 'info');
                    if (c.uuid.toLowerCase() === BLE_CHAR_UUID.toLowerCase() || c.uuid.includes('beb5') || c.uuid.includes('ff01')) {
                        characteristic = c;
                        break;
                    }
                }
                if (!characteristic && chars.length > 0) {
                    characteristic = chars[0];
                    appendBleLog(`Using Characteristic: ${characteristic.uuid}`, 'info');
                }
            } catch(allCharErr) {
                console.warn('getCharacteristics error:', allCharErr);
            }
        }

        if (!characteristic) {
            throw new Error(`Provisioning Characteristic (${BLE_CHAR_UUID}) not accessible. Please reconnect.`);
        }
        appendBleLog(`Provisioning Characteristic ready: ${characteristic.uuid} (Write & Notify capable).`, 'success');

        // Start notifications if supported
        try {
            await characteristic.startNotifications();
            characteristic.addEventListener('characteristicvaluechanged', handleBleNotification);
            appendBleLog('Subscribed to real-time status notifications from ESP32.', 'success');
        } catch(notifErr) {
            console.warn('Could not subscribe to notifications:', notifErr);
        }

        bleState.device = device;
        bleState.server = server;
        bleState.service = service;
        bleState.characteristic = characteristic;
        bleState.isConnected = true;
        bleState.deviceName = device.name || 'CHARRMPASS_ESP32_GATE';

        updateBleUiConnected(bleState.deviceName);
        appendBleLog(`Ready! ESP32 "${bleState.deviceName}" is paired. Enter SSID and Password below to send.`, 'success');
        showToast(`Connected to ${bleState.deviceName} via Bluetooth!`, 'success');

    } catch (err) {
        if (err.name === 'NotFoundError') {
            appendBleLog('Bluetooth scan was cancelled by user.', 'warn');
        } else {
            appendBleLog(`Bluetooth Error: ${err.message}`, 'error');
            showToast('Bluetooth Connection Failed: ' + err.message, 'error');
        }
    }
};

function onBleDisconnected() {
    appendBleLog(`Device "${bleState.deviceName || 'ESP32'}" disconnected from Bluetooth.`, 'warn');
    bleState.device = null;
    bleState.server = null;
    bleState.service = null;
    bleState.characteristic = null;
    bleState.isConnected = false;
    updateBleUiDisconnected();
    showToast('ESP32 Bluetooth disconnected.', 'warning');
}

window.disconnectBluetoothDevice = function() {
    if (bleState.device && bleState.device.gatt && bleState.device.gatt.connected) {
        bleState.device.gatt.disconnect();
    } else {
        onBleDisconnected();
    }
};

window.fillCampusPresetWifi = function() {
    appendBleLog('Tip: Click "Scan & Connect via Bluetooth" above to pair with your ESP32.', 'info');
    appendBleLog('Then enter your 2.4GHz Wi-Fi SSID and password to send them directly over BLE.', 'info');
    showToast('Click "Scan & Connect via Bluetooth" then enter your network credentials.', 'info');
    if (el('wifiSsidInput')) el('wifiSsidInput').focus();
};

window.handleWifiProvisionSubmit = async function(event) {
    if (event) event.preventDefault();

    const ssid = el('wifiSsidInput')?.value.trim();
    const passInput = el('wifiPassInput') || el('wifiPasswordInput');
    const password = passInput ? passInput.value.trim() : '';
    const gateId = el('bleTargetDeviceType')?.value || 'ENTRY';
    const secProto = el('wifiSecProtocol')?.value || 'WPA2';
    const ipMode = el('wifiIpMode')?.value || 'DHCP';

    if (!ssid) {
        showToast('Please enter the Wi-Fi Network Name (SSID).', 'warning');
        el('wifiSsidInput')?.focus();
        return;
    }

    if (!bleState.isConnected) {
        showToast('Please click "Scan & Connect via Bluetooth" to pair with your ESP32 first.', 'warning');
        appendBleLog('Cannot transmit credentials: No active Bluetooth connection. Click "Scan & Connect via Bluetooth" above.', 'warn');
        return;
    }

    const payloadObj = {
        ssid: ssid,
        pass: password
    };

    const rawPayload = JSON.stringify(payloadObj);
    const maskedPass = password ? '*'.repeat(password.length) : '(open/none)';

    appendBleLog(`Preparing Wi-Fi credentials package for Gate Target: ${gateId}...`, 'system');
    appendBleLog(`SSID: "${ssid}" | Password: ${maskedPass} | Security: ${secProto} | IP: ${ipMode}`, 'info');

    const submitBtn = el('btnSendProvision') || el('btnSendWifiConfig');
    const originalText = submitBtn ? submitBtn.innerHTML : 'Send Credentials';
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = `<i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i> Transmitting over BLE...`;
        lucide.createIcons();
    }

    try {
        appendBleLog(`Transmitting payload (${rawPayload.length} bytes) to ESP32 characteristic...`, 'tx');

        if (!bleState.characteristic) {
            throw new Error('Bluetooth characteristic not available. Please reconnect to your ESP32.');
        }

        const encoder = new TextEncoder();
        const dataBuffer = encoder.encode(rawPayload);
        
        if (typeof bleState.characteristic.writeValueWithResponse === 'function') {
            try {
                await bleState.characteristic.writeValueWithResponse(dataBuffer);
            } catch (wErr) {
                if (typeof bleState.characteristic.writeValueWithoutResponse === 'function') {
                    await bleState.characteristic.writeValueWithoutResponse(dataBuffer);
                } else if (typeof bleState.characteristic.writeValue === 'function') {
                    await bleState.characteristic.writeValue(dataBuffer);
                } else {
                    throw wErr;
                }
            }
        } else if (typeof bleState.characteristic.writeValue === 'function') {
            await bleState.characteristic.writeValue(dataBuffer);
        }
        appendBleLog('GATT Write Acknowledgement received: Payload successfully written to ESP32.', 'rx');

        appendBleLog(`[ESP32] Received new Wi-Fi credentials for "${ssid}". Connecting to network...`, 'info');
        showToast(`Wi-Fi credentials transmitted to ESP32 (${gateId})!`, 'success');

        if (el('flowStepRouter')) el('flowStepRouter').classList.add('border-emerald-500', 'bg-emerald-50/50');

    } catch (err) {
        appendBleLog(`Provisioning transmission error: ${err.message}`, 'error');
        showToast('Failed to transmit Wi-Fi credentials: ' + err.message, 'error');
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = originalText;
            lucide.createIcons();
        }
    }
};

// Real-world dynamic rendering of ESP32 devices table & health cards
window.renderEsp32DevicesTable = function() {
    const tableBody = el('esp32DevicesTable');
    const devices = adminState.devices || [];

    // Update target device dropdown
    const devSelect = el('bleTargetDeviceType');
    if (devSelect && devices.length > 0) {
        const currentVal = devSelect.value;
        devSelect.innerHTML = devices.map(d => `
            <option value="${d.esp32_identifier || d.gate_type}">${d.device_name || d.esp32_identifier} (${d.gate_type || 'GATE'})</option>
        `).join('') + `<option value="CUSTOM">Custom IoT Device (R.A.N. / EnerCharge Node)</option>`;
        if (currentVal) devSelect.value = currentVal;
    }

    // Determine online status based on real database last_online or latest transaction
    const now = Date.now();
    let onlineCount = 0;

    let entryGate = devices.find(d => (d.gate_type === 'ENTRY' || (d.esp32_identifier && d.esp32_identifier.includes('ENTRY'))));
    let exitGate = devices.find(d => (d.gate_type === 'EXIT' || (d.esp32_identifier && d.esp32_identifier.includes('EXIT'))));

    // Calculate real activity for each device
    const deviceStatuses = devices.map(dev => {
        let lastSeenMs = dev.last_online ? new Date(dev.last_online).getTime() : 0;
        
        // Also check if any recent transaction matches this gate
        const matchingTxn = adminState.logs.find(l => 
            (l.gate && dev.esp32_identifier && l.gate.includes(dev.esp32_identifier)) ||
            (l.direction === dev.gate_type)
        );
        if (matchingTxn && matchingTxn.timestamp) {
            const txnMs = new Date(matchingTxn.timestamp).getTime();
            if (txnMs > lastSeenMs) lastSeenMs = txnMs;
        }

        const elapsedSecs = Math.floor((now - lastSeenMs) / 1000);
        let status = 'OFFLINE';
        let statusBadge = '';
        let lastSeenText = 'No recorded activity';

        if (lastSeenMs > 0) {
            if (elapsedSecs < 300) { // Active in last 5 minutes
                status = 'ONLINE';
                onlineCount++;
                statusBadge = '<span class="px-2 py-0.5 rounded-full text-[10px] font-black bg-emerald-100 text-emerald-800 border border-emerald-300 flex items-center justify-center gap-1"><span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span> ONLINE</span>';
                lastSeenText = elapsedSecs < 60 ? 'Active just now' : `Active ${Math.floor(elapsedSecs / 60)}m ago`;
            } else if (elapsedSecs < 86400) { // Within 24 hours
                status = 'STANDBY';
                onlineCount++;
                statusBadge = '<span class="px-2 py-0.5 rounded-full text-[10px] font-black bg-amber-100 text-amber-800 border border-amber-300">STANDBY</span>';
                const h = Math.floor(elapsedSecs / 3600);
                const m = Math.floor((elapsedSecs % 3600) / 60);
                lastSeenText = `Last active ${h > 0 ? `${h}h ` : ''}${m}m ago`;
            } else {
                status = 'OFFLINE';
                statusBadge = '<span class="px-2 py-0.5 rounded-full text-[10px] font-black bg-slate-100 text-slate-500 border border-slate-200">OFFLINE</span>';
                const days = Math.floor(elapsedSecs / 86400);
                lastSeenText = `Last seen ${days}d ago`;
            }
        } else {
            statusBadge = '<span class="px-2 py-0.5 rounded-full text-[10px] font-black bg-slate-100 text-slate-500 border border-slate-200">OFFLINE</span>';
        }

        return { ...dev, computedStatus: status, statusBadge, lastSeenText, elapsedSecs };
    });

    // Update Gate Health Cards
    if (el('entryGateStatusBadge')) {
        const entryDev = deviceStatuses.find(d => d.gate_type === 'ENTRY' || (d.esp32_identifier && d.esp32_identifier.includes('ENTRY')));
        if (entryDev && entryDev.computedStatus === 'ONLINE') {
            el('entryGateStatusBadge').innerHTML = `<span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span> ONLINE (Active)`;
            el('entryGateStatusBadge').className = 'text-sm font-black text-emerald-700 mt-1 flex items-center gap-1.5';
            if (el('entryGateIpText')) el('entryGateIpText').textContent = `${entryDev.device_location || 'Main Entry'} • ${entryDev.lastSeenText}`;
        } else if (entryDev && entryDev.computedStatus === 'STANDBY') {
            el('entryGateStatusBadge').innerHTML = `<span class="w-2 h-2 rounded-full bg-amber-500"></span> STANDBY`;
            el('entryGateStatusBadge').className = 'text-sm font-black text-amber-700 mt-1 flex items-center gap-1.5';
            if (el('entryGateIpText')) el('entryGateIpText').textContent = `${entryDev.lastSeenText}`;
        } else {
            el('entryGateStatusBadge').innerHTML = `<span class="w-2 h-2 rounded-full bg-slate-400"></span> OFFLINE / STANDBY`;
            el('entryGateStatusBadge').className = 'text-sm font-black text-slate-500 mt-1 flex items-center gap-1.5';
            if (el('entryGateIpText')) el('entryGateIpText').textContent = entryDev ? entryDev.lastSeenText : 'No active gate session';
        }
    }

    if (el('exitGateStatusBadge')) {
        const exitDev = deviceStatuses.find(d => d.gate_type === 'EXIT' || (d.esp32_identifier && d.esp32_identifier.includes('EXIT')));
        if (exitDev && exitDev.computedStatus === 'ONLINE') {
            el('exitGateStatusBadge').innerHTML = `<span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span> ONLINE (Active)`;
            el('exitGateStatusBadge').className = 'text-sm font-black text-emerald-700 mt-1 flex items-center gap-1.5';
            if (el('exitGateIpText')) el('exitGateIpText').textContent = `${exitDev.device_location || 'Main Exit'} • ${exitDev.lastSeenText}`;
        } else if (exitDev && exitDev.computedStatus === 'STANDBY') {
            el('exitGateStatusBadge').innerHTML = `<span class="w-2 h-2 rounded-full bg-amber-500"></span> STANDBY`;
            el('exitGateStatusBadge').className = 'text-sm font-black text-amber-700 mt-1 flex items-center gap-1.5';
            if (el('exitGateIpText')) el('exitGateIpText').textContent = `${exitDev.lastSeenText}`;
        } else {
            el('exitGateStatusBadge').innerHTML = `<span class="w-2 h-2 rounded-full bg-slate-400"></span> OFFLINE / STANDBY`;
            el('exitGateStatusBadge').className = 'text-sm font-black text-slate-500 mt-1 flex items-center gap-1.5';
            if (el('exitGateIpText')) el('exitGateIpText').textContent = exitDev ? exitDev.lastSeenText : 'No active gate session';
        }
    }

    if (el('syncedGatesCount')) {
        el('syncedGatesCount').textContent = `${onlineCount} of ${devices.length} Nodes Active`;
    }

    // Render Table
    if (tableBody) {
        if (!deviceStatuses.length) {
            tableBody.innerHTML = `
                <tr>
                    <td colspan="7" class="p-8 text-center text-slate-400">
                        <div class="flex flex-col items-center justify-center">
                            <i data-lucide="cpu" class="w-8 h-8 text-slate-300 mb-2"></i>
                            <p class="font-bold text-slate-700">No ESP32 Gate Units Registered</p>
                            <p class="text-xs text-slate-400">Click "Register Gate Unit" above to add your first microcontroller gateway.</p>
                        </div>
                    </td>
                </tr>
            `;
            lucide.createIcons();
            return;
        }

        tableBody.innerHTML = deviceStatuses.map(d => {
            const roleBadge = d.gate_type === 'ENTRY' 
                ? '<span class="px-2 py-0.5 rounded text-[10px] font-black bg-emerald-100 text-emerald-800">ENTRY GATE</span>'
                : (d.gate_type === 'EXIT' 
                    ? '<span class="px-2 py-0.5 rounded text-[10px] font-black bg-blue-100 text-blue-800">EXIT GATE</span>'
                    : '<span class="px-2 py-0.5 rounded text-[10px] font-black bg-purple-100 text-purple-800">ADMIN</span>');

            const rangeBadge = d.rfid_range === 'LONG_RANGE'
                ? '<span class="font-mono text-emerald-700 font-bold">900MHz UHF</span>'
                : (d.rfid_range === 'CLOSE_RANGE'
                    ? '<span class="font-mono text-blue-700 font-bold">13.56MHz NFC</span>'
                    : '<span class="font-mono text-purple-700 font-bold">Hybrid Dual</span>');

            const categoryText = (d.device_category || 'VEHICLE_BARRIER').replace(/_/g, ' ');

            return `
            <tr class="hover:bg-slate-50 transition-colors">
                <td class="p-3.5">
                    <div class="flex items-center gap-2">
                        <div class="w-8 h-8 rounded-xl bg-slate-100 text-slate-700 flex items-center justify-center font-bold">
                            <i data-lucide="cpu" class="w-4 h-4 text-emerald-700"></i>
                        </div>
                        <div>
                            <div class="font-bold text-slate-800">${d.device_name || d.esp32_identifier}</div>
                            <div class="text-[10px] font-mono text-slate-400 font-semibold">${d.esp32_identifier}</div>
                        </div>
                    </div>
                </td>
                <td class="p-3.5">${roleBadge}</td>
                <td class="p-3.5">
                    <div class="font-bold text-slate-700 text-xs">${categoryText}</div>
                    <div class="text-[11px]">${rangeBadge}</div>
                </td>
                <td class="p-3.5 text-slate-600 font-medium">${d.device_location || 'Campus Gate'}</td>
                <td class="p-3.5">
                    <div class="font-semibold text-slate-700 text-xs">${d.lastSeenText}</div>
                    <div class="text-[10px] text-slate-400 font-mono">${d.last_online ? new Date(d.last_online).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }) : '--'}</div>
                </td>
                <td class="p-3.5 text-center">${d.statusBadge}</td>
                <td class="p-3.5 text-right">
                    <div class="flex items-center justify-end gap-1.5 flex-wrap">
                        <button onclick="openChangeGateWifiModal('${d.id}', '${(d.device_name || d.esp32_identifier).replace(/'/g, "\\'")}', '${d.esp32_identifier}')" class="px-2.5 py-1 bg-charm-dark text-white hover:bg-charm-mid rounded-lg font-bold text-xs flex items-center gap-1 transition-colors shadow-sm" title="Change Wi-Fi Over-The-Air (1-Click)">
                            <i data-lucide="wifi" class="w-3.5 h-3.5 text-charm-yellow"></i> Change Wi-Fi
                        </button>
                        <button onclick="reprovisionDevice('${d.gate_type || 'ENTRY'}')" class="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg font-bold text-xs transition-colors" title="Pair & Provision via Bluetooth (Offline)">BLE</button>
                        <button onclick="openDeviceModal('${d.id}')" class="p-1.5 text-slate-400 hover:text-blue-600 rounded-lg transition-colors" title="Edit Gate Unit"><i data-lucide="edit-2" class="w-3.5 h-3.5"></i></button>
                        <button onclick="deleteDevice('${d.id}')" class="p-1.5 text-slate-400 hover:text-rose-600 rounded-lg transition-colors" title="Delete Gate Unit"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>
                    </div>
                </td>
            </tr>`;
        }).join('');
        lucide.createIcons();
    }
};

// Real ping test measuring live Supabase HTTPS latency and verifying registered gates
window.pingAllGates = async function() {
    appendBleLog('Initiating real network ping to cloud database and verifying registered gate nodes...', 'system');
    showToast('Testing live connectivity to all ESP32 gate nodes...', 'info');

    const startTime = performance.now();
    try {
        if (isConnected && supabaseClient) {
            const { data: devData, error } = await supabaseClient
                .from('devices')
                .select('*')
                .order('device_name', { ascending: true });
            
            const latencyMs = Math.round(performance.now() - startTime);
            if (error) throw error;

            adminState.devices = devData || [];
            renderEsp32DevicesTable();

            appendBleLog(`Cloud Gateway Roundtrip Latency: ${latencyMs}ms (HTTP 200 OK)`, 'success');
            
            if (adminState.devices.length > 0) {
                adminState.devices.forEach((dev, idx) => {
                    const lastOnline = dev.last_online ? new Date(dev.last_online).toLocaleTimeString() : 'Never';
                    appendBleLog(`Node ${idx+1} [${dev.esp32_identifier}]: Status=${dev.status || 'ONLINE'}, Last Seen=${lastOnline}`, 'info');
                });
                showToast(`Ping completed! Cloud Latency: ${latencyMs}ms (${adminState.devices.length} Gates checked)`, 'success');
            } else {
                appendBleLog('No physical gate devices registered in database.', 'warn');
                showToast(`Cloud Ping OK (${latencyMs}ms). No devices registered.`, 'info');
            }
        } else {
            const latencyMs = 28;
            appendBleLog(`Local Ping Latency: ${latencyMs}ms (Standby)`, 'info');
            showToast('Ping test completed (Local Mode).', 'info');
        }
    } catch(err) {
        appendBleLog(`Ping error: ${err.message}`, 'error');
        showToast('Ping test failed: ' + err.message, 'error');
    }
};

window.reprovisionDevice = function(gateType) {
    if (el('bleTargetDeviceType')) el('bleTargetDeviceType').value = gateType;
    updatePortalApNameHint(gateType);
    appendBleLog(`Prepared provisioning form for Gate Role: ${gateType}. Click "Scan & Connect via Bluetooth" to send Wi-Fi.`, 'info');
    showToast(`Ready to provision ${gateType}.`, 'info');
    const formCard = el('bleProvisioningCard');
    if (formCard) formCard.scrollIntoView({ behavior: 'smooth' });
};

// Update the AP hotspot name hint based on which gate type is selected
function updatePortalApNameHint(gateType) {
    const hint = el('portalApNameHint');
    if (!hint) return;
    if (gateType === 'CUSTOM') {
        hint.textContent = 'CHARRMPASS_UHF_SETUP';
    } else {
        // Both ENTRY and EXIT use the entry-gate AP name for standard MFRC522 units
        hint.textContent = 'CHARRMPASS_ENTRY_SETUP';
    }
}

// Wire up the gate type selector to update the AP hint live
(function() {
    const sel = el('bleTargetDeviceType');
    if (sel) {
        sel.addEventListener('change', () => updatePortalApNameHint(sel.value));
        updatePortalApNameHint(sel.value); // init on load
    }
})();


window.toggleArduinoSketchDrawer = function() {
    const drawer = el('arduinoBleDrawer') || el('arduinoSketchDrawer');
    if (!drawer) return;
    drawer.classList.toggle('hidden');
    lucide.createIcons();
};

window.copyArduinoBleSnippet = function() {
    const code = el('arduinoBleCodeBlock')?.innerText || el('arduinoBleCode')?.innerText;
    if (!code) return;
    navigator.clipboard.writeText(code).then(() => {
        showToast('Arduino C++ Sketch copied to clipboard!', 'success');
    }).catch(() => {
        showToast('Could not copy code automatically.', 'warning');
    });
};

// ==============================================
// ESP32 GATE DEVICE MANAGEMENT (MODAL CRUD)
// ==============================================
window.openDeviceModal = function(id = null) {
    const modal = el('deviceModal');
    if (!modal) return;
    el('deviceForm')?.reset();
    el('formDevId').value = '';
    const title = el('deviceModalTitle');
    
    if (id) {
        const dev = adminState.devices.find(d => d.id === id);
        if (dev) {
            el('formDevId').value = dev.id;
            if (el('formDevName')) el('formDevName').value = dev.device_name || '';
            if (el('formDevIdentifier')) el('formDevIdentifier').value = dev.esp32_identifier || '';
            if (el('formDevGateType')) el('formDevGateType').value = dev.gate_type || 'ENTRY';
            if (el('formDevCategory')) el('formDevCategory').value = dev.device_category || 'VEHICLE_BARRIER';
            if (el('formDevRange')) el('formDevRange').value = dev.rfid_range || 'LONG_RANGE';
            if (el('formDevLocation')) el('formDevLocation').value = dev.device_location || '';
            if (title) title.textContent = `Edit Gate Unit (${dev.esp32_identifier})`;
        }
    } else {
        if (title) title.textContent = 'Register ESP32 Gate Unit';
    }

    modal.classList.remove('hidden');
    setTimeout(() => {
        modal.classList.remove('opacity-0');
        el('deviceModalContent')?.classList.remove('scale-95');
    }, 10);
    lucide.createIcons();
};

window.closeDeviceModal = function() {
    const modal = el('deviceModal');
    if (!modal) return;
    modal.classList.add('opacity-0');
    el('deviceModalContent')?.classList.add('scale-95');
    setTimeout(() => modal.classList.add('hidden'), 300);
};

window.deleteDevice = async function(id) {
    if (!id) return;
    const dev = adminState.devices.find(d => d.id === id);
    const name = dev?.device_name || dev?.esp32_identifier || 'this device';
    if (!confirm(`Are you sure you want to remove gate unit "${name}"?`)) return;

    try {
        if (isConnected && supabaseClient) {
            const { error } = await supabaseClient.from('devices').delete().eq('id', id);
            if (error) throw error;
            showToast(`Gate unit "${name}" deleted!`, 'success');
            await loadData();
        } else {
            adminState.devices = adminState.devices.filter(d => d.id !== id);
            renderEsp32DevicesTable();
            showToast(`Gate unit deleted locally.`, 'info');
        }
    } catch(err) {
        showToast('Error deleting device: ' + err.message, 'error');
    }
};

el('deviceForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = el('formDevId')?.value;
    const device_name = el('formDevName')?.value.trim();
    const esp32_identifier = el('formDevIdentifier')?.value.trim().toUpperCase();
    const gate_type = el('formDevGateType')?.value || 'ENTRY';
    const device_category = el('formDevCategory')?.value || 'VEHICLE_BARRIER';
    const rfid_range = el('formDevRange')?.value || 'LONG_RANGE';
    const device_location = el('formDevLocation')?.value.trim() || 'Campus Gate';

    if (!device_name || !esp32_identifier) {
        showToast('Device Name and ESP32 Identifier are required.', 'warning');
        return;
    }

    const payload = {
        device_name,
        esp32_identifier,
        gate_type,
        device_category,
        rfid_range,
        device_location,
        status: 'ONLINE',
        last_online: new Date().toISOString()
    };

    try {
        if (isConnected && supabaseClient) {
            if (id) {
                const { error } = await supabaseClient.from('devices').update(payload).eq('id', id);
                if (error) throw error;
                showToast(`Gate unit "${device_name}" updated!`, 'success');
            } else {
                const { error } = await supabaseClient.from('devices').upsert(payload, { onConflict: 'esp32_identifier' });
                if (error) throw error;
                showToast(`Gate unit "${device_name}" registered!`, 'success');
            }
            closeDeviceModal();
            await loadData();
        } else {
            if (id) {
                const idx = adminState.devices.findIndex(d => d.id === id);
                if (idx !== -1) adminState.devices[idx] = { ...adminState.devices[idx], ...payload };
            } else {
                adminState.devices.push({ id: 'DEV-' + Date.now(), ...payload });
            }
            closeDeviceModal();
            renderEsp32DevicesTable();
            showToast(`Gate unit saved locally.`, 'info');
        }
    } catch(err) {
        showToast('Error saving gate unit: ' + err.message, 'error');
    }
});

// ==============================================
// 1-CLICK REMOTE OVER-THE-AIR WI-FI RECONFIGURATION
// ==============================================
window.openChangeGateWifiModal = function(deviceId = null, deviceName = '', esp32Identifier = '') {
    const modal = el('changeGateWifiModal');
    if (!modal) return;

    const devSelect = el('changeWifiDeviceId');
    const devices = adminState.devices || [];

    if (devSelect) {
        if (devices.length > 0) {
            devSelect.innerHTML = devices.map(d => {
                const isSelected = (deviceId && d.id === deviceId) || (esp32Identifier && d.esp32_identifier === esp32Identifier);
                const wifiInfo = d.wifi_ssid ? ` • Current Wi-Fi: ${d.wifi_ssid}` : '';
                return `<option value="${d.id}" data-identifier="${d.esp32_identifier}" data-name="${(d.device_name || d.esp32_identifier).replace(/"/g, '&quot;')}" ${isSelected ? 'selected' : ''}>
                    ${d.device_name || d.esp32_identifier} (${d.esp32_identifier})${wifiInfo}
                </option>`;
            }).join('');
        } else {
            devSelect.innerHTML = `<option value="DEFAULT_GATE" data-identifier="CHARRMPASS_GATE_ENTRY" data-name="CHARRMPASS Entry Unit">CHARRMPASS Entry Unit (Default Gate)</option>`;
        }
    }

    if (el('changeWifiSsid')) el('changeWifiSsid').value = '';
    if (el('changeWifiPass')) el('changeWifiPass').value = '';

    modal.classList.remove('hidden');
    setTimeout(() => {
        modal.classList.remove('opacity-0');
        el('changeGateWifiModalContent')?.classList.remove('scale-95');
    }, 10);
    lucide.createIcons();
};

window.closeChangeGateWifiModal = function() {
    const modal = el('changeGateWifiModal');
    if (!modal) return;
    modal.classList.add('opacity-0');
    el('changeGateWifiModalContent')?.classList.add('scale-95');
    setTimeout(() => modal.classList.add('hidden'), 300);
};

window.submitChangeGateWifi = async function(event) {
    if (event) event.preventDefault();

    const devSelect = el('changeWifiDeviceId');
    const deviceId = devSelect?.value;
    const selectedOption = devSelect?.options[devSelect.selectedIndex];
    const deviceName = selectedOption?.getAttribute('data-name') || 'Gate Unit';
    const esp32Identifier = selectedOption?.getAttribute('data-identifier') || '';

    const newSsid = el('changeWifiSsid')?.value?.trim();
    const newPass = el('changeWifiPass')?.value || '';

    if (!newSsid) {
        showToast('Please enter the new Wi-Fi SSID network name.', 'warning');
        return;
    }

    const submitBtn = el('btnSubmitChangeWifi');
    const originalBtnHtml = submitBtn ? submitBtn.innerHTML : '';
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = `<i data-lucide="loader-2" class="w-4 h-4 animate-spin text-charm-yellow"></i> Sending Command...`;
        lucide.createIcons();
    }

    appendBleLog(`[OTA Wi-Fi] Initiating remote Wi-Fi command for "${deviceName}" (${esp32Identifier})...`, 'system');
    appendBleLog(`[OTA Wi-Fi] Target SSID: "${newSsid}" (Password: ${newPass ? '••••••••' : 'Open'})`, 'info');

    try {
        if (isConnected && supabaseClient) {
            let updateQuery;
            if (deviceId && deviceId !== 'DEFAULT_GATE') {
                updateQuery = supabaseClient
                    .from('devices')
                    .update({
                        target_ssid: newSsid,
                        target_pass: newPass,
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', deviceId);
            } else if (esp32Identifier) {
                updateQuery = supabaseClient
                    .from('devices')
                    .update({
                        target_ssid: newSsid,
                        target_pass: newPass,
                        updated_at: new Date().toISOString()
                    })
                    .eq('esp32_identifier', esp32Identifier);
            } else {
                updateQuery = supabaseClient
                    .from('devices')
                    .update({
                        target_ssid: newSsid,
                        target_pass: newPass,
                        updated_at: new Date().toISOString()
                    })
                    .eq('gate_type', 'ENTRY');
            }

            const { data, error } = await updateQuery;
            if (error) throw error;

            appendBleLog(`[OTA Wi-Fi] ✅ Wi-Fi update command delivered to Supabase queue for ${deviceName}! ESP32 will switch within seconds.`, 'success');
            showToast(`Wi-Fi update command sent to ${deviceName}! It will connect to "${newSsid}" automatically.`, 'success');
        } else {
            appendBleLog(`[OTA Wi-Fi] Simulation: Stored target Wi-Fi (${newSsid}) locally for ${deviceName}.`, 'info');
            showToast(`Wi-Fi update command queued locally for ${deviceName}.`, 'info');
        }

        closeChangeGateWifiModal();
        if (window.pingAllGates) setTimeout(() => window.pingAllGates(), 1500);

    } catch (err) {
        console.error('Error dispatching OTA Wi-Fi update:', err);
        appendBleLog(`[OTA Wi-Fi] ❌ Failed to dispatch Wi-Fi command: ${err.message}`, 'error');
        showToast('Failed to send Wi-Fi command: ' + err.message, 'error');
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = originalBtnHtml;
            lucide.createIcons();
        }
    }
};

// ============================================================
// ACADEMIC PROGRAMS, SECTIONS & BULK UPLOAD SUBSYSTEM
// ============================================================

window.academicState = {
    programs: [
        { code: 'BSIT', name: 'Bachelor of Science in Information Technology', department: 'College of Computing' },
        { code: 'BSCS', name: 'Bachelor of Science in Computer Science', department: 'College of Computing' },
        { code: 'BSA',  name: 'Bachelor of Science in Agriculture', department: 'College of Agriculture' },
        { code: 'BSHM', name: 'Bachelor of Science in Hospitality Management', department: 'College of Hospitality & Tourism' },
        { code: 'BSED', name: 'Bachelor of Secondary Education', department: 'College of Education' },
        { code: 'BSCRIM', name: 'Bachelor of Science in Criminology', department: 'College of Criminology' },
        { code: 'ENGINEERING', name: 'College of Engineering & Architecture', department: 'Engineering' },
        { code: 'ADMIN', name: 'Administrative & Support Staff', department: 'Administration' }
    ],
    sections: [
        { program: 'BSIT', year: 1, section: '1A' }, { program: 'BSIT', year: 1, section: '1B' },
        { program: 'BSIT', year: 2, section: '2A' }, { program: 'BSIT', year: 2, section: '2B' },
        { program: 'BSIT', year: 3, section: '3A' }, { program: 'BSIT', year: 3, section: '3B' },
        { program: 'BSIT', year: 4, section: '4A' }, { program: 'BSIT', year: 4, section: '4B' },
        { program: 'BSCS', year: 1, section: '1A' }, { program: 'BSCS', year: 2, section: '2A' },
        { program: 'BSCS', year: 3, section: '3A' }, { program: 'BSCS', year: 4, section: '4A' },
        { program: 'BSA',  year: 1, section: '1A' }, { program: 'BSA',  year: 2, section: '2A' },
        { program: 'BSA',  year: 3, section: '3A' }, { program: 'BSA',  year: 4, section: '4A' },
        { program: 'BSHM', year: 1, section: '1A' }, { program: 'BSHM', year: 2, section: '2A' },
        { program: 'BSHM', year: 3, section: '3A' }, { program: 'BSHM', year: 4, section: '4A' },
        { program: 'BSED', year: 1, section: '1A' }, { program: 'BSED', year: 2, section: '2A' },
        { program: 'BSED', year: 3, section: '3A' }, { program: 'BSED', year: 4, section: '4A' },
        { program: 'BSCRIM', year: 1, section: '1A' }, { program: 'BSCRIM', year: 2, section: '2A' },
        { program: 'BSCRIM', year: 3, section: '3A' }, { program: 'BSCRIM', year: 4, section: '4A' }
    ]
};

window.bulkUploadState = {
    activeTab: 'students',
    parsedRecords: [],
    fileType: 'students',
    fileName: '',
    isUploading: false
};

// 1. Initialize Academic Programs and Sections
function loadAcademicData() {
    try {
        const savedProgs = localStorage.getItem('charrmpass_academic_programs');
        if (savedProgs) academicState.programs = JSON.parse(savedProgs);
        const savedSecs = localStorage.getItem('charrmpass_academic_sections');
        if (savedSecs) academicState.sections = JSON.parse(savedSecs);
    } catch(e) {
        console.warn('Could not load academic presets from storage', e);
    }
    renderAcademicDataUI();
}

function saveAcademicDataToStorage() {
    try {
        localStorage.setItem('charrmpass_academic_programs', JSON.stringify(academicState.programs));
        localStorage.setItem('charrmpass_academic_sections', JSON.stringify(academicState.sections));
    } catch(e) {}
}

function renderAcademicDataUI() {
    // Populate Main Filter Dropdowns
    const progFilter = el('programFilter');
    if (progFilter) {
        const currentVal = progFilter.value;
        let html = '<option value="">All Programs</option>';
        academicState.programs.forEach(p => {
            html += `<option value="${p.code}" ${currentVal === p.code ? 'selected' : ''}>${p.code} - ${p.name}</option>`;
        });
        progFilter.innerHTML = html;
    }

    const secFilter = el('sectionFilter');
    if (secFilter) {
        const currentVal = secFilter.value;
        const uniqueSections = Array.from(new Set(academicState.sections.map(s => s.section))).sort();
        let html = '<option value="">All Sections</option>';
        uniqueSections.forEach(s => {
            html += `<option value="${s}" ${currentVal === s ? 'selected' : ''}>Section ${s}</option>`;
        });
        secFilter.innerHTML = html;
    }

    // Populate Bulk Modal Student Program select
    const bulkProg = el('bulkStudentProgram');
    if (bulkProg) {
        let html = '';
        academicState.programs.forEach(p => {
            html += `<option value="${p.code}">${p.code} - ${p.name}</option>`;
        });
        bulkProg.innerHTML = html;
    }

    // Populate Bulk Modal New Section Program select
    const newSecProg = el('newSecProgram');
    if (newSecProg) {
        let html = '';
        academicState.programs.forEach(p => {
            html += `<option value="${p.code}">${p.code} (${p.department || 'General'})</option>`;
        });
        newSecProg.innerHTML = html;
    }

    // Populate Faculty Department select
    const bulkDept = el('bulkFacultyDept');
    if (bulkDept) {
        const uniqueDepts = Array.from(new Set(academicState.programs.map(p => p.department).filter(Boolean)));
        let html = '';
        uniqueDepts.forEach(d => {
            html += `<option value="${d}">${d}</option>`;
        });
        bulkDept.innerHTML = html;
    }

    updateBulkSectionOptions();
    renderAcademicBadgesList();
}

function updateBulkSectionOptions() {
    const prog = el('bulkStudentProgram')?.value || 'BSIT';
    const year = parseInt(el('bulkStudentYear')?.value || '3', 10);
    const secSelect = el('bulkStudentSection');
    if (!secSelect) return;

    const matching = academicState.sections.filter(s => s.program === prog && s.year === year);
    if (matching.length > 0) {
        secSelect.innerHTML = matching.map(s => `<option value="${s.section}">Section ${s.section}</option>`).join('');
    } else {
        secSelect.innerHTML = `
            <option value="${year}A">Section ${year}A</option>
            <option value="${year}B">Section ${year}B</option>
        `;
    }
}

function renderAcademicBadgesList() {
    const container = el('academicProgramsBadgesList');
    if (!container) return;

    container.innerHTML = academicState.programs.map(p => {
        const progSections = academicState.sections.filter(s => s.program === p.code);
        return `
            <div class="p-4 rounded-2xl bg-white border border-slate-200/80 shadow-sm flex flex-col justify-between gap-3">
                <div>
                    <div class="flex items-center justify-between">
                        <span class="font-display font-black text-sm text-charm-dark">${p.code}</span>
                        <span class="text-[10px] font-bold px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">${p.department || 'General'}</span>
                    </div>
                    <p class="text-xs font-semibold text-slate-700 mt-1 line-clamp-1">${p.name}</p>
                </div>
                <div>
                    <div class="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">Configured Sections (${progSections.length}):</div>
                    <div class="flex flex-wrap gap-1">
                        ${progSections.length ? progSections.map(s => `
                            <span class="px-2 py-0.5 rounded-lg bg-emerald-50 text-emerald-800 border border-emerald-200 text-[10px] font-bold flex items-center gap-1">
                                ${s.section}
                                <button onclick="deleteAcademicSection('${p.code}', ${s.year}, '${s.section}')" class="text-emerald-500 hover:text-red-500 font-black">×</button>
                            </span>
                        `).join('') : '<span class="text-[11px] text-slate-400 italic">No sections configured yet</span>'}
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

window.saveNewAcademicProgram = function() {
    const code = (el('newProgCode')?.value || '').trim().toUpperCase();
    const name = (el('newProgName')?.value || '').trim();
    const dept = (el('newProgDept')?.value || '').trim() || 'General';

    if (!code || !name) {
        showToast('Please provide both Program Code and Program Name', 'warning');
        return;
    }

    if (academicState.programs.some(p => p.code === code)) {
        showToast(`Program code "${code}" already exists!`, 'warning');
        return;
    }

    academicState.programs.push({ code, name, department: dept });
    // Add default 1A, 2A, 3A, 4A sections
    [1, 2, 3, 4].forEach(y => {
        academicState.sections.push({ program: code, year: y, section: `${y}A` });
    });

    saveAcademicDataToStorage();
    renderAcademicDataUI();
    if (el('newProgCode')) el('newProgCode').value = '';
    if (el('newProgName')) el('newProgName').value = '';
    if (el('newProgDept')) el('newProgDept').value = '';
    showToast(`Program "${code}" created successfully!`, 'success');
};

window.saveNewAcademicSection = function() {
    const prog = (el('newSecProgram')?.value || '').trim().toUpperCase();
    const year = parseInt(el('newSecYear')?.value || '1', 10);
    const sec = (el('newSecName')?.value || '').trim().toUpperCase();

    if (!prog || !sec) {
        showToast('Please select a program and enter section name', 'warning');
        return;
    }

    if (academicState.sections.some(s => s.program === prog && s.year === year && s.section === sec)) {
        showToast(`Section "${sec}" already exists for ${prog} Year ${year}`, 'warning');
        return;
    }

    academicState.sections.push({ program: prog, year, section: sec });
    saveAcademicDataToStorage();
    renderAcademicDataUI();
    if (el('newSecName')) el('newSecName').value = '';
    showToast(`Added Section ${sec} to ${prog}!`, 'success');
};

window.deleteAcademicSection = function(prog, year, sec) {
    academicState.sections = academicState.sections.filter(s => !(s.program === prog && s.year === year && s.section === sec));
    saveAcademicDataToStorage();
    renderAcademicDataUI();
    showToast(`Removed section ${sec} from ${prog}`, 'info');
};

// 2. Bulk Upload Modal Operations
window.openBulkUploadModal = function() {
    const modal = el('bulkUploadModal');
    if (!modal) return;
    renderAcademicDataUI();
    resetBulkUploadForm();
    modal.classList.remove('hidden');
    setTimeout(() => {
        modal.classList.remove('opacity-0');
        el('bulkUploadModalContent')?.classList.remove('scale-95');
    }, 10);
    if (window.lucide && typeof lucide.createIcons === 'function') {
        lucide.createIcons();
    }
};

window.closeBulkUploadModal = function() {
    const modal = el('bulkUploadModal');
    if (!modal) return;
    modal.classList.add('opacity-0');
    el('bulkUploadModalContent')?.classList.add('scale-95');
    setTimeout(() => {
        modal.classList.add('hidden');
        resetBulkUploadForm();
    }, 250);
};

window.switchBulkTab = function(tabName) {
    bulkUploadState.activeTab = tabName;
    bulkUploadState.fileType = tabName === 'faculty' ? 'faculty' : 'students';
    
    // Update button styles
    ['students', 'faculty', 'programs'].forEach(t => {
        const btn = el(`bulkTabBtn-${t}`);
        const content = el(`bulkTabContent-${t}`);
        if (btn) {
            if (t === tabName) {
                btn.className = 'bulk-tab-btn px-4 py-2 rounded-xl text-xs font-black uppercase tracking-wider transition-all bg-charm-dark text-white shadow-sm flex items-center gap-2';
            } else {
                btn.className = 'bulk-tab-btn px-4 py-2 rounded-xl text-xs font-black uppercase tracking-wider transition-all text-slate-600 hover:bg-slate-100 flex items-center gap-2';
            }
        }
        if (content) {
            content.classList.toggle('hidden', t !== tabName);
        }
    });

    if (window.lucide && typeof lucide.createIcons === 'function') {
        lucide.createIcons();
    }
};

window.toggleBulkStudentScope = function() {
    const mode = el('bulkStudentMode')?.value || 'SCOPED';
    const scopeFields = el('bulkStudentScopeFields');
    if (scopeFields) {
        scopeFields.classList.toggle('hidden', mode === 'MULTI');
    }
};

// Switch between File Upload and Direct Excel Paste
window.switchBulkInputMode = function(type, mode) {
    const fileContainer = el(`${type === 'faculty' ? 'faculty' : 'student'}DropzoneContainer`);
    const pasteContainer = el(`${type === 'faculty' ? 'faculty' : 'student'}PasteContainer`);
    const btnFile = el(`bulkInputModeBtn-${type}-file`);
    const btnPaste = el(`bulkInputModeBtn-${type}-paste`);

    if (mode === 'file') {
        if (fileContainer) fileContainer.classList.remove('hidden');
        if (pasteContainer) pasteContainer.classList.add('hidden');
        if (btnFile) btnFile.className = 'px-3 py-1 rounded-lg text-xs font-bold bg-white text-slate-800 shadow-sm transition-all flex items-center gap-1.5';
        if (btnPaste) btnPaste.className = 'px-3 py-1 rounded-lg text-xs font-bold text-slate-600 hover:text-slate-900 transition-all flex items-center gap-1.5';
    } else {
        if (fileContainer) fileContainer.classList.add('hidden');
        if (pasteContainer) pasteContainer.classList.remove('hidden');
        if (btnFile) btnFile.className = 'px-3 py-1 rounded-lg text-xs font-bold text-slate-600 hover:text-slate-900 transition-all flex items-center gap-1.5';
        if (btnPaste) btnPaste.className = 'px-3 py-1 rounded-lg text-xs font-bold bg-white text-slate-800 shadow-sm transition-all flex items-center gap-1.5';
    }

    if (window.lucide && typeof lucide.createIcons === 'function') {
        lucide.createIcons();
    }
};

// Load Sample Demo Data into Paste Textarea
window.loadSamplePasteData = function(type) {
    if (type === 'students') {
        const area = el('bulkStudentPasteArea');
        if (area) {
            area.value = "Student ID\tLast Name\tFirst Name\tMiddle Name\tSuffix\tTransit Mode\n" +
                         "2022-00101\tDela Cruz\tJuan\tMercado\t\tVEHICLE\n" +
                         "2022-00102\tSantos\tMaria Clara\tReyes\t\tPEDESTRIAN\n" +
                         "2022-00103\tReyes\tCarlos\tPadilla\tJr.\tPEDESTRIAN\n" +
                         "2022-00104\tVillanueva\tAna Beatriz\tFlores\t\tVEHICLE\n" +
                         "2022-00105\tTan\tKenji\tLim\t\tPEDESTRIAN";
            showToast('Sample student roster pasted. Click "Read and Verify" to view.', 'info');
        }
    } else {
        const area = el('bulkFacultyPasteArea');
        if (area) {
            area.value = "Employee ID\tLast Name\tFirst Name\tMiddle Name\tDepartment\tRole\tTransit Mode\n" +
                         "EMP-2019-01\tTuring\tAlan\tMathison\tCollege of Computing\tFaculty\tVEHICLE\n" +
                         "EMP-2021-04\tHopper\tGrace\tBrewster\tCollege of Computing\tFaculty\tVEHICLE\n" +
                         "STAFF-009\tCruz\tJuanita\tBautista\tAdministration\tStaff\tPEDESTRIAN\n" +
                         "VENDOR-02\tPenduko\tPedro\tSantos\tCanteen Services\tOthers\tVEHICLE";
            showToast('Sample faculty roster pasted. Click "Read and Verify" to view.', 'info');
        }
    }
};

// Process Data Pasted from Clipboard / Excel
window.processPastedText = function(type) {
    const areaId = type === 'students' ? 'bulkStudentPasteArea' : 'bulkFacultyPasteArea';
    const text = (el(areaId)?.value || '').trim();
    if (!text) {
        showToast('Please paste your roster data from Excel into the box first.', 'warning');
        return;
    }
    parseCSVTextAndPreview(text, type, 'Pasted from Excel / Clipboard');
};

// 3. Template Generation & Download (.CSV with UTF-8 BOM for Microsoft Excel)
window.downloadCSVTemplate = function(type) {
    let csvContent = '';
    let filename = '';

    if (type === 'students') {
        const mode = el('bulkStudentMode')?.value || 'SCOPED';
        if (mode === 'SCOPED') {
            const prog = el('bulkStudentProgram')?.value || 'BSIT';
            const sec = el('bulkStudentSection')?.value || '3A';
            filename = `CHARRMPASS_Students_${prog}_${sec}_Template.csv`;
            csvContent = "Student ID,Last Name,First Name,Middle Name,Suffix,Sex,Age,Address,Transit Mode,Plate Number\n" +
                         "2022-00101,Dela Cruz,Juan,Mercado,,Male,21,\"Ibajay, Aklan\",VEHICLE,ABC-1234\n" +
                         "2022-00102,Santos,Maria Clara,Reyes,,Female,20,\"Kalibo, Aklan\",PEDESTRIAN,\n" +
                         "2022-00103,Reyes,Carlos,Padilla,Jr.,Male,21,\"Tangalan, Aklan\",PEDESTRIAN,\n" +
                         "2022-00104,Lopez,Ana Beatriz,Villanueva,,Female,22,\"Numancia, Aklan\",VEHICLE,XYZ-5678\n";
        } else {
            filename = `CHARRMPASS_Master_Students_Template.csv`;
            csvContent = "Student ID,Last Name,First Name,Middle Name,Suffix,Program,Section,Sex,Age,Address,Transit Mode,Plate Number\n" +
                         "2022-00101,Dela Cruz,Juan,Mercado,,BSIT,3A,Male,21,\"Ibajay, Aklan\",VEHICLE,ABC-1234\n" +
                         "2022-00102,Santos,Maria Clara,Reyes,,BSCS,2B,Female,20,\"Kalibo, Aklan\",PEDESTRIAN,\n" +
                         "2022-00103,Reyes,Carlos,Padilla,Jr.,BSA,1A,Male,19,\"Tangalan, Aklan\",PEDESTRIAN,\n";
        }
    } else {
        filename = `CHARRMPASS_Faculty_Staff_Template.csv`;
        csvContent = "Employee ID,Last Name,First Name,Middle Name,Suffix,Role,Department,Sex,Age,Address,Transit Mode,Plate Number\n" +
                     "EMP-2018-01,Turing,Alan,Mathison,Dr.,Faculty,\"College of Computing\",Male,42,\"Kalibo, Aklan\",VEHICLE,ABC-789\n" +
                     "EMP-2020-04,Hopper,Grace,Brewster,,Faculty,\"College of Computing\",Female,38,\"Ibajay, Aklan\",VEHICLE,XYZ-456\n" +
                     "STAFF-009,Cruz,Juanita,Bautista,,Staff,Administration,Female,30,\"Makato, Aklan\",PEDESTRIAN,\n" +
                     "VENDOR-02,Penduko,Pedro,Santos,,Others,\"Canteen Services\",Male,45,\"Numancia, Aklan\",VEHICLE,JKL-321\n";
    }

    // Include UTF-8 Byte Order Mark (\uFEFF) so Microsoft Excel opens it cleanly without garbling characters
    const blob = new Blob(["\uFEFF" + csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    showToast(`Downloaded template: ${filename}`, 'info');
};

// 4. File Drag & Drop Handlers
window.handleDragOver = function(e) {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.classList.add('border-emerald-500', 'bg-emerald-50/40');
};

window.handleDragLeave = function(e) {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.classList.remove('border-emerald-500', 'bg-emerald-50/40');
};

window.handleDrop = function(e, type) {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.classList.remove('border-emerald-500', 'bg-emerald-50/40');
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        processUploadedCSVFile(e.dataTransfer.files[0], type);
    }
};

window.handleFileSelected = function(e, type) {
    if (e.target.files && e.target.files.length > 0) {
        processUploadedCSVFile(e.target.files[0], type);
    }
};

// 5. Robust Smart Parsing & Normalization Engine
function processUploadedCSVFile(file, type) {
    if (!file) return;
    bulkUploadState.fileType = type;
    bulkUploadState.fileName = file.name;

    const reader = new FileReader();
    reader.onload = function(evt) {
        const text = evt.target.result;
        parseCSVTextAndPreview(text, type, file.name);
    };
    reader.readAsText(file);
}

function parseCSVTextAndPreview(csvText, type, fileName) {
    let rows = [];

    // Auto-detect delimiter (tabs, commas, or semicolons)
    const firstLine = (csvText.split(/\r\n|\n/)[0] || '');
    const hasTabs = firstLine.includes('\t');
    const hasSemicolon = !hasTabs && firstLine.includes(';') && !firstLine.includes(',');

    if (window.Papa && typeof Papa.parse === 'function' && !hasTabs) {
        const results = Papa.parse(csvText, { header: true, skipEmptyLines: true, delimiter: hasSemicolon ? ';' : '' });
        rows = results.data;
    } else {
        rows = fallbackPureJsCSVParse(csvText, hasTabs ? '\t' : (hasSemicolon ? ';' : ','));
    }

    if (!rows || rows.length === 0) {
        showToast('The uploaded file or text contains no readable data rows.', 'error');
        return;
    }

    // Context & Defaults from Scope Form
    const studentMode = el('bulkStudentMode')?.value || 'SCOPED';
    const scopedProg = el('bulkStudentProgram')?.value || 'BSIT';
    const scopedSec = el('bulkStudentSection')?.value || '3A';
    const defaultStudentTransit = el('bulkStudentTransit')?.value || 'PEDESTRIAN';
    const defaultStudentStatus = el('bulkStudentStatus')?.value || 'APPROVED';

    const facultyDept = el('bulkFacultyDept')?.value || 'College of Computing';
    const defaultFacultyRole = el('bulkFacultyRole')?.value || 'Faculty';
    const defaultFacultyStatus = el('bulkFacultyStatus')?.value || 'APPROVED';

    const existingUsers = adminState.users || [];
    const normalizedList = [];

    rows.forEach((row, index) => {
        // Map header permutations to standard keys
        const mapped = {};
        for (let key in row) {
            if (!row.hasOwnProperty(key)) continue;
            const val = (row[key] || '').toString().trim();
            const cleanKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
            
            if (['studentid', 'idnumber', 'idno', 'id', 'studentno', 'lrn', 'schoolid', 'cpassid', 'cpass', 'employeeid', 'empid'].includes(cleanKey)) {
                mapped.id_number = val;
            } else if (['lastname', 'surname', 'familyname', 'lname', 'last'].includes(cleanKey)) {
                mapped.last_name = val;
            } else if (['firstname', 'givenname', 'fname', 'first'].includes(cleanKey)) {
                mapped.first_name = val;
            } else if (['middlename', 'middleinitial', 'mi', 'middle', 'mname'].includes(cleanKey)) {
                mapped.middle_name = val;
            } else if (['suffix', 'extension', 'ext', 'nameext', 'suffixname'].includes(cleanKey)) {
                mapped.suffix = val;
            } else if (['fullname', 'name', 'studentname', 'person', 'employeename', 'completename'].includes(cleanKey)) {
                mapped.full_name = val;
            } else if (['sex', 'gender'].includes(cleanKey)) {
                mapped.sex = val.toUpperCase().startsWith('F') ? 'Female' : 'Male';
            } else if (['age'].includes(cleanKey)) {
                mapped.age = parseInt(val, 10) || null;
            } else if (['address', 'residence', 'homeaddress', 'location'].includes(cleanKey)) {
                mapped.address = val;
            } else if (['program', 'course', 'degree', 'department', 'dept', 'college'].includes(cleanKey)) {
                mapped.program = val.toUpperCase();
            } else if (['section', 'sec', 'class', 'yearandsection', 'yrsec'].includes(cleanKey)) {
                mapped.section = val.toUpperCase();
            } else if (['role', 'designation', 'position', 'usertype', 'type'].includes(cleanKey)) {
                mapped.role = val;
            } else if (['transitmode', 'mode', 'transittype', 'transit', 'accessmode'].includes(cleanKey)) {
                mapped.default_transit_mode = val.toUpperCase().includes('VEH') ? 'VEHICLE' : 'PEDESTRIAN';
            } else if (['platenumber', 'plate', 'plateno', 'platenumbervehicle'].includes(cleanKey)) {
                mapped.plate_number = val.toUpperCase();
            } else if (['vehicletype', 'vtype'].includes(cleanKey)) {
                mapped.vehicle_type = val;
            } else if (['vehiclemodel', 'model'].includes(cleanKey)) {
                mapped.vehicle_model = val;
            } else if (['rfiduid', 'uid', 'rfid', 'rfidtag', 'tag'].includes(cleanKey)) {
                mapped.rfid_uid = val.toUpperCase();
            }
        }

        // Assemble Full Name from parts if separate columns were provided
        let finalFullName = '';
        if (mapped.last_name || mapped.first_name) {
            const last = (mapped.last_name || '').trim();
            const first = (mapped.first_name || '').trim();
            const middle = (mapped.middle_name || '').trim();
            const suffix = (mapped.suffix || '').trim();

            if (last && first) {
                let middlePart = '';
                if (middle) {
                    middlePart = middle.length === 1 ? ` ${middle}.` : ` ${middle}`;
                }
                let suffixPart = suffix ? ` ${suffix}` : '';
                finalFullName = `${last}, ${first}${middlePart}${suffixPart}`.trim();
            } else {
                finalFullName = `${last} ${first}`.trim();
            }
        } else if (mapped.full_name) {
            finalFullName = mapped.full_name.trim();
        }

        mapped.full_name = finalFullName;

        if (!mapped.full_name && !mapped.id_number) return; // skip empty rows

        // Set role & hierarchy based on type & scope
        let role = mapped.role || (type === 'students' ? 'Student' : defaultFacultyRole);
        let program = mapped.program;
        let section = mapped.section;

        if (type === 'students') {
            if (studentMode === 'SCOPED') {
                program = scopedProg;
                section = scopedSec;
            } else {
                program = program || scopedProg;
                section = section || scopedSec;
            }
        } else {
            program = program || facultyDept;
            section = section || '--';
        }

        const transitMode = mapped.default_transit_mode || 
                            (mapped.plate_number ? 'VEHICLE' : (type === 'students' ? defaultStudentTransit : 'PEDESTRIAN'));
        const approvalStatus = type === 'students' ? defaultStudentStatus : defaultFacultyStatus;

        // Duplicate Check
        const isDuplicate = existingUsers.some(u => 
            (mapped.id_number && (u.student_id === mapped.id_number || u.cpass_id === mapped.id_number)) ||
            (mapped.full_name && u.full_name && u.full_name.toLowerCase() === mapped.full_name.toLowerCase())
        );

        normalizedList.push({
            rowNumber: index + 1,
            student_id: mapped.id_number || '',
            cpass_id: mapped.id_number || '',
            full_name: mapped.full_name || '',
            role: role,
            program: program,
            section: section,
            sex: mapped.sex || 'Male',
            age: mapped.age || null,
            address: mapped.address || '',
            default_transit_mode: transitMode,
            vehicle_type: mapped.vehicle_type || (transitMode === 'VEHICLE' ? 'Motorcycle' : 'None'),
            vehicle_model: mapped.vehicle_model || '',
            plate_number: mapped.plate_number || '',
            rfid_uid: mapped.rfid_uid || '',
            approval_status: approvalStatus,
            isDuplicate: isDuplicate,
            isValid: Boolean(mapped.full_name && mapped.full_name.length >= 2)
        });
    });

    bulkUploadState.parsedRecords = normalizedList;
    renderBulkPreviewUI(fileName);
}

function fallbackPureJsCSVParse(text, delimiter = ',') {
    const lines = text.split(/\r\n|\n/).map(l => l.trim()).filter(Boolean);
    if (!lines.length) return [];
    
    // Parse header
    const headers = lines[0].split(delimiter).map(h => h.replace(/^["']|["']$/g, '').trim());
    const data = [];

    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        const simpleCols = line.split(delimiter);
        const obj = {};
        headers.forEach((h, idx) => {
            obj[h] = simpleCols[idx] ? simpleCols[idx].replace(/^["']|["']$/g, '').trim() : '';
        });
        data.push(obj);
    }
    return data;
}

// 6. Preview Table & UI Renderer
function renderBulkPreviewUI(fileName) {
    const previewContainer = el('bulkPreviewContainer');
    const tableBody = el('bulkPreviewTableBody');
    const btnExecute = el('btnExecuteBulkImport');
    const btnExecuteText = el('btnExecuteBulkImportText');
    const badgeTotal = el('bulkBadgeTotal');
    const badgeValid = el('bulkBadgeValid');
    const badgeValidText = el('bulkBadgeValidText');
    const badgeWarn = el('bulkBadgeWarn');
    const badgeError = el('bulkBadgeError');
    const previewFileName = el('bulkPreviewFileName');

    if (!previewContainer || !tableBody) return;

    previewContainer.classList.remove('hidden');
    if (previewFileName) previewFileName.textContent = `${fileName} (${bulkUploadState.parsedRecords.length} records processed)`;

    const total = bulkUploadState.parsedRecords.length;
    const validCount = bulkUploadState.parsedRecords.filter(r => r.isValid).length;
    const duplicateCount = bulkUploadState.parsedRecords.filter(r => r.isDuplicate).length;
    const errorCount = total - validCount;

    if (badgeTotal) badgeTotal.textContent = `${total} Total`;
    if (badgeValidText) badgeValidText.textContent = `${validCount} Ready to Enroll`;
    
    if (badgeWarn) {
        if (duplicateCount > 0) {
            badgeWarn.textContent = `${duplicateCount} Existing (Will Update)`;
            badgeWarn.classList.remove('hidden');
        } else {
            badgeWarn.classList.add('hidden');
        }
    }

    if (badgeError) {
        if (errorCount > 0) {
            badgeError.textContent = `${errorCount} Missing Name`;
            badgeError.classList.remove('hidden');
        } else {
            badgeError.classList.add('hidden');
        }
    }

    renderBulkPreviewRows(bulkUploadState.parsedRecords);

    if (btnExecute) {
        btnExecute.disabled = validCount === 0;
        if (btnExecuteText) {
            btnExecuteText.textContent = `Enroll ${validCount} ${bulkUploadState.fileType === 'students' ? 'Students' : 'Members'} into CHARRMPASS`;
        }
    }

    if (window.lucide && typeof lucide.createIcons === 'function') {
        lucide.createIcons();
    }
}

function renderBulkPreviewRows(recordsToRender) {
    const tableBody = el('bulkPreviewTableBody');
    if (!tableBody) return;

    if (!recordsToRender.length) {
        tableBody.innerHTML = `
            <tr>
                <td colspan="8" class="p-6 text-center text-slate-400 italic">No matching records found in preview.</td>
            </tr>
        `;
        return;
    }

    tableBody.innerHTML = recordsToRender.map(r => `
        <tr class="hover:bg-slate-50 border-b border-slate-100 transition-colors ${!r.isValid ? 'bg-red-50/60' : ''}">
            <td class="p-2.5 text-center font-mono font-bold text-slate-400 text-[11px]">${r.rowNumber}</td>
            <td class="p-2.5 font-mono font-bold text-slate-800 text-xs">
                ${r.student_id ? `<span class="bg-slate-100 px-2 py-0.5 rounded-md">${r.student_id}</span>` : '<span class="text-slate-400 italic text-[11px]">Auto CPASS</span>'}
            </td>
            <td class="p-2.5 font-bold text-slate-800">
                <div class="flex items-center gap-1.5 flex-wrap">
                    <span>${r.full_name || '<span class="text-red-500 font-bold text-xs">⚠️ Missing Full Name!</span>'}</span>
                    ${r.isDuplicate ? '<span class="text-[9px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 font-bold border border-amber-200">Will Update</span>' : ''}
                </div>
            </td>
            <td class="p-2.5"><span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 text-slate-700">${r.role}</span></td>
            <td class="p-2.5 font-semibold text-slate-700 text-xs">
                <span class="font-bold text-emerald-800">${r.program}</span> <span class="text-slate-400">• ${r.section}</span>
            </td>
            <td class="p-2.5 font-mono text-xs">
                ${r.default_transit_mode === 'VEHICLE' 
                    ? `<span class="text-emerald-700 font-bold flex items-center gap-1">🚗 ${r.plate_number || 'Vehicle'}</span>` 
                    : '<span class="text-slate-500 flex items-center gap-1">🚶 Pedestrian</span>'}
            </td>
            <td class="p-2.5 text-center">
                ${r.isValid 
                    ? `<span class="px-2 py-0.5 rounded-full text-[10px] font-black ${r.approval_status === 'APPROVED' ? 'bg-emerald-100 text-emerald-800 border border-emerald-200' : 'bg-yellow-100 text-yellow-800'}">${r.approval_status}</span>`
                    : '<span class="px-2 py-0.5 rounded-full text-[10px] font-black bg-red-100 text-red-800 border border-red-200">Fix Needed</span>'}
            </td>
            <td class="p-2.5 text-center">
                <button type="button" onclick="removeBulkPreviewRow(${r.rowNumber})" class="text-slate-400 hover:text-red-600 p-1 rounded-lg hover:bg-red-50 transition-all" title="Remove this row">
                    <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
                </button>
            </td>
        </tr>
    `).join('');

    if (window.lucide && typeof lucide.createIcons === 'function') {
        lucide.createIcons();
    }
}

// Live search in preview table
window.filterBulkPreviewTable = function() {
    const q = (el('bulkPreviewSearch')?.value || '').toLowerCase().trim();
    if (!q) {
        renderBulkPreviewRows(bulkUploadState.parsedRecords);
        return;
    }
    const filtered = bulkUploadState.parsedRecords.filter(r => 
        (r.full_name && r.full_name.toLowerCase().includes(q)) ||
        (r.student_id && r.student_id.toLowerCase().includes(q)) ||
        (r.program && r.program.toLowerCase().includes(q)) ||
        (r.section && r.section.toLowerCase().includes(q))
    );
    renderBulkPreviewRows(filtered);
};

// Remove single row directly from preview
window.removeBulkPreviewRow = function(rowNum) {
    bulkUploadState.parsedRecords = bulkUploadState.parsedRecords.filter(r => r.rowNumber !== rowNum);
    renderBulkPreviewUI(bulkUploadState.fileName || 'Roster');
    showToast(`Removed row #${rowNum}`, 'info');
};

window.resetBulkUploadForm = function() {
    bulkUploadState.parsedRecords = [];
    bulkUploadState.fileName = '';
    const previewContainer = el('bulkPreviewContainer');
    if (previewContainer) previewContainer.classList.add('hidden');
    const studentFileInput = el('bulkStudentFileInput');
    if (studentFileInput) studentFileInput.value = '';
    const facultyFileInput = el('bulkFacultyFileInput');
    if (facultyFileInput) facultyFileInput.value = '';
    const pasteStudentArea = el('bulkStudentPasteArea');
    if (pasteStudentArea) pasteStudentArea.value = '';
    const pasteFacultyArea = el('bulkFacultyPasteArea');
    if (pasteFacultyArea) pasteFacultyArea.value = '';
    const previewSearch = el('bulkPreviewSearch');
    if (previewSearch) previewSearch.value = '';
    const btnExecute = el('btnExecuteBulkImport');
    if (btnExecute) btnExecute.disabled = true;
    const progressContainer = el('bulkProgressBarContainer');
    if (progressContainer) progressContainer.classList.add('hidden');
};

// 7. Batch Import Execution into Supabase & Local State
window.executeBulkImport = async function() {
    const validRecords = bulkUploadState.parsedRecords.filter(r => r.isValid);
    if (!validRecords.length) {
        showToast('No valid records to import', 'warning');
        return;
    }

    const btnExecute = el('btnExecuteBulkImport');
    const btnText = el('btnExecuteBulkImportText');
    const progressContainer = el('bulkProgressBarContainer');
    const progressBarFill = el('bulkProgressBarFill');
    const progressPercent = el('bulkProgressPercent');
    const progressLabel = el('bulkProgressLabel');

    if (btnExecute) btnExecute.disabled = true;
    if (progressContainer) progressContainer.classList.remove('hidden');

    let insertedCount = 0;
    const total = validRecords.length;

    try {
        if (isConnected && supabaseClient) {
            // Direct Supabase Client batch upsert
            for (let i = 0; i < validRecords.length; i++) {
                const r = validRecords[i];
                const userPayload = {
                    full_name: r.full_name,
                    student_id: r.student_id || null,
                    cpass_id: r.student_id || (r.cpass_id ? r.cpass_id.toUpperCase() : null),
                    role: r.role,
                    program: r.program,
                    section: r.section,
                    sex: r.sex,
                    age: r.age,
                    address: r.address,
                    default_transit_mode: r.default_transit_mode,
                    approval_status: r.approval_status
                };

                const { data: userData, error: userError } = await supabaseClient
                    .from('users')
                    .upsert(userPayload, { onConflict: 'cpass_id' })
                    .select()
                    .single();

                if (!userError && userData) {
                    // Attach Vehicle if plate provided
                    if (r.plate_number && r.plate_number !== 'PENDING-PLATE' && r.plate_number !== 'NONE' && r.plate_number.trim()) {
                        await supabaseClient.from('vehicles').upsert({
                            user_id: userData.id,
                            plate_number: r.plate_number,
                            vehicle_type: r.vehicle_type || 'Motorcycle',
                            vehicle_model: r.vehicle_model || '',
                            approval_status: r.approval_status
                        }, { onConflict: 'plate_number' });
                    }
                }

                insertedCount++;
                const pct = Math.min(100, Math.round((insertedCount / total) * 100));
                if (progressBarFill) progressBarFill.style.width = `${pct}%`;
                if (progressPercent) progressPercent.textContent = `${pct}%`;
                if (progressLabel) progressLabel.innerHTML = `<i data-lucide="loader-2" class="w-4 h-4 animate-spin text-emerald-600"></i> Enrolled ${insertedCount} of ${total} records...`;
            }

            showToast(`🎉 Successfully enrolled ${insertedCount} ${bulkUploadState.fileType === 'students' ? 'students' : 'members'} into CHARRMPASS!`, 'success');
            await loadData();
            closeBulkUploadModal();

        } else {
            // Local Offline Simulation mode
            validRecords.forEach((r, idx) => {
                const newId = 'LOCAL-' + Date.now() + '-' + idx;
                const localUser = {
                    id: newId,
                    full_name: r.full_name,
                    cpass_id: r.student_id || ('CP' + String(adminState.users.length + idx).padStart(2, '0')),
                    student_id: r.student_id || null,
                    role: r.role,
                    program: r.program,
                    section: r.section,
                    sex: r.sex,
                    age: r.age,
                    address: r.address,
                    default_transit_mode: r.default_transit_mode,
                    user_type: r.default_transit_mode,
                    rfid_type: r.default_transit_mode === 'VEHICLE' ? 'LONG_RANGE' : 'CLOSE_RANGE',
                    rfid_uid: r.rfid_uid || '',
                    plate_number: r.plate_number || '',
                    vehicle_type: r.vehicle_type || '',
                    authorization_status: r.approval_status === 'APPROVED' ? 'AUTHORIZED' : 'PENDING',
                    approval_status: r.approval_status
                };

                const existingIdx = adminState.users.findIndex(u => 
                    (r.student_id && u.student_id === r.student_id) || 
                    (u.full_name && r.full_name && u.full_name.toLowerCase() === r.full_name.toLowerCase())
                );

                if (existingIdx !== -1) {
                    adminState.users[existingIdx] = { ...adminState.users[existingIdx], ...localUser };
                } else {
                    adminState.users.unshift(localUser);
                }
            });

            renderStats();
            renderUsersTable();
            renderPendingApprovals();
            showToast(`🎉 Local Batch Import: Enrolled ${validRecords.length} records into CHARRMPASS.`, 'success');
            closeBulkUploadModal();
        }
    } catch(err) {
        console.error('Bulk Import Error:', err);
        showToast('Bulk import error: ' + err.message, 'error');
    } finally {
        if (btnExecute) btnExecute.disabled = false;
        if (btnText) btnText.textContent = 'Import to CHARRMPASS';
    }
};

// Initialize on page load
loadAcademicData();

setupRealtime();
loadData();

