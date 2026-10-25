# PhuongCode Webmail

A full webmail for **mail.phuongcode.com** (Node.js + Express + MySQL, vanilla JS front end), in **English (default) and Vietnamese**.

## Live demo

Open **https://mail.phuongcode.com** and press **Open the demo mailbox** (or sign in with `demo@phuongcode.com` / `Demo@2026`). Every visitor gets a private sandbox mailbox stored in the database, pre-filled with sample messages; mail sent from the demo is never delivered outside it (sending to the demo address itself lands in its Inbox), and the sandbox is deleted after 6 hours. The demo account can be switched off or changed under Admin → Server settings.

## Features

**Webmail (users)**
- Sign in with any mailbox on an allowed domain (credentials are checked against the mail server, like Roundcube).
- Folders with unread counts, create / rename / delete / sub-folders, empty Trash & Spam, drag & drop messages onto folders.
- Message list with paging, search (everywhere / subject / from / to / body), filters (unread, starred), multi-select (Ctrl/Shift), mark read/unread, star, move, archive, spam / not spam, delete.
- Safe message view: HTML sanitised server-side and shown in a sandboxed iframe with CSP; remote images blocked until you allow them (or the sender is a contact); inline (cid) images; attachments with preview / download; view source, download .eml, print; read receipts.
- Compose with **TinyMCE** (fonts, sizes, colours, tables, links, images, emoji, source code, full screen…) or plain text; reply / reply all / forward (with attachments) / edit as new; Cc/Bcc; contact autocomplete; drag-and-drop attachments with progress; pasted images sent as inline attachments; priority; read-receipt request; drafts with auto-save; signature.
- Contacts (address book) with auto-collected recipients, vCard import / export.
- Settings: language, theme (light/dark/auto), page size, auto-refresh, desktop notifications, display name, Reply-To, signature, compose defaults, privacy, folder management, password change, IMAP/POP3/SMTP settings for mail apps.
- Responsive layout for phones; keyboard shortcuts (c, r, a, f, j/k, Delete, /, Esc).

**Admin panel (`/admin`)**
- Dashboard, activity log, multiple administrators.
- Domains: add more domains besides @phuongcode.com, allow / forbid guest registration per domain, link to the Hostinger mail order.
- Mailboxes: create, disable, reset password, delete (optionally on the server too), import existing mailboxes from Hostinger.
- **Random addresses**: choose length, character set, prefix, how many, link validity and whether sending is allowed. Each gets a **private no-login link** (`/m/<token>`) to read the mailbox; links can be revoked, made read-only or re-issued.
- Registrations: guests request an address on `/register`; nothing works until an admin approves (optional e-mail notifications).
- Server settings: IMAP **or** POP3 for receiving, SMTP for sending (Hostinger defaults: `imap.hostinger.com:993`, `pop.hostinger.com:995`, `smtp.hostinger.com:465`, SSL), connection test.

## How mailboxes are created

| Mode | When | What happens |
|---|---|---|
| `hostinger` | `HOSTINGER_API_TOKEN` is set | Mailboxes are created / deleted / re-passworded through the Hostinger Mail API (`/api/mail/v1`). |
| `manual` | no token | The webmail stores the (encrypted) password and marks the mailbox *awaiting creation*; create it in hPanel → Emails with the same password and press **Verify**. |
| `greenmail` | `PROVISIONER=greenmail` | Local test mail server only. |

## Run locally

```bash
npm install
cp .env.example .env   # fill DB_* and secrets
npm start
```

`npm run smoke` runs API tests (`scripts/smoke-demo.js` covers the demo sandbox) against a local [GreenMail](https://greenmail-mail-test.github.io/greenmail/) server (`PROVISIONER=greenmail`, `MAIL_TLS_INSECURE=true`, IMAP 3993 / POP3 3995 / SMTP 3465). `npm run check` verifies the EN/VI dictionaries.

## Security notes
- Mailbox passwords of signed-in users are encrypted with a key derived from the session cookie; stored passwords (random / link mailboxes) with `ENCRYPTION_KEY`.
- CSRF protection (custom header), rate limiting on login / registration / links, strict CSP, sandboxed message rendering, attachments served with `Content-Security-Policy: sandbox`.
