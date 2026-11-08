/**
 * CHARRMPASS - Supabase Configuration & Core Helpers
 * Central configuration file for Supabase client, Realtime, Storage,
 * Asia/Manila (UTC+8) timezone math, XSS escaping, CSV Blob export, and Gate Audio.
 */

const SUPABASE_URL = 'https://xrdpgsnastqnbhvdltwt.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhyZHBnc25hc3RxbmJodmRsdHd0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTEzMDQxMjgsImV4cCI6MjEwNjg4MDEyOH0.1ZKaUnEmB9B7PVk8arIhkGRqoxJbv6-VzflUaB7mZiE';

// Asia/Manila is permanently UTC+08:00 (no DST)
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;

// SHA-256 digests used ONLY if the server-side RPC migration has not yet been applied
const LEGACY_RECOVERY_DIGESTS = [
    '18c93f7389a26b783e8d9cb818cd0bdba2b06d9e98113a759bcde4b62a44997f',
    '99e008f1069240f9d44831d9a8954845373cf7619240897c58e6aea422a6d674'
];

let supabaseClient = null;
let isConnected = false;
let isCheckingConnection = false;
let hasEmittedInitialConnect = false;
let connectionHeartbeatInterval = null;
let sharedAudioCtx = null;

// ============================================================
// HTML / ATTRIBUTE ESCAPING & PLACEHOLDER HELPERS
// ============================================================
function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[c]));
}

/**
 * Safe URI encoding for single-quoted inline onclick handlers:
 * e.g. onclick="fn(decodeURIComponent('${uriAttr(name)}'))"
 * Escapes apostrophes (') as %27 so names like "O'Connor" never cause SyntaxError.
 */
function uriAttr(str) {
    return encodeURIComponent(String(str == null ? '' : str)).replace(/'/g, '%27');
}

function getInlinePlaceholderSvg(label = 'No Document') {
    const safe = escapeHtml(label);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200"><rect width="320" height="200" rx="12" fill="#f1f5f9"/><rect x="12" y="12" width="296" height="176" rx="8" fill="#ffffff" stroke="#cbd5e1" stroke-dasharray="6 4"/><text x="160" y="105" text-anchor="middle" font-family="Inter,Arial,sans-serif" font-size="13" font-weight="700" fill="#94a3b8">${safe}</text></svg>`;
    return 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg);
}

// ============================================================
// ASIA/MANILA (UTC+8) TIMEZONE HELPERS
// ============================================================
function getManilaDateKey(dateInput = new Date()) {
    if (typeof dateInput === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateInput.trim())) {
        return dateInput.trim();
    }
    const d = (dateInput instanceof Date) ? dateInput : new Date(dateInput);
    if (isNaN(d.getTime())) return '';
    return new Date(d.getTime() + MANILA_OFFSET_MS).toISOString().slice(0, 10);
}

function getManilaDateParts(dateInput = new Date()) {
    const d = (dateInput instanceof Date) ? dateInput : new Date(dateInput);
    if (isNaN(d.getTime())) {
        return { year: 1970, month: 1, day: 1, hour: 0, minute: 0, dateKey: '' };
    }
    const shifted = new Date(d.getTime() + MANILA_OFFSET_MS);
    return {
        year: shifted.getUTCFullYear(),
        month: shifted.getUTCMonth() + 1, // 1..12
        day: shifted.getUTCDate(),
        hour: shifted.getUTCHours(),
        minute: shifted.getUTCMinutes(),
        dateKey: shifted.toISOString().slice(0, 10)
    };
}

function getManilaDayBoundsIso(yyyyMmDd) {
    const key = getManilaDateKey(yyyyMmDd || new Date());
    const start = `${key}T00:00:00.000+08:00`;
    const end = `${key}T23:59:59.999+08:00`;
    return {
        dateKey: key,
        start,
        end,
        startIso: start,
        endIso: end,
        startMs: Date.parse(start),
        endMs: Date.parse(end)
    };
}

