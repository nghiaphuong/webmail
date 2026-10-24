// Kiểm thử chế độ POP3 (thư tải về DB). Chạy: node scripts/smoke-pop3.js (máy chủ thử GreenMail)
const BASE = process.env.BASE || 'http://localhost:3100';
function client() {
  let cookie = '';
  return async (method, path, body) => {
    const r = await fetch(BASE + path, { method, redirect: 'manual', headers: { 'x-wm': '1', cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    for (const c of r.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const [k] = kv.split('='); cookie = cookie.split('; ').filter(x => x && !x.startsWith(k + '=')).concat(kv).join('; '); }
    const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
    return { status: r.status, body: j };
  };
}
const ok = (c, m) => { if (!c) { console.error('FAIL', m); process.exitCode = 1; } else console.log('ok', m); };
(async () => {
  const ad = client();
  await ad('POST', '/api/admin/login', { username: 'admin', password: 'Admin123!' });
  let r = await ad('PUT', '/api/admin/settings', { protocol: 'pop3' });
  ok(r.body.settings?.protocol === 'pop3', 'switch to pop3');
  try {
    const b = client();
    r = await b('POST', '/api/login', { email: 'bob@phuongcode.com', password: 'Secret123!' });
    ok(r.status === 200, 'pop3 login ' + JSON.stringify(r.body));
    r = await b('GET', '/api/folders');
    ok(r.status === 200, 'pop3 folders ' + r.body.folders?.map(f => `${f.path}:${f.unread}/${f.total}`).join(' '));
    r = await b('GET', '/api/messages?f=INBOX');
    ok(r.status === 200 && r.body.total > 0, 'pop3 inbox total=' + r.body.total);
    const uid = r.body.items[0].uid;
    r = await b('GET', `/api/message?f=INBOX&uid=${uid}`);
    ok(r.status === 200 && r.body.subject, 'pop3 read ' + r.body.subject);
    r = await b('GET', '/api/messages?f=INBOX&q=WYSIWYG');
    ok(r.status === 200, 'pop3 search total=' + r.body.total);
    r = await b('POST', '/api/send', { to: 'alice@phuongcode.com', subject: 'from pop3 mode', isHtml: false, text: 'hi' });
    ok(r.status === 200, 'pop3 send');
    r = await b('GET', '/api/messages?f=Sent');
    ok(r.body.total > 0, 'pop3 sent copy total=' + r.body.total);
    r = await b('POST', '/api/messages/action', { f: 'INBOX', uids: [uid], action: 'delete' });
    ok(r.status === 200, 'pop3 delete -> trash');
    r = await b('GET', '/api/messages?f=Trash');
    ok(r.body.total > 0, 'pop3 trash total=' + r.body.total);
    r = await b('POST', '/api/folders', { name: 'Work' + Date.now() });
    ok(r.status === 200, 'pop3 folder create');
    r = await b('GET', '/api/folders');
    ok(r.body.folders.find(f => f.path === 'INBOX').total >= 0, 'pop3 no re-download duplicates: ' + r.body.folders.map(f => `${f.path}:${f.total}`).join(' '));
  } finally {
    r = await ad('PUT', '/api/admin/settings', { protocol: 'imap' });
    ok(r.body.settings?.protocol === 'imap', 'switch back to imap');
  }
})();
