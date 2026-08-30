/**
 * CHARRMPASS - Supabase Configuration
 * Central configuration file for Supabase client
 */

const SUPABASE_URL = 'https://sdwjkgtxrpeajuymgpxp.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNkd2prZ3R4cnBlYWp1eW1ncHhwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgxMDA0ODEsImV4cCI6MjEwMzY3NjQ4MX0.ZLloaPDBQTMj_OMTgr5BX6VHqEK7Nc0bFnB7b35d4PA';

let supabaseClient = null;
let isConnected = false;

function initSupabase() {
    try {
        if (window.supabase && SUPABASE_URL) {
            supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
                auth: { persistSession: false }
            });
            isConnected = true;
            console.log('✅ Supabase connected (Auth persistence disabled)');
        }
    } catch (e) {
        console.warn('⚠️ Supabase not initialized. Running in Demo Mode.', e);
    }
    return { supabaseClient, isConnected };
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

// DB Status Badge update
function updateDBBadge() {
    const badge = document.getElementById('dbStatusBadge');
    if (!badge) return;
    
    if (isConnected) {
        badge.innerHTML = `<span class="relative flex h-2 w-2"><span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span><span class="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span></span><span class="text-green-700">Supabase Connected</span>`;
        badge.className = "flex items-center gap-2 px-3 py-1.5 rounded-full bg-green-100 border border-green-200 shadow-sm text-[10px] font-bold uppercase tracking-wide";
    }
}
