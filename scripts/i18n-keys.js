// Kiểm tra: mọi khóa i18n dùng trong public/*.js đều có trong cả tiếng Anh và tiếng Việt.
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'public');
global.window = {};
require(path.join(dir, 'i18n.js'));
const D = window.I18N;
const used = new Set();
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.js') && f !== 'i18n.js')) {
  const src = fs.readFileSync(path.join(dir, f), 'utf8');
  for (const m of src.matchAll(/\bt\('([a-zA-Z0-9_.]+)'/g)) used.add(m[1]);
  for (const m of src.matchAll(/data-i18n(?:-ph|-title)?="([a-zA-Z0-9_.]+)"/g)) used.add(m[1]);
}
// Khóa động
const dyn = {
  'err.': ['invalid_credentials', 'too_many_attempts', 'domain_not_allowed', 'mailbox_disabled', 'mailbox_pending', 'mail_server_unreachable', 'not_logged_in', 'forbidden', 'wrong_password', 'weak_password', 'provider_error', 'not_supported', 'invalid_name', 'folder_exists', 'cannot_modify_special', 'only_trash_or_junk', 'message_not_found', 'not_found', 'no_messages', 'folder_required', 'no_junk_folder', 'unknown_action', 'sending_disabled', 'file_too_large', 'too_many_recipients', 'invalid_recipient', 'attachments_too_large', 'send_rate_limited', 'no_recipients', 'smtp_error', 'no_drafts_folder', 'invalid_email', 'contact_exists', 'registration_closed', 'invalid_local_part', 'reserved_address', 'address_taken', 'invalid_token', 'setup_done', 'invalid_setup_code', 'invalid_input', 'invalid_domain', 'domain_exists', 'domain_in_use', 'no_stored_password', 'could_not_generate', 'invalid_host', 'exists', 'cannot_delete_self', 'csrf', 'server_error', 'network_error', 'too_large', 'upload_failed', 'editor', 'session_credentials'],
  'folder.': ['inbox', 'drafts', 'sent', 'junk', 'trash', 'archive'],
  'filter.': ['all', 'unread', 'flagged'],
  'done.': ['delete', 'move', 'spam', 'notspam', 'archive'],
  'search.': ['all', 'subject', 'from', 'to', 'body'],
  'settings.tab.': ['general', 'identity', 'compose', 'privacy', 'folders', 'password', 'clients'],
  'kind.': ['admin', 'registered', 'random', 'external'],
  'status.': ['active', 'disabled', 'pending_provision'],
  'prov.': ['hostinger', 'manual', 'greenmail'],
  'charset.': ['alnum', 'letters', 'digits', 'hex'],
  'reg.': ['pending', 'approved', 'rejected'],
  'reg.statusText.': ['pending', 'approved', 'rejected'],
  'admin.nav.': ['dashboard', 'mailboxes', 'random', 'registrations', 'domains', 'settings', 'admins', 'audit'],
  'theme.': ['auto', 'light', 'dark'],
  'priority.': ['high', 'normal', 'low'],
  'settings.': ['previewPane', 'notifications', 'confirmDelete', 'composeHtml', 'replyAbove', 'collectContacts', 'blockRemote'],
  'act.': ['unflag'],
};
for (const [p, list] of Object.entries(dyn)) list.forEach(k => used.add(p + k));
used.delete('err.session_credentials');
for (const k of [...used]) if (k.endsWith('.')) used.delete(k);
let bad = 0;
for (const lang of ['en', 'vi']) {
  const missing = [...used].filter(k => !(k in (D[lang] || {}))).sort();
  if (missing.length) { bad++; console.log(`${lang} missing (${missing.length}):\n  ` + missing.join('\n  ')); }
  const extra = Object.keys(D[lang] || {}).filter(k => !used.has(k));
  if (extra.length) console.log(`${lang} unused: ` + extra.join(', '));
}
if (!bad) console.log(`i18n OK – ${used.size} keys`);
process.exitCode = bad ? 1 : 0;
