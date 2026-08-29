const ACCESS_TOKEN_KEY = 'pulsehost_access_token';

let accessPromise = null;
let pendingResolve = null;
let submitting = false;

function getAccessToken() {
  return localStorage.getItem(ACCESS_TOKEN_KEY);
}

function setAccessToken(token) {
  if (token) localStorage.setItem(ACCESS_TOKEN_KEY, token);
  else localStorage.removeItem(ACCESS_TOKEN_KEY);
}

function hideAccessGate() {
  document.getElementById('access-gate')?.classList.add('hidden');
  document.body.classList.remove('access-locked');
}

function showAccessGateOverlay() {
  const overlay = document.getElementById('access-gate');
  if (!overlay) return;
  overlay.classList.remove('hidden');
  document.body.classList.add('access-locked');
  document.getElementById('access-code-input')?.focus();
}

async function fetchAccessStatus() {
  const res = await fetch('/api/access/status', {
    headers: { 'X-Access-Token': getAccessToken() || '' },
  });
  return res.json();
}

async function isAccessGranted() {
  try {
    const data = await fetchAccessStatus();
    return !data.required || data.granted;
  } catch {
    return false;
  }
}

function completeAccessFlow() {
  hideAccessGate();
  window.dispatchEvent(new Event('pulsehost-access-granted'));
  if (pendingResolve) {
    const done = pendingResolve;
    pendingResolve = null;
    done(true);
  }
}

async function submitAccessCode(e) {
  if (e) e.preventDefault();
  if (submitting) return;
  submitting = true;

  const input = document.getElementById('access-code-input');
  const err = document.getElementById('access-gate-error');
  const btn = document.getElementById('access-gate-submit');
  const code = input?.value || '';

  err?.classList.add('hidden');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Vérification...';
  }

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (typeof getClientId === 'function') headers['X-Client-Id'] = getClientId();

    const res = await fetch('/api/access/verify', {
      method: 'POST',
      headers,
      body: JSON.stringify({ code }),
    });

    let data = {};
    try {
      data = await res.json();
    } catch {
      data = {};
    }

    if (!res.ok) {
      throw new Error(data.error || `Erreur ${res.status}`);
    }

    if (!data.token) {
      throw new Error('Réponse serveur invalide');
    }

    setAccessToken(data.token);

    if (await isAccessGranted()) {
      completeAccessFlow();
      return;
    }

    throw new Error('Code accepté mais session non validée — réessaie');
  } catch (ex) {
    if (err) {
      err.textContent = ex.message || 'Erreur de connexion';
      err.classList.remove('hidden');
    }
  } finally {
    submitting = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Entrer';
    }
  }
}

function bindAccessForm() {
  const form = document.getElementById('access-gate-form');
  if (!form || form.dataset.bound === '1') return;
  form.dataset.bound = '1';
  form.addEventListener('submit', submitAccessCode);
}

async function runAccessCheck() {
  bindAccessForm();

  if (await isAccessGranted()) {
    hideAccessGate();
    return true;
  }

  showAccessGateOverlay();

  if (await isAccessGranted()) {
    hideAccessGate();
    return true;
  }

  await new Promise((resolve) => {
    pendingResolve = resolve;
  });

  return true;
}

function ensureSiteAccess() {
  if (!accessPromise) {
    accessPromise = runAccessCheck().catch((err) => {
      accessPromise = null;
      showAccessGateOverlay();
      bindAccessForm();
      throw err;
    });
  }
  return accessPromise;
}

function lockSiteAccess() {
  accessPromise = null;
  pendingResolve = null;
  setAccessToken(null);
  showAccessGateOverlay();
  bindAccessForm();
  accessPromise = runAccessCheck();
  return accessPromise;
}

window.ensureSiteAccess = ensureSiteAccess;
window.lockSiteAccess = lockSiteAccess;
window.submitAccessCode = submitAccessCode;

bindAccessForm();
ensureSiteAccess();
