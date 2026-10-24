// Tạo / xóa / đổi mật khẩu hộp thư thật trên máy chủ thư.
//  - hostinger: Hostinger Mail API (developers.hostinger.com, /api/mail/v1), cần HOSTINGER_API_TOKEN
//  - greenmail: máy chủ thư thử nghiệm cục bộ (chỉ để phát triển)
//  - manual:    admin tự tạo hộp thư trong hPanel rồi bấm "Kiểm tra" trong trang quản trị
const config = require('./config');
const db = require('./db');

function mode() {
  if (config.provisioner) return config.provisioner;
  return config.hostingerToken ? 'hostinger' : 'manual';
}

class ApiError extends Error {}

async function hapi(method, path, body) {
  const r = await fetch(config.hostingerApi + path, {
    method,
    headers: { Authorization: `Bearer ${config.hostingerToken}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { message: text.slice(0, 300) }; }
  if (!r.ok) {
    const detail = data?.errors ? Object.values(data.errors).flat().join(' ') : '';
    throw new ApiError(`Hostinger API ${r.status}: ${data?.message || r.statusText}${detail ? ' – ' + detail : ''}`);
  }
  return data;
}

const orderDomain = o => {
  const d = o.domain;
  if (!d) return '';
  return String(typeof d === 'string' ? d : d.domain || d.name || d.fqdn || '').toLowerCase();
};

async function listOrders() {
  const out = [];
  for (let page = 1; page < 20; page++) {
    const r = await hapi('GET', `/api/mail/v1/orders?page=${page}&per_page=100`);
    const items = r?.data || [];
    out.push(...items.map(o => ({ id: o.id, domain: orderDomain(o), status: o.status, seats: o.seats, expires_at: o.expires_at, plan: o.plan?.name || o.plan?.slug || o.plan || '' })));
    if (!r?.meta || page * (r.meta.per_page || 100) >= (r.meta.total || 0)) break;
  }
  return out;
}

async function orderFor(domainRow) {
  if (domainRow.hostinger_order_id) return domainRow.hostinger_order_id;
  const orders = await listOrders();
  const o = orders.find(x => x.domain === domainRow.domain.toLowerCase());
  if (!o) throw new ApiError(`No Hostinger mail order found for ${domainRow.domain}`);
  await db.q('UPDATE domains SET hostinger_order_id = ? WHERE id = ?', [o.id, domainRow.id]);
  return o.id;
}

async function listRemoteMailboxes(domainRow) {
  const orderId = await orderFor(domainRow);
  const out = [];
  for (let page = 1; page < 50; page++) {
    const r = await hapi('GET', `/api/mail/v1/orders/${encodeURIComponent(orderId)}/mailboxes?page=${page}&per_page=100`);
    out.push(...(r?.data || []));
    if (!r?.meta || page * (r.meta.per_page || 100) >= (r.meta.total || 0)) break;
  }
  return out;
}

async function findRemoteId(address, domainRow) {
  const orderId = await orderFor(domainRow);
  const r = await hapi('GET', `/api/mail/v1/orders/${encodeURIComponent(orderId)}/mailboxes?search=${encodeURIComponent(address)}&per_page=50`);
  return (r?.data || []).find(m => String(m.address).toLowerCase() === address.toLowerCase())?.id || null;
}

async function greenmail(method, path, body) {
  const r = await fetch(config.greenmailApi + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new ApiError(`GreenMail ${r.status}: ${await r.text()}`);
  return r.headers.get('content-type')?.includes('json') ? r.json() : null;
}

// Trả về { status: 'active' | 'pending_provision', providerId }.
async function create(address, password, domainRow) {
  const m = mode();
  const local = address.split('@')[0];
  if (m === 'hostinger') {
    const orderId = await orderFor(domainRow);
    const r = await hapi('POST', `/api/mail/v1/orders/${encodeURIComponent(orderId)}/mailboxes`, { local_part: local, password });
    return { status: 'active', providerId: r?.id || null };
  }
  if (m === 'greenmail') {
    await greenmail('POST', '/api/user', { email: address, login: address, password });
    return { status: 'active', providerId: null };
  }
  return { status: 'pending_provision', providerId: null };
}

async function remove(mb, domainRow) {
  const m = mode();
  if (m === 'hostinger') {
    const id = mb.provider_id || await findRemoteId(mb.address, domainRow);
    if (id) await hapi('DELETE', `/api/mail/v1/mailboxes/${encodeURIComponent(id)}`);
    return !!id;
  }
  if (m === 'greenmail') { await greenmail('DELETE', '/api/user/' + encodeURIComponent(mb.address)).catch(() => {}); return true; }
  return false;
}

async function setPassword(mb, domainRow, password) {
  const m = mode();
  if (m === 'hostinger') {
    const id = mb.provider_id || await findRemoteId(mb.address, domainRow);
    if (!id) throw new ApiError('Mailbox not found in Hostinger');
    await hapi('PATCH', `/api/mail/v1/mailboxes/${encodeURIComponent(id)}/password`, { password });
    if (!mb.provider_id && mb.id) await db.q('UPDATE mailboxes SET provider_id = ? WHERE id = ?', [id, mb.id]);
    return true;
  }
  if (m === 'greenmail') {
    await greenmail('DELETE', '/api/user/' + encodeURIComponent(mb.address)).catch(() => {});
    await greenmail('POST', '/api/user', { email: mb.address, login: mb.address, password });
    return true;
  }
  return false; // thủ công: admin đổi trong hPanel
}

module.exports = { mode, create, remove, setPassword, listOrders, listRemoteMailboxes, ApiError };