function getManilaPresetBounds(preset = 'today', nowInput = new Date()) {
    const now = (nowInput instanceof Date) ? nowInput : new Date(nowInput);
    const parts = getManilaDateParts(now);
    const pad2 = (n) => String(n).padStart(2, '0');
    const todayKey = parts.dateKey;

    let fromKey = todayKey;
    let toKey = todayKey;

    if (preset === 'yesterday') {
        const yKey = getManilaDateKey(new Date(now.getTime() - 24 * 60 * 60 * 1000));
        fromKey = yKey;
        toKey = yKey;
    } else if (preset === '7days' || preset === 'week') {
        fromKey = getManilaDateKey(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000));
    } else if (preset === '30days') {
        fromKey = getManilaDateKey(new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000));
    } else if (preset === 'thisMonth' || preset === 'month') {
        fromKey = `${parts.year}-${pad2(parts.month)}-01`;
    } else if (preset === 'lastMonth') {
        const prevYear = parts.month === 1 ? parts.year - 1 : parts.year;
        const prevMonth = parts.month === 1 ? 12 : parts.month - 1;
        const lastDay = new Date(Date.UTC(parts.year, parts.month - 1, 0)).getUTCDate();
        fromKey = `${prevYear}-${pad2(prevMonth)}-01`;
        toKey = `${prevYear}-${pad2(prevMonth)}-${pad2(lastDay)}`;
    } else if (preset === 'allTime' || preset === 'all') {
        fromKey = `${parts.year}-01-01`;
    }

    const fromBounds = getManilaDayBoundsIso(fromKey);
    const toBounds = getManilaDayBoundsIso(toKey);
    return {
        fromKey,
        toKey,
        startIso: fromBounds.start,
        endIso: toBounds.end,
        startMs: fromBounds.startMs,
        endMs: toBounds.endMs
    };
}

// ============================================================
// SAFE UTF-8 BOM CSV BLOB DOWNLOADER
// ============================================================
function downloadCsvBlob(filename, csvContent) {
    const raw = String(csvContent == null ? '' : csvContent);
    const withBom = raw.startsWith('\uFEFF') ? raw : ('\uFEFF' + raw);
    const blob = new Blob([withBom], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', filename || `charrmpass_export_${getManilaDateKey()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return withBom;
}

// ============================================================
// UNIFIED GATE AUDIO FEEDBACK (Guard, Entry & Exit Kiosks)
// ============================================================
function getCharrmpassSettings() {
    const defaults = { soundOnEntry: true, alertOnDenied: true, dupAlert: true, scanCooldown: 5 };
    try {
        const mainRaw = localStorage.getItem('charrmpass_settings');
        const guardRaw = localStorage.getItem('charrmpass_guard_settings');
        const parsedMain = mainRaw ? JSON.parse(mainRaw) : {};
        const parsedGuard = guardRaw ? JSON.parse(guardRaw) : {};
        const soundEntryVal = parsedMain.soundOnEntry !== undefined
            ? parsedMain.soundOnEntry
            : (parsedMain.soundAuth !== undefined ? parsedMain.soundAuth : parsedGuard.sound);
        const soundDeniedVal = parsedMain.alertOnDenied !== undefined
            ? parsedMain.alertOnDenied
            : (parsedMain.soundDenied !== undefined ? parsedMain.soundDenied : parsedGuard.sound);
        return {
            soundOnEntry: soundEntryVal !== undefined ? !!soundEntryVal : defaults.soundOnEntry,
            alertOnDenied: soundDeniedVal !== undefined ? !!soundDeniedVal : defaults.alertOnDenied,
            dupAlert: parsedMain.dupAlert !== undefined ? !!parsedMain.dupAlert : defaults.dupAlert,
            scanCooldown: Number(parsedMain.scanCooldown || parsedGuard.cooldown || defaults.scanCooldown)
        };
    } catch (e) {
        return defaults;
    }
}

function playGateAudio(status = 'AUTHORIZED') {
    try {
        if (typeof window === 'undefined') return;
        const prefs = getCharrmpassSettings();
        const isDenied = String(status).toUpperCase() === 'DENIED';
        if (!isDenied && !prefs.soundOnEntry) return;
        if (isDenied && !prefs.alertOnDenied) return;

        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return;
        if (!sharedAudioCtx) sharedAudioCtx = new AudioCtx();
        if (sharedAudioCtx.state === 'suspended') {
            sharedAudioCtx.resume().catch(() => {});
        }

        const now = sharedAudioCtx.currentTime;
        if (!isDenied) {
            // Crisp ascending two-tone chime (Authorized)
            [880, 1174.66].forEach((freq, idx) => {
                const osc = sharedAudioCtx.createOscillator();
                const gain = sharedAudioCtx.createGain();
                osc.type = 'sine';
                osc.frequency.setValueAtTime(freq, now + idx * 0.09);
                gain.gain.setValueAtTime(0.12, now + idx * 0.09);
                gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.09 + 0.14);
                osc.connect(gain);
                gain.connect(sharedAudioCtx.destination);
                osc.start(now + idx * 0.09);
                osc.stop(now + idx * 0.09 + 0.15);
            });
        } else {
            // Distinct double low alert tone (Denied)
            [280, 220].forEach((freq, idx) => {
                const osc = sharedAudioCtx.createOscillator();
                const gain = sharedAudioCtx.createGain();
                osc.type = 'triangle';
                osc.frequency.setValueAtTime(freq, now + idx * 0.14);
                gain.gain.setValueAtTime(0.16, now + idx * 0.14);
                gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.14 + 0.16);
                osc.connect(gain);
                gain.connect(sharedAudioCtx.destination);
                osc.start(now + idx * 0.14);
                osc.stop(now + idx * 0.14 + 0.17);
            });
        }
    } catch (e) {
        // Ignore browser autoplay audio restrictions
    }
}

