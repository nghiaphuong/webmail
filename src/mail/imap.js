const { ImapFlow } = require('imapflow');
const db = require('../db');

const IDLE_MS = 4 * 60e3;
const SPECIAL = ['\\Sent', '\\Drafts', '\\Trash', '\\Junk', '\\Archive'];
const SPECIAL_NAMES = {
  '\\Sent': ['sent', 'sent items', 'sent messages', 'inbox.sent'],
  '\\Drafts': ['drafts', 'draft', 'inbox.drafts'],
  '\\Trash': ['trash', 'deleted', 'deleted items', 'deleted messages', 'inbox.trash'],
  '\\Junk': ['junk', 'spam', 'junk e-mail', 'inbox.junk', 'inbox.spam'],
  '\\Archive': ['archive', 'archives', 'inbox.archive'],
};
const DEFAULT_NAMES = { '\\Sent': 'Sent', '\\Drafts': 'Drafts', '\\Trash': 'Trash', '\\Junk': 'Junk' };

function clientOptions(user, pass) {
  const s = db.settings();
  return {
    host: s.imap.host, port: Number(s.imap.port), secure: !!s.imap.secure,
    auth: { user, pass },
    logger: false,
    tls: { rejectUnauthorized: !s.tlsInsecure },
    connectionTimeout: 20000, greetingTimeout: 15000, socketTimeout: 5 * 60e3,
    disableAutoIdle: true,
  };
}

// Kiểm tra đăng nhập IMAP (dùng khi người dùng đăng nhập webmail).
async function verify(user, pass) {
  const c = new ImapFlow(clientOptions(user, pass));
  c.on('error', () => {});
  try { await c.connect(); await c.logout(); return true; } catch (e) {
    if (e.authenticationFailed || /auth/i.test(e.responseText || e.message)) return false;
    throw e;
  }
}

// Mỗi phiên giữ một kết nối IMAP dùng lại; các thao tác được xếp hàng tuần tự (IMAP chỉ chọn một thư mục một lúc).
const pool = new Map();

class ImapStore {
  constructor(key, user, pass) {
    this.key = key; this.user = user; this.pass = pass;
    this.client = null; this.queue = Promise.resolve(); this.last = Date.now(); this.specials = null;
  }
  async ensure() {
    if (this.client && this.client.usable) return this.client;
    const c = new ImapFlow(clientOptions(this.user, this.pass));
    c.on('error', () => {});
    c.on('close', () => { if (this.client === c) this.client = null; });
    await c.connect();
    this.client = c;
    return c;
  }
  run(fn) {
    const p = this.queue.then(async () => {
      this.last = Date.now();
      const c = await this.ensure();
      return fn(c);
    });
    this.queue = p.catch(() => {});
    return p;
  }
  async withBox(path, fn) {
    return this.run(async c => {
      const lock = await c.getMailboxLock(path);
      try { return await fn(c); } finally { lock.release(); }
    });
  }
  close() { try { this.client?.logout().catch(() => {}); } catch { /* đã đóng */ } this.client = null; }

  async folders() {
    return this.run(async c => {
      let list = await c.list({ statusQuery: { messages: true, unseen: true } });
      const specials = this.detectSpecials(list);
      // Tạo các thư mục đặc biệt còn thiếu (lần đầu dùng hộp thư mới).
      let created = false;
      for (const su of Object.keys(DEFAULT_NAMES)) {
        if (specials[su]) continue;
        const inboxNs = list.find(f => f.path.toUpperCase().startsWith('INBOX' + (f.delimiter || '.')) && f.path.toUpperCase() !== 'INBOX');
        const delim = list[0]?.delimiter || '.';
        const name = inboxNs ? `INBOX${delim}${DEFAULT_NAMES[su]}` : DEFAULT_NAMES[su];
        try { await c.mailboxCreate(name); created = true; } catch { /* có thể đã tồn tại hoặc không được phép */ }
      }
      if (created) {
        list = await c.list({ statusQuery: { messages: true, unseen: true } });
        this.detectSpecials(list);
      }
      return list.filter(f => !(f.flags && f.flags.has('\\Noselect') && !f.specialUse)).map(f => ({
        path: f.path, name: f.name, delimiter: f.delimiter || '.',
        special: f.path.toUpperCase() === 'INBOX' ? '\\Inbox' : (this.specialOf(f.path) || null),
        total: f.status?.messages ?? 0, unread: f.status?.unseen ?? 0,
        subscribed: f.subscribed !== false,
      }));
    });
  }
  detectSpecials(list) {
    const sp = {};
    for (const f of list) if (f.specialUse && SPECIAL.includes(f.specialUse) && !sp[f.specialUse]) sp[f.specialUse] = f.path;
    for (const su of SPECIAL) {
      if (sp[su]) continue;
      const hit = list.find(f => SPECIAL_NAMES[su].includes(f.path.toLowerCase()) || SPECIAL_NAMES[su].includes(f.name.toLowerCase()));
      if (hit) sp[su] = hit.path;
    }
    this.specials = sp;
    return sp;
  }
  specialOf(path) { return Object.entries(this.specials || {}).find(([, p]) => p === path)?.[0]; }
  async special(su) {
    if (!this.specials) await this.folders();
    return this.specials[su] || null;
  }

