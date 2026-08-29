const CLIENT_KEY = 'pulsehost_client_id';
const PROJECTS_KEY = 'pulsehost_projects_cache';

function readCookie(name) {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function writeCookie(name, value, days = 365) {
  const maxAge = days * 24 * 60 * 60;
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${maxAge}; SameSite=Lax`;
}

function getClientId() {
  let id = null;
  try { id = localStorage.getItem(CLIENT_KEY); } catch { /* ignore */ }
  if (!id) id = readCookie(CLIENT_KEY);
  if (!id) {
    try { id = sessionStorage.getItem(CLIENT_KEY); } catch { /* ignore */ }
  }
  if (!id) {
    id = crypto.randomUUID();
  }
  try { localStorage.setItem(CLIENT_KEY, id); } catch { /* ignore */ }
  try { sessionStorage.setItem(CLIENT_KEY, id); } catch { /* ignore */ }
  writeCookie(CLIENT_KEY, id);
  return id;
}

function getCloudKey(projectId) {
  if (!projectId) return null;
  const k = `pulsehost_cloud_key_${projectId}`;
  try {
    return localStorage.getItem(k) || sessionStorage.getItem(k);
  } catch {
    return null;
  }
}

function setCloudKey(projectId, key) {
  if (!projectId || !key) return;
  const k = `pulsehost_cloud_key_${projectId}`;
  try { localStorage.setItem(k, key); } catch { /* ignore */ }
  try { sessionStorage.setItem(k, key); } catch { /* ignore */ }
}

function cacheProjects(projects) {
  try {
    localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects));
  } catch { /* ignore */ }
}

function loadCachedProjects() {
  try {
    const raw = localStorage.getItem(PROJECTS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

async function api(path, options = {}) {
  const headers = {
    'X-Client-Id': getClientId(),
    ...options.headers,
  };

  const projectMatch = path.match(/\/api\/projects\/([^/]+)/);
  if (projectMatch) {
    const cloudKey = getCloudKey(projectMatch[1]);
    if (cloudKey) headers['X-Cloud-Key'] = cloudKey;
  }

  if (!(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(path, { ...options, headers });
  const raw = await res.text();
  let data = {};
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      const plain = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (!res.ok) {
        throw new Error(plain.slice(0, 120) || `Erreur serveur (${res.status})`);
      }
    }
  }
  if (!res.ok) throw new Error(data.error || `Erreur serveur (${res.status})`);
  return data;
}

function showToast(msg, type = 'success') {
  const c = document.getElementById('toast-container');
  if (!c) return;
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatUptime(s) {
  if (!s) return '—';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
