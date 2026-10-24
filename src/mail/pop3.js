// Chế độ POP3: thư được tải từ máy chủ (pop.hostinger.com:995) về cơ sở dữ liệu của webmail.
// Các thư mục (Sent, Drafts, Trash, …) và cờ đã đọc/gắn sao được lưu cục bộ.
const tls = require('tls');
const net = require('net');
const { simpleParser } = require('mailparser');
const db = require('../db');

class Pop3Client {
  constructor({ host, port, secure, tlsInsecure }) {
    this.opts = { host, port: Number(port), secure, tlsInsecure };
    this.buf = ''; this.waiters = [];
  }
  connect() {
    return new Promise((resolve, reject) => {
      const { host, port, secure, tlsInsecure } = this.opts;
      const onConnect = () => this.read(false).then(l => (l.startsWith('+OK') ? resolve() : reject(new Error(l)))).catch(reject);
      this.sock = secure
        ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: !tlsInsecure }, onConnect)
        : net.connect({ host, port }, onConnect);
      this.sock.setTimeout(30000, () => this.sock.destroy(new Error('POP3 timeout')));
      this.sock.on('data', d => { this.buf += d.toString('latin1'); this.pump(); });
      this.sock.on('error', e => { reject(e); this.fail(e); });
      this.sock.on('close', () => this.fail(new Error('POP3 connection closed')));
    });
  }
  fail(e) { const w = this.waiters; this.waiters = []; w.forEach(x => x.reject(e)); }
  pump() {
    while (this.waiters.length) {
      const w = this.waiters[0];
      let end;
      if (w.multi) {
        // Phản hồi nhiều dòng kết thúc bằng "\r\n.\r\n"; phản hồi lỗi chỉ có một dòng.
        if (this.buf.startsWith('-ERR')) end = this.buf.indexOf('\r\n') + 2;
        else { const i = this.buf.indexOf('\r\n.\r\n'); end = i === -1 ? 0 : i + 5; }
      } else { const i = this.buf.indexOf('\r\n'); end = i === -1 ? 0 : i + 2; }
      if (!end || end < 2) return;
      const chunk = this.buf.slice(0, end);
      this.buf = this.buf.slice(end);
      this.waiters.shift().resolve(chunk);
    }
  }
  read(multi) { return new Promise((resolve, reject) => { this.waiters.push({ resolve, reject, multi }); this.pump(); }); }
  async cmd(line, multi = false) {
    this.sock.write(line + '\r\n');
    const r = await this.read(multi);
    if (!r.startsWith('+OK')) throw Object.assign(new Error(r.trim()), { pop3: true });
    return r;
  }
  async login(user, pass) {
    try { await this.cmd('USER ' + user); await this.cmd('PASS ' + pass); return true; } catch (e) {
      if (e.pop3) return false;
      throw e;
    }
  }
  async uidl() {
    const r = await this.cmd('UIDL', true);
    return r.split('\r\n').slice(1).filter(l => l && l !== '.').map(l => { const [n, id] = l.split(' '); return { n: Number(n), id }; });
  }
  async retr(n) {
    const r = await this.cmd('RETR ' + n, true);
    const body = r.slice(r.indexOf('\r\n') + 2, r.length - 3).replace(/\r\n\.\./g, '\r\n.');
    return Buffer.from(body, 'latin1');
  }
  dele(n) { return this.cmd('DELE ' + n); }
  async quit() { try { await this.cmd('QUIT'); } catch { /* bỏ qua */ } this.sock.destroy(); }
}

const serverOpts = () => { const s = db.settings(); return { ...s.pop3, tlsInsecure: s.tlsInsecure }; };

async function verify(user, pass) {
  const c = new Pop3Client(serverOpts());
  await c.connect();
  const ok = await c.login(user, pass);
  await c.quit();
  return ok;
}

const FOLDERS = [['INBOX', '\\Inbox'], ['Drafts', '\\Drafts'], ['Sent', '\\Sent'], ['Junk', '\\Junk'], ['Trash', '\\Trash']];
const syncing = new Map();
const lastSync = new Map();