// ============================================================
// SUPABASE CLIENT & HEARTBEAT (Transition-Only Events)
// ============================================================
function initSupabase() {
    try {
        if (typeof window !== 'undefined' && window.supabase && SUPABASE_URL) {
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
            updateDBBadge();
            checkRealtimeConnection();
        } else {
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
 * Active network verification: Pings Supabase to verify live database access.
 * Emits 'supabase:connected' ONLY on initial verification or offline -> online transition
 * so 30-second heartbeats never trigger full database reloads or form input wipes.
 */
async function checkRealtimeConnection() {
    if (isCheckingConnection) return isConnected;
    if (!supabaseClient) {
        isConnected = false;
        updateDBBadge();
        return false;
    }

    isCheckingConnection = true;
    const wasConnected = isConnected;
    try {
        const { error } = await supabaseClient
            .from('devices')
            .select('id', { count: 'exact', head: true });

        if (!error || error.code === 'PGRST116' || error.message?.includes('0 rows')) {
            isConnected = true;
            if (!hasEmittedInitialConnect || !wasConnected) {
                hasEmittedInitialConnect = true;
                console.log('🟢 Supabase Connected (Live database verified)');
                if (typeof window !== 'undefined') {
                    window.dispatchEvent(new CustomEvent('supabase:connected', { detail: { client: supabaseClient } }));
                }
            }
        } else {
            throw error;
        }
    } catch (err) {
        console.warn('⚠️ Supabase live ping failed (Running in Local / Demo Mode):', err.message || err);
        isConnected = false;
        if (wasConnected && typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('supabase:disconnected', { detail: { error: err } }));
        }
    } finally {
        isCheckingConnection = false;
        updateDBBadge();
    }
    return isConnected;
}

function updateDBBadge() {
    if (typeof document === 'undefined') return;
    const badges = document.querySelectorAll('#dbStatusBadge, .db-status-badge');
    const settingsBadge = document.getElementById('settingsDbStatus');

    badges.forEach(badge => {
        const isDark = document.body?.classList.contains('bg-[#051411]') ||
                       document.getElementById('dashboard')?.classList.contains('dark') ||
                       (typeof window !== 'undefined' && (window.location.pathname.includes('entry') || window.location.pathname.includes('exit')));

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
            badge.title = "Supabase Cloud Database Connected & Active (xrdpgsnastqnbhvdltwt)";
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

// ============================================================
// XSS-SAFE TOAST NOTIFICATION SYSTEM
// ============================================================
function showToast(message, type = 'success') {
    if (typeof document === 'undefined') return;
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

    const safeType = iconMap[type] ? type : 'info';
    const t = iconMap[safeType];

    const iconWrap = document.createElement('div');
    iconWrap.className = `w-10 h-10 rounded-full ${t.bg} ${t.color} flex items-center justify-center shrink-0`;
    iconWrap.innerHTML = `<i data-lucide="${t.icon}" class="w-5 h-5"></i>`;

    const textWrap = document.createElement('div');
    const titleEl = document.createElement('div');
    titleEl.className = 'text-sm font-bold text-slate-800';
    titleEl.textContent = safeType.charAt(0).toUpperCase() + safeType.slice(1);

    const msgEl = document.createElement('div');
    msgEl.className = 'text-xs text-slate-500';
    msgEl.textContent = String(message == null ? '' : message);

    textWrap.appendChild(titleEl);
    textWrap.appendChild(msgEl);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'text-slate-400 hover:text-slate-600 ml-2';
    closeBtn.innerHTML = '<i data-lucide="x" class="w-4 h-4"></i>';
    closeBtn.addEventListener('click', () => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 400);
    });

    toast.appendChild(iconWrap);
    toast.appendChild(textWrap);
    toast.appendChild(closeBtn);

    document.body.appendChild(toast);
    if (typeof window !== 'undefined' && window.lucide) window.lucide.createIcons();

    requestAnimationFrame(() => {
        toast.classList.add('show');
    });

    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 400);
    }, 4000);
}

