const db = require('../db');
const imap = require('./imap');
const pop3 = require('./pop3');
const session = require('../session');
const { DemoStore } = require('./demo');

// Trả về kho thư (IMAP hoặc POP3+cục bộ) cho phiên hiện tại.
async function forSession(s) {
  if (s.kind === 'demo') return new DemoStore(s.owner, s.address);
  const pass = await session.mailPassword(s);
  if (!pass) throw Object.assign(new Error('Session credentials unavailable'), { status: 401 });
  if (db.settings().protocol === 'pop3') return new pop3.LocalStore(s.address, pass);
  return imap.get(s.id, s.address, pass);
}

async function verify(user, pass) {
  return db.settings().protocol === 'pop3' ? pop3.verify(user, pass) : imap.verify(user, pass);
}

module.exports = { forSession, verify, drop: imap.drop };
