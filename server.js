const path = require('path');
const express = require('express');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const config = require('./src/config');
const db = require('./src/db');
const crypto = require('./src/crypto');
const session = require('./src/session');
const admin = require('./src/routes/admin');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(compression());
app.use(cookieParser());

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (config.publicUrl.startsWith('https://')) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  next();
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

// Chống CSRF: mọi yêu cầu thay đổi dữ liệu tới /api phải có header X-WM (trang khác không gửi được header tùy chỉnh).
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.get('x-wm') !== '1') return res.status(403).json({ error: 'csrf' });
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use('/api', express.json({ limit: '30mb' }));
app.use(session.attach);
app.use('/api/admin', admin.router);
app.use('/', require('./src/routes/public'));
app.use('/api', require('./src/routes/mail'));
app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));

// Trang & tài nguyên tĩnh
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob: https: http:",
  "font-src 'self' data:", "connect-src 'self'", "frame-src 'self' blob: about:", "object-src 'none'", "base-uri 'self'",
  "form-action 'self'", "frame-ancestors 'self'",
].join('; ');
const page = file => (req, res) => {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', file));
};
app.get('/', page('index.html'));
app.get('/admin', page('admin.html'));
app.get('/register', page('register.html'));

const staticOpts = maxAge => ({
  index: false,
  setHeaders(res, file) {
    res.setHeader('Cache-Control', /\.(js|css|html|json)$/.test(file) && !maxAge ? 'no-cache' : `public, max-age=${maxAge || 604800}`);
  },
});
app.use('/vendor/tinymce', express.static(path.join(__dirname, 'node_modules/tinymce'), staticOpts(86400)));
app.use('/vendor/tinymce-langs', express.static(path.join(__dirname, 'node_modules/tinymce-i18n/langs8'), staticOpts(86400)));
app.use(express.static(path.join(__dirname, 'public'), staticOpts(0)));
app.use((req, res) => res.status(404).sendFile(path.join(__dirname, 'public', '404.html')));

// Lỗi: trả JSON cho API.
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  const status = err.status || (err.type === 'entity.too.large' ? 413 : 500);
  if (status >= 500 && !err.code) console.error(req.method, req.path, err);
  if (res.headersSent) return;
  res.status(status).json({ error: err.code || (status === 413 ? 'too_large' : 'server_error'), message: status < 500 || err.code ? err.message : undefined });
});

(async () => {
  try {
    await db.migrate();
    await crypto.init();
    await admin.bootstrap();
    const n = Number((await db.one('SELECT COUNT(*) n FROM domains')).n);
    if (!n && process.env.DEFAULT_DOMAIN !== '') {
      await db.q('INSERT INTO domains (domain, allow_registration) VALUES (?, 1)', [process.env.DEFAULT_DOMAIN || 'phuongcode.com']);
    }
    setInterval(session.cleanup, 3600e3).unref();
    console.log('Database ready');
  } catch (e) {
    console.error('Startup error – check DB_* variables:', e.message);
  }
  app.listen(config.port, () => console.log(`Webmail listening on ${config.port}`));
})();