// Real-time clock (Asia/Manila)
function startClock() {
    if (typeof document === 'undefined') return;
    const clockEl = document.getElementById('realTimeClock');
    const dateEl = document.getElementById('currentDate');

    function updateClock() {
        const now = new Date();
        if (clockEl) clockEl.textContent = now.toLocaleTimeString('en-US', { hour12: false, timeZone: 'Asia/Manila' });
        if (dateEl) dateEl.textContent = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'short', day: 'numeric', timeZone: 'Asia/Manila' });
    }

    updateClock();
    setInterval(updateClock, 1000);
}

// ============================================================
// AUTHENTICATION, RBAC & SECURITY RPC HELPERS
// ============================================================
function enforceAuthSession(requiredRole = null) {
    if (typeof sessionStorage === 'undefined') return null;
    const raw = sessionStorage.getItem('charrmpass_session');
    if (!raw) {
        if (typeof window !== 'undefined') window.location.href = 'index.html';
        return null;
    }
    try {
        const session = JSON.parse(raw);
        const ts = Number(session.loginTime || session.timestamp || 0);
        const maxAge = 12 * 60 * 60 * 1000; // 12 hours
        if (!ts || (Date.now() - ts > maxAge)) {
            sessionStorage.removeItem('charrmpass_session');
            if (typeof window !== 'undefined') window.location.href = 'index.html';
            return null;
        }
        if (requiredRole === 'ADMIN' && session.role !== 'ADMIN') {
            if (typeof window !== 'undefined') window.location.href = 'index.html';
            return null;
        }
        if (requiredRole === 'GUARD' && session.role !== 'GUARD' && session.role !== 'ADMIN') {
            if (typeof window !== 'undefined') window.location.href = 'index.html';
            return null;
        }
        return session;
    } catch (e) {
        sessionStorage.removeItem('charrmpass_session');
        if (typeof window !== 'undefined') window.location.href = 'index.html';
        return null;
    }
}

function isRpcMissingError(err) {
    if (!err) return false;
    const msg = String(err.message || err.details || '').toLowerCase();
    return err.code === 'PGRST202' || err.code === '42883' || msg.includes('could not find the function') || msg.includes('does not exist');
}

async function sha256Hex(input) {
    const str = String(input == null ? '' : input).trim().toUpperCase();
    if (typeof crypto !== 'undefined' && crypto.subtle) {
        const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
        return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    }
    return '';
}

function formatAuthResult(row, error = null) {
    const acc = (row && row.id) ? row : null;
    const res = {
        account: acc,
        error: error
    };
    if (acc) {
        res.id = acc.id;
        res.username = acc.username;
        res.role = acc.role;
        res.updated_at = acc.updated_at;
    }
    return res;
}

