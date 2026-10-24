const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const multer = require('multer');
const addressparser = require('nodemailer/lib/addressparser');
const { convert: htmlToText } = require('html-to-text');
const db = require('../db');
const session = require('../session');
const stores = require('../mail/store');
const smtp = require('../mail/smtp');
const render = require('../mail/render');
const provision = require('../provision');
const { passwordOk, token, encrypt } = require('../crypto');
const { wrap, fail, limited, isEmail, str, int } = require('../util');

const router = express.Router();

// ---------- Tùy chọn người dùng ----------
const PREF_DEFAULTS = {
  displayName: '', signature: '', replyTo: '', lang: 'en', pageSize: 50, blockRemote: true, composeHtml: true,
  replyAbove: true, autoRefresh: 60, notifications: false, collectContacts: true, previewPane: true, theme: 'auto',
  draftAutosave: 60, confirmDelete: false,
};
async function getPrefs(address) {
  const r = await db.one('SELECT prefs FROM user_prefs WHERE address = ?', [address]);
  let p = {};
  try { p = r ? JSON.parse(r.prefs) : {}; } catch { p = {}; }
  return { ...PREF_DEFAULTS, ...p };
}
function cleanPrefs(input) {
  const out = {};
  for (const [k, d] of Object.entries(PREF_DEFAULTS)) {
    if (!(k in input)) continue;
    const v = input[k];
    if (typeof d === 'boolean') out[k] = !!v;
    else if (typeof d === 'number') out[k] = int(v, d, 0, 3600);
    else out[k] = str(v, k === 'signature' ? 20000 : 255);
  }
  if ('lang' in out && !['en', 'vi'].includes(out.lang)) out.lang = 'en';
  if ('theme' in out && !['auto', 'light', 'dark'].includes(out.theme)) out.theme = 'auto';
  if ('pageSize' in out) out.pageSize = Math.min(200, Math.max(10, out.pageSize));
  if ('replyTo' in out && out.replyTo && !isEmail(out.replyTo)) out.replyTo = '';
  return out;
}

// ---------- Đăng nhập ----------
router.post('/login', wrap(async (req, res) => {
  const email = str(req.body.email, 254).toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (!isEmail(email) || !password) fail(400, 'invalid_credentials');
  if (limited('login-ip:' + req.ip, 30, 15 * 60e3) || limited('login:' + email, 10, 15 * 60e3)) fail(429, 'too_many_attempts');
  const domain = email.split('@')[1];
  const d = await db.one('SELECT id FROM domains WHERE domain = ? AND active = 1', [domain]);
  if (!d) fail(403, 'domain_not_allowed');
  const mb = await db.one('SELECT id, status FROM mailboxes WHERE address = ?', [email]);
  if (mb?.status === 'disabled') fail(403, 'mailbox_disabled');
  if (mb?.status === 'pending_provision') fail(403, 'mailbox_pending');
  let ok;
  try { ok = await stores.verify(email, password); } catch (e) {
    console.error('login verify', e.message);
    fail(502, 'mail_server_unreachable');
  }
  if (!ok) { await db.audit(email, 'login_failed', email, '', req.ip); fail(401, 'invalid_credentials'); }
  if (mb) await db.q('UPDATE mailboxes SET last_login = UTC_TIMESTAMP() WHERE id = ?', [mb.id]);
  else await db.q('INSERT INTO mailboxes (address, domain_id, kind, status, last_login) VALUES (?, ?, ?, ?, UTC_TIMESTAMP())', [email, d.id, 'external', 'active']);
  await session.destroy(req, res, 'user');
  await session.create(res, { kind: 'user', address: email, password, hours: req.body.remember ? 24 * 14 : 12, req });
  const lang = str(req.body.lang, 5);
  if (['en', 'vi'].includes(lang)) {
    const prefs = await getPrefs(email);
    if (!(await db.one('SELECT 1 x FROM user_prefs WHERE address = ?', [email]))) {
      await db.q('INSERT INTO user_prefs (address, prefs) VALUES (?, ?)', [email, JSON.stringify({ ...prefs, lang })]);
    }
  }
  res.json({ ok: true });
}));

