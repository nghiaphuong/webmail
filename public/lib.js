/* Tiện ích dùng chung cho webmail, trang quản trị và trang đăng ký. */
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---- Ngôn ngữ ----
  const LS = k => { try { return localStorage.getItem(k); } catch { return null; } };
  const LSset = (k, v) => { try { localStorage.setItem(k, v); } catch { /* chế độ riêng tư */ } };
  let lang = LS('wm_lang') || 'en';
  if (!['en', 'vi'].includes(lang)) lang = 'en';
  function t(key, vars) {
    const d = window.I18N[lang] || window.I18N.en;
    let s = d[key] ?? window.I18N.en[key] ?? key;
    if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m));
    return s;
  }
  function setLang(l, persist = true) {
    lang = l === 'vi' ? 'vi' : 'en';
    if (persist) LSset('wm_lang', lang);
    document.documentElement.lang = lang;
    applyI18n();
  }
  function applyI18n(root = document) {
    $$('[data-i18n]', root).forEach(el => { el.textContent = t(el.dataset.i18n); });
    $$('[data-i18n-ph]', root).forEach(el => { el.placeholder = t(el.dataset.i18nPh); });
    $$('[data-i18n-title]', root).forEach(el => { el.title = t(el.dataset.i18nTitle); el.setAttribute('aria-label', el.title); });
    $$('.lang-switch button', root).forEach(b => b.classList.toggle('on', b.dataset.lang === lang));
  }
  function langSwitch(onChange) {
    return `<div class="lang-switch" role="group" aria-label="Language">${['en', 'vi'].map(l => `<button type="button" data-lang="${l}" class="${l === lang ? 'on' : ''}">${l.toUpperCase()}</button>`).join('')}</div>`;
  }
  document.addEventListener('click', e => {
    const b = e.target.closest('.lang-switch button');
    if (!b) return;
    setLang(b.dataset.lang);
    document.dispatchEvent(new CustomEvent('langchange', { detail: lang }));
  });

  // ---- Giao diện sáng/tối ----
  function setTheme(th) {
    if (th === 'light' || th === 'dark') document.documentElement.dataset.theme = th;
    else delete document.documentElement.dataset.theme;
  }

  // ---- Gọi API ----
  class ApiError extends Error { constructor(status, code, msg) { super(msg || code); this.status = status; this.code = code; } }
  async function api(method, path, body, opts = {}) {
    const init = { method, headers: { 'X-WM': '1' }, credentials: 'same-origin' };
    if (body instanceof FormData || typeof body === 'string') init.body = body;
    else if (body !== undefined) { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
    let r;
    try { r = await fetch(path, init); } catch { throw new ApiError(0, 'network_error'); }
    const ct = r.headers.get('content-type') || '';
    const data = ct.includes('json') ? await r.json().catch(() => ({})) : await r.text();
    if (!r.ok) {
      if (r.status === 401 && opts.onUnauthorized !== false && window.onUnauthorized) window.onUnauthorized();
      throw new ApiError(r.status, data?.error || 'server_error', data?.message);
    }
    return data;
  }
  const errText = e => {
    const k = 'err.' + (e?.code || 'server_error');
    const s = t(k);
    return s === k ? (e?.message || t('err.server_error')) : s + (e?.code === 'smtp_error' || e?.code === 'provider_error' ? (e.message ? ` (${e.message})` : '') : '');
  };

  // ---- Thông báo nổi & hộp thoại ----
  function toast(msg, type = '') {
    let box = $('#toasts');
    if (!box) { box = document.createElement('div'); box.id = 'toasts'; document.body.appendChild(box); }
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => el.remove(), type === 'error' ? 6000 : 3200);
  }
  function modal({ title, body, buttons = [], wide = false, onOpen }) {
    return new Promise(resolve => {
      const back = document.createElement('div');
      back.className = 'modal-back';
      back.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
        <div class="modal-h"><span class="grow">${esc(title)}</span><button class="btn ghost icon sm" data-x="close" aria-label="${esc(t('close'))}">${icon('x')}</button></div>
        <div class="modal-b">${body}</div>
        ${buttons.length ? `<div class="modal-f">${buttons.map((b, i) => `<button class="btn ${b.cls || ''}" data-i="${i}">${esc(b.label)}</button>`).join('')}</div>` : ''}
      </div>`;
      const close = v => { back.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
      const onKey = e => { if (e.key === 'Escape') close(null); };
      document.addEventListener('keydown', onKey);
      back.addEventListener('mousedown', e => { if (e.target === back) back.dataset.down = '1'; });
      back.addEventListener('click', async e => {
        if (e.target === back && back.dataset.down) return close(null);
        back.dataset.down = '';
        if (e.target.closest('[data-x="close"]')) return close(null);
        const b = e.target.closest('.modal-f [data-i]');
        if (!b) return;
        const spec = buttons[Number(b.dataset.i)];
        if (spec.onClick) {
          b.disabled = true;
          try { const v = await spec.onClick(back); if (v !== false) close(v === undefined ? spec.value ?? true : v); } finally { b.disabled = false; }
        } else close(spec.value ?? null);
      });
      document.body.appendChild(back);
      applyI18n(back);
      onOpen?.(back, close);
      setTimeout(() => $('input:not([type=checkbox]):not([readonly]), select, textarea', back)?.focus(), 30);
    });
  }
  const confirmBox = (text, { ok = t('ok'), danger = false, title = t('confirm') } = {}) => modal({
    title, body: `<p style="margin:0">${esc(text)}</p>`,
    buttons: [{ label: t('cancel'), value: false }, { label: ok, cls: danger ? 'danger solid' : 'primary', value: true }],
  }).then(v => v === true);
  const promptBox = (title, { value = '', label = '', placeholder = '' } = {}) => modal({
    title, body: `<label class="field">${label ? `<span>${esc(label)}</span>` : ''}<input class="input" id="pb-in" value="${esc(value)}" placeholder="${esc(placeholder)}"></label>`,
    buttons: [{ label: t('cancel'), value: null }, { label: t('ok'), cls: 'primary', onClick: b => $('#pb-in', b).value.trim() || false }],
    onOpen: (b, close) => $('#pb-in', b).addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.value.trim()) close(e.target.value.trim()); }),
  });

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); } catch {
      const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch { /* bỏ qua */ } ta.remove();
    }
    toast(t('copied'), 'ok');
  }

  // ---- Định dạng ----
  const locale = () => (lang === 'vi' ? 'vi-VN' : 'en-GB');
  function fmtDate(iso, long = false) {
    if (!iso) return '';
    const d = new Date(iso.includes('T') || iso.endsWith('Z') ? iso : iso.replace(' ', 'T') + 'Z');
    if (isNaN(d)) return '';
    const now = new Date();
    if (long) return d.toLocaleString(locale(), { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
    if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString(locale(), { day: 'numeric', month: 'short' });
    return d.toLocaleDateString(locale(), { year: 'numeric', month: 'short', day: 'numeric' });
  }
  function fmtSize(b) {
    if (b == null) return '';
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(b < 10240 ? 1 : 0) + ' KB';
    if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
    return (b / 1073741824).toFixed(2) + ' GB';
  }

  // ---- Biểu tượng (SVG nét) ----
  const P = {
    inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
    draft: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    trash: '<path d="M3 6h18"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
    spam: '<path d="M7.86 2h8.28L22 7.86v8.28L16.14 22H7.86L2 16.14V7.86z"/><path d="M12 8v4M12 16h.01"/>',
    archive: '<path d="M21 8v13H3V8"/><path d="M1 3h22v5H1z"/><path d="M10 12h4"/>',
    folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    pen: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    refresh: '<path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
    reply: '<path d="M9 17 4 12l5-5"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>',
    replyall: '<path d="M7 17 2 12l5-5"/><path d="M12 17l-5-5 5-5"/><path d="M22 18v-2a4 4 0 0 0-4-4H7"/>',
    forward: '<path d="m15 17 5-5-5-5"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/>',
    star: '<path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/>',
    clip: '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    menu: '<path d="M3 12h18M3 6h18M3 18h18"/>',
    more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
    user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/>',
    mail: '<path d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/><path d="m22 6-10 7L2 6"/>',
    mailopen: '<path d="M21.2 8.4c.5.38.8.97.8 1.6v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V10a2 2 0 0 1 .8-1.6l8-6a2 2 0 0 1 2.4 0z"/><path d="m22 10-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 10"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5M12 3v12"/>',
    print: '<path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v8H6z"/>',
    code: '<path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
    back: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
    left: '<path d="m15 18-6-6 6-6"/>',
    right: '<path d="m9 18 6-6-6-6"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    key: '<path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.78 7.78 5.5 5.5 0 0 1 7.78-7.78zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4"/>',
    dice: '<rect x="2" y="2" width="20" height="20" rx="3"/><circle cx="8" cy="8" r="1.3" fill="currentColor"/><circle cx="16" cy="16" r="1.3" fill="currentColor"/><circle cx="16" cy="8" r="1.3" fill="currentColor"/><circle cx="8" cy="16" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/>',
    home: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
    server: '<rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><path d="M6 6h.01M6 18h.01"/>',
    flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><path d="M4 22v-7"/>',
    book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
    expand: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
  };
  const icon = (name, cls = 'ico') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${P[name] || ''}</svg>`;
  const LOGO = `<span class="logo">${icon('mail', '')}</span>`;

  window.WM = { $, $$, esc, t, setLang, getLang: () => lang, applyI18n, langSwitch, setTheme, api, ApiError, errText, toast, modal, confirmBox, promptBox, copy, fmtDate, fmtSize, icon, LOGO, LS, LSset };
})();