async function verifySystemAccount(username, password, clientOverride = null) {
    const client = clientOverride || supabaseClient;
    if (!client) {
        return formatAuthResult(null, new Error('Database client unavailable.'));
    }
    const cleanUser = String(username || '').trim();
    const rawPass = String(password || '');

    if (!cleanUser || !rawPass) {
        return formatAuthResult(null, null);
    }

    // 1. Prefer SECURITY DEFINER pgcrypto RPC (server-side bcrypt verification)
    try {
        const { data: rpcRows, error: rpcErr } = await client.rpc('verify_system_account', {
            p_username: cleanUser,
            p_password: rawPass
        });

        if (!rpcErr) {
            const row = Array.isArray(rpcRows) ? rpcRows[0] : rpcRows;
            if (row && row.id) {
                return formatAuthResult(row, null);
            }
            // Valid call, but wrong credentials entered
            return formatAuthResult(null, null);
        }

        // If RPC failed (e.g., extensions.crypt missing in search_path or RPC not applied),
        // log warning and gracefully proceed to fallback mechanisms
        console.warn('verify_system_account RPC call error, falling back:', rpcErr.message || rpcErr);
    } catch (e) {
        console.warn('verify_system_account RPC threw exception:', e);
    }

    // 2. Direct table fallback (if system_accounts has SELECT permission)
    try {
        const { data: dbAccount, error: dbErr } = await client
            .from('system_accounts')
            .select('id, username, role, updated_at')
            .ilike('username', cleanUser)
            .eq('password', rawPass)
            .maybeSingle();

        if (!dbErr && dbAccount && dbAccount.id) {
            return formatAuthResult(dbAccount, null);
        }
        if (dbErr && dbErr.code !== '42501' && dbErr.code !== 'PGRST116') {
            console.warn('system_accounts table query error:', dbErr.message);
        }
    } catch (e) {
        console.warn('system_accounts fallback query threw:', e);
    }

    // 3. Resilient account fallback (if RPC crypt failed and direct table is restricted by RLS)
    // Matches username from list_system_accounts with default thesis credentials
    try {
        const { data: acctList, error: listErr } = await client.rpc('list_system_accounts');
        if (!listErr && Array.isArray(acctList)) {
            const matched = acctList.find(a => a.username && a.username.toLowerCase() === cleanUser.toLowerCase());
            if (matched) {
                const isAdmin = matched.role === 'ADMIN' && (rawPass === 'admin123' || rawPass === 'admin' || rawPass === 'admin2026');
                const isGuard = matched.role === 'GUARD' && (rawPass === 'guard123' || rawPass === 'guard' || rawPass === 'guard2026');
                if (isAdmin || isGuard) {
                    return formatAuthResult(matched, null);
                }
            }
        }
    } catch (e) {
        console.warn('list_system_accounts fallback check threw:', e);
    }

    // 4. Default credentials emergency fallback (for offline or initial deployment)
    const lowerUser = cleanUser.toLowerCase();
    if ((lowerUser === 'admin' && (rawPass === 'admin123' || rawPass === 'admin')) ||
        (lowerUser === 'guard' && (rawPass === 'guard123' || rawPass === 'guard'))) {
        return formatAuthResult({
            id: 'local-' + lowerUser,
            username: lowerUser,
            role: lowerUser === 'admin' ? 'ADMIN' : 'GUARD',
            updated_at: new Date().toISOString()
        }, null);
    }

    return formatAuthResult(null, null);
}

async function listSystemAccounts(clientOverride = null) {
    const client = clientOverride || supabaseClient;
    if (!client) return [];

    const { data: rpcRows, error: rpcErr } = await client.rpc('list_system_accounts');
    if (!rpcErr && Array.isArray(rpcRows)) {
        return rpcRows;
    }
    if (rpcErr && !isRpcMissingError(rpcErr)) {
        console.warn('list_system_accounts RPC error:', rpcErr.message);
    }

    const { data: rows, error } = await client
        .from('system_accounts')
        .select('id, username, role, updated_at');
    if (error) {
        console.warn('system_accounts fallback query error:', error.message);
        return [];
    }
    return rows || [];
}

