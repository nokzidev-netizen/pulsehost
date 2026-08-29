const crypto = require('crypto');
const http = require('http');
const https = require('https');

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function isAccessRequired() {
  return Boolean(process.env.PULSE_ACCESS_CODE?.trim());
}

function getAccessCode() {
  return process.env.PULSE_ACCESS_CODE?.trim() || '';
}

function createAccessToken() {
  const secret = getAccessCode();
  if (!secret) return null;

  const exp = Date.now() + TOKEN_TTL_MS;
  const payload = JSON.stringify({ exp });
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return Buffer.from(JSON.stringify({ exp, sig })).toString('base64url');
}

function validateAccessToken(token) {
  if (!isAccessRequired()) return true;
  if (!token) return false;

  try {
    const data = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    const payload = JSON.stringify({ exp: data.exp });
    const sig = crypto.createHmac('sha256', getAccessCode()).update(payload).digest('hex');
    if (sig !== data.sig) return false;
    if (Date.now() > data.exp) return false;
    return true;
  } catch {
    return false;
  }
}

function verifyAccessCode(code) {
  if (!isAccessRequired()) return true;
  const { safeEqual } = require('./crypto');
  return safeEqual((code || '').trim(), getAccessCode());
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return req.headers['x-real-ip'] || req.socket?.remoteAddress || 'inconnue';
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, { timeout: 5000 }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(raw));
        } catch (err) {
          reject(err);
        }
      });
    }).on('error', reject);
  });
}

async function lookupGeo(ip) {
  if (!ip || ip === 'inconnue' || ip.startsWith('::') || ip.startsWith('127.') || ip === '::1') {
    return { country: 'Local', city: '—', region: '—', isp: '—', ip };
  }

  try {
    const data = await fetchJson(
      `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,regionName,city,isp,query`,
    );
    if (data.status !== 'success') return { country: '?', city: '?', region: '?', isp: '?', ip };
    return {
      country: data.country || '?',
      city: data.city || '?',
      region: data.regionName || '?',
      isp: data.isp || '?',
      ip: data.query || ip,
    };
  } catch {
    return { country: '?', city: '?', region: '?', isp: '?', ip };
  }
}

function postWebhook(url, body) {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(url);
      const lib = parsed.protocol === 'https:' ? https : http;
      const payload = JSON.stringify(body);
      const req = lib.request(
        parsed,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
          timeout: 8000,
        },
        () => resolve(),
      );
      req.on('error', () => resolve());
      req.write(payload);
      req.end();
    } catch {
      resolve();
    }
  });
}

async function notifyAccess(req, clientId) {
  const webhook = process.env.PULSE_DISCORD_WEBHOOK?.trim();
  if (!webhook) return;

  const ip = getClientIp(req);
  const geo = await lookupGeo(ip);
  const ua = req.headers['user-agent'] || '—';

  await postWebhook(webhook, {
    embeds: [{
      title: '🔐 Accès PulseHost autorisé',
      color: 0x6366f1,
      fields: [
        { name: 'IP', value: geo.ip || ip, inline: true },
        { name: 'Pays', value: geo.country, inline: true },
        { name: 'Ville', value: geo.city, inline: true },
        { name: 'Région', value: geo.region, inline: true },
        { name: 'FAI / ISP', value: geo.isp, inline: true },
        { name: 'Client ID', value: clientId ? `\`${clientId.slice(0, 12)}…\`` : '—', inline: true },
        { name: 'User-Agent', value: ua.slice(0, 200), inline: false },
      ],
      timestamp: new Date().toISOString(),
    }],
  });
}

module.exports = {
  isAccessRequired,
  createAccessToken,
  validateAccessToken,
  verifyAccessCode,
  notifyAccess,
  getClientIp,
};
