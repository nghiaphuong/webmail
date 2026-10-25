// Chế độ demo: tài khoản thử công khai cho khách/nhà tuyển dụng. Mỗi phiên demo có hộp thư riêng lưu trong DB
// (không dùng máy chủ thư thật), được tạo sẵn thư mẫu; thư "gửi đi" không bao giờ ra ngoài Internet.
const zlib = require('zlib');
const db = require('../db');
const smtp = require('./smtp');
const { LocalStore, indexFields, sqlDate } = require('./pop3');

// Ảnh PNG nhỏ (dải màu xanh – tím) dùng làm ảnh nhúng trong thư mẫu.
function makePng(w, h) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3);
    for (let x = 0; x < w; x++) {
      const t = (x + y) / (w + h);
      row[1 + x * 3] = Math.round(59 + (109 - 59) * t);
      row[2 + x * 3] = Math.round(130 + (40 - 130) * t);
      row[3 + x * 3] = Math.round(246 + (217 - 246) * t);
    }
    rows.push(row);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

const ago = h => new Date(Date.now() - h * 3600e3);

function samples(me) {
  const logo = makePng(120, 120);
  const card = 'font-family:Segoe UI,Arial,sans-serif;max-width:620px;margin:auto;color:#1d2433';
  return [
    {
      folder: 'INBOX', flags: [], date: ago(0.3),
      mail: {
        from: { name: 'PhuongCode Mail', address: 'hello@phuongcode.com' }, to: me, subject: 'Welcome to PhuongCode Mail 👋',
        html: `<div style="${card}"><p><img src="cid:logo@demo" width="60" height="60" alt="logo" style="border-radius:14px"></p>
          <h2 style="margin:0 0 8px">Welcome to the demo!</h2>
          <p>This is a <b>private sandbox mailbox</b> just for you. Everything works like a real mailbox – but nothing you send leaves this demo, and the data is wiped after a few hours.</p>
          <h3>Things to try</h3>
          <ol>
            <li><b>Compose</b> a rich-text message (fonts, colours, tables, images, emoji) and send it to <i>${me.address}</i> – it arrives in your Inbox.</li>
            <li>Reply, reply all or forward this message – the attachment below comes along.</li>
            <li>Open the <i>Weekly design digest</i> to see how <b>remote images are blocked</b> for privacy.</li>
            <li>Star, move, archive, mark as spam, drag messages onto folders, create your own folders.</li>
            <li>Search, filter unread/starred, and use keyboard shortcuts (<code>c</code>, <code>r</code>, <code>j</code>/<code>k</code>, <code>/</code>).</li>
            <li>Switch the language (EN / VI) and the dark theme in <b>Settings</b>, set a signature, manage contacts.</li>
          </ol>
          <table style="border-collapse:collapse;margin-top:10px" cellpadding="8" border="1">
            <tr style="background:#eef2ff"><th>Feature</th><th>Status</th></tr>
            <tr><td>IMAP / POP3 / SMTP</td><td>✅</td></tr><tr><td>WYSIWYG editor</td><td>✅</td></tr><tr><td>Admin panel &amp; random addresses</td><td>✅</td></tr>
          </table>
          <p style="color:#667085;font-size:13px;margin-top:18px">Built by Nghia Phuong Luu · <a href="https://phuongcode.com">phuongcode.com</a></p></div>`,
        attachments: [
          { filename: 'logo.png', content: logo, contentType: 'image/png', cid: 'logo@demo' },
          { filename: 'feature-list.txt', content: 'PhuongCode Mail – features\n\n- Three-pane mail client\n- Rich-text compose (TinyMCE)\n- Attachments, drafts, read receipts\n- Contacts with vCard import/export\n- Admin: domains, mailboxes, registrations, random addresses with no-login links\n- English and Vietnamese\n', contentType: 'text/plain' },
        ],
      },
    },
    {
      folder: 'INBOX', flags: [], date: ago(2),
      mail: {
        from: { name: 'Nguyễn Minh Anh', address: 'minhanh@example.vn' }, to: me, subject: 'Chào mừng bạn đến với webmail 🇻🇳',
        html: `<div style="${card}"><p>Xin chào,</p><p>Webmail này hỗ trợ <b>tiếng Việt</b> và <b>tiếng Anh</b>. Bạn có thể đổi ngôn ngữ bằng nút <b>EN / VI</b> ở góc trên bên phải hoặc trong phần <i>Cài đặt</i>.</p>
          <ul><li>Soạn thư có định dạng, chèn bảng, hình ảnh</li><li>Danh bạ, chữ ký, thư nháp tự lưu</li><li>Giao diện sáng / tối, dùng tốt trên điện thoại</li></ul>
          <p>Thân mến,<br>Minh Anh</p></div>`,
      },
    },
    {
      folder: 'INBOX', flags: ['\\Seen'], date: ago(5),
      mail: {
        from: { name: 'Design Weekly', address: 'digest@designweekly.example' }, to: me, subject: 'Weekly design digest – remote images are blocked',
        html: `<div style="${card}"><h2>This week in design</h2>
          <p><img src="https://picsum.photos/seed/phuongcode/600/220" width="600" height="220" alt="Banner" style="max-width:100%;border-radius:10px"></p>
          <p>Newsletters often embed remote images that tell the sender when and where you opened the message. PhuongCode Mail hides them until you click <b>Show images</b>.</p>
          <p><a href="https://phuongcode.com">Read more →</a></p></div>`,
        headers: { 'List-Unsubscribe': '<mailto:unsubscribe@designweekly.example>' },
      },
    },
    {
      folder: 'INBOX', flags: ['\\Seen', '\\Flagged'], date: ago(26),
      mail: {
        from: { name: 'Ingrid Hansen', address: 'ingrid.hansen@example.no' }, to: me, cc: [{ name: 'Lars Berg', address: 'lars.berg@example.no' }],
        subject: 'Q3 numbers for the board meeting', priority: 'high',
        html: `<div style="${card}"><p>Hi,</p><p>Attached are the Q3 figures we discussed. Could you confirm you have received them? (This message asks for a <b>read receipt</b>.)</p>
          <table cellpadding="6" style="border-collapse:collapse" border="1"><tr><th>Region</th><th>Revenue (NOK m)</th><th>Growth</th></tr>
          <tr><td>Norway</td><td>12.4</td><td style="color:#16a34a">+8%</td></tr><tr><td>Vietnam</td><td>7.9</td><td style="color:#16a34a">+21%</td></tr><tr><td>ASEAN</td><td>4.2</td><td style="color:#dc2626">−3%</td></tr></table>
          <p>Best regards,<br>Ingrid</p></div>`,
        attachments: [{ filename: 'q3-revenue.csv', content: 'region,revenue_nok_m,growth\nNorway,12.4,0.08\nVietnam,7.9,0.21\nASEAN,4.2,-0.03\n', contentType: 'text/csv' }],
        headers: { 'Disposition-Notification-To': 'ingrid.hansen@example.no' },
      },
    },
    {
      folder: 'INBOX', flags: ['\\Seen', '\\Answered'], date: ago(50),
      mail: {
        from: { name: 'Lars Berg', address: 'lars.berg@example.no' }, to: me, subject: 'Re: Coffee next week?',
        text: 'Thursday at 10:00 works for me. See you at the usual place!\n\nLars\n\n> Are you free for a coffee next week?',
      },
    },
    {
      folder: 'Sent', flags: ['\\Seen'], date: ago(52),
      mail: { from: me, to: [{ name: 'Lars Berg', address: 'lars.berg@example.no' }], subject: 'Coffee next week?', html: '<p>Hi Lars,</p><p>Are you free for a coffee next week?</p><p>Cheers</p>' },
    },
    {
      folder: 'Drafts', flags: ['\\Seen', '\\Draft'], date: ago(1),
      mail: { from: me, to: [{ name: 'Ingrid Hansen', address: 'ingrid.hansen@example.no' }], subject: 'Re: Q3 numbers for the board meeting', html: '<p>Hi Ingrid,</p><p>Thanks, I have received the figures. A few questions about ASEAN:</p><ul><li>…</li></ul>' },
    },
    {
      folder: 'Junk', flags: [], date: ago(8),
      mail: { from: { name: 'Lottery Winner Dept', address: 'win@prize.example' }, to: me, subject: 'CONGRATULATIONS!!! You have won $1,000,000', html: '<h1 style="color:red">You are our lucky winner!!!</h1><p>Send us your bank details to claim your prize.</p><p><i>(A sample spam message – try “Not spam” or “Empty folder”.)</i></p>' },
    },
    {
      folder: 'Projects', flags: ['\\Seen'], date: ago(30),
      mail: { from: { name: 'Deploy Bot', address: 'deploy@ci.example' }, to: me, subject: 'Your website mail.phuongcode.com is live', html: `<div style="${card}"><p>Your Node.js application has been built and deployed successfully.</p><p><b>Build:</b> completed in 11s · <b>Node.js:</b> 22</p></div>` },
    },
  ];
}

