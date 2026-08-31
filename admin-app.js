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



// =====================
// VIEW SWITCHING
// =====================
function adminView(v) {
    document.querySelectorAll('.app-view').forEach(el=>{el.classList.add('hidden');el.classList.remove('flex');});
    const t = document.getElementById('aview-'+v);
    if(t){t.classList.remove('hidden');t.classList.add('flex');}
    document.querySelectorAll('.sidebar-item').forEach(s=>s.classList.remove('active'));
    const n = document.getElementById('anav-'+v);
    if(n) n.classList.add('active');
    if(v==='analytics') initCharts();
    renderAdmin();
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
            if (acc) adminState.accounts = acc;

            const {data:st, error:ste} = await supabaseClient.from('special_tags').select('*');
            if (ste) console.error('Special tags error:', ste);
            if (st) adminState.specialTags = st;

            console.log('✅ Admin data refreshed:', adminState.users.length, 'users,', adminState.logs.length, 'transactions,', adminState.activeVehicles, 'inside');
        } catch(e) {
            console.error('CRITICAL LOAD ERROR:', e);
            showToast('Database Error: ' + e.message, 'error');
        }
    } else {
        adminState.users = [...demoUsers];
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
        initCharts();
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
                            <i data-lucide="key-round" class="w-3.5 h-3.5"></i> Change Password / Username
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
        const recentLogs = adminState.logs.slice(0, 50);
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
                            <button onclick="editSpecialTag('${t.id}')" class="p-2 text-slate-400 hover:text-charm-dark transition-colors"><i data-lucide="edit-3" class="w-4 h-4"></i></button>
                            <button onclick="deleteSpecialTag('${t.id}')" class="p-2 text-slate-400 hover:text-red-500 transition-colors"><i data-lucide="trash-2" class="w-4 h-4"></i></button>
                        </td>
                    </tr>
                `;
            }).join('');
        } else {
            table.innerHTML = '<tr><td colspan="4" class="p-8 text-center text-slate-400">No special tags configured</td></tr>';
        }
    }
    
    lucide.createIcons();
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



// =====================
// ANALYTICS
// =====================
let chart1, chart3;
let analyticsRange = 'day';

window.setAnalyticsRange = function(range) {
    analyticsRange = range;
    document.querySelectorAll('.analytics-tab').forEach(btn => btn.classList.remove('active-range'));
    document.getElementById(`tab-${range}`).classList.add('active-range');
    initCharts();
};

function initCharts() {
    if(!window.Chart) return;
    
    // 1. Filter logs based on range
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

    // 2. Unique Activity Distribution (Unique entities per timeframe)
    const unique = { Student: new Set(), Faculty: new Set(), Staff: new Set(), Visitor: new Set(), Emergency: new Set() };
    
    filteredLogs.forEach(l => {
        if (l.is_emergency) {
            unique.Emergency.add(l.rfid_uid);
        } else if (l.visitor_name) {
            // Visitor uniqueness by name + UID
            unique.Visitor.add(l.visitor_name + (l.rfid_uid || ''));
        } else if (l.users) {
            const role = l.users.role;
            const uid = l.user_id || l.rfid_uid;
            if (role && unique[role]) {
                unique[role].add(uid);
            }
        }
    });

    const dataPoints = [
        unique.Student.size,
        unique.Faculty.size,
        unique.Staff.size,
        unique.Visitor.size,
        unique.Emergency.size
    ];

    const ctx1 = el('chartUserTypes');
    if(ctx1) {
        if(chart1) chart1.destroy();
        chart1 = new Chart(ctx1,{
            type:'doughnut',
            data:{
                labels:['Students','Faculty','Staff', 'Visitors', 'Emergency'],
                datasets:[{
                    data: dataPoints,
                    backgroundColor:['#0E4B3A','#1F6B4F','#F2B827', '#3B82F6', '#EF4444'],
                    borderWidth:0
                }]
            },
            options:{
                responsive:true,
                maintainAspectRatio:false,
                plugins:{legend:{position:'bottom', labels:{boxWidth:10, font:{size:10}}}}
            }
        });
    }

    // 3. Peak Hours
    const ctx3 = el('chartPeakHours');
    if(ctx3) {
        if(chart3) chart3.destroy();
        const hours = Array(24).fill(0);
        filteredLogs.forEach(l => { if(l.timestamp) { const h = new Date(l.timestamp).getHours(); hours[h]++; } });
        chart3 = new Chart(ctx3,{type:'line',data:{labels:hours.map((_,i)=>i+':00'),datasets:[{label:'Activity',data:hours,borderColor:'#1F6B4F',backgroundColor:'rgba(31,107,79,0.1)',fill:true,tension:0.4,borderWidth:3,pointRadius:0}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{y:{beginAtZero:true,grid:{color:'#f1f5f9'}},x:{grid:{display:false}}}}});
    }
}

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
