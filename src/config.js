require('dotenv').config();

const env = process.env;
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

module.exports = {
  port: num(env.PORT, 3000),
  publicUrl: (env.PUBLIC_URL || 'http://localhost:3000').replace(/\/$/, ''),
  appName: env.APP_NAME || 'PhuongCode Mail',
  sessionSecret: env.SESSION_SECRET || '',
  encryptionKey: env.ENCRYPTION_KEY || '',
  db: {
    host: env.DB_HOST || '127.0.0.1',
    port: num(env.DB_PORT, 3306),
    database: env.DB_NAME || '',
    user: env.DB_USER || '',
    password: env.DB_PASSWORD || '',
  },
  admin: { user: env.ADMIN_USER || '', password: env.ADMIN_PASSWORD || '' },
  // Hostinger Mail API (hPanel > API). Bỏ trống = admin tạo hộp thư thủ công trong hPanel.
  hostingerToken: env.HOSTINGER_API_TOKEN || '',
  hostingerApi: (env.HOSTINGER_API_URL || 'https://developers.hostinger.com').replace(/\/$/, ''),
  // Giá trị mặc định cho máy chủ thư (admin có thể đổi trong trang quản trị).
  mailDefaults: {
    protocol: env.MAIL_PROTOCOL || 'imap',
    imap: { host: env.IMAP_HOST || 'imap.hostinger.com', port: num(env.IMAP_PORT, 993), secure: env.IMAP_SECURE !== 'false' },
    pop3: { host: env.POP3_HOST || 'pop.hostinger.com', port: num(env.POP3_PORT, 995), secure: env.POP3_SECURE !== 'false' },
    smtp: { host: env.SMTP_HOST || 'smtp.hostinger.com', port: num(env.SMTP_PORT, 465), secure: env.SMTP_SECURE !== 'false' },
    tlsInsecure: env.MAIL_TLS_INSECURE === 'true',
  },
  provisioner: env.PROVISIONER || '', // '' = tự chọn (hostinger nếu có token, ngược lại manual); 'greenmail' cho môi trường thử
  greenmailApi: env.GREENMAIL_API || 'http://127.0.0.1:8090',
  maxUploadMb: num(env.MAX_UPLOAD_MB, 25),
};