async function indexFields(raw) {
  const m = await simpleParser(raw, { skipHtmlToText: false, skipImageLinks: true, skipTextLinks: true });
  const a = x => (x?.value || []).map(v => ({ name: v.name || '', address: v.address || '' }));
  return {
    subject: (m.subject || '').slice(0, 500),
    from: a(m.from), to: a(m.to), cc: a(m.cc),
    date: m.date && !isNaN(m.date) ? m.date : new Date(),
    att: (m.attachments || []).some(x => x.contentDisposition === 'attachment' || !x.related),
    text: [(m.text || '').slice(0, 20000)].join(' '),
  };
}
const sqlDate = d => new Date(d).toISOString().slice(0, 19).replace('T', ' ');

class LocalStore {
  constructor(owner, pass) { this.owner = owner; this.pass = pass; }
  async ensureFolders() {
    for (const [p, sp] of FOLDERS) await db.q('INSERT IGNORE INTO local_folders (owner, path, special) VALUES (?,?,?)', [this.owner, p, sp]);
  }
  // Tải thư mới từ POP3 (tối đa mỗi 20 giây một lần cho mỗi hộp thư).
  async sync(force = false) {
    if (!force && Date.now() - (lastSync.get(this.owner) || 0) < 20e3) return;
    if (syncing.has(this.owner)) return syncing.get(this.owner);
    const p = (async () => {
      const c = new Pop3Client(serverOpts());
      await c.connect();
      try {
        if (!(await c.login(this.owner, this.pass))) throw new Error('POP3 authentication failed');
        const list = await c.uidl();
        const seen = new Set((await db.q('SELECT uidl FROM pop3_seen WHERE owner = ?', [this.owner])).map(r => r.uidl));
        const leave = db.settings().pop3LeaveCopy;
        for (const { n, id } of list) {
          if (seen.has(id)) { if (!leave) await c.dele(n); continue; }
          const raw = await c.retr(n);
          const f = await indexFields(raw);
          await db.q('INSERT INTO local_messages (owner, folder, flags, internal_date, size, subject, from_json, to_json, has_att, search_text, raw) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
            [this.owner, 'INBOX', '', sqlDate(f.date), raw.length, f.subject, JSON.stringify(f.from), JSON.stringify({ to: f.to, cc: f.cc }), f.att ? 1 : 0, f.text, raw]);
          await db.q('INSERT IGNORE INTO pop3_seen (owner, uidl) VALUES (?, ?)', [this.owner, id]);
          if (!leave) await c.dele(n);
        }
        lastSync.set(this.owner, Date.now());
      } finally { await c.quit(); }
    })().finally(() => syncing.delete(this.owner));
    syncing.set(this.owner, p);
    return p;
  }
  async folders() {
    await this.ensureFolders();
    try { await this.sync(); } catch (e) { console.error('pop3 sync', e.message); }
    const rows = await db.q(`SELECT f.path, f.special,
        (SELECT COUNT(*) FROM local_messages m WHERE m.owner = f.owner AND m.folder = f.path) total,
        (SELECT COUNT(*) FROM local_messages m WHERE m.owner = f.owner AND m.folder = f.path AND FIND_IN_SET('\\\\Seen', m.flags) = 0) unread
      FROM local_folders f WHERE f.owner = ? ORDER BY f.special IS NULL, f.id`, [this.owner]);
    return rows.map(r => ({ path: r.path, name: r.path.split('/').pop(), delimiter: '/', special: r.special, total: Number(r.total), unread: Number(r.unread), subscribed: true }));
  }
  async special(su) {
    await this.ensureFolders();
    const r = await db.one('SELECT path FROM local_folders WHERE owner = ? AND special = ?', [this.owner, su]);
    return r?.path || null;
  }
  async list(path, { page = 1, size = 50, search = null, filter = 'all' }) {
    if (path === 'INBOX') { try { await this.sync(); } catch (e) { console.error('pop3 sync', e.message); } }
    const where = ['owner = ?', 'folder = ?'];
    const args = [this.owner, path];
    if (filter === 'unread') where.push("FIND_IN_SET('\\\\Seen', flags) = 0");
    if (filter === 'flagged') where.push("FIND_IN_SET('\\\\Flagged', flags) > 0");
    if (search?.text) {
      const like = '%' + search.text.replace(/[%_\\]/g, m => '\\' + m) + '%';
      const cols = { subject: ['subject'], from: ['from_json'], to: ['to_json'], body: ['search_text'] }[search.scope] || ['subject', 'from_json', 'to_json', 'search_text'];
      where.push('(' + cols.map(c => `${c} LIKE ?`).join(' OR ') + ')');
      cols.forEach(() => args.push(like));
    }
    const w = where.join(' AND ');
    const total = Number((await db.one(`SELECT COUNT(*) n FROM local_messages WHERE ${w}`, args)).n);
    const rows = await db.q(`SELECT id, flags, internal_date, size, subject, from_json, to_json, has_att FROM local_messages WHERE ${w} ORDER BY internal_date DESC, id DESC LIMIT ? OFFSET ?`,
      [...args, size, (page - 1) * size]);
    return {
      total,
      items: rows.map(r => {
        const to = JSON.parse(r.to_json || '{}');
        return {
          uid: r.id, subject: r.subject, from: JSON.parse(r.from_json || '[]'), to: to.to || [], cc: to.cc || [],
          date: new Date(r.internal_date + 'Z').toISOString(), size: r.size,
          flags: r.flags ? r.flags.split(',') : [], attachment: !!r.has_att,
        };
      }),
    };
  }
  async source(path, uid) {
    const r = await db.one('SELECT raw FROM local_messages WHERE owner = ? AND folder = ? AND id = ?', [this.owner, path, uid]);
    return r ? r.raw : null;
  }
  async flags(path, uids, add = [], remove = []) {
    const rows = await db.q('SELECT id, flags FROM local_messages WHERE owner = ? AND folder = ? AND id IN (?)', [this.owner, path, uids]);
    for (const r of rows) {
      const set = new Set(r.flags ? r.flags.split(',') : []);
      add.forEach(f => set.add(f)); remove.forEach(f => set.delete(f));
      await db.q('UPDATE local_messages SET flags = ? WHERE id = ?', [[...set].join(','), r.id]);
    }
  }
  async move(path, uids, dest) {
    await db.q('UPDATE local_messages SET folder = ? WHERE owner = ? AND folder = ? AND id IN (?)', [dest, this.owner, path, uids]);
  }
  async expunge(path, uids) { await db.q('DELETE FROM local_messages WHERE owner = ? AND folder = ? AND id IN (?)', [this.owner, path, uids]); }
  async empty(path) { await db.q('DELETE FROM local_messages WHERE owner = ? AND folder = ?', [this.owner, path]); }
  async append(path, raw, flags = []) {
    const f = await indexFields(raw);
    const r = await db.q('INSERT INTO local_messages (owner, folder, flags, internal_date, size, subject, from_json, to_json, has_att, search_text, raw) VALUES (?,?,?,UTC_TIMESTAMP(),?,?,?,?,?,?,?)',
      [this.owner, path, flags.join(','), raw.length, f.subject, JSON.stringify(f.from), JSON.stringify({ to: f.to, cc: f.cc }), f.att ? 1 : 0, f.text, raw]);
    return r.insertId;
  }
  async createFolder(path) { await db.q('INSERT INTO local_folders (owner, path) VALUES (?, ?)', [this.owner, path]); }
  async renameFolder(from, to) {
    const f = await db.one('SELECT special FROM local_folders WHERE owner = ? AND path = ?', [this.owner, from]);
    if (!f || f.special) throw new Error('Cannot rename this folder');
    await db.q('UPDATE local_folders SET path = ? WHERE owner = ? AND path = ?', [to, this.owner, from]);
    await db.q('UPDATE local_messages SET folder = ? WHERE owner = ? AND folder = ?', [to, this.owner, from]);
  }
  async deleteFolder(path) {
    const f = await db.one('SELECT special FROM local_folders WHERE owner = ? AND path = ?', [this.owner, path]);
    if (!f || f.special) throw new Error('Cannot delete this folder');
    await db.q('DELETE FROM local_messages WHERE owner = ? AND folder = ?', [this.owner, path]);
    await db.q('DELETE FROM local_folders WHERE owner = ? AND path = ?', [this.owner, path]);
  }
  async quota() {
    const r = await db.one('SELECT COALESCE(SUM(size),0) used FROM local_messages WHERE owner = ?', [this.owner]);
    return { used: Math.round(Number(r.used) / 1024), limit: null };
  }
}

module.exports = { LocalStore, verify, Pop3Client };
