const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const PREFIX = 'ph1:';

function deriveKey() {
  const secret = process.env.PULSE_SECRET_KEY
    || process.env.PULSE_ACCESS_CODE
    || 'pulsehost-dev-key-change-in-production';
  return crypto.createHash('sha256').update(secret).digest();
}

function encrypt(value) {
  if (!value || typeof value !== 'string') return value;
  if (value.startsWith(PREFIX)) return value;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, deriveKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64url')}:${tag.toString('base64url')}:${encrypted.toString('base64url')}`;
}

function decrypt(value) {
  if (!value || typeof value !== 'string') return value;
  if (!value.startsWith(PREFIX)) return value;

  try {
    const [, ivB64, tagB64, dataB64] = value.split(':');
    const decipher = crypto.createDecipheriv(
      ALGO,
      deriveKey(),
      Buffer.from(ivB64, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64url')),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  } catch {
    return '';
  }
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function maskSecret(value, visible = 4) {
  if (!value) return '';
  if (value.length <= visible * 2) return '••••••••';
  return `${value.slice(0, visible)}…${value.slice(-visible)}`;
}

module.exports = { encrypt, decrypt, safeEqual, maskSecret };