router.post('/logout', wrap(async (req, res) => {
  if (req.mailSession) stores.drop(req.mailSession.id);
  await session.destroy(req, res, 'user');
  res.json({ ok: true });
}));

// Các route bên dưới cần phiên hợp lệ.
router.use((req, res, next) => (req.mailSession ? next() : res.status(401).json({ error: 'not_logged_in' })));

const store = req => stores.forSession(req.mailSession);
const folderOf = req => {
  const f = str(req.query.f ?? req.body?.f, 500);
  if (!f) fail(400, 'folder_required');
  return f;
};
const uidList = v => (Array.isArray(v) ? v : [v]).map(Number).filter(n => Number.isInteger(n) && n > 0).slice(0, 5000);

router.get('/me', wrap(async (req, res) => {
  const s = req.mailSession;
  const mb = await db.one('SELECT display_name, kind FROM mailboxes WHERE address = ?', [s.address]);
  const prefs = await getPrefs(s.address);
  const prefsSaved = !!(await db.one("SELECT 1 x FROM user_prefs WHERE address = ?", [s.address]));
  let linkExpires = null;
  if (s.kind === 'link') linkExpires = (await db.one('SELECT expires_at FROM access_links WHERE id = ?', [s.link_id]))?.expires_at || null;
  const st = db.settings();
  res.json({
    address: s.address, kind: s.kind, canSend: !!s.can_send, displayName: prefs.displayName || mb?.display_name || '',
    prefs, prefsSaved, appName: st.appName, protocol: st.protocol, maxUploadMb: st.maxUploadMb, linkExpires,
    canChangePassword: s.kind === 'user' && provision.mode() !== 'manual',
    servers: { imap: st.imap, pop3: st.pop3, smtp: st.smtp },
  });
}));

router.put('/prefs', wrap(async (req, res) => {
  const prefs = { ...(await getPrefs(req.mailSession.address)), ...cleanPrefs(req.body || {}) };
  await db.q('INSERT INTO user_prefs (address, prefs) VALUES (?, ?) ON DUPLICATE KEY UPDATE prefs = VALUES(prefs)', [req.mailSession.address, JSON.stringify(prefs)]);
  res.json({ prefs });
}));

router.post('/password', wrap(async (req, res) => {
  const s = req.mailSession;
  if (s.kind !== 'user') fail(403, 'forbidden');
  const { current, next } = req.body || {};
  const real = await session.mailPassword(s);
  if (current !== real) fail(400, 'wrong_password');
  if (!passwordOk(next)) fail(400, 'weak_password');
  const mb = await db.one('SELECT * FROM mailboxes WHERE address = ?', [s.address]);
  const domain = await db.one('SELECT * FROM domains WHERE domain = ?', [s.address.split('@')[1]]);
  let done;
  try { done = await provision.setPassword(mb || { address: s.address }, domain, next); } catch (e) { fail(502, 'provider_error', e.message); }
  if (!done) fail(400, 'not_supported');
  if (mb?.enc_password) await db.q('UPDATE mailboxes SET enc_password = ? WHERE id = ?', [encrypt(next), mb.id]);
  await session.updatePassword(s, next);
  stores.drop(s.id);
  await db.audit(s.address, 'password_changed', s.address, '', req.ip);
  res.json({ ok: true });
}));

// ---------- Thư mục ----------
router.get('/folders', wrap(async (req, res) => {
  const st = await store(req);
  const folders = await st.folders();
  res.json({ folders, quota: await st.quota().catch(() => null) });
}));

