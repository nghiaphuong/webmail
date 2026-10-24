// Thư thông báo hệ thống (đơn đăng ký mới, duyệt/từ chối) gửi từ "hộp thư hệ thống" do admin chọn.
const db = require('./db');
const config = require('./config');
const smtp = require('./mail/smtp');
const { decrypt } = require('./crypto');
const { escapeHtml } = require('./mail/render');

const T = {
  en: {
    newRegSubject: n => `New mailbox request: ${n}`,
    newRegBody: (r, url) => `<p>A visitor requested the address <b>${r}</b>.</p><p><a href="${url}">Open the admin panel</a> to approve or reject it.</p>`,
    approvedSubject: a => `Your mailbox ${a} is ready`,
    approvedBody: (a, url) => `<p>Good news! Your request was approved and <b>${a}</b> is now active.</p><p>Sign in at <a href="${url}">${url}</a> with the password you chose.</p>`,
    rejectedSubject: a => `Your mailbox request for ${a}`,
    rejectedBody: (a, why) => `<p>Sorry, your request for <b>${a}</b> was not approved.</p>${why ? `<p>Reason: ${why}</p>` : ''}`,
  },
  vi: {
    newRegSubject: n => `Yêu cầu hộp thư mới: ${n}`,
    newRegBody: (r, url) => `<p>Có khách đăng ký địa chỉ <b>${r}</b>.</p><p><a href="${url}">Mở trang quản trị</a> để duyệt hoặc từ chối.</p>`,
    approvedSubject: a => `Hộp thư ${a} của bạn đã sẵn sàng`,
    approvedBody: (a, url) => `<p>Yêu cầu của bạn đã được duyệt, địa chỉ <b>${a}</b> đã hoạt động.</p><p>Đăng nhập tại <a href="${url}">${url}</a> bằng mật khẩu bạn đã chọn.</p>`,
    rejectedSubject: a => `Yêu cầu hộp thư ${a}`,
    rejectedBody: (a, why) => `<p>Rất tiếc, yêu cầu tạo địa chỉ <b>${a}</b> chưa được chấp thuận.</p>${why ? `<p>Lý do: ${why}</p>` : ''}`,
  },
};

async function sendSystem(to, subject, html) {
  const s = db.settings();
  if (!s.systemMailboxId || !to) return false;
  const mb = await db.one('SELECT address, display_name, enc_password FROM mailboxes WHERE id = ? AND status = ?', [s.systemMailboxId, 'active']);
  const pass = mb && decrypt(mb.enc_password);
  if (!pass) return false;
  try {
    await smtp.send(mb.address, pass, { from: { name: mb.display_name || s.appName, address: mb.address }, to, subject, html });
    return true;
  } catch (e) { console.error('notify', e.message); return false; }
}

const t = lang => T[lang === 'vi' ? 'vi' : 'en'];

module.exports = {
  newRegistration: address => sendSystem(db.settings().notifyEmail, t('vi').newRegSubject(address), t('vi').newRegBody(escapeHtml(address), `${config.publicUrl}/admin#/registrations`)),
  approved: (to, lang, address) => sendSystem(to, t(lang).approvedSubject(address), t(lang).approvedBody(escapeHtml(address), config.publicUrl)),
  rejected: (to, lang, address, why) => sendSystem(to, t(lang).rejectedSubject(address), t(lang).rejectedBody(escapeHtml(address), escapeHtml(why || ''))),
};
