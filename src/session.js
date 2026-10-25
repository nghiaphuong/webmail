const db = require('./db');
const { encrypt, decrypt, sha256, token } = require('./crypto');
const config = require('./config');

const COOKIE = { user: 'wm_sid', admin: 'wm_admin' };
const secure = config.publicUrl.startsWith('https://');
const cookieOpts = maxAge => ({ httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge });

// Cookie chứa chuỗi ngẫu nhiên; DB chỉ lưu sha256 của nó. Mật khẩu hộp thư được mã hóa bằng khóa
// dẫn xuất từ chính cookie, nên lộ DB cũng không giải mã được nếu không có cookie.
async function create(res, { kind, address = null, adminId = null, linkId = null, password = null, canSend = true, hours = 12, req }) {
  const raw = token(32);
  const id = sha256(raw);
  const expires = new Date(Date.now() + hours * 3600e3);
  await db.q(
    'INSERT INTO sessions (id, kind, address, admin_id, link_id, enc_secret, can_send, ip, ua, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [id, kind, address, adminId, linkId, password ? encrypt(password, raw) : null, canSend ? 1 : 0,
      req?.ip || '', String(req?.get('user-agent') || '').slice(0, 255), expires.toISOString().slice(0, 19).replace('T', ' ')]);
  res.cookie(kind === 'admin' ? COOKIE.admin : COOKIE.user, raw, cookieOpts(hours * 3600e3));
  return id;
}

async function load(raw) {
  if (!raw || raw.length > 100) return null;
  const s = await db.one('SELECT * FROM sessions WHERE id = ? AND expires_at > UTC_TIMESTAMP()', [sha256(raw)]);
  if (!s) return null;
  s.raw = raw;
  // Khóa dữ liệu (danh bạ, tùy chọn, thư cục bộ): mỗi khách demo có hộp thư riêng.
  s.owner = s.kind === 'demo' ? 'demo:' + s.id.slice(0, 24) : s.address;
  // Cập nhật last_seen tối đa mỗi phút một lần.
  if (Date.now() - Date.parse(s.last_seen + 'Z') > 60e3) db.q('UPDATE sessions SET last_seen = UTC_TIMESTAMP() WHERE id = ?', [s.id]).catch(() => {});
  return s;
}

async function destroy(req, res, kind) {
  const name = kind === 'admin' ? COOKIE.admin : COOKIE.user;
  const raw = req.cookies?.[name];
  if (raw) await db.q('DELETE FROM sessions WHERE id = ?', [sha256(raw)]);
  res.clearCookie(name, { path: '/' });
}

// Mật khẩu IMAP/SMTP của phiên: phiên người dùng giải mã bằng cookie; phiên qua đường link dùng mật khẩu hộp thư.
async function mailPassword(s) {
  if (s.kind === 'user') return decrypt(s.enc_secret, s.raw);
  if (s.kind === 'link') {
    const m = await db.one('SELECT enc_password FROM mailboxes WHERE address = ?', [s.address]);
    return m ? decrypt(m.enc_password) : null;
  }
  return null;
}

async function updatePassword(s, password) {
  if (s.kind === 'user') await db.q('UPDATE sessions SET enc_secret = ? WHERE id = ?', [encrypt(password, s.raw), s.id]);
}

const cleanup = () => db.q('DELETE FROM sessions WHERE expires_at < UTC_TIMESTAMP()').catch(() => {});

// Middleware: gắn req.mailSession (người dùng/khách qua link) và req.adminSession.
async function attach(req, res, next) {
  try {
    req.mailSession = await load(req.cookies?.[COOKIE.user]);
    if (req.mailSession && !['user', 'link', 'demo'].includes(req.mailSession.kind)) req.mailSession = null;
    if (req.mailSession?.kind === 'link') {
      const l = await db.one('SELECT revoked, expires_at FROM access_links WHERE id = ?', [req.mailSession.link_id]);
      if (!l || l.revoked || (l.expires_at && Date.parse(l.expires_at + 'Z') < Date.now())) req.mailSession = null;
    }
    if (req.mailSession && req.mailSession.kind !== 'demo') {
      const m = await db.one('SELECT status FROM mailboxes WHERE address = ?', [req.mailSession.address]);
      if (m && m.status === 'disabled') req.mailSession = null;
    }
    if (req.path.startsWith('/api/admin')) {
      req.adminSession = await load(req.cookies?.[COOKIE.admin]);
      if (req.adminSession && req.adminSession.kind !== 'admin') req.adminSession = null;
    }
    next();
  } catch (e) { next(e); }
}

module.exports = { create, load, destroy, mailPassword, updatePassword, cleanup, attach, COOKIE };