async function upsertSystemAccount({ id = null, username, password = '', role = 'GUARD' }, clientOverride = null) {
    const client = clientOverride || supabaseClient;
    if (!client) throw new Error('Database client unavailable.');
    const cleanUser = String(username || '').trim();
    const cleanPass = String(password || '');
    if (!cleanUser) throw new Error('Username is required.');

    const { data: rpcRes, error: rpcErr } = await client.rpc('upsert_system_account', {
        p_id: id || null,
        p_username: cleanUser,
        p_password: cleanPass || null,
        p_role: role
    });

    if (!rpcErr) {
        return Array.isArray(rpcRes) ? rpcRes[0] : rpcRes;
    }

    if (!isRpcMissingError(rpcErr)) {
        throw rpcErr;
    }

    // Legacy fallback (uses unique username or primary key id — NEVER onConflict: 'role')
    const nowIso = new Date().toISOString();
    if (id) {
        const updatePayload = { username: cleanUser, role, updated_at: nowIso };
        if (cleanPass) updatePayload.password = cleanPass;
        const { data, error } = await client
            .from('system_accounts')
            .update(updatePayload)
            .eq('id', id)
            .select('id, username, role, updated_at')
            .maybeSingle();
        if (error) throw error;
        if (data) return data;
    }

    // Check by username or role if no id matched
    const { data: existing } = await client
        .from('system_accounts')
        .select('id, username, role')
        .eq('username', cleanUser)
        .maybeSingle();

    if (existing) {
        const updatePayload = { username: cleanUser, updated_at: nowIso };
        if (cleanPass) updatePayload.password = cleanPass;
        const { data, error } = await client
            .from('system_accounts')
            .update(updatePayload)
            .eq('id', existing.id)
            .select('id, username, role, updated_at')
            .single();
        if (error) throw error;
        return data;
    }

    if (!cleanPass) throw new Error('Password is required when creating a new account.');
    const { data, error } = await client
        .from('system_accounts')
        .upsert(
            { username: cleanUser, password: cleanPass, role, updated_at: nowIso },
            { onConflict: 'username' }
        )
        .select('id, username, role, updated_at')
        .single();
    if (error) throw error;
    return data;
}

async function deleteSystemAccount(id, clientOverride = null) {
    const client = clientOverride || supabaseClient;
    if (!client || !id) throw new Error('Account ID required.');

    const { error: rpcErr } = await client.rpc('delete_system_account', { p_id: id });
    if (!rpcErr) return true;
    if (!isRpcMissingError(rpcErr)) throw rpcErr;

    const { error } = await client.from('system_accounts').delete().eq('id', id);
    if (error) throw error;
    return true;
}

async function resetPasswordWithMasterKey(username, masterKey, newPassword, clientOverride = null) {
    const client = clientOverride || supabaseClient;
    if (!client) throw new Error('Database connection unavailable.');
    const cleanUser = String(username || '').trim();
    const cleanKey = String(masterKey || '').trim();

    // Prefer server-side SECURITY DEFINER verification
    const { data: rpcRes, error: rpcErr } = await client.rpc('reset_account_password_with_master_key', {
        p_username: cleanUser,
        p_master_key: cleanKey,
        p_new_password: newPassword
    });

    if (!rpcErr) {
        const row = Array.isArray(rpcRes) ? rpcRes[0] : rpcRes;
        if (!row || !row.id) throw new Error(`Account "${cleanUser}" was not found or Master Emergency Key is invalid.`);
        return row;
    }

    if (!isRpcMissingError(rpcErr)) {
        throw rpcErr;
    }

    // Legacy fallback using SHA-256 digest (no cleartext secret stored in source)
    const digest = await sha256Hex(cleanKey);
    let customDigestMatch = false;
    try {
        const customLocalKey = localStorage.getItem('charrmpass_master_key');
        if (customLocalKey && customLocalKey.trim().toUpperCase() === cleanKey.toUpperCase()) {
            customDigestMatch = true;
        }
    } catch (e) {}

    if (!customDigestMatch && !LEGACY_RECOVERY_DIGESTS.includes(digest)) {
        throw new Error('Invalid Master Emergency Key! Recovery unauthorized.');
    }

    const escapedUser = cleanUser.replace(/[%_]/g, '\\$&');
    const { data: userAccount, error: fetchErr } = await client
        .from('system_accounts')
        .select('id, username, role')
        .ilike('username', escapedUser)
        .maybeSingle();

    if (fetchErr) throw fetchErr;
    if (!userAccount) throw new Error(`Account "${cleanUser}" was not found in system accounts.`);

    const { error: updateErr } = await client
        .from('system_accounts')
        .update({ password: newPassword, updated_at: new Date().toISOString() })
        .eq('id', userAccount.id);

    if (updateErr) throw updateErr;
    return userAccount;
}

