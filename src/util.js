// Tiện ích dùng chung cho các route.
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

class HttpError extends Error {
  constructor(status, code, message) { super(message || code); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new HttpError(status, code, message); };

// Giới hạn tần suất đơn giản trong bộ nhớ: tối đa `max` lần trong `windowMs` cho mỗi khóa.
const buckets = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const b = (buckets.get(key) || []).filter(t => now - t < windowMs);
  if (b.length >= max) { buckets.set(key, b); return true; }
  b.push(now); buckets.set(key, b);
  return false;
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (!b.some(t => now - t < 3600e3)) buckets.delete(k); }, 600e3).unref();

const EMAIL_RE = /^[^\s@<>()",;:]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
const isEmail = s => typeof s === 'string' && s.length <= 254 && EMAIL_RE.test(s.trim());
const LOCAL_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const isLocalPart = s => typeof s === 'string' && LOCAL_RE.test(s) && !/[._-]{2}/.test(s);
const DOMAIN_RE = /^(?=.{3,190}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const isDomain = s => typeof s === 'string' && DOMAIN_RE.test(s);

const RESERVED = new Set(['admin', 'administrator', 'root', 'postmaster', 'hostmaster', 'webmaster', 'abuse', 'security', 'noreply', 'no-reply', 'mailer-daemon', 'support', 'info', 'billing', 'sales', 'contact', 'help']);

const str = (v, max = 255) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const int = (v, d, min = -Infinity, max = Infinity) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };
const sqlDate = d => new Date(d).toISOString().slice(0, 19).replace('T', ' ');

module.exports = { wrap, HttpError, fail, limited, isEmail, isLocalPart, isDomain, RESERVED, str, int, sqlDate };
