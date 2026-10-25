// Kiểm thử tài khoản demo (hộp thư hộp cát). Chạy: node scripts/smoke-demo.js
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
  const pub = client();
  const cfg = (await pub('GET', '/api/public/config')).body;
  ok(cfg.demo?.email && cfg.demo?.password, 'demo credentials published ' + cfg.demo?.email);
  const a = client(), b = client();
  let r = await a('POST', '/api/login', cfg.demo);
  ok(r.status === 200 && r.body.demo, 'demo login A');
  await b('POST', '/api/login', cfg.demo);
  r = await a('GET', '/api/me');
  ok(r.body.kind === 'demo' && r.body.address === cfg.demo.email && !r.body.canChangePassword, 'me demo');
  r = await a('GET', '/api/folders');
  ok(r.body.folders.length >= 6, 'seeded folders ' + r.body.folders.map(f => `${f.path}:${f.unread}/${f.total}`).join(' '));
  r = await a('GET', '/api/messages?f=INBOX');
  ok(r.body.total >= 5, 'seeded inbox ' + r.body.items.map(m => m.subject).join(' | '));
  const welcome = r.body.items.find(m => /Welcome/.test(m.subject));
  r = await a('GET', `/api/message?f=INBOX&uid=${welcome.uid}`);
  ok(r.body.attachments.length === 1 && /part\?/.test(r.body.html), 'welcome renders inline image + attachment');
  r = await a('GET', '/api/messages?f=INBOX');
  const digest = r.body.items.find(m => /digest/.test(m.subject));
  r = await a('GET', `/api/message?f=INBOX&uid=${digest.uid}`);
  ok(r.body.blocked > 0, 'remote image blocked in digest');
  r = await a('POST', '/api/send', { to: cfg.demo.email + ', someone@gmail.com', subject: 'Hello from demo', isHtml: true, html: '<p>Test <b>bold</b></p>' });
  ok(r.status === 200 && r.body.warnings.includes('demo_not_delivered'), 'demo send simulated');
  r = await a('GET', '/api/messages?f=INBOX&q=Hello from demo');
  ok(r.body.total === 1, 'self-addressed demo message arrived in inbox');
  r = await b('GET', '/api/messages?f=INBOX&q=Hello from demo');
  ok(r.body.total === 0, 'visitor B sandbox isolated');
  r = await a('POST', '/api/contacts', { name: 'X', email: 'x@example.com' });
  r = await b('GET', '/api/contacts?q=x@example.com');
  ok(r.body.contacts.length === 0, 'contacts isolated');
  r = await a('POST', '/api/password', { current: cfg.demo.password, next: 'Abcdef1!x' });
  ok(r.status === 403, 'demo cannot change password');
  r = await a('POST', '/api/login', { email: cfg.demo.email, password: 'wrong' });
  ok(r.status !== 200, 'wrong demo password rejected ' + r.status);
  r = await a('POST', '/api/logout', {});
  ok(r.status === 200, 'logout');
})();
