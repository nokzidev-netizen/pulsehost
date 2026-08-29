const ACCESS_TOKEN_KEY = 'pulsehost_access_token';

let accessPromise = null;
let gateWaiter = null;
let formReady = false;

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

function waitForAccessGateSubmit() {
  showAccessGateOverlay();
  return new Promise((resolve) => {
    gateWaiter = resolve;
  });
}

function finishGateAttempt(success) {
  if (!gateWaiter) return;
  const resolve = gateWaiter;
  gateWaiter = null;
  resolve(success);
}

async function submitAccessCode() {
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
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Code incorrect');

    setAccessToken(data.token);
    hideAccessGate();
    window.dispatchEvent(new Event('pulsehost-access-granted'));
    finishGateAttempt(true);
    return true;
  } catch (ex) {
    if (err) {
      err.textContent = ex.message || 'Erreur de connexion';
      err.classList.remove('hidden');
    }
    finishGateAttempt(false);
    return false;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Entrer';
    }
  }
}

function bindAccessForm() {
  if (formReady) return;
  const form = document.getElementById('access-gate-form');
  const btn = document.getElementById('access-gate-submit');
  const input = document.getElementById('access-code-input');
  if (!form) return;

  formReady = true;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submitAccessCode();
  });
  btn?.addEventListener('click', (e) => {
    e.preventDefault();
    submitAccessCode();
  });
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitAccessCode();
    }
  });
}

async function runAccessCheck() {
  bindAccessForm();

  try {
    const res = await fetch('/api/access/status', {
      headers: { 'X-Access-Token': getAccessToken() || '' },
    });
    const data = await res.json();
    if (!data.required || data.granted) {
      hideAccessGate();
      return true;
    }
  } catch {
    /* afficher le gate */
  }

  setAccessToken(null);

  let ok = false;
  while (!ok) {
    ok = await waitForAccessGateSubmit();
    if (!ok) await new Promise((r) => setTimeout(r, 200));
  }

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
  setAccessToken(null);
  return ensureSiteAccess();
}

window.ensureSiteAccess = ensureSiteAccess;
window.lockSiteAccess = lockSiteAccess;
window.hideAccessGate = hideAccessGate;

bindAccessForm();
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => ensureSiteAccess());
} else {
  ensureSiteAccess();
}
