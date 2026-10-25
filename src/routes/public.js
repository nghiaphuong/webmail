const express = require('express');
const db = require('../db');
const session = require('../session');
const notify = require('../notify');
const { encrypt, decrypt, sha256, token, passwordOk } = require('../crypto');
const { wrap, fail, limited, isEmail, isLocalPart, RESERVED, str, int } = require('../util');

const router = express.Router();

router.get('/api/public/config', wrap(async (req, res) => {
  const s = db.settings();
  const domains = await db.q('SELECT id, domain FROM domains WHERE active = 1 AND allow_registration = 1 ORDER BY domain');
  res.json({ appName: s.appName, registrationOpen: !!s.registrationOpen && domains.length > 0, domains, demo: s.demoEnabled ? { email: s.demoEmail, password: s.demoPassword } : null });
}));

router.get('/api/public/check', wrap(async (req, res) => {
  if (limited('check:' + req.ip, 60, 60e3)) fail(429, 'too_many_attempts');
  const local = str(req.query.local, 64).toLowerCase();
  const d = await db.one('SELECT domain FROM domains WHERE id = ? AND active = 1 AND allow_registration = 1', [int(req.query.domainId, 0)]);
  if (!d || !isLocalPart(local)) return res.json({ available: false, reason: 'invalid' });
  if (RESERVED.has(local)) return res.json({ available: false, reason: 'reserved' });
  res.json({ available: !(await taken(local, d.domain, int(req.query.domainId, 0))) });
}));

async function taken(local, domain, domainId) {
  const addr = `${local}@${domain}`;
  if (await db.one('SELECT 1 x FROM mailboxes WHERE address = ?', [addr])) return true;
  return !!(await db.one("SELECT 1 x FROM registrations WHERE local_part = ? AND domain_id = ? AND status = 'pending'", [local, domainId]));
}

router.post('/api/public/register', wrap(async (req, res) => {
  const s = db.settings();
  if (!s.registrationOpen) fail(403, 'registration_closed');
  const b = req.body || {};
  if (b.website) return res.json({ ok: true, token: token(16) }); // bẫy bot (honeypot)
  if (limited('reg:' + req.ip, 5, 3600e3)) fail(429, 'too_many_attempts');
  const local = str(b.local, 64).toLowerCase();
  const d = await db.one('SELECT id, domain FROM domains WHERE id = ? AND active = 1 AND allow_registration = 1', [int(b.domainId, 0)]);
  if (!d) fail(400, 'domain_not_allowed');
  if (!isLocalPart(local)) fail(400, 'invalid_local_part');
  if (RESERVED.has(local)) fail(400, 'reserved_address');
  if (await taken(local, d.domain, d.id)) fail(409, 'address_taken');
  if (!passwordOk(b.password)) fail(400, 'weak_password');
  const contact = str(b.contactEmail, 254).toLowerCase();
  if (contact && !isEmail(contact)) fail(400, 'invalid_email');
  const statusToken = token(24);
  await db.q('INSERT INTO registrations (local_part, domain_id, display_name, contact_email, reason, enc_password, lang, status_token, ip) VALUES (?,?,?,?,?,?,?,?,?)',
    [local, d.id, str(b.displayName, 190), contact, str(b.reason, 1000), encrypt(b.password), b.lang === 'vi' ? 'vi' : 'en', sha256(statusToken), req.ip]);
  await db.audit('guest', 'registration_submitted', `${local}@${d.domain}`, contact, req.ip);
  notify.newRegistration(`${local}@${d.domain}`).catch(() => {});
  res.json({ ok: true, token: statusToken, address: `${local}@${d.domain}` });
}));

router.get('/api/public/register/status', wrap(async (req, res) => {
  const t = str(req.query.token, 100);
  if (!t) fail(400, 'invalid_token');
  const r = await db.one(`SELECT r.local_part, r.status, r.reject_reason, r.created_at, r.decided_at, d.domain
    FROM registrations r JOIN domains d ON d.id = r.domain_id WHERE r.status_token = ?`, [sha256(t)]);
  if (!r) fail(404, 'not_found');
  res.json({ address: `${r.local_part}@${r.domain}`, status: r.status, reason: r.reject_reason, createdAt: r.created_at, decidedAt: r.decided_at });
}));

// Đường link truy cập hộp thư không cần đăng nhập: /m/<token>
router.get('/m/:token', wrap(async (req, res) => {
  const t = str(req.params.token, 100);
  const bad = () => res.redirect('/?link=invalid');
  if (!t || limited('link:' + req.ip, 60, 600e3)) return bad();
  const l = await db.one(`SELECT l.*, m.address, m.status, m.enc_password FROM access_links l JOIN mailboxes m ON m.id = l.mailbox_id
    WHERE l.token_hash = ?`, [sha256(t)]);
  if (!l || l.revoked || l.status !== 'active' || !decrypt(l.enc_password)) return bad();
  if (l.expires_at && Date.parse(l.expires_at + 'Z') < Date.now()) return res.redirect('/?link=expired');
  await db.q('UPDATE access_links SET use_count = use_count + 1, last_used = UTC_TIMESTAMP() WHERE id = ?', [l.id]);
  await session.destroy(req, res, 'user');
  let hours = 24 * 30;
  if (l.expires_at) hours = Math.max(0.1, Math.min(hours, (Date.parse(l.expires_at + 'Z') - Date.now()) / 3600e3));
  await session.create(res, { kind: 'link', address: l.address, linkId: l.id, canSend: !!l.can_send, hours, req });
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.redirect('/#/mail/INBOX');
}));

module.exports = router;