const seeding = new Map();

class DemoStore extends LocalStore {
  constructor(owner, address) { super(owner, null); this.address = address; }
  async sync() { /* demo: không có máy chủ POP3 */ }
  async list(path, opts) { await this.ensureFolders(); return super.list(path, opts); }
  // Tránh tạo thư mẫu hai lần khi nhiều yêu cầu đầu tiên đến cùng lúc.
  ensureFolders() {
    if (!seeding.has(this.owner)) seeding.set(this.owner, this.seed().finally(() => setTimeout(() => seeding.delete(this.owner), 60e3)));
    return seeding.get(this.owner);
  }
  async seed() {
    const n = Number((await db.one('SELECT COUNT(*) n FROM local_folders WHERE owner = ?', [this.owner])).n);
    if (n) return;
    await super.ensureFolders();
    await db.q('INSERT IGNORE INTO local_folders (owner, path) VALUES (?, ?)', [this.owner, 'Projects']);
    const me = { name: 'Demo User', address: this.address };
    for (const s of samples(me)) {
      const { raw } = await smtp.build({ ...s.mail, date: s.date }, true);
      await this.insert(s.folder, raw, s.flags, s.date);
    }
    for (const [name, email, org] of [['Ingrid Hansen', 'ingrid.hansen@example.no', 'Nordic Ventures AS'], ['Lars Berg', 'lars.berg@example.no', 'Nordic Ventures AS'], ['Nguyễn Minh Anh', 'minhanh@example.vn', 'Hanoi Tech']]) {
      await db.q('INSERT IGNORE INTO contacts (owner, name, email, org) VALUES (?, ?, ?, ?)', [this.owner, name, email, org]);
    }
  }
  async insert(folder, raw, flags, date) {
    const f = await indexFields(raw);
    await db.q('INSERT INTO local_messages (owner, folder, flags, internal_date, size, subject, from_json, to_json, has_att, search_text, raw) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [this.owner, folder, flags.join(','), sqlDate(date), raw.length, f.subject, JSON.stringify(f.from), JSON.stringify({ to: f.to, cc: f.cc }), f.att ? 1 : 0, f.text, raw]);
  }
  async quota() { const q = await super.quota(); return { used: q.used, limit: 50 * 1024 }; }
}

// "Gửi" trong demo: lưu bản sao vào Sent; thư gửi cho chính địa chỉ demo được đưa vào Hộp thư đến.
async function deliver(store, mail, recipients) {
  const { raw, messageId } = await smtp.build(mail, true);
  await store.insert('Sent', raw, ['\\Seen'], new Date());
  if (recipients.some(a => a.address.toLowerCase() === store.address.toLowerCase())) {
    const { raw: inRaw } = await smtp.build({ ...mail, bcc: [], messageId }, false);
    await store.insert('INBOX', inRaw, [], new Date());
  }
  return { messageId };
}

// Xóa hộp thư demo của các phiên đã hết hạn.
async function cleanup() {
  const live = "SELECT CONCAT('demo:', LEFT(id, 24)) FROM sessions WHERE kind = 'demo' AND expires_at > UTC_TIMESTAMP()";
  for (const t of ['local_messages', 'local_folders', 'contacts']) await db.q(`DELETE FROM ${t} WHERE owner LIKE 'demo:%' AND owner NOT IN (${live})`).catch(() => {});
  await db.q(`DELETE FROM user_prefs WHERE address LIKE 'demo:%' AND address NOT IN (${live})`).catch(() => {});
}

module.exports = { DemoStore, deliver, cleanup };
