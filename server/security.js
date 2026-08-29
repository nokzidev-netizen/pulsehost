const SENSITIVE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Cache-Control': 'no-store, no-cache, must-revalidate, private',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-src https:; base-uri 'self'; form-action 'self'",
};

const RATE_BUCKETS = new Map();
const WINDOW_MS = 60 * 1000;

function applySecurityHeaders(_req, res, next) {
  for (const [key, value] of Object.entries(SENSITIVE_HEADERS)) {
    res.setHeader(key, value);
  }
  res.removeHeader('X-Powered-By');
  next();
}

function getRateKey(req) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.headers['x-real-ip']
    || req.socket?.remoteAddress
    || 'unknown';
  return `${ip}:${req.path}`;
}

function rateLimit({ max = 120, windowMs = WINDOW_MS } = {}) {
  return (req, res, next) => {
    if (req.path.startsWith('/api/access/')) return next();
    const key = getRateKey(req);
    const now = Date.now();
    let bucket = RATE_BUCKETS.get(key);

    if (!bucket || now - bucket.start > windowMs) {
      bucket = { start: now, count: 0 };
      RATE_BUCKETS.set(key, bucket);
    }

    bucket.count += 1;
    if (bucket.count > max) {
      return res.status(429).json({ error: 'Trop de requêtes — réessaie dans un instant' });
    }
    next();
  };
}

function strictRateLimit(max = 15) {
  return rateLimit({ max, windowMs: WINDOW_MS });
}

function blockScanners(req, res, next) {
  const p = req.path.toLowerCase();
  const blocked = [
    '/.env', '/.git', '/wp-admin', '/wp-login', '/phpmyadmin',
    '/config', '/backup', '/.aws', '/server-status', '/actuator',
  ];
  if (blocked.some((b) => p.startsWith(b) || p.includes(b))) {
    return res.status(404).end();
  }
  next();
}

module.exports = {
  applySecurityHeaders,
  rateLimit,
  strictRateLimit,
  blockScanners,
};
