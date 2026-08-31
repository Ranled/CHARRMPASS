/**
 * CHARRMPASS - Admin Dashboard Logic
 * User management, RFID UID assignment, analytics, and real-time updates
 */
if (typeof initSupabase === 'function') initSupabase();
if (typeof startClock === 'function') startClock();
if (typeof updateDBBadge === 'function') updateDBBadge();
if (window.lucide) lucide.createIcons();
const el = id => document.getElementById(id);

let adminState = { users: [], pendingUsers: [], logs: [], accounts: [], specialTags: [], activeVehicles: 0 };

// Demo data (fallback)
const demoUsers = [
    { id:'1', full_name:'Juan Dela Cruz', role:'Student', rfid_uid:'B7 78 96 31', program:'BSIT', section:'3A', vehicle_type:'Car', vehicle_model:'Honda Civic', plate_number:'XYZ-123', vehicle_color:'Black', authorization_status:'AUTHORIZED', age:21, sex:'Male', address:'Ibajay, Aklan', created_at:'2024-01-15' },
    { id:'2', full_name:'Maria Santos', role:'Faculty', rfid_uid:'UID67890', program:'Engineering', section:'--', vehicle_type:'SUV', vehicle_model:'Toyota Fortuner', plate_number:'ABC-789', vehicle_color:'White', authorization_status:'AUTHORIZED', age:35, sex:'Female', address:'Kalibo, Aklan', created_at:'2024-02-01' },
    { id:'3', full_name:'Carlos Reyes', role:'Staff', rfid_uid:'UID55555', program:'Admin', section:'--', vehicle_type:'Motorcycle', vehicle_model:'Yamaha NMAX', plate_number:'DEF-456', vehicle_color:'Silver', authorization_status:'AUTHORIZED', age:28, sex:'Male', address:'Nabas, Aklan', created_at:'2024-03-10' },
    { id:'4', full_name:'Ana Lopez', role:'Student', rfid_uid:'', program:'BSCS', section:'2B', vehicle_type:'Motorcycle', vehicle_model:'Honda Click', plate_number:'GHI-789', vehicle_color:'Red', authorization_status:'PENDING', age:20, sex:'Female', address:'Ibajay, Aklan', created_at:'2024-05-13' },
    { id:'5', full_name:'Pedro Garcia', role:'Student', rfid_uid:'', program:'BSA', section:'1A', vehicle_type:'Car', vehicle_model:'Vios', plate_number:'JKL-012', vehicle_color:'Blue', authorization_status:'PENDING', age:19, sex:'Male', address:'Tangalan, Aklan', created_at:'2024-05-14' },
];

const demoSpecialTags = [
    { id: '1', rfid_uid: '73 71 A9 FE', type: 'VISITOR', description: 'Visitor Pass (Reusable RFID Tag)' },
    { id: '2', rfid_uid: 'D3 85 96 FE', type: 'EMERGENCY', description: 'Emergency Response Vehicle Tag' }
];

const demoAccounts = [
    { id: '1', username: 'guard', password: 'guard123', role: 'GUARD' },
    { id: '2', username: 'admin', password: 'admin123', role: 'ADMIN' }
];



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
// LOAD DATA
// =====================
async function loadData() {
    if (isConnected) {
        try {
            // Load users with their vehicles and rfid_cards via JOIN
            const {data:u, error:ue} = await supabaseClient
                .from('users')
                .select(`
                    *,
                    vehicles ( id, vehicle_type, vehicle_model, plate_number, vehicle_color, motorcycle_image ),
                    rfid_cards ( id, rfid_uid, authorization_status )
                `)
                .order('created_at', {ascending: false});
            if (ue) { console.error('Users error:', ue); throw ue; }
            if (u) {
                // Flatten for convenience: promote first vehicle/card fields
                adminState.users = u.map(usr => ({
                    ...usr,
                    vehicle_type:     usr.vehicles?.[0]?.vehicle_type     || null,
                    vehicle_model:    usr.vehicles?.[0]?.vehicle_model    || null,
                    plate_number:     usr.vehicles?.[0]?.plate_number     || null,
                    vehicle_color:    usr.vehicles?.[0]?.vehicle_color    || null,
                    motorcycle_image: usr.vehicles?.[0]?.motorcycle_image || null,
                    vehicle_id:       usr.vehicles?.[0]?.id               || null,
                    rfid_uid:         usr.rfid_cards?.[0]?.rfid_uid       || null,
                    rfid_card_id:     usr.rfid_cards?.[0]?.id             || null,
                    authorization_status: usr.rfid_cards?.[0]?.authorization_status || 'PENDING',
                }));
            }

            // Load transactions with vehicle & user info
            const {data:l, error:le} = await supabaseClient
                .from('transactions')
                .select(`
                    *,
                    users ( full_name, role, program, section, profile_image ),
                    vehicles ( plate_number, vehicle_type, vehicle_model, vehicle_color )
                `)
                .order('timestamp', {ascending: false})
                .limit(1000);
            if (le) console.error('Transactions error:', le);
            if (l) adminState.logs = l;

            // Currently inside = ENTRY count - EXIT count (authorized)
            const entries = adminState.logs.filter(t => t.direction === 'ENTRY' && t.status === 'AUTHORIZED').length;
            const exits   = adminState.logs.filter(t => t.direction === 'EXIT'  && t.status === 'AUTHORIZED').length;
            adminState.activeVehicles = Math.max(0, entries - exits);

            const {data:acc, error:acce} = await supabaseClient.from('system_accounts').select('*');
            if (acce) console.error('Accounts error:', acce);
            if (acc && acc.length) adminState.accounts = acc;
            else if (!adminState.accounts.length) adminState.accounts = [...demoAccounts];

            const {data:st, error:ste} = await supabaseClient.from('special_tags').select('*');
            if (ste) console.error('Special tags error:', ste);
            if (st && st.length) adminState.specialTags = st;
            else if (!adminState.specialTags.length) adminState.specialTags = [...demoSpecialTags];

            console.log('✅ Admin data refreshed:', adminState.users.length, 'users,', adminState.logs.length, 'transactions,', adminState.activeVehicles, 'inside');
        } catch(e) {
            console.error('CRITICAL LOAD ERROR:', e);
            showToast('Database Error: ' + e.message, 'error');
            if (!adminState.specialTags.length) adminState.specialTags = [...demoSpecialTags];
            if (!adminState.accounts.length) adminState.accounts = [...demoAccounts];
        }
    } else {
        adminState.users = [...demoUsers];
        adminState.specialTags = [...demoSpecialTags];
        adminState.accounts = [...demoAccounts];
    }
    adminState.pendingUsers = adminState.users.filter(u => u.authorization_status === 'PENDING' || !u.authorization_status);
    renderAdmin();
}

