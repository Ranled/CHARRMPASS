/**
 * CHARRMPASS - Supabase Configuration & Core Helpers
 * Central configuration file for Supabase client, Realtime, and Storage
 */

const SUPABASE_URL = 'https://sdwjkgtxrpeajuymgpxp.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNkd2prZ3R4cnBlYWp1eW1ncHhwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgxMDA0ODEsImV4cCI6MjEwMzY3NjQ4MX0.ZLloaPDBQTMj_OMTgr5BX6VHqEK7Nc0bFnB7b35d4PA';

let supabaseClient = null;
let isConnected = false;
let isCheckingConnection = false;
let connectionHeartbeatInterval = null;

/**
 * Initialize Supabase Client
 */
function initSupabase() {
    try {
        if (window.supabase && SUPABASE_URL) {
            if (!supabaseClient) {
                supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
                    auth: { persistSession: false },
                    realtime: {
                        params: {
                            eventsPerSecond: 10
                        }
                    }
                });
            }
            isConnected = true;
            console.log('✅ Supabase Client initialized & connected');
            updateDBBadge();
            // Background verification ping
            checkRealtimeConnection();
        } else {
            console.warn('⚠️ Supabase JS SDK not loaded.');
            isConnected = false;
            updateDBBadge();
        }
    } catch (e) {
        console.warn('⚠️ Supabase initialization failed.', e);
        isConnected = false;
        updateDBBadge();
    }
    return { supabaseClient, isConnected };
}

/**
 * Active network verification: Pings Supabase to verify live database access
 */
async function checkRealtimeConnection() {
    if (isCheckingConnection) return isConnected;
    if (!supabaseClient) {
        isConnected = false;
        updateDBBadge();
        return false;
    }

    isCheckingConnection = true;
    try {
        // Fast lightweight head query to verify connectivity
        const { error } = await supabaseClient
            .from('system_accounts')
            .select('id', { count: 'exact', head: true });

        if (!error || error.code === 'PGRST116' || error.message?.includes('0 rows')) {
            isConnected = true;
            console.log('🟢 Supabase Connected (Live database verified)');
            window.dispatchEvent(new CustomEvent('supabase:connected', { detail: { client: supabaseClient } }));
        } else {
            // Check fallback table in case system_accounts permissions differ
            const { error: altErr } = await supabaseClient
                .from('devices')
                .select('id', { count: 'exact', head: true });
            
            if (!altErr) {
                isConnected = true;
                console.log('🟢 Supabase Connected (Live fallback verified)');
                window.dispatchEvent(new CustomEvent('supabase:connected', { detail: { client: supabaseClient } }));
            } else {
                throw error || altErr;
            }
        }
    } catch (err) {
        console.warn('⚠️ Supabase live ping failed (Running in Local / Demo Mode):', err.message || err);
        isConnected = false;
        window.dispatchEvent(new CustomEvent('supabase:disconnected', { detail: { error: err } }));
    } finally {
        isCheckingConnection = false;
        updateDBBadge();
    }
    return isConnected;
}

/**
 * Update DB Status Badge across any page element
 */
function updateDBBadge() {
    const badges = document.querySelectorAll('#dbStatusBadge, .db-status-badge');
    const settingsBadge = document.getElementById('settingsDbStatus');

    badges.forEach(badge => {
        const isDark = document.body.classList.contains('bg-[#051411]') || 
                       document.getElementById('dashboard')?.classList.contains('dark') ||
                       window.location.pathname.includes('entry') ||
                       window.location.pathname.includes('exit');

        if (isConnected) {
            if (isDark) {
                badge.innerHTML = `
                    <span class="relative flex h-2 w-2">
                        <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                        <span class="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                    </span>
                    <span class="text-emerald-400 font-bold tracking-wide">Supabase Connected</span>
                `;
                badge.className = "flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-950/70 border border-emerald-500/40 shadow-sm text-[11px] font-bold uppercase tracking-wider backdrop-blur-md";
            } else {
                badge.innerHTML = `
                    <span class="relative flex h-2 w-2">
                        <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                        <span class="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
                    </span>
                    <span class="text-green-800 font-bold tracking-wide">Supabase Connected</span>
                `;
                badge.className = "flex items-center gap-2 px-3 py-1.5 rounded-full bg-green-100/90 border border-green-300 shadow-sm text-[11px] font-bold uppercase tracking-wider";
            }
            badge.title = "Supabase Cloud Database Connected & Active (sdwjkgtxrpeajuymgpxp)";
        } else if (isCheckingConnection) {
            badge.innerHTML = `
                <span class="relative flex h-2 w-2">
                    <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                    <span class="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
                </span>
                <span class="text-amber-700 font-bold tracking-wide">Connecting...</span>
            `;
            badge.className = "flex items-center gap-2 px-3 py-1.5 rounded-full bg-amber-100 border border-amber-200 shadow-sm text-[11px] font-bold uppercase tracking-wider";
            badge.title = "Connecting to Supabase Cloud...";
        } else {
            badge.innerHTML = `
                <span class="relative flex h-2 w-2">
                    <span class="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
                </span>
                <span class="text-amber-700 font-bold tracking-wide">Demo / Offline</span>
            `;
            badge.className = "flex items-center gap-2 px-3 py-1.5 rounded-full bg-amber-100 border border-amber-200 shadow-sm text-[11px] font-bold uppercase tracking-wider";
            badge.title = "Database Offline or Local Mode";
        }
    });

    if (settingsBadge) {
        if (isConnected) {
            settingsBadge.textContent = 'Connected (Supabase Cloud)';
            settingsBadge.className = 'text-sm font-bold text-green-600 mt-1';
        } else {
            settingsBadge.textContent = 'Offline (Local Demo)';
            settingsBadge.className = 'text-sm font-bold text-amber-600 mt-1';
        }
    }
}

