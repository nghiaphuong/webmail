const nodemailer = require('nodemailer');
const MailComposer = require('nodemailer/lib/mail-composer');
const db = require('../db');

function transport(user, pass) {
  const s = db.settings();
  return nodemailer.createTransport({
    host: s.smtp.host, port: Number(s.smtp.port), secure: !!s.smtp.secure,
    auth: { user, pass },
    tls: { rejectUnauthorized: !s.tlsInsecure },
    connectionTimeout: 20000, greetingTimeout: 15000, socketTimeout: 60000,
  });
}

// Dựng thư thô (RFC 822). keepBcc = true cho bản lưu trong Sent/Drafts.
function build(mail, keepBcc = false) {
  const c = new MailComposer(mail).compile();
  c.keepBcc = keepBcc;
  return new Promise((resolve, reject) => c.build((e, raw) => (e ? reject(e) : resolve({ raw, envelope: c.getEnvelope(), messageId: c.messageId() }))));
}

async function send(user, pass, mail) {
  const sent = await build(mail, false);
  const t = transport(user, pass);
  try {
    await t.sendMail({ envelope: sent.envelope, raw: sent.raw });
  } finally { t.close(); }
  const copy = await build({ ...mail, messageId: sent.messageId }, true);
  return { raw: copy.raw, messageId: sent.messageId };
}

async function verify(user, pass) {
  const t = transport(user, pass);
  try { await t.verify(); return true; } finally { t.close(); }
}

module.exports = { send, build, verify };
