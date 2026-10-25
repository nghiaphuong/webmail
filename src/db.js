const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const config = require('./config');

let pool = null;

async function q(sql, params = []) {
  if (!pool) throw new Error('Database is not configured');
  const [rows] = await pool.query(sql, params);
  return rows;
}
const one = async (sql, params) => (await q(sql, params))[0] || null;

async function migrate() {
  if (!config.db.database) throw new Error('DB_NAME is empty – the webmail needs a MySQL database');
  pool = mysql.createPool({
    ...config.db,
    waitForConnections: true,
    connectionLimit: 8,
    charset: 'utf8mb4',
    timezone: 'Z',
    dateStrings: true,
    supportBigNumbers: true,
  });
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  for (const stmt of sql.split(/;\s*\n/).map(s => s.trim()).filter(Boolean)) await pool.query(stmt);
  await loadSettings();
}

// ---- Cài đặt do admin chỉnh, lưu trong bảng settings (JSON), cache trong bộ nhớ ----
const DEFAULTS = {
  appName: config.appName,
  protocol: config.mailDefaults.protocol, // 'imap' | 'pop3'
  imap: config.mailDefaults.imap,
  pop3: config.mailDefaults.pop3,
  smtp: config.mailDefaults.smtp,
  tlsInsecure: config.mailDefaults.tlsInsecure,
  pop3LeaveCopy: true,
  registrationOpen: true,
  notifyEmail: '',
  systemMailboxId: null,
  maxUploadMb: config.maxUploadMb,
  linkDefaultCanSend: true,
  // Tài khoản demo công khai (hộp thư hộp cát, không gửi thư thật)
  demoEnabled: true,
  demoEmail: `demo@${process.env.DEFAULT_DOMAIN || 'phuongcode.com'}`,
  demoPassword: 'Demo@2026',
};
let cache = { ...DEFAULTS };

async function loadSettings() {
  const rows = await q('SELECT k, v FROM settings');
  cache = { ...DEFAULTS };
  for (const r of rows) {
    if (r.k.startsWith('_')) continue;
    try { cache[r.k] = JSON.parse(r.v); } catch { /* bỏ qua giá trị hỏng */ }
  }
}
const settings = () => cache;
async function saveSettings(patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULTS)) continue;
    await q('INSERT INTO settings (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)', [k, JSON.stringify(v)]);
  }
  await loadSettings();
}
// Giá trị nội bộ (không hiển thị trong trang cài đặt), ví dụ khóa mã hóa tự sinh.
async function getInternal(k) {
  const r = await one('SELECT v FROM settings WHERE k = ?', ['_' + k]);
  return r ? JSON.parse(r.v) : null;
}
async function setInternal(k, v) {
  await q('INSERT INTO settings (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)', ['_' + k, JSON.stringify(v)]);
}

async function audit(actor, action, target = '', detail = '', ip = '') {
  try {
    await q('INSERT INTO audit_log (actor, action, target, detail, ip) VALUES (?, ?, ?, ?, ?)',
      [String(actor).slice(0, 255), action, String(target).slice(0, 255), String(detail).slice(0, 1000), ip]);
  } catch (e) { console.error('audit', e.message); }
}

module.exports = { q, one, migrate, settings, saveSettings, getInternal, setInternal, audit, DEFAULTS };
