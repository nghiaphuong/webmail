const express = require('express');
const db = require('../db');
const config = require('../config');
const session = require('../session');
const provision = require('../provision');
const stores = require('../mail/store');
const smtp = require('../mail/smtp');
const notify = require('../notify');
const crypto = require('../crypto');
const { wrap, fail, limited, isEmail, isLocalPart, isDomain, str, int, sqlDate } = require('../util');

const router = express.Router();
const actor = req => 'admin:' + (req.adminSession?.username || req.adminSession?.admin_id);

// ---------- Đăng nhập quản trị ----------
let setupCode = null;
async function bootstrap() {
  const { user, password } = config.admin;
  const n = Number((await db.one('SELECT COUNT(*) n FROM admins')).n);
  if (user && password && !(await db.one('SELECT id FROM admins WHERE username = ?', [user]))) {
    await db.q('INSERT INTO admins (username, pass_hash) VALUES (?, ?)', [user, crypto.hashPassword(password)]);
    console.log(`Admin account "${user}" created from ADMIN_USER/ADMIN_PASSWORD`);
  } else if (!n) {
    setupCode = crypto.randomString(10, 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789');
    console.log(`No admin account yet. Open /admin and use setup code: ${setupCode}`);
  }
}

router.get('/status', wrap(async (req, res) => {
  res.json({ loggedIn: !!req.adminSession, needsSetup: !!setupCode, appName: db.settings().appName, username: req.adminSession ? (await adminRow(req))?.username : null });
}));
const adminRow = req => db.one('SELECT id, username FROM admins WHERE id = ?', [req.adminSession.admin_id]);

router.post('/setup', wrap(async (req, res) => {
  if (!setupCode) fail(400, 'setup_done');
  if (limited('setup:' + req.ip, 10, 3600e3)) fail(429, 'too_many_attempts');
  const { code, username, password } = req.body || {};
  if (String(code || '').trim().toUpperCase() !== setupCode) fail(403, 'invalid_setup_code');
  if (!/^[a-zA-Z0-9._-]{3,64}$/.test(username || '') || !crypto.passwordOk(password)) fail(400, 'invalid_input');
  await db.q('INSERT INTO admins (username, pass_hash) VALUES (?, ?)', [username, crypto.hashPassword(password)]);
  setupCode = null;
  res.json({ ok: true });
}));

router.post('/login', wrap(async (req, res) => {
  const { username, password } = req.body || {};
  if (limited('admin-login:' + req.ip, 10, 15 * 60e3)) fail(429, 'too_many_attempts');
  const a = await db.one('SELECT * FROM admins WHERE username = ?', [str(username, 64)]);
  if (!a || !crypto.verifyPassword(String(password || ''), a.pass_hash)) {
    await db.audit('admin:' + str(username, 64), 'admin_login_failed', '', '', req.ip);
    fail(401, 'invalid_credentials');
  }
  await db.q('UPDATE admins SET last_login = UTC_TIMESTAMP() WHERE id = ?', [a.id]);
  await session.create(res, { kind: 'admin', adminId: a.id, hours: 12, req });
  await db.audit('admin:' + a.username, 'admin_login', '', '', req.ip);
  res.json({ ok: true });
}));

router.post('/logout', wrap(async (req, res) => { await session.destroy(req, res, 'admin'); res.json({ ok: true }); }));

router.use(wrap(async (req, res, next) => {
  if (!req.adminSession) fail(401, 'not_logged_in');
  const a = await adminRow(req);
  if (!a) fail(401, 'not_logged_in');
  req.adminSession.username = a.username;
  next();
}));

// ---------- Tổng quan ----------
router.get('/stats', wrap(async (req, res) => {
  const count = async (sql, a = []) => Number((await db.one(sql, a)).n);
  res.json({
    mailboxes: await count('SELECT COUNT(*) n FROM mailboxes'),
    byKind: await db.q('SELECT kind, COUNT(*) n FROM mailboxes GROUP BY kind'),
    pendingProvision: await count("SELECT COUNT(*) n FROM mailboxes WHERE status = 'pending_provision'"),
    disabled: await count("SELECT COUNT(*) n FROM mailboxes WHERE status = 'disabled'"),
    pendingRegistrations: await count("SELECT COUNT(*) n FROM registrations WHERE status = 'pending'"),
    activeLinks: await count('SELECT COUNT(*) n FROM access_links WHERE revoked = 0 AND (expires_at IS NULL OR expires_at > UTC_TIMESTAMP())'),
    activeSessions: await count("SELECT COUNT(*) n FROM sessions WHERE kind IN ('user','link') AND expires_at > UTC_TIMESTAMP() AND last_seen > UTC_TIMESTAMP() - INTERVAL 1 DAY"),
    domains: await count('SELECT COUNT(*) n FROM domains'),
    provisioner: provision.mode(),
    protocol: db.settings().protocol,
    recent: await db.q('SELECT actor, action, target, created_at FROM audit_log ORDER BY id DESC LIMIT 12'),
  });
}));

// ---------- Tên miền ----------
router.get('/domains', wrap(async (req, res) => {
  res.json({ domains: await db.q(`SELECT d.*, (SELECT COUNT(*) FROM mailboxes m WHERE m.domain_id = d.id) mailboxes
    FROM domains d ORDER BY d.domain`) });
}));
router.post('/domains', wrap(async (req, res) => {
  const domain = str(req.body.domain, 190).toLowerCase().replace(/^@/, '');
  if (!isDomain(domain)) fail(400, 'invalid_domain');
  if (await db.one('SELECT id FROM domains WHERE domain = ?', [domain])) fail(409, 'domain_exists');
  const r = await db.q('INSERT INTO domains (domain, allow_registration, hostinger_order_id) VALUES (?, ?, ?)',
    [domain, req.body.allowRegistration ? 1 : 0, str(req.body.hostingerOrderId, 64) || null]);
  let warning = null;
  if (provision.mode() === 'hostinger' && !req.body.hostingerOrderId) {
    try {
      const o = (await provision.listOrders()).find(x => x.domain === domain);
      if (o) await db.q('UPDATE domains SET hostinger_order_id = ? WHERE id = ?', [o.id, r.insertId]);
      else warning = 'no_hostinger_order';
    } catch (e) { warning = e.message; }
  }
  await db.audit(actor(req), 'domain_added', domain, '', req.ip);
  res.json({ ok: true, id: r.insertId, warning });
}));
router.patch('/domains/:id', wrap(async (req, res) => {
  const id = int(req.params.id, 0);
  const b = req.body || {};
  const sets = [];
  const args = [];
  if ('allowRegistration' in b) { sets.push('allow_registration = ?'); args.push(b.allowRegistration ? 1 : 0); }
  if ('active' in b) { sets.push('active = ?'); args.push(b.active ? 1 : 0); }
  if ('hostingerOrderId' in b) { sets.push('hostinger_order_id = ?'); args.push(str(b.hostingerOrderId, 64) || null); }
  if (sets.length) await db.q(`UPDATE domains SET ${sets.join(', ')} WHERE id = ?`, [...args, id]);
  await db.audit(actor(req), 'domain_updated', String(id), JSON.stringify(b).slice(0, 300), req.ip);
  res.json({ ok: true });
}));
router.delete('/domains/:id', wrap(async (req, res) => {
  const id = int(req.params.id, 0);
  const d = await db.one('SELECT * FROM domains WHERE id = ?', [id]);
  if (!d) fail(404, 'not_found');
  if (Number((await db.one('SELECT COUNT(*) n FROM mailboxes WHERE domain_id = ?', [id])).n)) fail(409, 'domain_in_use');
  await db.q("DELETE FROM registrations WHERE domain_id = ? AND status <> 'pending'", [id]);
  if (await db.one("SELECT 1 x FROM registrations WHERE domain_id = ? AND status = 'pending'", [id])) fail(409, 'domain_in_use');
  await db.q('DELETE FROM domains WHERE id = ?', [id]);
  await db.audit(actor(req), 'domain_deleted', d.domain, '', req.ip);
  res.json({ ok: true });
}));
router.get('/hostinger/orders', wrap(async (req, res) => {
  if (provision.mode() !== 'hostinger') return res.json({ orders: [], configured: false });
  try { res.json({ orders: await provision.listOrders(), configured: true }); } catch (e) { fail(502, 'provider_error', e.message); }
}));

// ---------- Hộp thư ----------
const domainById = id => db.one('SELECT * FROM domains WHERE id = ?', [id]);
const linkUrl = t => `${config.publicUrl}/m/${t}`;

async function createLink(mailboxId, { canSend = true, expiresDays = 0, note = '' } = {}) {
  const t = crypto.token(24);
  const expires = expiresDays > 0 ? sqlDate(Date.now() + expiresDays * 86400e3) : null;
  const r = await db.q('INSERT INTO access_links (mailbox_id, token_hash, enc_token, can_send, expires_at, note) VALUES (?,?,?,?,?,?)',
    [mailboxId, crypto.sha256(t), crypto.encrypt(t), canSend ? 1 : 0, expires, str(note, 255)]);
  return { id: r.insertId, url: linkUrl(t), expires_at: expires, can_send: canSend ? 1 : 0 };
}

async function provisionMailbox(req, { local, domain, password, kind, displayName = '', note = '', keepPassword }) {
  const address = `${local}@${domain.domain}`;
  if (await db.one('SELECT id FROM mailboxes WHERE address = ?', [address])) fail(409, 'address_taken');
  let result;
  try { result = await provision.create(address, password, domain); } catch (e) { fail(502, 'provider_error', e.message); }
  const store = keepPassword || result.status === 'pending_provision';
  const r = await db.q('INSERT INTO mailboxes (address, domain_id, display_name, kind, status, provider_id, enc_password, note, created_by) VALUES (?,?,?,?,?,?,?,?,?)',
    [address, domain.id, str(displayName, 190), kind, result.status, result.providerId, store ? crypto.encrypt(password) : null, str(note, 500), actor(req)]);
  await db.audit(actor(req), 'mailbox_created', address, `${kind} ${result.status}`, req.ip);
  return { id: r.insertId, address, status: result.status };
}

router.get('/mailboxes', wrap(async (req, res) => {
  const where = ['1=1'];
  const args = [];
  const qtext = str(req.query.q, 100);
  if (qtext) { where.push('(m.address LIKE ? OR m.display_name LIKE ? OR m.note LIKE ?)'); const l = `%${qtext.replace(/[%_\\]/g, x => '\\' + x)}%`; args.push(l, l, l); }
  if (['admin', 'registered', 'random', 'external'].includes(req.query.kind)) { where.push('m.kind = ?'); args.push(req.query.kind); }
  if (['active', 'disabled', 'pending_provision'].includes(req.query.status)) { where.push('m.status = ?'); args.push(req.query.status); }
  if (req.query.domainId) { where.push('m.domain_id = ?'); args.push(int(req.query.domainId, 0)); }
  const page = int(req.query.page, 1, 1);
  const size = 50;
  const w = where.join(' AND ');
  const total = Number((await db.one(`SELECT COUNT(*) n FROM mailboxes m WHERE ${w}`, args)).n);
  const rows = await db.q(`SELECT m.id, m.address, m.display_name, m.kind, m.status, m.note, m.created_at, m.last_login, m.created_by,
      m.enc_password IS NOT NULL has_password,
      (SELECT COUNT(*) FROM access_links l WHERE l.mailbox_id = m.id AND l.revoked = 0 AND (l.expires_at IS NULL OR l.expires_at > UTC_TIMESTAMP())) links
    FROM mailboxes m WHERE ${w} ORDER BY m.created_at DESC, m.id DESC LIMIT ? OFFSET ?`, [...args, size, (page - 1) * size]);
  res.json({ total, page, size, mailboxes: rows });
}));

router.post('/mailboxes', wrap(async (req, res) => {
  const b = req.body || {};
  const domain = await domainById(int(b.domainId, 0));
  if (!domain) fail(400, 'invalid_domain');
  const local = str(b.local, 64).toLowerCase();
  if (!isLocalPart(local)) fail(400, 'invalid_local_part');
  const password = b.password || crypto.strongPassword(16);
  if (!crypto.passwordOk(password)) fail(400, 'weak_password');
  const mb = await provisionMailbox(req, { local, domain, password, kind: 'admin', displayName: b.displayName, note: b.note, keepPassword: !!b.keepPassword });
  let link = null;
  if (b.createLink) link = await createLink(mb.id, { canSend: b.linkCanSend !== false, expiresDays: int(b.linkExpiresDays, 0, 0, 3650) });
  res.json({ ...mb, password, link });
}));

// Tạo địa chỉ ngẫu nhiên kèm đường link truy cập không cần đăng nhập.
router.post('/mailboxes/random', wrap(async (req, res) => {
  const b = req.body || {};
  const domain = await domainById(int(b.domainId, 0));
  if (!domain) fail(400, 'invalid_domain');
  const length = int(b.length, 10, 4, 40);
  const count = int(b.count, 1, 1, 50);
  const sets = { alnum: 'abcdefghijklmnopqrstuvwxyz0123456789', letters: 'abcdefghijklmnopqrstuvwxyz', digits: '0123456789', hex: '0123456789abcdef' };
  const alphabet = sets[b.charset] || sets.alnum;
  const prefix = str(b.prefix, 20).toLowerCase();
  if (prefix && !/^[a-z0-9][a-z0-9._-]*$/.test(prefix)) fail(400, 'invalid_local_part');
  const out = [];
  for (let n = 0; n < count; n++) {
    let local = null;
    for (let tries = 0; tries < 20 && !local; tries++) {
      const cand = prefix + crypto.randomString(length, alphabet);
      if (isLocalPart(cand) && !(await db.one('SELECT id FROM mailboxes WHERE address = ?', [`${cand}@${domain.domain}`]))) local = cand;
    }
    if (!local) fail(500, 'could_not_generate');
    const password = crypto.strongPassword(20);
    try {
      const mb = await provisionMailbox(req, { local, domain, password, kind: 'random', displayName: b.displayName, note: b.note, keepPassword: true });
      const link = await createLink(mb.id, { canSend: b.canSend !== false, expiresDays: int(b.expiresDays, 0, 0, 3650), note: b.note });
      out.push({ ...mb, link, password: mb.status === 'pending_provision' ? password : undefined });
    } catch (e) {
      if (!out.length) throw e;
      out.push({ error: e.message });
      break;
    }
  }
  res.json({ created: out });
}));

router.get('/mailboxes/:id', wrap(async (req, res) => {
  const m = await db.one(`SELECT m.*, d.domain FROM mailboxes m LEFT JOIN domains d ON d.id = m.domain_id WHERE m.id = ?`, [int(req.params.id, 0)]);
  if (!m) fail(404, 'not_found');
  const links = (await db.q('SELECT * FROM access_links WHERE mailbox_id = ? ORDER BY id DESC', [m.id])).map(l => ({
    id: l.id, url: linkUrl(crypto.decrypt(l.enc_token) || ''), can_send: l.can_send, expires_at: l.expires_at, revoked: l.revoked,
    note: l.note, use_count: l.use_count, last_used: l.last_used, created_at: l.created_at,
  }));
  const sessions = Number((await db.one('SELECT COUNT(*) n FROM sessions WHERE address = ? AND expires_at > UTC_TIMESTAMP()', [m.address])).n);
  delete m.enc_password;
  res.json({ mailbox: { ...m, has_password: !!(await db.one('SELECT enc_password IS NOT NULL p FROM mailboxes WHERE id = ?', [m.id])).p }, links, sessions });
}));

router.patch('/mailboxes/:id', wrap(async (req, res) => {
  const m = await db.one('SELECT * FROM mailboxes WHERE id = ?', [int(req.params.id, 0)]);
  if (!m) fail(404, 'not_found');
  const b = req.body || {};
  if ('displayName' in b) await db.q('UPDATE mailboxes SET display_name = ? WHERE id = ?', [str(b.displayName, 190), m.id]);
  if ('note' in b) await db.q('UPDATE mailboxes SET note = ? WHERE id = ?', [str(b.note, 500), m.id]);
  if ('status' in b && ['active', 'disabled'].includes(b.status) && m.status !== 'pending_provision') {
    await db.q('UPDATE mailboxes SET status = ? WHERE id = ?', [b.status, m.id]);
    if (b.status === 'disabled') await db.q('DELETE FROM sessions WHERE address = ?', [m.address]);
    await db.audit(actor(req), 'mailbox_' + b.status, m.address, '', req.ip);
  }
  res.json({ ok: true });
}));

router.post('/mailboxes/:id/reveal', wrap(async (req, res) => {
  const m = await db.one('SELECT address, enc_password FROM mailboxes WHERE id = ?', [int(req.params.id, 0)]);
  if (!m || !m.enc_password) fail(404, 'no_stored_password');
  await db.audit(actor(req), 'password_revealed', m.address, '', req.ip);
  res.json({ password: crypto.decrypt(m.enc_password) });
}));

router.post('/mailboxes/:id/password', wrap(async (req, res) => {
  const m = await db.one('SELECT * FROM mailboxes WHERE id = ?', [int(req.params.id, 0)]);
  if (!m) fail(404, 'not_found');
  const password = req.body.password || crypto.strongPassword(m.kind === 'random' ? 20 : 16);
  if (!crypto.passwordOk(password)) fail(400, 'weak_password');
  const domain = await domainById(m.domain_id);
  let done = false;
  if (m.status !== 'pending_provision') {
    try { done = await provision.setPassword(m, domain, password); } catch (e) { fail(502, 'provider_error', e.message); }
  }
  // Chế độ thủ công: chỉ lưu mật khẩu mới (admin đổi tương ứng trong hPanel).
  const keep = m.enc_password || !done || req.body.keepPassword;
  await db.q('UPDATE mailboxes SET enc_password = ? WHERE id = ?', [keep ? crypto.encrypt(password) : null, m.id]);
  await db.q("DELETE FROM sessions WHERE address = ? AND kind = 'user'", [m.address]);
  await db.audit(actor(req), 'password_reset', m.address, done ? 'provider' : 'stored-only', req.ip);
  res.json({ ok: true, password, providerUpdated: done });
}));

// Chế độ thủ công: kiểm tra hộp thư đã được tạo trong hPanel chưa (đăng nhập thử bằng mật khẩu đã lưu).
router.post('/mailboxes/:id/verify', wrap(async (req, res) => {
  const m = await db.one('SELECT * FROM mailboxes WHERE id = ?', [int(req.params.id, 0)]);
  if (!m) fail(404, 'not_found');
  const pass = crypto.decrypt(m.enc_password);
  if (!pass) fail(400, 'no_stored_password');
  let ok = false;
  try { ok = await stores.verify(m.address, pass); } catch (e) { fail(502, 'mail_server_unreachable', e.message); }
  if (!ok) return res.json({ ok: false });
  const wasPending = m.status === 'pending_provision';
  await db.q("UPDATE mailboxes SET status = 'active' WHERE id = ? AND status = 'pending_provision'", [m.id]);
  if (wasPending && m.kind === 'registered') {
    await db.q('UPDATE mailboxes SET enc_password = NULL WHERE id = ?', [m.id]);
    const r = await db.one('SELECT contact_email, lang FROM registrations WHERE mailbox_id = ?', [m.id]);
    if (r?.contact_email) notify.approved(r.contact_email, r.lang, m.address).catch(() => {});
  }
  await db.audit(actor(req), 'mailbox_verified', m.address, '', req.ip);
  res.json({ ok: true });
}));

router.delete('/mailboxes/:id', wrap(async (req, res) => {
  const m = await db.one('SELECT * FROM mailboxes WHERE id = ?', [int(req.params.id, 0)]);
  if (!m) fail(404, 'not_found');
  let remoteDeleted = false;
  if (req.query.remote === '1' && m.status !== 'pending_provision') {
    try { remoteDeleted = await provision.remove(m, await domainById(m.domain_id)); } catch (e) { fail(502, 'provider_error', e.message); }
  }
  for (const t of ['user_prefs', 'local_folders']) await db.q(`DELETE FROM ${t} WHERE ${t === 'user_prefs' ? 'address' : 'owner'} = ?`, [m.address]);
  for (const t of ['contacts', 'local_messages', 'pop3_seen']) await db.q(`DELETE FROM ${t} WHERE owner = ?`, [m.address]);
  await db.q('DELETE FROM sessions WHERE address = ?', [m.address]);
  await db.q('DELETE FROM access_links WHERE mailbox_id = ?', [m.id]);
  await db.q('DELETE FROM mailboxes WHERE id = ?', [m.id]);
  await db.audit(actor(req), 'mailbox_deleted', m.address, remoteDeleted ? 'remote deleted' : 'local only', req.ip);
  res.json({ ok: true, remoteDeleted });
}));

// Nhập các hộp thư đã có trên Hostinger vào danh sách.
router.post('/mailboxes/sync', wrap(async (req, res) => {
  if (provision.mode() !== 'hostinger') fail(400, 'not_supported');
  const domains = req.body.domainId ? [await domainById(int(req.body.domainId, 0))] : await db.q('SELECT * FROM domains WHERE active = 1');
  let added = 0;
  const errors = [];
  for (const d of domains.filter(Boolean)) {
    try {
      for (const r of await provision.listRemoteMailboxes(d)) {
        const address = String(r.address || '').toLowerCase();
        if (!isEmail(address)) continue;
        const x = await db.q('INSERT IGNORE INTO mailboxes (address, domain_id, kind, status, provider_id, created_by) VALUES (?,?,?,?,?,?)',
          [address, d.id, 'external', r.status === 'suspended' ? 'disabled' : 'active', r.id, 'sync']);
        if (x.affectedRows) added++;
        else await db.q('UPDATE mailboxes SET provider_id = ? WHERE address = ? AND provider_id IS NULL', [r.id, address]);
      }
    } catch (e) { errors.push(`${d.domain}: ${e.message}`); }
  }
  res.json({ added, errors });
}));

// ---------- Đường link truy cập ----------
router.post('/mailboxes/:id/links', wrap(async (req, res) => {
  const m = await db.one('SELECT id, enc_password FROM mailboxes WHERE id = ?', [int(req.params.id, 0)]);
  if (!m) fail(404, 'not_found');
  if (!m.enc_password) fail(400, 'no_stored_password');
  const link = await createLink(m.id, { canSend: req.body.canSend !== false, expiresDays: int(req.body.expiresDays, 0, 0, 3650), note: req.body.note });
  await db.audit(actor(req), 'link_created', String(m.id), '', req.ip);
  res.json({ link });
}));
router.patch('/links/:id', wrap(async (req, res) => {
  const l = await db.one('SELECT * FROM access_links WHERE id = ?', [int(req.params.id, 0)]);
  if (!l) fail(404, 'not_found');
  const b = req.body || {};
  if ('revoked' in b) {
    await db.q('UPDATE access_links SET revoked = ? WHERE id = ?', [b.revoked ? 1 : 0, l.id]);
    if (b.revoked) await db.q('DELETE FROM sessions WHERE link_id = ?', [l.id]);
  }
  if ('canSend' in b) {
    await db.q('UPDATE access_links SET can_send = ? WHERE id = ?', [b.canSend ? 1 : 0, l.id]);
    await db.q('UPDATE sessions SET can_send = ? WHERE link_id = ?', [b.canSend ? 1 : 0, l.id]);
  }
  if ('expiresDays' in b) {
    const d = int(b.expiresDays, 0, 0, 3650);
    await db.q('UPDATE access_links SET expires_at = ? WHERE id = ?', [d ? sqlDate(Date.now() + d * 86400e3) : null, l.id]);
  }
  await db.audit(actor(req), 'link_updated', String(l.id), JSON.stringify(b).slice(0, 200), req.ip);
  res.json({ ok: true });
}));
router.delete('/links/:id', wrap(async (req, res) => {
  const id = int(req.params.id, 0);
  await db.q('DELETE FROM sessions WHERE link_id = ?', [id]);
  await db.q('DELETE FROM access_links WHERE id = ?', [id]);
  res.json({ ok: true });
}));

// ---------- Đơn đăng ký ----------
router.get('/registrations', wrap(async (req, res) => {
  const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
  res.json({ registrations: await db.q(`SELECT r.id, r.local_part, r.display_name, r.contact_email, r.reason, r.lang, r.status, r.reject_reason, r.ip,
      r.created_at, r.decided_at, r.decided_by, d.domain, r.mailbox_id
    FROM registrations r JOIN domains d ON d.id = r.domain_id WHERE r.status = ? ORDER BY r.id DESC LIMIT 500`, [status]) });
}));
router.post('/registrations/:id/approve', wrap(async (req, res) => {
  const r = await db.one("SELECT * FROM registrations WHERE id = ? AND status = 'pending'", [int(req.params.id, 0)]);
  if (!r) fail(404, 'not_found');
  const domain = await domainById(r.domain_id);
  const password = crypto.decrypt(r.enc_password);
  if (!password) fail(400, 'no_stored_password');
  const mb = await provisionMailbox(req, { local: r.local_part, domain, password, kind: 'registered', displayName: r.display_name, note: r.reason.slice(0, 500), keepPassword: false });
  await db.q("UPDATE registrations SET status = 'approved', enc_password = NULL, mailbox_id = ?, decided_by = ?, decided_at = UTC_TIMESTAMP() WHERE id = ?", [mb.id, actor(req), r.id]);
  if (mb.status === 'active' && r.contact_email) notify.approved(r.contact_email, r.lang, mb.address).catch(() => {});
  res.json({ ok: true, mailbox: mb });
}));
router.post('/registrations/:id/reject', wrap(async (req, res) => {
  const r = await db.one("SELECT r.*, d.domain FROM registrations r JOIN domains d ON d.id = r.domain_id WHERE r.id = ? AND r.status = 'pending'", [int(req.params.id, 0)]);
  if (!r) fail(404, 'not_found');
  const reason = str(req.body.reason, 500);
  await db.q("UPDATE registrations SET status = 'rejected', enc_password = NULL, reject_reason = ?, decided_by = ?, decided_at = UTC_TIMESTAMP() WHERE id = ?", [reason, actor(req), r.id]);
  await db.audit(actor(req), 'registration_rejected', `${r.local_part}@${r.domain}`, reason, req.ip);
  if (r.contact_email) notify.rejected(r.contact_email, r.lang, `${r.local_part}@${r.domain}`, reason).catch(() => {});
  res.json({ ok: true });
}));
router.delete('/registrations/:id', wrap(async (req, res) => {
  await db.q("DELETE FROM registrations WHERE id = ? AND status <> 'pending'", [int(req.params.id, 0)]);
  res.json({ ok: true });
}));

// ---------- Cài đặt máy chủ ----------
router.get('/settings', wrap(async (req, res) => {
  res.json({ settings: db.settings(), provisioner: provision.mode(), hostingerConfigured: !!config.hostingerToken, publicUrl: config.publicUrl,
    systemMailboxes: await db.q("SELECT id, address FROM mailboxes WHERE enc_password IS NOT NULL AND status = 'active' ORDER BY address") });
}));
function server(v, fallback) {
  if (!v || typeof v !== 'object') return fallback;
  const host = str(v.host, 190);
  if (!host || !/^[a-zA-Z0-9.-]+$/.test(host)) fail(400, 'invalid_host');
  return { host, port: int(v.port, fallback.port, 1, 65535), secure: !!v.secure };
}
router.put('/settings', wrap(async (req, res) => {
  const b = req.body || {};
  const cur = db.settings();
  const patch = {};
  if ('appName' in b) patch.appName = str(b.appName, 60) || cur.appName;
  if ('protocol' in b) patch.protocol = b.protocol === 'pop3' ? 'pop3' : 'imap';
  if ('imap' in b) patch.imap = server(b.imap, cur.imap);
  if ('pop3' in b) patch.pop3 = server(b.pop3, cur.pop3);
  if ('smtp' in b) patch.smtp = server(b.smtp, cur.smtp);
  if ('tlsInsecure' in b) patch.tlsInsecure = !!b.tlsInsecure;
  if ('pop3LeaveCopy' in b) patch.pop3LeaveCopy = !!b.pop3LeaveCopy;
  if ('registrationOpen' in b) patch.registrationOpen = !!b.registrationOpen;
  if ('linkDefaultCanSend' in b) patch.linkDefaultCanSend = !!b.linkDefaultCanSend;
  if ('notifyEmail' in b) { const e = str(b.notifyEmail, 254); if (e && !isEmail(e)) fail(400, 'invalid_email'); patch.notifyEmail = e; }
  if ('systemMailboxId' in b) patch.systemMailboxId = b.systemMailboxId ? int(b.systemMailboxId, null) : null;
  if ('demoEnabled' in b) patch.demoEnabled = !!b.demoEnabled;
  if ('demoEmail' in b) { const e = str(b.demoEmail, 254).toLowerCase(); if (!isEmail(e)) fail(400, 'invalid_email'); patch.demoEmail = e; }
  if ('demoPassword' in b) { const p = str(b.demoPassword, 64); if (p.length < 4) fail(400, 'invalid_input'); patch.demoPassword = p; }
  if ('maxUploadMb' in b) patch.maxUploadMb = int(b.maxUploadMb, 25, 1, 50);
  await db.saveSettings(patch);
  await db.audit(actor(req), 'settings_updated', '', Object.keys(patch).join(','), req.ip);
  res.json({ settings: db.settings() });
}));
router.post('/settings/test', wrap(async (req, res) => {
  const b = req.body || {};
  let address = str(b.address, 254).toLowerCase();
  let password = typeof b.password === 'string' ? b.password : '';
  if (!password && b.mailboxId) {
    const m = await db.one('SELECT address, enc_password FROM mailboxes WHERE id = ?', [int(b.mailboxId, 0)]);
    if (m) { address = m.address; password = crypto.decrypt(m.enc_password) || ''; }
  }
  const out = {};
  const t0 = Date.now();
  const run = async (k, fn) => {
    const t = Date.now();
    try { out[k] = { ok: !!(await fn()), ms: Date.now() - t }; } catch (e) { out[k] = { ok: false, error: e.message, ms: Date.now() - t }; }
  };
  if (b.hostinger) await run('hostinger', async () => (await provision.listOrders()).length >= 0);
  if (address && password) {
    const imap = require('../mail/imap');
    const pop3 = require('../mail/pop3');
    await run('imap', () => imap.verify(address, password));
    await run('pop3', () => pop3.verify(address, password));
    await run('smtp', () => smtp.verify(address, password));
  }
  res.json({ results: out, ms: Date.now() - t0 });
}));

// ---------- Quản trị viên & nhật ký ----------
router.get('/admins', wrap(async (req, res) => res.json({ admins: await db.q('SELECT id, username, created_at, last_login FROM admins ORDER BY id') })));
router.post('/admins', wrap(async (req, res) => {
  const { username, password } = req.body || {};
  if (!/^[a-zA-Z0-9._-]{3,64}$/.test(username || '') || !crypto.passwordOk(password)) fail(400, 'invalid_input');
  try { await db.q('INSERT INTO admins (username, pass_hash) VALUES (?, ?)', [username, crypto.hashPassword(password)]); } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') fail(409, 'exists'); throw e;
  }
  await db.audit(actor(req), 'admin_created', username, '', req.ip);
  res.json({ ok: true });
}));
router.delete('/admins/:id', wrap(async (req, res) => {
  const id = int(req.params.id, 0);
  if (id === req.adminSession.admin_id) fail(400, 'cannot_delete_self');
  await db.q('DELETE FROM admins WHERE id = ?', [id]);
  await db.q("DELETE FROM sessions WHERE kind = 'admin' AND admin_id = ?", [id]);
  await db.audit(actor(req), 'admin_deleted', String(id), '', req.ip);
  res.json({ ok: true });
}));
router.post('/password', wrap(async (req, res) => {
  const a = await db.one('SELECT * FROM admins WHERE id = ?', [req.adminSession.admin_id]);
  if (!crypto.verifyPassword(String(req.body.current || ''), a.pass_hash)) fail(400, 'wrong_password');
  if (!crypto.passwordOk(req.body.next)) fail(400, 'weak_password');
  await db.q('UPDATE admins SET pass_hash = ? WHERE id = ?', [crypto.hashPassword(req.body.next), a.id]);
  await db.q("DELETE FROM sessions WHERE kind = 'admin' AND admin_id = ? AND id <> ?", [a.id, req.adminSession.id]);
  await db.audit(actor(req), 'admin_password_changed', a.username, '', req.ip);
  res.json({ ok: true });
}));
router.get('/audit', wrap(async (req, res) => {
  const page = int(req.query.page, 1, 1);
  res.json({ entries: await db.q('SELECT * FROM audit_log ORDER BY id DESC LIMIT 100 OFFSET ?', [(page - 1) * 100]), page });
}));

module.exports = { router, bootstrap };
