// Kiểm thử nhanh API với máy chủ thư cục bộ (GreenMail). Chạy: node scripts/smoke.js
const BASE = process.env.BASE || 'http://localhost:3100';
function client() {
  let cookie = '';
  return async (method, path, body, raw) => {
    const r = await fetch(BASE + path, { method, redirect: 'manual', headers: { 'x-wm': '1', cookie, ...(body && !raw ? { 'content-type': 'application/json' } : {}) }, body: raw ? body : body ? JSON.stringify(body) : undefined });
    const sc = r.headers.getSetCookie?.() || [];
    for (const c of sc) { const [kv] = c.split(';'); const [k] = kv.split('='); cookie = cookie.split('; ').filter(x => x && !x.startsWith(k + '=')).concat(kv).join('; '); }
    const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
    return { status: r.status, body: j, headers: r.headers };
  };
}
const ok = (c, m) => { if (!c) { console.error('FAIL', m); process.exitCode = 1; } else console.log('ok', m); };
(async () => {
  const a = client();
  let r = await a('POST', '/api/login', { email: 'alice@phuongcode.com', password: 'wrong' });
  ok(r.status === 401, 'wrong password rejected ' + r.status);
  r = await a('POST', '/api/login', { email: 'alice@phuongcode.com', password: 'Secret123!' });
  ok(r.status === 200, 'login ' + JSON.stringify(r.body));
  r = await a('GET', '/api/folders');
  ok(r.status === 200, 'folders ' + JSON.stringify(r.body).slice(0, 400));
  r = await a('POST', '/api/send', { to: 'bob@phuongcode.com, "Alice" <alice@phuongcode.com>', subject: 'Xin chào ' + Date.now(), isHtml: true, html: '<p>Hello <b>Bob</b> <img src="https://example.com/x.png"></p><script>alert(1)</script>' });
  ok(r.status === 200, 'send ' + JSON.stringify(r.body));
  r = await a('GET', '/api/messages?f=INBOX');
  ok(r.status === 200 && r.body.total > 0, 'inbox list total=' + r.body.total);
  const uid = r.body.items?.[0]?.uid;
  r = await a('GET', `/api/message?f=INBOX&uid=${uid}`);
  ok(r.status === 200 && !/script/.test(r.body.html) && r.body.blocked > 0, 'message view sanitized, blocked=' + r.body.blocked);
  r = await a('GET', `/api/message/compose?f=INBOX&uid=${uid}&mode=replyall`);
  ok(r.status === 200, 'reply prefill ' + JSON.stringify({ to: r.body.to, cc: r.body.cc, subject: r.body.subject }));
  r = await a('POST', '/api/draft', { to: 'bob@phuongcode.com', subject: 'draft', isHtml: true, html: '<p>draft <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="></p>' });
  ok(r.status === 200 && r.body.draft, 'draft ' + JSON.stringify(r.body));
  r = await a('POST', '/api/folders', { name: 'Projects' + Date.now() });
  ok(r.status === 200, 'create folder ' + JSON.stringify(r.body));
  r = await a('GET', '/api/messages?f=INBOX&q=Bob&scope=all');
  ok(r.status === 200, 'search total=' + r.body.total);
  r = await a('POST', '/api/messages/action', { f: 'INBOX', uids: [uid], action: 'delete' });
  ok(r.status === 200, 'delete -> trash');
  r = await a('GET', '/api/folders');
  console.log(r.body.folders.map(f => `${f.path}(${f.special || ''}) ${f.unread}/${f.total}`).join(' | '));
  r = await a('POST', '/api/contacts', { name: 'Bob', email: 'bob@phuongcode.com' });
  ok(r.status === 200, 'contact add');
  r = await a('GET', '/api/contacts/suggest?q=bo');
  ok(r.body.contacts?.length, 'suggest ' + JSON.stringify(r.body));

  // Admin
  const ad = client();
  r = await ad('POST', '/api/admin/login', { username: 'admin', password: 'Admin123!' });
  ok(r.status === 200, 'admin login');
  r = await ad('GET', '/api/admin/domains');
  const dom = r.body.domains[0];
  r = await ad('POST', '/api/admin/mailboxes/random', { domainId: dom.id, length: 12, charset: 'alnum', count: 2, canSend: true, expiresDays: 7 });
  ok(r.status === 200 && r.body.created.length === 2, 'random ' + JSON.stringify(r.body).slice(0, 300));
  const link = r.body.created[0].link.url;
  const g = client();
  r = await g('GET', link.replace(/^https?:\/\/[^/]+/, ''));
  ok(r.status === 302 && r.headers.get('location').includes('#/mail'), 'magic link redirect');
  r = await g('GET', '/api/me');
  ok(r.status === 200 && r.body.kind === 'link', 'link session me ' + r.body.address);
  r = await g('GET', '/api/folders');
  ok(r.status === 200, 'link folders');
  // Đăng ký
  const pub = client();
  r = await pub('GET', '/api/public/config');
  ok(r.body.domains?.length, 'public config');
  const local = 'guest' + Date.now().toString(36);
  r = await pub('POST', '/api/public/register', { local, domainId: dom.id, displayName: 'Guest', password: 'Guest123!x', contactEmail: 'g@example.com', lang: 'vi' });
  ok(r.status === 200, 'register ' + JSON.stringify(r.body));
  const st = r.body.token;
  r = await pub('POST', '/api/login', { email: `${local}@${dom.domain}`, password: 'Guest123!x' });
  ok(r.status === 401, 'pending registration cannot login ' + r.status);
  r = await ad('GET', '/api/admin/registrations');
  const reg = r.body.registrations.find(x => x.local_part === local);
  r = await ad('POST', `/api/admin/registrations/${reg.id}/approve`, {});
  ok(r.status === 200, 'approve ' + JSON.stringify(r.body));
  r = await pub('GET', '/api/public/register/status?token=' + st);
  ok(r.body.status === 'approved', 'status approved');
  r = await pub('POST', '/api/login', { email: `${local}@${dom.domain}`, password: 'Guest123!x' });
  ok(r.status === 200, 'approved user login');
  r = await ad('GET', '/api/admin/stats');
  ok(r.status === 200, 'stats ' + JSON.stringify(r.body).slice(0, 200));
  r = await a('POST', '/api/messages/action', { f: 'INBOX', uids: [1], action: 'read' }, false);
  r = await fetch(BASE + '/api/logout', { method: 'POST' });
  ok(r.status === 403, 'csrf header enforced');
})();