// Toast notification system
function showToast(message, type = 'success') {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'toast';
    
    const iconMap = {
        success: { icon: 'check-circle', bg: 'bg-green-100', color: 'text-green-600' },
        error: { icon: 'x-circle', bg: 'bg-red-100', color: 'text-red-600' },
        warning: { icon: 'alert-triangle', bg: 'bg-yellow-100', color: 'text-yellow-600' },
        info: { icon: 'info', bg: 'bg-blue-100', color: 'text-blue-600' }
    };
    
    const t = iconMap[type] || iconMap.info;
    
    toast.innerHTML = `
        <div class="w-10 h-10 rounded-full ${t.bg} ${t.color} flex items-center justify-center shrink-0">
            <i data-lucide="${t.icon}" class="w-5 h-5"></i>
        </div>
        <div>
            <div class="text-sm font-bold text-slate-800">${type.charAt(0).toUpperCase() + type.slice(1)}</div>
            <div class="text-xs text-slate-500">${message}</div>
        </div>
        <button onclick="this.parentElement.classList.remove('show'); setTimeout(()=>this.parentElement.remove(),400)" class="text-slate-400 hover:text-slate-600 ml-2">
            <i data-lucide="x" class="w-4 h-4"></i>
        </button>
    `;
    
    document.body.appendChild(toast);
    if (window.lucide) lucide.createIcons();
    
    requestAnimationFrame(() => {
        toast.classList.add('show');
    });
    
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 400);
    }, 4000);
}

// Real-time clock
function startClock() {
    const clockEl = document.getElementById('realTimeClock');
    const dateEl = document.getElementById('currentDate');
    
    function updateClock() {
        const now = new Date();
        if (clockEl) clockEl.textContent = now.toLocaleTimeString('en-US', { hour12: false });
        if (dateEl) dateEl.textContent = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'short', day: 'numeric' });
    }
    
    updateClock();
    setInterval(updateClock, 1000);
}

// Security: Session Expiration Check (12-hour validity)
function enforceAuthSession(requiredRole = null) {
    const raw = sessionStorage.getItem('charrmpass_session');
    if (!raw) {
        window.location.href = 'index.html';
        return null;
    }
    try {
        const session = JSON.parse(raw);
        const maxAge = 12 * 60 * 60 * 1000; // 12 hours
        if (!session.loginTime || (Date.now() - session.loginTime > maxAge)) {
            sessionStorage.removeItem('charrmpass_session');
            window.location.href = 'index.html';
            return null;
        }
        if (requiredRole && session.role !== requiredRole && session.role !== 'ADMIN') {
            window.location.href = 'index.html';
            return null;
        }
        return session;
    } catch (e) {
        sessionStorage.removeItem('charrmpass_session');
        window.location.href = 'index.html';
        return null;
    }
}

// Helper for Storage / Base64 photo handling
async function uploadImageToStorage(dataUrl, bucket, fileName) {
    if (!isConnected || !supabaseClient || !dataUrl || !dataUrl.startsWith('data:')) {
        return dataUrl;
    }
    try {
        const res = await fetch(dataUrl);
        const blob = await res.blob();
        const fileExt = blob.type.split('/')[1] || 'jpg';
        const cleanPath = `${fileName}_${Date.now()}.${fileExt}`;

        const { data, error } = await supabaseClient.storage
            .from(bucket)
            .upload(cleanPath, blob, {
                cacheControl: '3600',
                upsert: true
            });

        if (error) {
            console.warn(`Storage upload to [${bucket}] failed, using compressed base64 fallback:`, error.message);
            return dataUrl;
        }

        const { data: publicData } = supabaseClient.storage
            .from(bucket)
            .getPublicUrl(cleanPath);

        return publicData.publicUrl || dataUrl;
    } catch (e) {
        console.warn('Storage helper fallback:', e);
        return dataUrl;
    }
}

// Heartbeat and Network Listeners
function setupConnectionHeartbeat() {
    if (connectionHeartbeatInterval) clearInterval(connectionHeartbeatInterval);
    connectionHeartbeatInterval = setInterval(() => {
        checkRealtimeConnection();
    }, 30000); // 30s heartbeat

    window.addEventListener('online', () => {
        console.log('🌐 Network online detected, reconnecting Supabase...');
        checkRealtimeConnection();
    });

    window.addEventListener('offline', () => {
        console.warn('🌐 Network offline detected');
        isConnected = false;
        updateDBBadge();
    });
}

// Auto-run on script load
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        initSupabase();
        setupConnectionHeartbeat();
    });
} else {
    initSupabase();
    setupConnectionHeartbeat();
}