router.post('/folders', wrap(async (req, res) => {
  const name = str(req.body.name, 100);
  if (!name || /[\\/%*]/.test(name)) fail(400, 'invalid_name');
  const st = await store(req);
  const folders = await st.folders();
  const parent = str(req.body.parent, 500);
  const delim = folders[0]?.delimiter || '.';
  if (name.includes(delim)) fail(400, 'invalid_name');
  const p = parent ? parent + delim + name : name;
  if (folders.some(f => f.path.toLowerCase() === p.toLowerCase())) fail(409, 'folder_exists');
  await st.createFolder(p);
  res.json({ path: p });
}));

router.patch('/folders', wrap(async (req, res) => {
  const from = str(req.body.path, 500);
  const name = str(req.body.name, 100);
  if (!from || !name || /[\\/%*]/.test(name)) fail(400, 'invalid_name');
  const st = await store(req);
  const folders = await st.folders();
  const f = folders.find(x => x.path === from);
  if (!f || f.special) fail(400, 'cannot_modify_special');
  if (name.includes(f.delimiter)) fail(400, 'invalid_name');
  const parts = from.split(f.delimiter);
  parts[parts.length - 1] = name;
  const to = parts.join(f.delimiter);
  await st.renameFolder(from, to);
  res.json({ path: to });
}));

router.delete('/folders', wrap(async (req, res) => {
  const p = folderOf(req);
  const st = await store(req);
  const f = (await st.folders()).find(x => x.path === p);
  if (!f || f.special) fail(400, 'cannot_modify_special');
  await st.deleteFolder(p);
  res.json({ ok: true });
}));

router.post('/folders/empty', wrap(async (req, res) => {
  const p = folderOf(req);
  const st = await store(req);
  const f = (await st.folders()).find(x => x.path === p);
  if (!f) fail(404, 'not_found');
  if (!['\\Trash', '\\Junk'].includes(f.special)) fail(400, 'only_trash_or_junk');
  await st.empty(p);
  res.json({ ok: true });
}));

// ---------- Danh sách & đọc thư ----------
router.get('/messages', wrap(async (req, res) => {
  const st = await store(req);
  const f = folderOf(req);
  const prefs = await getPrefs(req.mailSession.address);
  const size = int(req.query.size, prefs.pageSize, 10, 200);
  const page = int(req.query.page, 1, 1, 100000);
  const text = str(req.query.q, 200);
  const r = await st.list(f, {
    page, size,
    search: text ? { text, scope: ['all', 'subject', 'from', 'to', 'body'].includes(req.query.scope) ? req.query.scope : 'all' } : null,
    filter: ['unread', 'flagged'].includes(req.query.filter) ? req.query.filter : 'all',
  });
  res.json({ ...r, page, size });
}));

async function loadMessage(req, f, uid) {
  const st = await store(req);
  const raw = await st.source(f, uid);
  if (!raw) fail(404, 'message_not_found');
  const parsed = await render.parse(`${req.mailSession.id}:${f}:${uid}`, raw);
  return { st, raw, parsed };
}
const partUrl = (f, uid) => i => `/api/message/part?f=${encodeURIComponent(f)}&uid=${uid}&i=${i}`;

router.get('/message', wrap(async (req, res) => {
  const f = folderOf(req);
  const uid = int(req.query.uid, 0, 1);
  const { st, parsed } = await loadMessage(req, f, uid);
  const prefs = await getPrefs(req.mailSession.address);
  let blockRemote = prefs.blockRemote && req.query.images !== '1';
  // Người gửi có trong danh bạ thì luôn hiện ảnh.
  const sender = parsed.from?.value?.[0]?.address?.toLowerCase();
  if (blockRemote && sender && await db.one('SELECT 1 x FROM contacts WHERE owner = ? AND email = ? AND collected = 0', [req.mailSession.address, sender])) blockRemote = false;
  const view = render.toView(parsed, { blockRemote, partUrl: partUrl(f, uid) });
  if (req.query.peek !== '1') await st.flags(f, [uid], ['\\Seen']).catch(() => {});
  res.json({ uid, folder: f, ...view });
}));