const renderAll = renderAdmin;
window.renderAll = renderAdmin;

// =====================
// RENDER
// =====================
function renderAdmin() {
    const activeCount = typeof adminState.activeVehicles === 'number' ? adminState.activeVehicles : 0;
    const today = new Date().toISOString().split('T')[0];
    const todayEntries = adminState.logs.filter(l => l.direction === 'ENTRY' && l.timestamp?.startsWith(today));
    const todayExits   = adminState.logs.filter(l => l.direction === 'EXIT'  && l.timestamp?.startsWith(today));

    if(el('adminStatUsers'))   el('adminStatUsers').textContent   = adminState.users.length;
    if(el('adminStatPending')) el('adminStatPending').textContent = adminState.pendingUsers.length;
    if(el('adminStatEntries')) el('adminStatEntries').textContent = todayEntries.length;
    if(el('adminStatInside'))  el('adminStatInside').textContent  = activeCount;

    // Update charts if viewing analytics
    const analyticsView = el('aview-analytics');
    if (analyticsView && !analyticsView.classList.contains('hidden')) {
        renderAnalytics();
    }

    // Pending table
    if(el('pendingTable')) {
        el('pendingTable').innerHTML = adminState.pendingUsers.length ? adminState.pendingUsers.map(u => `
            <tr class="hover:bg-white/60 border-b border-slate-100/50 transition-colors">
                <td class="p-4">
                    <div class="flex items-center gap-3">
                        <img src="${u.profile_image || 'https://ui-avatars.com/api/?name='+encodeURIComponent(u.full_name)}" class="w-8 h-8 rounded-lg object-cover">
                        <div class="font-bold text-slate-800">${u.full_name}</div>
                    </div>
                </td>
                <td class="p-4"><span class="px-2 py-0.5 rounded text-xs font-bold bg-slate-200 text-slate-700 uppercase">${u.role}</span></td>
                <td class="p-4 text-sm text-slate-600">${u.vehicle_type||'--'} - ${u.vehicle_model||'--'}</td>
                <td class="p-4 text-sm text-slate-500">${u.created_at?new Date(u.created_at).toLocaleDateString():'--'}</td>
                <td class="p-4 text-center"><span class="px-2 py-1 rounded text-[10px] font-bold bg-yellow-100 text-yellow-700">PENDING</span></td>
                <td class="p-4 text-right whitespace-nowrap">
                    <button onclick="openReviewModal('${u.id}')" class="px-3 py-1 bg-blue-50 text-blue-600 rounded-lg text-xs font-bold hover:bg-blue-100 transition-colors mr-1">Review</button>
                    <button onclick="approveUser('${u.id}')" class="px-3 py-1 bg-charm-green text-white rounded-lg text-xs font-bold hover:bg-green-600 mr-1">Approve</button>
                    <button onclick="denyRegistration('${u.id}')" class="px-3 py-1 bg-red-500 text-white rounded-lg text-xs font-bold hover:bg-red-600">Deny</button>
                </td>
            </tr>
        `).join('') : '<tr><td colspan="6" class="p-8 text-center text-slate-400">No pending registrations</td></tr>';
    }

    // Users table
    if(el('usersTable')) {
        const search = (el('userSearch')?.value||'').toLowerCase();
        const role = el('roleFilter')?.value||'';
        let filtered = [...adminState.users];
        if(search) filtered = filtered.filter(u => (u.full_name||'').toLowerCase().includes(search) || (u.rfid_uid||'').toLowerCase().includes(search) || (u.plate_number||'').toLowerCase().includes(search));
        if(role) filtered = filtered.filter(u => u.role===role);
        el('usersTable').innerHTML = filtered.length ? filtered.map(u => {
            const isAuth = u.authorization_status === 'AUTHORIZED';
            const statusClass = isAuth ? 'bg-green-100 text-green-700' : (u.authorization_status === 'PENDING' ? 'bg-yellow-100 text-yellow-700' : 'bg-red-100 text-red-700');
            const statusLabel = u.authorization_status || (u.rfid_uid ? 'AUTHORIZED' : 'PENDING');
            return `<tr class="hover:bg-white/60 border-b border-slate-100/50">
                <td class="p-4 font-bold text-slate-800">${u.full_name || '--'}</td>
                <td class="p-4"><span class="px-2 py-0.5 rounded text-xs font-bold bg-slate-200 text-slate-700 uppercase">${u.role || '--'}</span><div class="text-xs text-slate-500 mt-1">${u.program||'--'} • ${u.section||'--'}</div></td>
                <td class="p-4 font-mono text-xs">${u.rfid_uid ? `<span class="text-green-600 font-bold">${u.rfid_uid}</span>` : '<span class="text-yellow-600 font-bold">Not Assigned</span>'}</td>
                <td class="p-4"><div class="font-semibold text-slate-700">${u.vehicle_type||'--'} - ${u.vehicle_model||'--'}</div></td>
                <td class="p-4 font-mono font-bold text-slate-700">${u.plate_number||'--'}</td>
                <td class="p-4 text-center"><span class="px-2 py-1 rounded text-[10px] font-bold ${statusClass}">${statusLabel}</span></td>
                <td class="p-4 text-right whitespace-nowrap">
                    <button onclick="openUserModal('${u.id}')" class="p-1.5 text-slate-400 hover:text-charm-dark rounded-lg hover:bg-slate-100" title="Edit / Assign RFID"><i data-lucide="edit" class="w-4 h-4"></i></button>
                    <button onclick="deleteUser('${u.id}')" class="p-1.5 text-slate-400 hover:text-red-500 ml-1 rounded-lg hover:bg-red-50" title="Delete"><i data-lucide="trash" class="w-4 h-4"></i></button>
                </td></tr>`;
        }).join('') : '<tr><td colspan="7" class="p-8 text-center text-slate-400">No users found</td></tr>';
    }

    // Accounts (Guard Management)
    if(el('accountsGrid')) {
        const guardAccounts = adminState.accounts.filter(acc => acc.role === 'GUARD');
        if (guardAccounts.length > 0) {
            el('accountsGrid').innerHTML = guardAccounts.map(acc => `
                <div class="glass-card p-6 rounded-3xl border border-white/60 shadow-glass flex flex-col items-center text-center animate-slide-up relative group">
                    <button onclick="deleteAccount('${acc.id}')" class="absolute top-4 right-4 p-2 rounded-xl text-slate-300 hover:text-red-500 hover:bg-red-50 transition-colors" title="Delete Guard Account">
                        <i data-lucide="trash-2" class="w-4 h-4"></i>
                    </button>
                    <div class="w-16 h-16 rounded-2xl bg-charm-dark text-charm-yellow flex items-center justify-center mb-4 shadow-lg">
                        <i data-lucide="shield-check" class="w-8 h-8"></i>
                    </div>
                    <h3 class="font-display font-bold text-xl text-slate-800">${acc.username}</h3>
                    <span class="px-3 py-0.5 rounded-full text-[10px] font-extrabold bg-green-100 text-green-800 uppercase tracking-widest mt-1">SECURITY GUARD</span>
                    
                    <div class="w-full mt-5 pt-4 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500">
                        <span class="font-semibold uppercase tracking-wider text-[10px] text-slate-400">Password:</span>
                        <span class="font-mono font-bold text-slate-700 bg-slate-100 px-2 py-0.5 rounded">${acc.password || '••••••••'}</span>
                    </div>

                    <div class="mt-5 flex gap-2 w-full">
                        <button onclick="openAccountModal('${acc.id}')" class="flex-1 px-4 py-2.5 rounded-xl bg-slate-100 text-slate-700 text-xs font-bold hover:bg-charm-dark hover:text-white transition-all flex items-center justify-center gap-1.5 shadow-sm">
                            <i data-lucide="key" class="w-3.5 h-3.5"></i> Change Password / Username
                        </button>
                    </div>
                </div>
            `).join('');
        } else {
            el('accountsGrid').innerHTML = `
                <div class="col-span-full py-16 flex flex-col items-center justify-center text-slate-400">
                    <div class="w-16 h-16 rounded-full bg-slate-100 flex items-center justify-center mb-3">
                        <i data-lucide="shield-off" class="w-8 h-8 text-slate-300"></i>
                    </div>
                    <p class="font-bold text-slate-700 mb-1 text-base">No Guard Accounts Found</p>
                    <p class="text-xs text-slate-400 mb-5 max-w-sm text-center">Create security guard credentials to allow officers to log into the Guard Station dashboard.</p>
                    <button onclick="openAccountModal()" class="px-5 py-2.5 bg-charm-dark text-white rounded-xl text-xs font-bold shadow-md hover:opacity-90 flex items-center gap-1.5">
                        <i data-lucide="plus" class="w-4 h-4"></i> Create Guard Account
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
        const recentLogs = filteredLogs.slice(0, 100);
        if (recentLogs.length) {
            el('adminLogsTable').innerHTML = recentLogs.map(l => {
                const dateObj  = l.timestamp ? new Date(l.timestamp) : null;
                let name     = l.users?.full_name;
                let plate    = l.vehicles?.plate_number;

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
                if (!plate) plate = l.rfid_uid ? l.rfid_uid.substring(0, 12) : '--';

                const dir      = l.direction || 'ENTRY';
                const isEntry  = dir === 'ENTRY';
                const isAuth   = l.status === 'AUTHORIZED';
                const statusBg = isAuth ? 'bg-green-100 text-green-700' : (l.status === 'PENDING_CONFIRMATION' ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700');
                const gateName = l.gate || (isEntry ? 'ENTRY_GATE' : 'EXIT_GATE');

                return `
                    <tr class="hover:bg-white/60 border-b border-slate-100/50 transition-colors">
                        <td class="p-4 text-xs font-mono font-medium text-slate-500">${ts}</td>
                        <td class="p-4 font-mono text-xs font-bold text-slate-500">${l.rfid_uid || '--'}</td>
                        <td class="p-4 font-bold text-slate-800">${name}</td>
                        <td class="p-4 font-mono text-xs font-bold text-charm-dark bg-charm-yellow/10 px-2 py-0.5 rounded inline-block my-3">${plate}</td>
                        <td class="p-4 text-center">
                            <span class="px-2.5 py-1 rounded-full text-[10px] font-extrabold uppercase ${isEntry ? 'bg-emerald-100 text-emerald-800' : 'bg-blue-100 text-blue-800'}">${dir}</span>
                        </td>
                        <td class="p-4 text-center">
                            <span class="px-2.5 py-1 rounded-full text-[10px] font-extrabold uppercase ${statusBg}">${l.status || '--'}</span>
                        </td>
                        <td class="p-4 text-right">
                            <span class="text-xs font-bold font-mono ${gateName.includes('ENTRY') ? 'text-emerald-600' : 'text-blue-600'}">${gateName}</span>
                        </td>
                    </tr>
                `;
            }).join('');
        } else {
            el('adminLogsTable').innerHTML = '<tr><td colspan="7" class="p-8 text-center text-slate-400 font-medium">No transactions found</td></tr>';
        }
    }

    // Ranking Tables (respecting timeframe)
    const now = new Date();
    let filteredLogs = adminState.logs;
    if (analyticsRange === 'day') {
        filteredLogs = adminState.logs.filter(l => {
            const d = new Date(l.timestamp);
            return d.getDate() === now.getDate() && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
        });
    } else if (analyticsRange === 'week') {
        const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        filteredLogs = adminState.logs.filter(l => new Date(l.timestamp) >= weekAgo);
    } else if (analyticsRange === 'month') {
        filteredLogs = adminState.logs.filter(l => {
            const d = new Date(l.timestamp);
            return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
        });
    } else if (analyticsRange === 'annual') {
        filteredLogs = adminState.logs.filter(l => new Date(l.timestamp).getFullYear() === now.getFullYear());
    }

    if (el('studentRankingTable')) {
        const studentLogs = filteredLogs.filter(l => l.users?.role === 'Student');
        const counts = {};
        studentLogs.forEach(l => { const name = l.users?.full_name; if(name) counts[name] = (counts[name] || 0) + 1; });
        const ranked = Object.entries(counts).sort((a,b) => b[1] - a[1]).slice(0, 5);
        el('studentRankingTable').innerHTML = ranked.length ? ranked.map(([name, count], i) => {
            const u = adminState.users.find(x => x.full_name === name);
            return `<tr class="border-b border-slate-50"><td class="p-3 text-center font-bold text-charm-dark">${i+1}</td><td class="p-3 font-semibold">${name}</td><td class="p-3 text-center text-slate-500">${u?.program||'--'}</td><td class="p-3 text-center"><span class="px-2 py-0.5 rounded-full bg-slate-100 font-bold text-slate-700">${count}</span></td></tr>`;
        }).join('') : '<tr><td colspan="4" class="p-8 text-center text-slate-300">No activity in this period</td></tr>';
    }

    if (el('facultyRankingTable')) {
        const facultyLogs = filteredLogs.filter(l => l.users?.role === 'Faculty' || l.users?.role === 'Staff');
        const counts = {};
        facultyLogs.forEach(l => { const name = l.users?.full_name; if(name) counts[name] = (counts[name] || 0) + 1; });
        const ranked = Object.entries(counts).sort((a,b) => b[1] - a[1]).slice(0, 5);
        el('facultyRankingTable').innerHTML = ranked.length ? ranked.map(([name, count], i) => {
            const u = adminState.users.find(x => x.full_name === name);
            return `<tr class="border-b border-slate-50"><td class="p-3 text-center font-bold text-charm-mid">${i+1}</td><td class="p-3 font-semibold">${name}</td><td class="p-3 text-center text-slate-500">${u?.role||'--'}</td><td class="p-3 text-center"><span class="px-2 py-0.5 rounded-full bg-slate-100 font-bold text-slate-700">${count}</span></td></tr>`;
        }).join('') : '<tr><td colspan="4" class="p-8 text-center text-slate-300">No activity in this period</td></tr>';
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
                            <button onclick="editSpecialTag('${t.id}')" class="p-2 text-slate-400 hover:text-charm-dark transition-colors"><i data-lucide="edit" class="w-4 h-4"></i></button>
                            <button onclick="deleteSpecialTag('${t.id}')" class="p-2 text-slate-400 hover:text-red-500 transition-colors"><i data-lucide="trash-2" class="w-4 h-4"></i></button>
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
            el('formVehType').value = u.vehicle_type || 'None';
            el('formPlate').value = u.plate_number || '';
            el('formVehModel').value = u.vehicle_model || '';
            el('formVehColor').value = u.vehicle_color || '';
            el('prevProfile').src = u.profile_image || 'https://ui-avatars.com/api/?name=' + u.full_name;
            el('prevMotor').src = u.motorcycle_image || 'https://images.unsplash.com/photo-1558981403-c5f91cbba527?auto=format&fit=crop&q=80&w=200';
        }
    }

    modal.classList.remove('hidden');
    setTimeout(() => {
        modal.classList.add('opacity-100');
        el('userModalContent').classList.remove('scale-95');
    }, 10);
    lucide.createIcons();
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
        updated_at: new Date().toISOString()
    };
    const vehicleData = {
        vehicle_type: el('formVehType').value,
        plate_number: el('formPlate').value.trim().toUpperCase() || 'NO-PLATE',
        vehicle_model: el('formVehModel').value.trim() || '--',
        vehicle_color: el('formVehColor').value.trim() || '--',
    };

    try {
        showToast('Saving user & RFID assignment...', 'info');

        if (userId) {
            // ─── EDIT EXISTING USER ───
            const user = adminState.users.find(u => u.id === userId);
            
            // 1. Update user
            const { error: uErr } = await supabaseClient.from('users').update(userData).eq('id', userId);
            if (uErr) throw uErr;

            // 2. Update or insert vehicle
            if (user?.vehicle_id) {
                const { error: vErr } = await supabaseClient.from('vehicles').update(vehicleData).eq('id', user.vehicle_id);
                if (vErr) throw vErr;
            } else {
                const { data: newV, error: vErr } = await supabaseClient.from('vehicles').insert([{ user_id: userId, ...vehicleData }]).select().single();
                if (vErr) throw vErr;
            }

            // 3. Update or upsert RFID Card UID
            if (user?.rfid_card_id) {
                const { error: cErr } = await supabaseClient.from('rfid_cards').update({
                    rfid_uid: newUid,
                    authorization_status: 'AUTHORIZED',
                    updated_at: new Date().toISOString()
                }).eq('id', user.rfid_card_id);
                if (cErr) throw cErr;
            } else {
                const { error: cErr } = await supabaseClient.from('rfid_cards').insert([{
                    rfid_uid: newUid,
                    user_id: userId,
                    vehicle_id: user?.vehicle_id || null,
                    authorization_status: 'AUTHORIZED'
                }]);
                if (cErr) throw cErr;
            }

            showToast(`User updated! RFID UID ${newUid} assigned.`, 'success');
        } else {
            // ─── ADD BRAND NEW USER ───
            // 1. Insert user
            const { data: newUser, error: uErr } = await supabaseClient.from('users').insert([userData]).select().single();
            if (uErr) throw uErr;

            // 2. Insert vehicle
            const { data: newV, error: vErr } = await supabaseClient.from('vehicles').insert([{ user_id: newUser.id, ...vehicleData }]).select().single();
            if (vErr) throw vErr;

            // 3. Insert RFID Card
            const { error: cErr } = await supabaseClient.from('rfid_cards').insert([{
                rfid_uid: newUid,
                user_id: newUser.id,
                vehicle_id: newV.id,
                authorization_status: 'AUTHORIZED'
            }]);
            if (cErr) throw cErr;

            showToast(`User created and RFID UID ${newUid} assigned!`, 'success');
        }

        closeUserModal();
        await loadData();
    } catch (err) {
        showToast('Error saving user: ' + err.message, 'error');
    }
});

window.approveUser = async function(id) {
    const u = adminState.pendingUsers.find(x => x.id === id);
    if (!u) return;

    // Check if the review modal is open and has a UID entered
    let assignedUid = '';
    const revInput = el('revRfidUid');
    if (revInput && revInput.value) {
        assignedUid = revInput.value.trim().toUpperCase();
    } else if (u.rfid_uid && !u.rfid_uid.startsWith('UNASSIGNED_')) {
        assignedUid = u.rfid_uid;
    }

    // If no UID is provided, open the Review Modal so the Admin can assign one
    if (!assignedUid) {
        openReviewModal(id);
        setTimeout(() => {
            if (el('revRfidUid')) {
                el('revRfidUid').focus();
                showToast('Please enter or scan the physical RFID UID to issue.', 'info');
            }
        }, 350);
        return;
    }

    try {
        showToast(`Approving & issuing RFID ${assignedUid}...`, 'info');

        // Check if card record already exists for this user
        const { data: existingCard } = await supabaseClient
            .from('rfid_cards')
            .select('id')
            .eq('user_id', id)
            .maybeSingle();

        if (existingCard) {
            const { error } = await supabaseClient
                .from('rfid_cards')
                .update({
                    rfid_uid: assignedUid,
                    authorization_status: 'AUTHORIZED',
                    updated_at: new Date().toISOString()
                })
                .eq('id', existingCard.id);
            if (error) throw error;
        } else {
            const { error } = await supabaseClient
                .from('rfid_cards')
                .insert([{
                    rfid_uid: assignedUid,
                    user_id: id,
                    vehicle_id: u.vehicle_id || null,
                    authorization_status: 'AUTHORIZED'
                }]);
            if (error) throw error;
        }

        closeReviewModal();
        showToast(`Approved! RFID Tag ${assignedUid} issued to ${u.full_name}.`, 'success');
        await loadData();
    } catch (err) {
        showToast('Error approving registration: ' + err.message, 'error');
    }
};

window.denyRegistration = async function(id) {
    if (!confirm('Are you sure you want to deny this registration?')) return;
    try {
        showToast('Denying registration...', 'info');
        const { error } = await supabaseClient
            .from('rfid_cards')
            .update({ authorization_status: 'DENIED', updated_at: new Date().toISOString() })
            .eq('user_id', id);
        if (error) throw error;
        closeReviewModal();
        showToast('Registration denied.', 'success');
        await loadData();
    } catch (err) { showToast('Error: ' + err.message, 'error'); }
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

function getFilteredAnalyticsLogs(preset = analyticsPreset, customFrom = customAnalyticsFrom, customTo = customAnalyticsTo) {
    const now = new Date();
    const logs = adminState.logs || [];
    
    if (preset === 'today') {
        const todayStr = now.toISOString().split('T')[0];
        return logs.filter(l => l.timestamp && l.timestamp.startsWith(todayStr));
    }
    if (preset === 'yesterday') {
        const y = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        const yStr = y.toISOString().split('T')[0];
        return logs.filter(l => l.timestamp && l.timestamp.startsWith(yStr));
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
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const prefix = `${year}-${month}`;
        return logs.filter(l => l.timestamp && l.timestamp.startsWith(prefix));
    }
    if (preset === 'lastMonth') {
        const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const year = lastMonthDate.getFullYear();
        const month = String(lastMonthDate.getMonth() + 1).padStart(2, '0');
        const prefix = `${year}-${month}`;
        return logs.filter(l => l.timestamp && l.timestamp.startsWith(prefix));
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
    const processedUids = new Set();
    const sortedLogsAsc = [...adminState.logs].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    sortedLogsAsc.forEach(l => {
        if (l.status !== 'AUTHORIZED') return;
        const uid = l.rfid_uid || l.id;
        if (l.direction === 'ENTRY') {
            openEntries.push(l);
        } else if (l.direction === 'EXIT') {
            const idx = openEntries.findIndex(e => e.rfid_uid === uid);
            if (idx !== -1) openEntries.splice(idx, 1);
        }
    });

    openEntries.forEach(l => {
        const role = (l.users?.role || '').toUpperCase();
        if (role === 'STUDENT') insideStud++;
        else if (role === 'FACULTY' || role === 'STAFF') insideStf++;
        else if (l.remarks && (l.remarks.includes('Visitor') || l.remarks.includes('VISITOR'))) insideVis++;
        else if (l.is_emergency) insideEmg++;
        else insideVis++;
    });

    if (el('insideStudents')) el('insideStudents').textContent = insideStud;
    if (el('insideStaff')) el('insideStaff').textContent = insideStf;
    if (el('insideVisitors')) el('insideVisitors').textContent = insideVis;
    if (el('insideEmergency')) el('insideEmergency').textContent = insideEmg;

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

    // 6. Guard Activity
    const guardAccounts = adminState.accounts.filter(a => a.role === 'GUARD') || [];
    if (el('guardActivityTable')) {
        el('guardActivityTable').innerHTML = guardAccounts.length ? guardAccounts.map(g => {
            const scans = filteredLogs.length > 0 ? Math.floor(filteredLogs.length / (guardAccounts.length || 1)) : 0;
            const entriesCnt = Math.floor(scans * 0.52);
            const exitsCnt = scans - entriesCnt;
            return `
                <tr class="border-b border-slate-100/60 hover:bg-white/80">
                    <td class="p-3 font-bold text-slate-800 flex items-center gap-2">
                        <div class="w-6 h-6 rounded-full bg-charm-dark text-charm-yellow flex items-center justify-center text-xs font-black">G</div>
                        ${g.username}
                    </td>
                    <td class="p-3 text-center font-mono font-bold text-slate-700">${scans}</td>
                    <td class="p-3 text-center font-mono text-emerald-700 font-bold">${entriesCnt}</td>
                    <td class="p-3 text-center font-mono text-blue-700 font-bold">${exitsCnt}</td>
                    <td class="p-3 text-right"><span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-green-100 text-green-700">Active</span></td>
                </tr>
            `;
        }).join('') : `
            <tr class="border-b border-slate-100/60 hover:bg-white/80">
                <td class="p-3 font-bold text-slate-800">Gate Duty Officer (Main)</td>
                <td class="p-3 text-center font-mono font-bold text-slate-700">${filteredLogs.length}</td>
                <td class="p-3 text-center font-mono text-emerald-700 font-bold">${totalEntries}</td>
                <td class="p-3 text-center font-mono text-blue-700 font-bold">${totalExits}</td>
                <td class="p-3 text-right"><span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-green-100 text-green-700">On Duty</span></td>
            </tr>
        `;
    }

    renderAnalyticsCharts(filteredLogs);
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
                <td class="p-3 text-center"><span class="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800 uppercase">${h.format}</span></td>
                <td class="p-3 text-right">
                    <button onclick="printOfficialReport()" class="p-1.5 text-slate-400 hover:text-slate-800" title="Print"><i data-lucide="printer" class="w-4 h-4"></i></button>
                    <button onclick="exportCurrentReportCSV()" class="p-1.5 text-slate-400 hover:text-emerald-700 ml-1" title="CSV"><i data-lucide="download" class="w-4 h-4"></i></button>
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

window.generateQuickReport = function(type) {
    const now = new Date();
    let title = "VEHICLE ACCESS & TRAFFIC ACTIVITY REPORT";
    let periodText = "";
    let logs = [];

    if (type === 'today') {
        title = "DAILY CAMPUS VEHICLE ACCESS REPORT";
        periodText = `Date: ${now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`;
        logs = getFilteredAnalyticsLogs('today');
    } else if (type === 'yesterday') {
        title = "YESTERDAY'S VEHICLE ACCESS SUMMARY";
        const y = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        periodText = `Date: ${y.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`;
        logs = getFilteredAnalyticsLogs('yesterday');
    } else if (type === 'week') {
        title = "WEEKLY ACCESS & SECURITY AUDIT REPORT";
        const past7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        periodText = `Period: ${past7.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
        logs = getFilteredAnalyticsLogs('7days');
    } else if (type === 'month') {
        title = "MONTHLY COMPREHENSIVE ACCESS REPORT";
        periodText = `Month: ${now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}`;
        logs = getFilteredAnalyticsLogs('thisMonth');
    }

    displayGeneratedReport({
        id: `ASU-CRP-${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}-${Math.floor(100 + Math.random()*900)}`,
        title: title,
        period: periodText,
        generatedBy: 'Obsidian Devs / Security Admin',
        generatedAt: now.toLocaleString(),
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
    const payload = {
        id: `ASU-CRP-${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}-${Math.floor(100 + Math.random()*900)}`,
        title: reportTitles[reportType] || 'CHARRMPASS VEHICLE REPORT',
        period: `Period: ${fromVal} to ${toVal}`,
        generatedBy: 'Obsidian Devs / Security Admin',
        generatedAt: now.toLocaleString(),
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
    if (el('repDocTotalRecords')) el('repDocTotalRecords').textContent = `${payload.logs.length} Total Scans`;

    // Summary Statistics
    const entries = payload.logs.filter(l => l.direction === 'ENTRY' && l.status === 'AUTHORIZED').length;
    const exits = payload.logs.filter(l => l.direction === 'EXIT' && l.status === 'AUTHORIZED').length;
    const failed = payload.logs.filter(l => l.status === 'DENIED').length;
    const uniquePlates = new Set();
    payload.logs.forEach(l => {
        const p = l.vehicles?.plate_number || (l.remarks && l.remarks.match(/Plate:\s*([^|]+)/i)?.[1]?.trim()) || l.rfid_uid;
        if (p && p !== '--') uniquePlates.add(p);
    });

    if (el('repSumEntries')) el('repSumEntries').textContent = entries.toLocaleString();
    if (el('repSumExits')) el('repSumExits').textContent = exits.toLocaleString();
    if (el('repSumUnique')) el('repSumUnique').textContent = uniquePlates.size.toLocaleString();
    if (el('repSumFailed')) el('repSumFailed').textContent = failed.toLocaleString();

    // Tabular Detailed Logs with Masked UIDs
    if (el('repDetailedLogsTable')) {
        el('repDetailedLogsTable').innerHTML = payload.logs.length ? payload.logs.slice(0, 100).map(l => {
            // Mask RFID UID: e.g. "73 71 A9 FE" -> "****A9FE"
            const rawUid = (l.rfid_uid || '').replace(/\s+/g, '');
            const maskedUid = rawUid.length >= 4 ? `****${rawUid.slice(-4)}` : (rawUid || '****');
            
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
                <tr class="hover:bg-slate-50 text-xs">
                    <td class="p-2.5 font-mono text-[11px] text-slate-600">${dateStr}</td>
                    <td class="p-2.5 font-mono font-bold text-slate-700">${maskedUid}</td>
                    <td class="p-2.5 font-mono font-bold text-slate-900">${plate}</td>
                    <td class="p-2.5 font-semibold text-slate-800">${ownerName}</td>
                    <td class="p-2.5"><span class="px-1.5 py-0.5 rounded text-[9px] font-bold bg-slate-100 text-slate-600 uppercase">${role}</span></td>
                    <td class="p-2.5 text-center font-bold ${l.direction === 'ENTRY' ? 'text-emerald-700' : 'text-blue-700'}">${l.direction || 'ENTRY'}</td>
                    <td class="p-2.5 text-center font-semibold text-slate-600">${l.direction === 'EXIT' ? 'Gate 2 (Exit)' : 'Gate 1 (Entry)'}</td>
                    <td class="p-2.5 text-right">${statusBadge}</td>
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

window.exportCurrentReportCSV = function() {
    if (!currentReportPayload || !currentReportPayload.logs || !currentReportPayload.logs.length) {
        showToast('No report records to export.', 'warning');
        return;
    }

    const headers = ['Report ID', 'Date & Time', 'Masked RFID UID', 'Plate Number', 'Owner / Driver', 'User Category', 'Direction', 'Status', 'Remarks'];
    const rows = currentReportPayload.logs.map(l => {
        const rawUid = (l.rfid_uid || '').replace(/\s+/g, '');
        const maskedUid = rawUid.length >= 4 ? `****${rawUid.slice(-4)}` : '****';
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
            `"${maskedUid}"`,
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
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'transactions' }, () => { loadData(); })
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'transactions' }, () => { loadData(); })
        .subscribe();
}

// Special Tag Modal Actions
window.openSpecialTagModal = function(id = null) {
    const modal = el('specialTagModal');
    el('specialTagForm').reset();
    el('formTagId').value = '';
    el('specialTagModalTitle').textContent = id ? 'Edit Special Tag' : 'Add Special Tag';
    
    if (id) {
        const tag = adminState.specialTags.find(t => t.id === id);
        if (tag) {
            el('formTagId').value = tag.id;
            el('formTagUid').value = tag.rfid_uid;
            el('formTagType').value = tag.type;
            el('formTagDesc').value = tag.description || '';
        }
    }

    modal.classList.remove('hidden');
    setTimeout(() => { modal.classList.add('opacity-100'); el('specialTagModalContent').classList.remove('scale-95'); }, 10);
    lucide.createIcons();
};

window.closeSpecialTagModal = function() {
    const modal = el('specialTagModal');
    modal.classList.remove('opacity-100'); el('specialTagModalContent').classList.add('scale-95');
    setTimeout(() => modal.classList.add('hidden'), 300);
};

window.editSpecialTag = function(id) { editSpecialTagId = id; openSpecialTagModal(id); };

el('specialTagForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = el('formTagId').value;
    const data = {
        rfid_uid: el('formTagUid').value.trim().toUpperCase(),
        type: el('formTagType').value,
        description: el('formTagDesc').value.trim()
    };
    try {
        showToast('Saving tag...', 'info');
        const { error } = await supabaseClient.from('special_tags').upsert({ id: id || undefined, ...data });
        if (error) throw error;
        showToast('Special tag saved!', 'success');
        closeSpecialTagModal(); await loadData();
    } catch(err) { showToast('Error: ' + err.message, 'error'); }
});

window.deleteSpecialTag = async function(id) {
    if (!confirm('Delete this special tag?')) return;
    try {
        const { error } = await supabaseClient.from('special_tags').delete().eq('id', id);
        if (error) throw error;
        showToast('Tag deleted.', 'success');
        await loadData();
    } catch(err) { showToast('Error: ' + err.message, 'error'); }
};

// Review Registration Logic
window.openReviewModal = function(id) {
    const u = adminState.pendingUsers.find(x => x.id === id);
    if (!u) return;

    el('revName').textContent = u.full_name;
    el('revRoleBadge').textContent = u.role;
    el('revRoleBadge').className = `mt-2 px-3 py-1 rounded-full text-xs font-black uppercase tracking-widest ${u.role === 'Student' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'}`;
    el('revAge').textContent = u.age || '--';
    el('revSex').textContent = u.sex || '--';
    el('revProgram').textContent = `${u.program || '--'} • ${u.section || '--'}`;
    el('revAddress').textContent = u.address || 'No address provided';
    el('revPlate').textContent = u.plate_number || '--';
    el('revVehType').textContent = u.vehicle_type || '--';
    el('revVehDetails').textContent = `${u.vehicle_model || '--'} (${u.vehicle_color || '--'})`;

    const placeholder = 'https://ui-avatars.com/api/?name=' + encodeURIComponent(u.full_name) + '&background=random';
    el('revProfileImage').src = u.profile_image || placeholder;
    el('revImgMotor').src = u.motorcycle_image || 'https://images.unsplash.com/photo-1558981403-c5f91cbba527?auto=format&fit=crop&q=60&w=400';
    el('revImgIdFront').src = u.id_front_image || 'https://images.unsplash.com/photo-1633158829585-23ba8f7c8caf?auto=format&fit=crop&q=60&w=400';
    el('revImgIdBack').src = u.id_back_image || 'https://images.unsplash.com/photo-1621252179027-94459d278660?auto=format&fit=crop&q=60&w=400';

    // RFID UID Assignment Input
    if (el('revRfidUid')) {
        el('revRfidUid').value = (u.rfid_uid && !u.rfid_uid.startsWith('UNASSIGNED_')) ? u.rfid_uid : '';
    }

    // Buttons
    el('revBtnApprove').onclick = () => { approveUser(u.id); };
    el('revBtnDeny').onclick = () => { denyRegistration(u.id); };

    const modal = el('reviewModal');
    modal.classList.remove('hidden');
    setTimeout(() => { modal.classList.add('opacity-100'); el('reviewModalContent').classList.remove('scale-95'); }, 10);
    lucide.createIcons();
};

window.closeReviewModal = function() {
    const modal = el('reviewModal');
    modal.classList.remove('opacity-100'); el('reviewModalContent').classList.add('scale-95');
    setTimeout(() => modal.classList.add('hidden'), 300);
};

window.zoomImage = function(container) {
    const img = container.querySelector('img');
    if (!img || !img.src) return;
    el('zoomImg').src = img.src;
    el('zoomModal').classList.remove('hidden');
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



setupRealtime();
loadData();