  async list(path, { page = 1, size = 50, search = null, filter = 'all' }) {
    return this.withBox(path, async c => {
      const exists = c.mailbox.exists || 0;
      let uids = null;
      const crit = {};
      if (filter === 'unread') crit.seen = false;
      if (filter === 'flagged') crit.flagged = true;
      if (search && search.text) {
        const t = search.text;
        const scope = search.scope || 'all';
        const or = [];
        if (scope === 'all' || scope === 'subject') or.push({ subject: t });
        if (scope === 'all' || scope === 'from') or.push({ from: t });
        if (scope === 'all' || scope === 'to') { or.push({ to: t }); or.push({ cc: t }); }
        if (scope === 'all' || scope === 'body') or.push({ body: t });
        if (or.length === 1) Object.assign(crit, or[0]); else crit.or = or;
      }
      const searching = Object.keys(crit).length > 0;
      let items = [];
      let total = exists;
      if (!exists) return { total: 0, items: [] };
      const q = { uid: true, envelope: true, flags: true, size: true, bodyStructure: true, internalDate: true };
      if (searching) {
        uids = (await c.search(crit, { uid: true })) || [];
        uids.sort((a, b) => b - a);
        total = uids.length;
        const slice = uids.slice((page - 1) * size, page * size);
        if (slice.length) for await (const m of c.fetch(slice.join(','), q, { uid: true })) items.push(m);
      } else {
        const hi = exists - (page - 1) * size;
        const lo = Math.max(1, hi - size + 1);
        if (hi >= 1) for await (const m of c.fetch(`${lo}:${hi}`, q)) items.push(m);
      }
      items.sort((a, b) => b.uid - a.uid);
      return { total, items: items.map(summary) };
    });
  }
  async source(path, uid) {
    return this.withBox(path, async c => {
      const r = await c.download(String(uid), undefined, { uid: true });
      if (!r || !r.content) return null;
      const chunks = [];
      for await (const ch of r.content) chunks.push(ch);
      return Buffer.concat(chunks);
    });
  }
  async flags(path, uids, add = [], remove = []) {
    return this.withBox(path, async c => {
      const r = uids.join(',');
      if (add.length) await c.messageFlagsAdd(r, add, { uid: true });
      if (remove.length) await c.messageFlagsRemove(r, remove, { uid: true });
    });
  }
  async move(path, uids, dest) {
    if (path === dest) return;
    return this.withBox(path, c => c.messageMove(uids.join(','), dest, { uid: true }));
  }
  async expunge(path, uids) {
    return this.withBox(path, c => c.messageDelete(uids.join(','), { uid: true }));
  }
  async empty(path) {
    return this.withBox(path, async c => { if (c.mailbox.exists) await c.messageDelete('1:*'); });
  }
  async append(path, raw, flags = []) {
    return this.run(async c => {
      const r = await c.append(path, raw, flags);
      return r && r.uid ? r.uid : null;
    });
  }
  async createFolder(path) { return this.run(c => c.mailboxCreate(path)); }
  async renameFolder(from, to) { return this.run(c => c.mailboxRename(from, to)); }
  async deleteFolder(path) { return this.run(c => c.mailboxDelete(path)); }
  async quota() {
    return this.run(async c => {
      try {
        const q = await c.getQuota('INBOX');
        if (q && q.storage) return { used: q.storage.used, limit: q.storage.limit };
      } catch { /* máy chủ không hỗ trợ QUOTA */ }
      return null;
    });
  }
}

function hasAttachment(node) {
  if (!node) return false;
  if (node.disposition === 'attachment') return true;
  if (node.childNodes) return node.childNodes.some(hasAttachment);
  return false;
}
const addr = list => (list || []).map(a => ({ name: a.name || '', address: a.address || '' }));
function summary(m) {
  const e = m.envelope || {};
  return {
    uid: m.uid,
    subject: e.subject || '',
    from: addr(e.from), to: addr(e.to), cc: addr(e.cc),
    date: (e.date || m.internalDate || new Date()).toISOString?.() || null,
    size: m.size || 0,
    flags: [...(m.flags || [])],
    attachment: hasAttachment(m.bodyStructure),
  };
}

function get(key, user, pass) {
  let s = pool.get(key);
  if (!s || s.pass !== pass) {
    s?.close();
    s = new ImapStore(key, user, pass);
    pool.set(key, s);
  }
  return s;
}
function drop(key) { pool.get(key)?.close(); pool.delete(key); }
setInterval(() => {
  for (const [k, s] of pool) if (Date.now() - s.last > IDLE_MS) { s.close(); pool.delete(k); }
}, 60e3).unref();

module.exports = { get, drop, verify };