router.get('/message/raw', wrap(async (req, res) => {
  const f = folderOf(req);
  const uid = int(req.query.uid, 0, 1);
  const st = await store(req);
  const raw = await st.source(f, uid);
  if (!raw) fail(404, 'message_not_found');
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
  if (req.query.dl === '1') {
    res.setHeader('Content-Type', 'message/rfc822');
    res.setHeader('Content-Disposition', `attachment; filename="message-${uid}.eml"`);
  } else res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(raw);
}));

const INLINE_OK = /^(image\/(png|jpe?g|gif|webp|bmp)|application\/pdf|text\/plain)$/i;
router.get('/message/part', wrap(async (req, res) => {
  const f = folderOf(req);
  const uid = int(req.query.uid, 0, 1);
  const i = int(req.query.i, -1, 0);
  const { parsed } = await loadMessage(req, f, uid);
  const a = parsed.attachments?.[i];
  if (!a) fail(404, 'not_found');
  const type = (a.contentType || 'application/octet-stream').toLowerCase();
  const inline = req.query.dl !== '1' && INLINE_OK.test(type);
  const name = (a.filename || `attachment-${i + 1}`).replace(/[\r\n"]/g, '');
  res.setHeader('Content-Type', inline ? type : 'application/octet-stream');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; plugin-types application/pdf");
  res.setHeader('Cache-Control', 'private, max-age=600');
  res.send(a.content);
}));

// Dữ liệu điền sẵn cho trả lời / trả lời tất cả / chuyển tiếp / sửa nháp.
router.get('/message/compose', wrap(async (req, res) => {
  const f = folderOf(req);
  const uid = int(req.query.uid, 0, 1);
  const mode = ['reply', 'replyall', 'forward', 'draft', 'edit'].includes(req.query.mode) ? req.query.mode : 'reply';
  const { parsed } = await loadMessage(req, f, uid);
  const me = req.mailSession.address.toLowerCase();
  const fmt = list => list.map(a => (a.name ? `"${a.name.replace(/"/g, '')}" <${a.address}>` : a.address)).join(', ');
  const v = render.toView(parsed, { blockRemote: false, partUrl: partUrl(f, uid) });
  const attachments = v.attachments.map(a => ({ f, uid, i: a.i, filename: a.filename, size: a.size, contentType: a.contentType }));
  if (mode === 'draft' || mode === 'edit') {
    return res.json({
      to: fmt(v.to), cc: fmt(v.cc), bcc: fmt(v.bcc), subject: v.subject,
      html: parsed.html ? render.quoteHtml(parsed) : null, text: parsed.text || '', isHtml: !!parsed.html,
      inReplyTo: v.inReplyTo, references: v.references, attachments, draft: mode === 'draft' ? { f, uid } : null,
    });
  }
  const subj = v.subject || '';
  const prefix = mode === 'forward' ? 'Fwd: ' : 'Re: ';
  const subject = new RegExp('^' + prefix.trim().replace(':', '\\s*:'), 'i').test(subj) ? subj : prefix + subj;
  let to = [];
  let cc = [];
  if (mode !== 'forward') {
    to = v.replyTo.length ? v.replyTo : v.from;
    if (to.length && to[0].address.toLowerCase() === me && v.to.length) to = v.to;
    if (to.length > 1) to = to.filter(a => a.address.toLowerCase() !== me);
    if (mode === 'replyall') {
      const seen = new Set(to.map(a => a.address.toLowerCase()).concat(me));
      cc = [...v.to, ...v.cc].filter(a => a.address && !seen.has(a.address.toLowerCase()) && seen.add(a.address.toLowerCase()));
    }
  }
  res.json({
    to: fmt(to), cc: fmt(cc), bcc: '', subject,
    quote: {
      from: fmt(v.from), to: fmt(v.to), cc: fmt(v.cc), date: v.date, subject: v.subject,
      html: render.quoteHtml(parsed), text: parsed.text || '',
    },
    inReplyTo: mode === 'forward' ? null : v.messageId,
    references: mode === 'forward' ? [] : [...v.references, v.messageId].filter(Boolean).slice(-20),
    attachments: mode === 'forward' ? attachments : [],
    origin: { f, uid, mode },
  });
}));

// Thao tác hàng loạt.
router.post('/messages/action', wrap(async (req, res) => {
  const f = folderOf(req);
  const uids = uidList(req.body.uids);
  if (!uids.length) fail(400, 'no_messages');
  const st = await store(req);
  const action = req.body.action;
  const flagOps = {
    read: [['\\Seen'], []], unread: [[], ['\\Seen']], flag: [['\\Flagged'], []], unflag: [[], ['\\Flagged']], mdnsent: [['$MDNSent'], []],
  };
  if (flagOps[action]) { await st.flags(f, uids, ...flagOps[action]); return res.json({ ok: true }); }
  const trash = await st.special('\\Trash');
  const junk = await st.special('\\Junk');
  const archive = await st.special('\\Archive');
  if (action === 'delete') {
    if (f === trash || !trash || req.body.permanent) await st.expunge(f, uids);
    else await st.move(f, uids, trash);
  } else if (action === 'move') {
    const to = str(req.body.to, 500);
    if (!to) fail(400, 'folder_required');
    await st.move(f, uids, to);
  } else if (action === 'spam') {
    if (!junk) fail(400, 'no_junk_folder');
    await st.flags(f, uids, ['$Junk'], ['$NotJunk']).catch(() => {});
    await st.move(f, uids, junk);
  } else if (action === 'notspam') {
    await st.flags(f, uids, ['$NotJunk'], ['$Junk']).catch(() => {});
    await st.move(f, uids, 'INBOX');
  } else if (action === 'archive') {
    let dest = archive;
    if (!dest) {
      const folders = await st.folders();
      dest = folders.find(x => x.name.toLowerCase() === 'archive')?.path;
      if (!dest) { dest = (folders.some(x => x.path.startsWith('INBOX' + x.delimiter)) ? 'INBOX' + folders[0].delimiter : '') + 'Archive'; await st.createFolder(dest); }
    }
    await st.move(f, uids, dest);
  } else fail(400, 'unknown_action');
  res.json({ ok: true });
}));

// ---------- Tệp đính kèm tải lên ----------
const UPLOAD_DIR = path.join(os.tmpdir(), 'webmail-uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const uploads = new Map(); // id -> { owner, name, type, size, file, t }
const upload = multer({
  storage: multer.diskStorage({ destination: UPLOAD_DIR, filename: (req, file, cb) => cb(null, token(18)) }),
  limits: { fileSize: 50 * 1024 * 1024, files: 20 },
});
router.post('/upload', (req, res, next) => {
  if (!req.mailSession.can_send) return res.status(403).json({ error: 'sending_disabled' });
  upload.array('files', 20)(req, res, err => {
    if (err) return res.status(413).json({ error: 'file_too_large' });
    const max = db.settings().maxUploadMb * 1024 * 1024;
    const out = [];
    for (const f of req.files || []) {
      if (f.size > max) { fs.unlink(f.path, () => {}); out.push({ error: 'file_too_large', name: f.originalname }); continue; }
      const id = path.basename(f.path);
      const name = Buffer.from(f.originalname, 'latin1').toString('utf8');
      uploads.set(id, { owner: req.mailSession.address, name, type: f.mimetype, size: f.size, file: f.path, t: Date.now() });
      out.push({ id, name, size: f.size, type: f.mimetype });
    }
    res.json({ files: out });
  });
});
router.delete('/upload/:id', (req, res) => {
  const u = uploads.get(req.params.id);
  if (u && u.owner === req.mailSession.address) { fs.unlink(u.file, () => {}); uploads.delete(req.params.id); }
  res.json({ ok: true });
});
setInterval(() => {
  for (const [id, u] of uploads) if (Date.now() - u.t > 12 * 3600e3) { fs.unlink(u.file, () => {}); uploads.delete(id); }
}, 3600e3).unref();

// ---------- Soạn & gửi ----------
function parseAddrs(v) {
  const list = Array.isArray(v) ? v.join(',') : String(v || '');
  const out = [];
  const walk = items => items.forEach(a => (a.group ? walk(a.group) : a.address && out.push({ name: a.name || '', address: a.address.trim() })));
  walk(addressparser(list));
  return out;
}

// Ảnh dán vào trình soạn thảo (data:) được chuyển thành tệp nhúng cid.
function inlineDataImages(html, attachments) {
  let n = 0;
  return html.replace(/(<img\b[^>]*?\bsrc\s*=\s*["'])data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)(["'])/gi, (m, pre, type, b64, post) => {
    const cid = `img${++n}.${token(6)}@webmail`;
    attachments.push({ filename: `image${n}.${type.split('/')[1].replace('jpeg', 'jpg').replace(/\+.*/, '')}`, content: Buffer.from(b64.replace(/\s/g, ''), 'base64'), contentType: type, cid, contentDisposition: 'inline' });
    return `${pre}cid:${cid}${post}`;
  });
}

async function buildMail(req) {
  const s = req.mailSession;
  const b = req.body || {};
  const prefs = await getPrefs(s.address);
  const mb = await db.one('SELECT display_name FROM mailboxes WHERE address = ?', [s.address]);
  const to = parseAddrs(b.to);
  const cc = parseAddrs(b.cc);
  const bcc = parseAddrs(b.bcc);
  const all = [...to, ...cc, ...bcc];
  if (all.length > 100) fail(400, 'too_many_recipients');
  const bad = all.find(a => !isEmail(a.address));
  if (bad) fail(400, 'invalid_recipient', bad.address);
  const attachments = [];
  for (const id of (Array.isArray(b.attachments) ? b.attachments : []).slice(0, 30)) {
    const u = uploads.get(id);
    if (u && u.owner === s.address) attachments.push({ filename: u.name, path: u.file, contentType: u.type });
  }
  // Tệp đính kèm lấy lại từ thư gốc (chuyển tiếp / nháp).
  for (const p of (Array.isArray(b.parts) ? b.parts : []).slice(0, 30)) {
    try {
      const { parsed } = await loadMessage(req, str(p.f, 500), int(p.uid, 0, 1));
      const a = parsed.attachments?.[int(p.i, -1, 0)];
      if (a) attachments.push({ filename: a.filename || 'attachment', content: a.content, contentType: a.contentType, cid: a.related ? a.cid : undefined });
    } catch { /* thư gốc đã bị xóa */ }
  }
  const total = attachments.reduce((n, a) => n + (a.content ? a.content.length : fs.statSync(a.path).size), 0);
  if (total > db.settings().maxUploadMb * 1024 * 1024) fail(413, 'attachments_too_large');
  const mail = {
    from: { name: prefs.displayName || mb?.display_name || '', address: s.address },
    to, cc, bcc,
    subject: str(b.subject, 998),
    attachments,
    headers: { 'X-Mailer': 'PhuongCode Webmail' },
  };
  if (prefs.replyTo) mail.replyTo = prefs.replyTo;
  if (b.isHtml) {
    const html = inlineDataImages(String(b.html || '').slice(0, 5e6), attachments);
    mail.html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${html}</body></html>`;
    mail.text = htmlToText(html, { wordwrap: 78, selectors: [{ selector: 'img', format: 'skip' }] });
  } else mail.text = String(b.text || '').slice(0, 2e6);
  if (b.inReplyTo) mail.inReplyTo = str(b.inReplyTo, 998);
  if (Array.isArray(b.references) && b.references.length) mail.references = b.references.map(x => str(x, 998)).filter(Boolean).slice(-20);
  if (['high', 'low'].includes(b.priority)) mail.priority = b.priority;
  if (b.receipt) mail.headers['Disposition-Notification-To'] = s.address;
  return { mail, all, prefs };
}

async function removeDraft(req, st, b) {
  if (!b.draft?.uid) return;
  const drafts = await st.special('\\Drafts');
  if (drafts && b.draft.f === drafts) await st.expunge(drafts, [int(b.draft.uid, 0, 1)]).catch(() => {});
}

router.post('/send', wrap(async (req, res) => {
  const s = req.mailSession;
  if (!s.can_send) fail(403, 'sending_disabled');
  if (limited('send:' + s.address, 120, 3600e3)) fail(429, 'send_rate_limited');
  const { mail, all, prefs } = await buildMail(req);
  if (!all.length) fail(400, 'no_recipients');
  const pass = await session.mailPassword(s);
  let result;
  try { result = await smtp.send(s.address, pass, mail); } catch (e) {
    console.error('smtp', e.message);
    fail(502, 'smtp_error', e.response || e.message);
  }
  const st = await store(req);
  const warnings = [];
  try {
    const sent = await st.special('\\Sent');
    if (sent) await st.append(sent, result.raw, ['\\Seen']);
  } catch (e) { warnings.push('sent_copy_failed'); console.error('append sent', e.message); }
  const b = req.body;
  await removeDraft(req, st, b);
  if (b.origin?.uid) {
    const flag = b.origin.mode === 'forward' ? '$Forwarded' : '\\Answered';
    await st.flags(str(b.origin.f, 500), [int(b.origin.uid, 0, 1)], [flag]).catch(() => {});
  }
  for (const id of b.attachments || []) { const u = uploads.get(id); if (u && u.owner === s.address) { fs.unlink(u.file, () => {}); uploads.delete(id); } }
  if (prefs.collectContacts) {
    for (const a of all) {
      await db.q('INSERT IGNORE INTO contacts (owner, name, email, collected) VALUES (?, ?, ?, 1)', [s.address, a.name.slice(0, 190), a.address.toLowerCase().slice(0, 255)]).catch(() => {});
    }
  }
  res.json({ ok: true, messageId: result.messageId, warnings });
}));

router.post('/draft', wrap(async (req, res) => {
  const { mail } = await buildMail(req);
  const { raw } = await smtp.build(mail, true);
  const st = await store(req);
  const drafts = await st.special('\\Drafts');
  if (!drafts) fail(400, 'no_drafts_folder');
  const uid = await st.append(drafts, raw, ['\\Seen', '\\Draft']);
  await removeDraft(req, st, req.body);
  res.json({ ok: true, draft: { f: drafts, uid } });
}));

// ---------- Danh bạ ----------
router.get('/contacts', wrap(async (req, res) => {
  const qtext = str(req.query.q, 100);
  const args = [req.mailSession.address];
  let where = 'owner = ?';
  if (qtext) { where += ' AND (name LIKE ? OR email LIKE ? OR org LIKE ?)'; const l = `%${qtext.replace(/[%_\\]/g, m => '\\' + m)}%`; args.push(l, l, l); }
  if (req.query.group === 'saved') where += ' AND collected = 0';
  if (req.query.group === 'collected') where += ' AND collected = 1';
  res.json({ contacts: await db.q(`SELECT id, name, email, phone, org, notes, collected FROM contacts WHERE ${where} ORDER BY collected, name = '', name, email LIMIT 2000`, args) });
}));
router.get('/contacts/suggest', wrap(async (req, res) => {
  const qtext = str(req.query.q, 100);
  if (!qtext) return res.json({ contacts: [] });
  const l = `%${qtext.replace(/[%_\\]/g, m => '\\' + m)}%`;
  res.json({ contacts: await db.q('SELECT name, email FROM contacts WHERE owner = ? AND (name LIKE ? OR email LIKE ?) ORDER BY collected, name LIMIT 10', [req.mailSession.address, l, l]) });
}));
function contactFields(b) {
  const email = str(b.email, 255).toLowerCase();
  if (!isEmail(email)) fail(400, 'invalid_email');
  return { name: str(b.name, 190), email, phone: str(b.phone, 64), org: str(b.org, 190), notes: str(b.notes, 1000) };
}
router.post('/contacts', wrap(async (req, res) => {
  const c = contactFields(req.body);
  await db.q(`INSERT INTO contacts (owner, name, email, phone, org, notes, collected) VALUES (?,?,?,?,?,?,0)
    ON DUPLICATE KEY UPDATE name = VALUES(name), phone = VALUES(phone), org = VALUES(org), notes = VALUES(notes), collected = 0`,
  [req.mailSession.address, c.name, c.email, c.phone, c.org, c.notes]);
  res.json({ ok: true });
}));
router.put('/contacts/:id', wrap(async (req, res) => {
  const c = contactFields(req.body);
  try {
    await db.q('UPDATE contacts SET name=?, email=?, phone=?, org=?, notes=?, collected=0 WHERE id = ? AND owner = ?', [c.name, c.email, c.phone, c.org, c.notes, int(req.params.id, 0), req.mailSession.address]);
  } catch (e) { if (e.code === 'ER_DUP_ENTRY') fail(409, 'contact_exists'); throw e; }
  res.json({ ok: true });
}));
router.post('/contacts/delete', wrap(async (req, res) => {
  const ids = uidList(req.body.ids);
  if (ids.length) await db.q('DELETE FROM contacts WHERE owner = ? AND id IN (?)', [req.mailSession.address, ids]);
  res.json({ ok: true });
}));
router.post('/contacts/import', express.text({ type: '*/*', limit: '5mb' }), wrap(async (req, res) => {
  const text = typeof req.body === 'string' ? req.body : '';
  let n = 0;
  const cards = text.replace(/\r?\n[ \t]/g, '').split(/BEGIN:VCARD/i).slice(1);
  for (const card of cards) {
    const get = k => { const m = card.match(new RegExp(`^${k}(?:;[^:\\n]*)?:(.*)$`, 'im')); return m ? m[1].trim().replace(/\\([,;\\])/g, '$1').replace(/\\n/gi, ' ') : ''; };
    const email = get('EMAIL').toLowerCase();
    if (!isEmail(email)) continue;
    const name = get('FN') || get('N').split(';').filter(Boolean).reverse().join(' ');
    await db.q(`INSERT INTO contacts (owner, name, email, phone, org, notes, collected) VALUES (?,?,?,?,?,?,0)
      ON DUPLICATE KEY UPDATE name = IF(VALUES(name) = '', name, VALUES(name)), collected = 0`,
    [req.mailSession.address, name.slice(0, 190), email, get('TEL').slice(0, 64), get('ORG').replace(/;/g, ' ').trim().slice(0, 190), get('NOTE').slice(0, 1000)]);
    n++;
  }
  res.json({ imported: n });
}));
router.get('/contacts/export', wrap(async (req, res) => {
  const rows = await db.q('SELECT * FROM contacts WHERE owner = ? AND collected = 0 ORDER BY name', [req.mailSession.address]);
  const esc = v => String(v || '').replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
  const out = rows.map(c => ['BEGIN:VCARD', 'VERSION:3.0', `FN:${esc(c.name || c.email)}`, `EMAIL;TYPE=INTERNET:${c.email}`,
    c.phone && `TEL:${esc(c.phone)}`, c.org && `ORG:${esc(c.org)}`, c.notes && `NOTE:${esc(c.notes)}`, 'END:VCARD'].filter(Boolean).join('\r\n')).join('\r\n');
  res.setHeader('Content-Type', 'text/vcard; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="contacts.vcf"');
  res.send(out);
}));

module.exports = router;