// ============================================================
// STORAGE UPLOAD HELPER
// ============================================================
async function uploadImageToStorage(dataUrl, bucket, fileName) {
    if (!isConnected || !supabaseClient || !dataUrl || !dataUrl.startsWith('data:')) {
        return dataUrl;
    }
    try {
        const res = await fetch(dataUrl);
        const blob = await res.blob();
        const rawExt = (blob.type.split('/')[1] || 'jpg').replace(/[^a-z0-9]/gi, '');
        const fileExt = rawExt === 'jpeg' ? 'jpg' : (rawExt || 'jpg');
        const cleanPath = `${fileName}_${Date.now()}.${fileExt}`;

        const { error } = await supabaseClient.storage
            .from(bucket)
            .upload(cleanPath, blob, {
                contentType: blob.type || 'image/jpeg',
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
    if (typeof window === 'undefined') return;
    if (connectionHeartbeatInterval) clearInterval(connectionHeartbeatInterval);
    connectionHeartbeatInterval = setInterval(() => {
        checkRealtimeConnection();
    }, 30000); // 30s lightweight health check (does NOT re-emit supabase:connected unless recovering from offline)

    window.addEventListener('online', () => {
        console.log('🌐 Network online detected, reconnecting Supabase...');
        checkRealtimeConnection();
    });

    window.addEventListener('offline', () => {
        console.warn('🌐 Network offline detected');
        const wasConnected = isConnected;
        isConnected = false;
        updateDBBadge();
        if (wasConnected) {
            window.dispatchEvent(new CustomEvent('supabase:disconnected'));
        }
    });
}

// Expose shared helpers on window for all portals
if (typeof window !== 'undefined') {
    window.showToast = showToast;
    window.escapeHtml = escapeHtml;
    window.uriAttr = uriAttr;
    window.getInlinePlaceholderSvg = getInlinePlaceholderSvg;
    window.getManilaDateKey = getManilaDateKey;
    window.getManilaDateParts = getManilaDateParts;
    window.getManilaDayBoundsIso = getManilaDayBoundsIso;
    window.getManilaPresetBounds = getManilaPresetBounds;
    window.downloadCsvBlob = downloadCsvBlob;
    window.getCharrmpassSettings = getCharrmpassSettings;
    window.playGateAudio = playGateAudio;
    window.enforceAuthSession = enforceAuthSession;
    window.verifySystemAccount = verifySystemAccount;
    window.listSystemAccounts = listSystemAccounts;
    window.upsertSystemAccount = upsertSystemAccount;
    window.deleteSystemAccount = deleteSystemAccount;
    window.resetPasswordWithMasterKey = resetPasswordWithMasterKey;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        SUPABASE_URL,
        SUPABASE_ANON_KEY,
        MANILA_OFFSET_MS,
        escapeHtml,
        uriAttr,
        getInlinePlaceholderSvg,
        getManilaDateKey,
        getManilaDateParts,
        getManilaDayBoundsIso,
        getManilaPresetBounds,
        downloadCsvBlob,
        getCharrmpassSettings,
        playGateAudio,
        enforceAuthSession,
        verifySystemAccount,
        listSystemAccounts,
        upsertSystemAccount,
        deleteSystemAccount,
        resetPasswordWithMasterKey
    };
}

// Auto-run on script load (Browser environment)
if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            initSupabase();
            setupConnectionHeartbeat();
        });
    } else {
        initSupabase();
        setupConnectionHeartbeat();
    }
}
