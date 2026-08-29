const ACCESS_TOKEN_KEY = 'pulsehost_access_token';

function getAccessToken() {
  return localStorage.getItem(ACCESS_TOKEN_KEY);
}

function setAccessToken(token) {
  if (token) localStorage.setItem(ACCESS_TOKEN_KEY, token);
  else localStorage.removeItem(ACCESS_TOKEN_KEY);
}

function showAccessGate() {
  return new Promise((resolve) => {
    const overlay = document.getElementById('access-gate');
    if (!overlay) {
      resolve(true);
      return;
    }

    overlay.classList.remove('hidden');
    document.body.classList.add('access-locked');

    const form = document.getElementById('access-gate-form');
    const input = document.getElementById('access-code-input');
    const err = document.getElementById('access-gate-error');
    const btn = document.getElementById('access-gate-submit');

    const submit = async (e) => {
      e.preventDefault();
      err?.classList.add('hidden');
      if (btn) { btn.disabled = true; btn.textContent = 'Vérification...'; }

      try {
        const headers = { 'Content-Type': 'application/json' };
        if (typeof getClientId === 'function') headers['X-Client-Id'] = getClientId();

        const res = await fetch('/api/access/verify', {
          method: 'POST',
          headers,
          body: JSON.stringify({ code: input?.value || '' }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Code incorrect');

        setAccessToken(data.token);
        overlay.classList.add('hidden');
        document.body.classList.remove('access-locked');
        resolve(true);
      } catch (ex) {
        if (err) {
          err.textContent = ex.message;
          err.classList.remove('hidden');
        }
        resolve(false);
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Entrer'; }
      }
    };

    form?.removeEventListener('submit', submit);
    form?.addEventListener('submit', submit);
    input?.focus();
  });
}

async function ensureSiteAccess() {
  const overlay = document.getElementById('access-gate');
  let required = true;
  let granted = false;

  try {
    const res = await fetch('/api/access/status', {
      headers: { 'X-Access-Token': getAccessToken() || '' },
    });
    const data = await res.json();
    required = !!data.required;
    granted = !!data.granted;
  } catch {
    required = true;
    granted = false;
  }

  if (!required || granted) {
    overlay?.classList.add('hidden');
    document.body.classList.remove('access-locked');
    return true;
  }

  setAccessToken(null);
  document.body.classList.add('access-locked');
  overlay?.classList.remove('hidden');

  let ok = false;
  while (!ok) {
    ok = await showAccessGate();
    if (!ok) await new Promise((r) => setTimeout(r, 400));
  }

  return true;
}

function lockSiteAccess() {
  setAccessToken(null);
  const overlay = document.getElementById('access-gate');
  overlay?.classList.remove('hidden');
  document.body.classList.add('access-locked');
  return ensureSiteAccess();
}

function primeAccessGate() {
  const overlay = document.getElementById('access-gate');
  if (!overlay || getAccessToken()) return;
  overlay.classList.remove('hidden');
  document.body.classList.add('access-locked');
}

function startAccessGate() {
  if (!window.__accessGateStarted) {
    window.__accessGateStarted = true;
    primeAccessGate();
    window.pulseAccessReady = ensureSiteAccess();
  }
  return window.pulseAccessReady;
}

window.lockSiteAccess = lockSiteAccess;
window.ensureSiteAccess = ensureSiteAccess;

primeAccessGate();
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startAccessGate);
} else {
  startAccessGate();
}
