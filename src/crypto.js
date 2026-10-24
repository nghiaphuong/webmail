const crypto = require('crypto');
const config = require('./config');
const db = require('./db');

let master = null;

// Khóa chính mã hóa mật khẩu hộp thư lưu trong DB. Ưu tiên ENCRYPTION_KEY, rồi SESSION_SECRET;
// nếu cả hai đều trống thì tự sinh và lưu trong DB (kém an toàn hơn, có cảnh báo).
async function init() {
  let secret = config.encryptionKey || config.sessionSecret;
  if (!secret) {
    secret = await db.getInternal('masterKey');
    if (!secret) {
      secret = crypto.randomBytes(32).toString('hex');
      await db.setInternal('masterKey', secret);
    }
    console.warn('WARNING: ENCRYPTION_KEY/SESSION_SECRET not set – using a key stored in the database');
  }
  master = crypto.createHash('sha256').update('webmail-master:' + secret).digest();
}

const derive = salt => Buffer.from(crypto.hkdfSync('sha256', master, Buffer.from(salt), Buffer.from('webmail'), 32));

function encrypt(text, salt = '') {
  if (text == null) return null;
  const key = salt ? derive(salt) : master;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return 'v1:' + Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}
function decrypt(blob, salt = '') {
  if (!blob || !blob.startsWith('v1:')) return null;
  try {
    const buf = Buffer.from(blob.slice(3), 'base64');
    const key = salt ? derive(salt) : master;
    const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
  } catch { return null; }
}

const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const token = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');

function randomString(len, alphabet) {
  let out = '';
  while (out.length < len) {
    const b = crypto.randomBytes(len * 2);
    for (const x of b) {
      // loại bỏ thiên lệch modulo
      if (x < 256 - (256 % alphabet.length)) out += alphabet[x % alphabet.length];
      if (out.length === len) break;
    }
  }
  return out;
}

// Mật khẩu đạt chính sách Hostinger: ≥ 8 ký tự, có chữ hoa, chữ thường, số và ký tự đặc biệt.
function strongPassword(len = 16) {
  const U = 'ABCDEFGHJKLMNPQRSTUVWXYZ', L = 'abcdefghijkmnopqrstuvwxyz', D = '23456789', S = '!@#$%^&*-_=+?';
  const all = U + L + D + S;
  const chars = [randomString(1, U), randomString(1, L), randomString(1, D), randomString(1, S), ...randomString(len - 4, all)];
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}
const passwordOk = p => typeof p === 'string' && p.length >= 8 && p.length <= 128 &&
  /[A-Z]/.test(p) && /[a-z]/.test(p) && /\d/.test(p) && /[^A-Za-z0-9]/.test(p);

// Băm mật khẩu admin bằng scrypt.
function hashPassword(p) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(p, salt, 64);
  return `scrypt$${salt.toString('base64')}$${h.toString('base64')}`;
}
function verifyPassword(p, stored) {
  const [alg, s, h] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const want = Buffer.from(h, 'base64');
  const got = crypto.scryptSync(String(p), Buffer.from(s, 'base64'), want.length);
  return crypto.timingSafeEqual(want, got);
}

module.exports = { init, encrypt, decrypt, sha256, token, randomString, strongPassword, passwordOk, hashPassword, verifyPassword };
