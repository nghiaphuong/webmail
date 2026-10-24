/* Webmail – ứng dụng một trang (vanilla JS). */
(() => {
  const { $, $$, esc, t, api, toast, modal, confirmBox, promptBox, icon, fmtDate, fmtSize, errText, applyI18n } = WM;
  const app = $('#app');

  const S = {
    me: null, prefs: {}, folders: [], quota: null, folder: 'INBOX', page: 1, total: 0, size: 50, items: [], sel: new Set(),
    uid: null, view: null, q: '', scope: 'all', filter: 'all', anchor: null, compose: null, unreadInbox: null, timer: null,
    lastHash: '', msg: null,
  };
  const SPECIAL_ORDER = ['\\Inbox', '\\Drafts', '\\Sent', '\\Archive', '\\Junk', '\\Trash'];
  const SPECIAL_ICON = { '\\Inbox': 'inbox', '\\Drafts': 'draft', '\\Sent': 'send', '\\Junk': 'spam', '\\Trash': 'trash', '\\Archive': 'archive' };
  const SPECIAL_KEY = { '\\Inbox': 'folder.inbox', '\\Drafts': 'folder.drafts', '\\Sent': 'folder.sent', '\\Junk': 'folder.junk', '\\Trash': 'folder.trash', '\\Archive': 'folder.archive' };

  const folderBy = path => S.folders.find(f => f.path === path);
  const special = su => S.folders.find(f => f.special === su)?.path;
  const folderLabel = f => (f ? (f.special ? t(SPECIAL_KEY[f.special]) : f.name) : '');
  const enc = encodeURIComponent;
  const COLORS = ['#2563eb', '#7c3aed', '#db2777', '#ea580c', '#059669', '#0891b2', '#4f46e5', '#b45309', '#dc2626', '#0d9488'];
  const avatar = (name, addr) => {
    const s = (name || addr || '?').trim();
    let h = 0;
    for (const c of addr || s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return `<span class="avatar" style="background:${COLORS[h % COLORS.length]}">${esc(s.replace(/["'<]/g, '').charAt(0).toUpperCase() || '?')}</span>`;
  };
  const who = a => esc(a?.name || a?.address || '');
  const addrLine = list => (list || []).map(a => (a.name ? `<b>${esc(a.name)}</b> &lt;${esc(a.address)}&gt;` : `<b>${esc(a.address)}</b>`)).join(', ');
  const typing = e => e.target.closest('input, textarea, select, [contenteditable="true"]');

  window.onUnauthorized = () => {
    if (S.me) { S.me = null; clearInterval(S.timer); renderLogin('session_expired'); }
  };

  // =================== Khởi động ===================
  async function boot() {
    try {
      S.me = await api('GET', '/api/me', undefined, { onUnauthorized: false });
    } catch (e) {
      if (e.status === 401) return renderLogin(new URLSearchParams(location.search).get('link'));
      app.innerHTML = `<div class="auth-wrap"><div class="alert error">${esc(errText(e))}</div></div>`;
      return;
    }
    S.prefs = S.me.prefs;
    S.size = S.prefs.pageSize || 50;
    if (S.me.prefsSaved) WM.setLang(S.prefs.lang || WM.getLang());
    else { S.prefs.lang = WM.getLang(); WM.setLang(S.prefs.lang); api('PUT', '/api/prefs', { lang: S.prefs.lang }).catch(() => {}); }
    WM.setTheme(S.prefs.theme);
    if (location.search) history.replaceState(null, '', '/' + location.hash);
    renderShell();
    await loadFolders();
    if (!location.hash || location.hash === '#' || location.hash === '#/') location.hash = '#/mail/INBOX';
    else route();
    startRefresh();
  }

  // =================== Đăng nhập ===================
  async function renderLogin(notice) {
    document.body.className = '';
    document.title = t('login.title');
    let pub = { appName: 'Webmail', registrationOpen: false };
    try { pub = await api('GET', '/api/public/config'); } catch { /* bỏ qua */ }
    const msg = notice === 'invalid' ? t('login.linkInvalid') : notice === 'expired' ? t('login.linkExpired') : notice === 'session_expired' ? t('login.sessionExpired') : '';
    app.innerHTML = `<div class="auth-wrap"><form class="auth-card stack" id="login" autocomplete="on">
      <div class="row"><div class="brand grow">${WM.LOGO}<span>${esc(pub.appName)}</span></div>${WM.langSwitch()}</div>
      <div><h2 style="margin:6px 0 2px;font-size:20px" data-i18n="login.heading"></h2><div class="muted" data-i18n="login.sub"></div></div>
      ${msg ? `<div class="alert warn">${esc(msg)}</div>` : ''}
      <div class="alert error" id="lerr" hidden></div>
      <label class="field"><span data-i18n="login.email"></span><input class="input" type="email" name="email" autocomplete="username" required autofocus placeholder="you@phuongcode.com"></label>
      <label class="field"><span data-i18n="login.password"></span><input class="input" type="password" name="password" autocomplete="current-password" required></label>
      <label class="check"><input type="checkbox" name="remember"><span data-i18n="login.remember"></span></label>
      <button class="btn primary" style="width:100%;height:40px" data-i18n="login.submit"></button>
      ${pub.registrationOpen ? `<div class="muted small" style="text-align:center"><span data-i18n="login.noAccount"></span> <a href="/register" data-i18n="login.register"></a></div>` : ''}
    </form></div>`;
    applyI18n(app);
    $('#login').addEventListener('submit', async e => {
      e.preventDefault();
      const f = e.target;
      const btn = $('button.primary', f);
      btn.disabled = true;
      $('#lerr').hidden = true;
      try {
        await api('POST', '/api/login', { email: f.email.value.trim(), password: f.password.value, remember: f.remember.checked, lang: WM.getLang() }, { onUnauthorized: false });
        location.hash = '#/mail/INBOX';
        await boot();
      } catch (err) {
        $('#lerr').textContent = errText(err);
        $('#lerr').hidden = false;
        btn.disabled = false;
      }
    });
  }

  // =================== Khung chính ===================
  function renderShell() {
    document.body.className = 'mail';
    const me = S.me;
    app.innerHTML = `<div class="shell">
      <header class="topbar">
        <button class="btn ghost icon mobile-only" id="navbtn" data-i18n-title="menu">${icon('menu')}</button>
        <a class="brand" href="#/mail/INBOX">${WM.LOGO}<span class="name">${esc(me.appName)}</span></a>
        <form class="search" id="search" role="search">
          ${icon('search')}
          <input name="q" data-i18n-ph="search.placeholder" autocomplete="off">
          <select name="scope" aria-label="scope">
            ${['all', 'subject', 'from', 'to', 'body'].map(s => `<option value="${s}" data-i18n="search.${s}"></option>`).join('')}
          </select>
          <button type="button" class="btn ghost icon sm" id="clearsearch" hidden>${icon('x')}</button>
        </form>
        <div class="who">
          <span class="desktop-only">${WM.langSwitch()}</span>
          <div class="usermenu">
            <button class="btn ghost" id="userbtn" style="padding:0 6px">${avatar(me.displayName, me.address)}</button>
            <div class="dropdown" id="userdd" hidden>
              <div class="head">${esc(me.displayName ? me.displayName + ' · ' : '')}${esc(me.address)}</div>
              <div class="sep"></div>
              <a class="item" href="#/settings">${icon('settings')}<span data-i18n="nav.settings"></span></a>
              <a class="item" href="#/contacts">${icon('users')}<span data-i18n="nav.contacts"></span></a>
              <div class="item mobile-only" style="justify-content:space-between"><span data-i18n="settings.language"></span>${WM.langSwitch()}</div>
              <div class="sep"></div>
              <button class="item" id="logout">${icon('logout')}<span data-i18n="nav.logout"></span></button>
            </div>
          </div>
        </div>
      </header>
      <div class="main">
        <aside class="sidebar">
          <button class="btn primary compose-btn" id="composebtn" ${me.canSend ? '' : 'disabled'}>${icon('pen')}<span data-i18n="compose"></span></button>
          <nav id="folders"></nav>
          <div class="quota" id="quota" hidden></div>
        </aside>
        <section class="content" id="content">
          ${me.kind === 'link' ? `<div class="linkbar">${icon('link')}<span>${esc(t('link.banner'))}${me.linkExpires ? ' · ' + esc(t('link.expires', { date: fmtDate(me.linkExpires, true) })) : ''}${me.canSend ? '' : ' · ' + esc(t('link.readOnly'))}</span></div>` : ''}
          <div id="view" style="display:flex;flex-direction:column;flex:1;min-height:0"></div>
        </section>
      </div>
    </div>`;
    applyI18n(app);
    $('#navbtn').onclick = () => document.body.classList.toggle('nav-open');
    $('#userbtn').onclick = e => { e.stopPropagation(); $('#userdd').hidden = !$('#userdd').hidden; };
    document.addEventListener('click', e => { if (!e.target.closest('.usermenu') && $('#userdd')) $('#userdd').hidden = true; });
    $('#logout').onclick = async () => {
      if (!(await leaveCompose())) return;
      await api('POST', '/api/logout').catch(() => {});
      location.href = '/';
    };
    $('#composebtn').onclick = () => { location.hash = '#/compose'; };
    $('#search').addEventListener('submit', e => {
      e.preventDefault();
      S.q = e.target.q.value.trim();
      S.scope = e.target.scope.value;
      S.page = 1;
      $('#clearsearch').hidden = !S.q;
      if (S.view !== 'mail') location.hash = '#/mail/' + enc(S.folder);
      else loadList();
    });
    $('#clearsearch').onclick = () => { $('#search').q.value = ''; S.q = ''; S.page = 1; $('#clearsearch').hidden = true; loadList(); };
  }
  document.addEventListener('langchange', async () => {
    if (!S.me) return;
    S.prefs.lang = WM.getLang();
    api('PUT', '/api/prefs', { lang: S.prefs.lang }).catch(() => {});
    const keep = S.view;
    renderFolders();
    if (keep === 'compose') return; // không dựng lại form đang soạn
    S.lastHash = '';
    route(true);
  });

  // =================== Thư mục ===================
  async function loadFolders() {
    try {
      const r = await api('GET', '/api/folders');
      S.folders = r.folders;
      S.quota = r.quota;
    } catch (e) { toast(errText(e), 'error'); }
    renderFolders();
    const inbox = folderBy('INBOX');
    if (inbox) {
      if (S.unreadInbox != null && inbox.unread > S.unreadInbox) notifyNew(inbox.unread - S.unreadInbox);
      S.unreadInbox = inbox.unread;
    }
    updateTitle();
  }
  function sortedFolders() {
    const rank = f => (f.special ? SPECIAL_ORDER.indexOf(f.special) : 99);
    return [...S.folders].sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path));
  }
  function depth(f) {
    let parts = f.path.split(f.delimiter);
    if (parts.length > 1 && parts[0].toUpperCase() === 'INBOX') parts = parts.slice(1);
    return f.special ? 0 : parts.length - 1;
  }
  function renderFolders() {
    const nav = $('#folders');
    if (!nav) return;
    const list = sortedFolders();
    const specials = list.filter(f => f.special);
    const others = list.filter(f => !f.special);
    const row = f => `<a class="folder ${S.view === 'mail' && f.path === S.folder ? 'on' : ''}" href="#/mail/${enc(f.path)}" data-path="${esc(f.path)}" style="padding-left:${10 + depth(f) * 16}px">
      ${icon(SPECIAL_ICON[f.special] || 'folder')}<span class="name">${esc(folderLabel(f))}</span>
      ${f.unread && f.special !== '\\Sent' && f.special !== '\\Trash' ? `<span class="count">${f.unread}</span>` : f.special === '\\Drafts' && f.total ? `<span class="count muted">${f.total}</span>` : ''}
      ${!f.special ? `<button class="btn ghost sm icon fmenu" data-fmenu="${esc(f.path)}" title="${esc(t('more'))}">${icon('more')}</button>` : ''}
    </a>`;
    nav.innerHTML = specials.map(row).join('') +
      `<div class="sec"><span class="grow" data-i18n="folders"></span><button class="btn ghost sm icon" id="newfolder" data-i18n-title="folder.new">${icon('plus')}</button></div>` +
      others.map(row).join('') +
      `<div class="sec" data-i18n="nav.tools"></div>
       <a class="folder ${S.view === 'contacts' ? 'on' : ''}" href="#/contacts">${icon('users')}<span class="name" data-i18n="nav.contacts"></span></a>
       <a class="folder ${S.view === 'settings' ? 'on' : ''}" href="#/settings">${icon('settings')}<span class="name" data-i18n="nav.settings"></span></a>`;
    applyI18n(nav);
    $('#newfolder').onclick = e => { e.preventDefault(); createFolder(); };
    $$('[data-fmenu]', nav).forEach(b => b.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); folderMenu(b.dataset.fmenu); }));
    $$('.folder[data-path]', nav).forEach(el => {
      el.addEventListener('click', () => document.body.classList.remove('nav-open'));
      el.addEventListener('dragover', e => { if (S.drag) { e.preventDefault(); el.classList.add('drop'); } });
      el.addEventListener('dragleave', () => el.classList.remove('drop'));
      el.addEventListener('drop', e => { e.preventDefault(); el.classList.remove('drop'); if (S.drag) act('move', S.drag, { to: el.dataset.path }); S.drag = null; });
    });
    const q = $('#quota');
    if (S.quota && q) {
      q.hidden = false;
      const pct = S.quota.limit ? Math.min(100, Math.round(S.quota.used / S.quota.limit * 100)) : 0;
      q.innerHTML = `${esc(t('quota', { used: fmtSize(S.quota.used * 1024), limit: S.quota.limit ? fmtSize(S.quota.limit * 1024) : '∞' }))}${S.quota.limit ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ''}`;
    }
  }
  async function createFolder(parent = '') {
    const name = await promptBox(t('folder.new'), { label: t('folder.name') });
    if (!name) return;
    try { await api('POST', '/api/folders', { name, parent }); toast(t('folder.created'), 'ok'); await loadFolders(); } catch (e) { toast(errText(e), 'error'); }
  }
  async function folderMenu(path) {
    const f = folderBy(path);
    const v = await modal({
      title: folderLabel(f),
      body: `<div class="stack"><button class="btn" data-a="rename" style="width:100%;justify-content:flex-start">${icon('pen')}<span data-i18n="folder.rename"></span></button>
        <button class="btn" data-a="sub" style="width:100%;justify-content:flex-start">${icon('plus')}<span data-i18n="folder.newSub"></span></button>
        <button class="btn" data-a="read" style="width:100%;justify-content:flex-start">${icon('mailopen')}<span data-i18n="folder.markAllRead"></span></button>
        <button class="btn danger" data-a="delete" style="width:100%;justify-content:flex-start">${icon('trash')}<span data-i18n="folder.delete"></span></button></div>`,
      onOpen: (b, close) => $$('[data-a]', b).forEach(x => x.onclick = () => close(x.dataset.a)),
    });
    try {
      if (v === 'rename') {
        const name = await promptBox(t('folder.rename'), { value: f.name, label: t('folder.name') });
        if (!name) return;
        const r = await api('PATCH', '/api/folders', { path, name });
        if (S.folder === path) location.hash = '#/mail/' + enc(r.path);
      } else if (v === 'sub') return createFolder(path);
      else if (v === 'read') {
        await markAllRead(path);
      } else if (v === 'delete') {
        if (!(await confirmBox(t('folder.confirmDelete', { name: f.name }), { danger: true, ok: t('delete') }))) return;
        await api('DELETE', '/api/folders?f=' + enc(path));
        if (S.folder === path) location.hash = '#/mail/INBOX';
      } else return;
      await loadFolders();
    } catch (e) { toast(errText(e), 'error'); }
  }
  async function markAllRead(path) {
    // Lấy tất cả UID chưa đọc theo từng trang rồi đánh dấu.
    let page = 1;
    for (;;) {
      const r = await api('GET', `/api/messages?f=${enc(path)}&filter=unread&size=200&page=1`);
      if (!r.items.length) break;
      await api('POST', '/api/messages/action', { f: path, uids: r.items.map(m => m.uid), action: 'read' });
      if (r.total <= r.items.length || ++page > 50) break;
    }
    if (path === S.folder) loadList();
  }
  function updateTitle() {
    const inbox = folderBy('INBOX');
    const n = inbox?.unread || 0;
    const f = folderBy(S.folder);
    const what = S.view === 'mail' ? folderLabel(f) : S.view === 'compose' ? t('compose') : S.view === 'contacts' ? t('nav.contacts') : S.view === 'settings' ? t('nav.settings') : '';
    document.title = `${n ? `(${n}) ` : ''}${what ? what + ' – ' : ''}${S.me?.appName || 'Webmail'}`;
  }

  // =================== Định tuyến ===================
  async function route(force = false) {
    if (!S.me) return;
    const h = location.hash || '#/mail/INBOX';
    if (!force && h === S.lastHash) return;
    const [path, query] = h.slice(1).split('?');
    const parts = path.split('/').filter(Boolean);
    const params = new URLSearchParams(query || '');
    if (S.view === 'compose' && parts[0] !== 'compose' && !(await leaveCompose())) { history.replaceState(null, '', S.lastHash); return; }
    S.lastHash = h;
    document.body.classList.remove('nav-open');
    if (parts[0] === 'compose') return renderCompose(params);
    destroyEditor();
    if (parts[0] === 'contacts') return renderContacts();
    if (parts[0] === 'settings') return renderSettings(parts[1] || 'general');
    const folder = decodeURIComponent(parts[1] || 'INBOX');
    const uid = parts[2] ? Number(parts[2]) : null;
    const changed = S.view !== 'mail' || folder !== S.folder;
    if (folder !== S.folder) { S.page = 1; S.sel.clear(); S.filter = 'all'; }
    S.folder = folder;
    if (changed) { renderMailView(); await loadList(); } else if (force) { renderMailView(); await loadList(); }
    renderFolders();
    if (uid) openMessage(uid); else closeReader();
    updateTitle();
  }
  window.addEventListener('hashchange', () => route());
  window.addEventListener('beforeunload', e => { if (S.compose?.dirty) { e.preventDefault(); e.returnValue = ''; } });

  // =================== Danh sách thư ===================
  function renderMailView() {
    S.view = 'mail';
    const f = folderBy(S.folder);
    const isTrash = f?.special === '\\Trash' || f?.special === '\\Junk';
    $('#view').innerHTML = `<div class="view-mail ${S.prefs.previewPane === false ? 'nopreview' : ''}" id="vm">
      <div class="listpane">
        <div class="toolbar">
          <label class="check" style="padding:0 6px" title="${esc(t('selectAll'))}"><input type="checkbox" id="selall"></label>
          <span class="title grow">${esc(folderLabel(f) || S.folder)}</span>
          <button class="btn ghost icon sm" data-act="refresh" title="${esc(t('refresh'))}">${icon('refresh')}</button>
          <span id="selacts" hidden class="row" style="gap:2px">
            <button class="btn ghost icon sm" data-act="read" title="${esc(t('act.markRead'))}">${icon('mailopen')}</button>
            <button class="btn ghost icon sm" data-act="unread" title="${esc(t('act.markUnread'))}">${icon('mail')}</button>
            <button class="btn ghost icon sm" data-act="flag" title="${esc(t('act.flag'))}">${icon('star')}</button>
            <button class="btn ghost icon sm" data-act="move" title="${esc(t('act.move'))}">${icon('folder')}</button>
            ${f?.special === '\\Junk' ? `<button class="btn ghost icon sm" data-act="notspam" title="${esc(t('act.notSpam'))}">${icon('inbox')}</button>` : `<button class="btn ghost icon sm" data-act="spam" title="${esc(t('act.spam'))}">${icon('spam')}</button>`}
            <button class="btn ghost icon sm danger" data-act="delete" title="${esc(t('delete'))}">${icon('trash')}</button>
          </span>
        </div>
        <div class="listhead">
          <select id="filter" aria-label="filter">${['all', 'unread', 'flagged'].map(x => `<option value="${x}" ${S.filter === x ? 'selected' : ''}>${esc(t('filter.' + x))}</option>`).join('')}</select>
          <span class="grow"></span>
          ${isTrash ? `<button class="btn sm danger" id="emptybtn">${esc(t('folder.empty'))}</button>` : ''}
        </div>
        <div class="msglist" id="msglist"><div class="empty"><span class="spinner"></span></div></div>
        <div class="pager" id="pager"></div>
      </div>
      <div class="readpane" id="readpane"><div class="empty">${icon('mail')}<div>${esc(t('noSelection'))}</div></div></div>
    </div>`;
    $('#filter').onchange = e => { S.filter = e.target.value; S.page = 1; loadList(); };
    $('#selall').onchange = e => { if (e.target.checked) S.items.forEach(m => S.sel.add(m.uid)); else S.sel.clear(); renderRows(); };
    $$('[data-act]', $('#vm')).forEach(b => b.onclick = () => toolbarAction(b.dataset.act));
    $('#emptybtn')?.addEventListener('click', async () => {
      if (!(await confirmBox(t('folder.confirmEmpty'), { danger: true, ok: t('folder.empty') }))) return;
      try { await api('POST', '/api/folders/empty', { f: S.folder }); await loadFolders(); loadList(); closeReader(true); } catch (e) { toast(errText(e), 'error'); }
    });
  }

  async function loadList(silent = false) {
    const box = $('#msglist');
    if (!box) return;
    if (!silent) box.innerHTML = '<div class="empty"><span class="spinner"></span></div>';
    const qs = new URLSearchParams({ f: S.folder, page: S.page, size: S.size, filter: S.filter });
    if (S.q) { qs.set('q', S.q); qs.set('scope', S.scope); }
    try {
      const r = await api('GET', '/api/messages?' + qs);
      S.items = r.items; S.total = r.total;
      const uids = new Set(S.items.map(m => m.uid));
      for (const u of [...S.sel]) if (!uids.has(u)) S.sel.delete(u);
      renderRows();
    } catch (e) {
      box.innerHTML = `<div class="empty"><div class="alert error">${esc(errText(e))}</div></div>`;
    }
  }
  function renderRows() {
    const box = $('#msglist');
    if (!box) return;
    const f = folderBy(S.folder);
    const outgoing = f && ['\\Sent', '\\Drafts'].includes(f.special);
    if (!S.items.length) {
      box.innerHTML = `<div class="empty">${icon(S.q ? 'search' : 'inbox')}<div>${esc(S.q ? t('noResults') : t('emptyFolder'))}</div></div>`;
    } else {
      box.innerHTML = S.items.map(m => {
        const unread = !m.flags.includes('\\Seen');
        const flagged = m.flags.includes('\\Flagged');
        const people = outgoing ? (m.to.length ? t('toPrefix') + ' ' + m.to.map(who).join(', ') : `<i>${esc(t('noRecipients'))}</i>`) : (m.from.map(who).join(', ') || `<i>${esc(t('unknownSender'))}</i>`);
        return `<div class="msg ${unread ? 'unread' : ''} ${S.uid === m.uid ? 'on' : ''} ${S.sel.has(m.uid) ? 'sel' : ''}" data-uid="${m.uid}" draggable="true">
          <span class="cb"><input type="checkbox" ${S.sel.has(m.uid) ? 'checked' : ''} aria-label="select"></span>
          <span class="from">${people}</span>
          <span class="date" title="${esc(fmtDate(m.date, true))}">${esc(fmtDate(m.date))}</span>
          <span class="subj">${m.flags.includes('\\Answered') ? `${icon('reply')} ` : ''}${m.flags.includes('$Forwarded') ? `${icon('forward')} ` : ''}${esc(m.subject || t('noSubject'))}</span>
          <span class="icons">${m.attachment ? icon('clip') : ''}<span class="star ${flagged ? 'on' : ''}" data-star title="${esc(t('act.flag'))}">${icon('star')}</span></span>
        </div>`;
      }).join('');
    }
    const from = S.total ? (S.page - 1) * S.size + 1 : 0;
    const to = Math.min(S.total, S.page * S.size);
    $('#pager').innerHTML = `<span class="grow">${esc(t('pager', { from, to, total: S.total }))}</span>
      <button class="btn ghost icon sm" id="prev" ${S.page <= 1 ? 'disabled' : ''}>${icon('left')}</button>
      <button class="btn ghost icon sm" id="next" ${to >= S.total ? 'disabled' : ''}>${icon('right')}</button>`;
    $('#prev').onclick = () => { S.page--; loadList(); };
    $('#next').onclick = () => { S.page++; loadList(); };
    $('#selacts').hidden = !S.sel.size && !S.uid;
    $('#selall').checked = S.items.length > 0 && S.items.every(m => S.sel.has(m.uid));
    $$('.msg', box).forEach(el => {
      const uid = Number(el.dataset.uid);
      el.addEventListener('click', e => {
        if (e.target.closest('[data-star]')) { const m = S.items.find(x => x.uid === uid); return act(m.flags.includes('\\Flagged') ? 'unflag' : 'flag', [uid]); }
        if (e.target.closest('.cb') || e.ctrlKey || e.metaKey) {
          if (e.target.tagName !== 'INPUT') e.preventDefault();
          if (S.sel.has(uid)) S.sel.delete(uid); else S.sel.add(uid);
          S.anchor = uid; return renderRows();
        }
        if (e.shiftKey && S.anchor) {
          const ids = S.items.map(m => m.uid);
          const [a, b] = [ids.indexOf(S.anchor), ids.indexOf(uid)].sort((x, y) => x - y);
          ids.slice(a, b + 1).forEach(u => S.sel.add(u));
          return renderRows();
        }
        S.anchor = uid;
        S.sel.clear();
        const f2 = folderBy(S.folder);
        if (f2?.special === '\\Drafts') { location.hash = `#/compose?mode=draft&f=${enc(S.folder)}&uid=${uid}`; return; }
        location.hash = `#/mail/${enc(S.folder)}/${uid}`;
      });
      el.addEventListener('dragstart', e => {
        S.drag = S.sel.has(uid) ? [...S.sel] : [uid];
        e.dataTransfer.setData('text/plain', String(S.drag.length));
        e.dataTransfer.effectAllowed = 'move';
      });
      el.addEventListener('dragend', () => setTimeout(() => { S.drag = null; }, 50));
    });
  }
  const targets = () => (S.sel.size ? [...S.sel] : S.uid ? [S.uid] : []);
  async function toolbarAction(a) {
    if (a === 'refresh') { await loadFolders(); return loadList(); }
    const uids = targets();
    if (!uids.length) return toast(t('selectFirst'));
    if (a === 'move') {
      const to = await pickFolder();
      if (to) act('move', uids, { to });
      return;
    }
    act(a, uids);
  }
  async function pickFolder() {
    const list = sortedFolders().filter(f => f.path !== S.folder);
    return modal({
      title: t('act.moveTo'),
      body: `<div class="stack" style="max-height:60vh;overflow:auto">${list.map(f => `<button class="btn" style="width:100%;justify-content:flex-start;padding-left:${12 + depth(f) * 16}px" data-p="${esc(f.path)}">${icon(SPECIAL_ICON[f.special] || 'folder')}${esc(folderLabel(f))}</button>`).join('')}</div>`,
      onOpen: (b, close) => $$('[data-p]', b).forEach(x => x.onclick = () => close(x.dataset.p)),
    });
  }
  async function act(action, uids, extra = {}) {
    if (action === 'delete' && S.prefs.confirmDelete && !(await confirmBox(t('confirmDeleteN', { n: uids.length }), { danger: true, ok: t('delete') }))) return;
    try {
      await api('POST', '/api/messages/action', { f: S.folder, uids, action, ...extra });
      const removed = ['delete', 'move', 'spam', 'notspam', 'archive'].includes(action);
      if (removed) {
        if (uids.includes(S.uid)) {
          // Mở thư kế tiếp sau khi xóa/di chuyển thư đang đọc.
          const idx = S.items.findIndex(m => m.uid === S.uid);
          const next = S.items.slice(idx + 1).find(m => !uids.includes(m.uid)) || S.items.slice(0, idx).reverse().find(m => !uids.includes(m.uid));
          closeReader(true);
          if (next && S.prefs.previewPane !== false && window.innerWidth > 860) location.hash = `#/mail/${enc(S.folder)}/${next.uid}`;
        }
        uids.forEach(u => S.sel.delete(u));
        toast(t('done.' + action), 'ok');
      } else {
        const f = { read: ['\\Seen', 1], unread: ['\\Seen', 0], flag: ['\\Flagged', 1], unflag: ['\\Flagged', 0], mdnsent: ['$MDNSent', 1] }[action];
        if (f) S.items.forEach(m => { if (uids.includes(m.uid)) { m.flags = m.flags.filter(x => x !== f[0]); if (f[1]) m.flags.push(f[0]); } });
        renderRows();
      }
      loadFolders();
      if (removed) loadList(true);
    } catch (e) { toast(errText(e), 'error'); }
  }

  // =================== Đọc thư ===================
  function closeReader(nav = false) {
    S.uid = null; S.msg = null;
    $('#vm')?.classList.remove('reading');
    const rp = $('#readpane');
    if (rp) rp.innerHTML = `<div class="empty">${icon('mail')}<div>${esc(t('noSelection'))}</div></div>`;
    $$('.msg.on').forEach(x => x.classList.remove('on'));
    if ($('#selacts')) $('#selacts').hidden = !S.sel.size;
    if (nav && location.hash.split('/').length > 3) history.replaceState(null, '', `#/mail/${enc(S.folder)}`), S.lastHash = location.hash;
  }
  async function openMessage(uid, images = false) {
    S.uid = uid;
    $('#vm')?.classList.add('reading');
    $$('.msg').forEach(x => x.classList.toggle('on', Number(x.dataset.uid) === uid));
    if ($('#selacts')) $('#selacts').hidden = false;
    const rp = $('#readpane');
    rp.innerHTML = '<div class="empty"><span class="spinner"></span></div>';
    let m;
    try {
      m = await api('GET', `/api/message?f=${enc(S.folder)}&uid=${uid}${images ? '&images=1' : ''}`);
    } catch (e) {
      rp.innerHTML = `<div class="empty"><div class="alert error">${esc(errText(e))}</div></div>`;
      return;
    }
    if (S.uid !== uid) return;
    S.msg = m;
    const item = S.items.find(x => x.uid === uid);
    if (item && !item.flags.includes('\\Seen')) {
      item.flags.push('\\Seen');
      renderRows();
      const f = folderBy(S.folder);
      if (f && f.unread) { f.unread--; renderFolders(); if (f.path === 'INBOX') S.unreadInbox = f.unread; updateTitle(); }
    }
    const f = folderBy(S.folder);
    const flagged = item?.flags.includes('\\Flagged');
    const sender = m.from[0] || {};
    const canSend = S.me.canSend;
    const showReceipt = m.receiptTo && canSend && f?.special !== '\\Sent' && !(item?.flags || []).includes('$MDNSent');
    rp.innerHTML = `<article class="reader">
      <div class="toolbar rtool">
        <button class="btn ghost icon sm" id="rback" title="${esc(t('back'))}">${icon('back')}</button>
        <span class="grow"></span>
        ${canSend ? `<button class="btn ghost sm" data-r="reply">${icon('reply')}<span class="desktop-only">${esc(t('reply'))}</span></button>
        <button class="btn ghost sm" data-r="replyall">${icon('replyall')}<span class="desktop-only">${esc(t('replyAll'))}</span></button>
        <button class="btn ghost sm" data-r="forward">${icon('forward')}<span class="desktop-only">${esc(t('forward'))}</span></button>
        <span class="sep"></span>` : ''}
        <button class="btn ghost icon sm" data-r="archive" title="${esc(t('act.archive'))}">${icon('archive')}</button>
        ${f?.special === '\\Junk' ? `<button class="btn ghost icon sm" data-r="notspam" title="${esc(t('act.notSpam'))}">${icon('inbox')}</button>` : `<button class="btn ghost icon sm" data-r="spam" title="${esc(t('act.spam'))}">${icon('spam')}</button>`}
        <button class="btn ghost icon sm" data-r="delete" title="${esc(t('delete'))}">${icon('trash')}</button>
        <div class="usermenu">
          <button class="btn ghost icon sm" id="rmore" title="${esc(t('more'))}">${icon('more')}</button>
          <div class="dropdown" id="rmoredd" hidden>
            <button class="item" data-r="unread">${icon('mail')}${esc(t('act.markUnread'))}</button>
            <button class="item" data-r="${flagged ? 'unflag' : 'flag'}">${icon('star')}${esc(t(flagged ? 'act.unflag' : 'act.flag'))}</button>
            <button class="item" data-r="move">${icon('folder')}${esc(t('act.moveTo'))}</button>
            ${canSend ? `<button class="item" data-r="edit">${icon('pen')}${esc(t('act.editAsNew'))}</button>` : ''}
            <div class="sep"></div>
            <button class="item" data-r="source">${icon('code')}${esc(t('act.source'))}</button>
            <a class="item" href="/api/message/raw?f=${enc(S.folder)}&uid=${uid}&dl=1">${icon('download')}${esc(t('act.downloadEml'))}</a>
            <button class="item" data-r="print">${icon('print')}${esc(t('act.print'))}</button>
            <div class="sep"></div>
            <button class="item" data-r="addcontact">${icon('user')}${esc(t('act.addContact'))}</button>
          </div>
        </div>
      </div>
      <div class="head">
        <h1>${esc(m.subject || t('noSubject'))}${m.priority === 'high' ? ` <span class="badge red">${esc(t('priority.high'))}</span>` : ''}</h1>
        <div class="meta">${avatar(sender.name, sender.address)}
          <div class="grow">
            <div class="row" style="justify-content:space-between;align-items:flex-start"><div class="addr">${addrLine(m.from)}</div><div class="muted small nowrap">${esc(fmtDate(m.date, true))}</div></div>
            <div class="addr">${esc(t('toPrefix'))} ${addrLine(m.to) || '—'}</div>
            ${m.cc.length ? `<div class="addr">${esc(t('ccPrefix'))} ${addrLine(m.cc)}</div>` : ''}
            ${m.bcc.length ? `<div class="addr">${esc(t('bccPrefix'))} ${addrLine(m.bcc)}</div>` : ''}
            ${m.replyTo.length && m.replyTo[0].address !== sender.address ? `<div class="addr">${esc(t('replyToPrefix'))} ${addrLine(m.replyTo)}</div>` : ''}
          </div>
        </div>
      </div>
      ${m.blocked ? `<div class="banner alert warn small">${icon('shield')}<span class="grow">${esc(t('images.blocked'))}</span><button class="btn sm" id="showimg">${esc(t('images.show'))}</button><button class="btn sm" id="trustsender">${esc(t('images.always'))}</button></div>` : ''}
      ${showReceipt ? `<div class="banner alert small">${icon('check')}<span class="grow">${esc(t('receipt.asked'))}</span><button class="btn sm" id="sendmdn">${esc(t('receipt.send'))}</button><button class="btn sm ghost" id="ignoremdn">${esc(t('receipt.ignore'))}</button></div>` : ''}
      ${m.attachments.length ? `<div class="atts">${m.attachments.map(a => attChip(a, uid)).join('')}</div>` : ''}
      <div class="body"><iframe id="mframe" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" title="message" referrerpolicy="no-referrer"></iframe></div>
    </article>`;
    fillFrame($('#mframe'), m);
    $('#rback').onclick = () => { location.hash = '#/mail/' + enc(S.folder); };
    $('#rmore').onclick = e => { e.stopPropagation(); $('#rmoredd').hidden = !$('#rmoredd').hidden; };
    document.addEventListener('click', () => { const d = $('#rmoredd'); if (d) d.hidden = true; }, { once: true });
    $$('[data-r]', rp).forEach(b => b.onclick = () => readerAction(b.dataset.r, uid));
    $('#showimg')?.addEventListener('click', () => openMessage(uid, true));
    $('#trustsender')?.addEventListener('click', async () => {
      try { await api('POST', '/api/contacts', { email: sender.address, name: sender.name }); } catch { /* bỏ qua */ }
      openMessage(uid, true);
    });
    $('#sendmdn')?.addEventListener('click', async () => {
      try {
        await api('POST', '/api/send', { to: m.receiptTo, subject: t('receipt.subject', { subject: m.subject }), isHtml: false, text: t('receipt.body', { subject: m.subject, date: fmtDate(new Date().toISOString(), true), address: S.me.address }) });
        await act('mdnsent', [uid]);
        toast(t('receipt.sent'), 'ok');
        $('#sendmdn').closest('.banner').remove();
      } catch (e) { toast(errText(e), 'error'); }
    });
    $('#ignoremdn')?.addEventListener('click', async () => { await act('mdnsent', [uid]); $('#ignoremdn').closest('.banner').remove(); });
  }
  function attChip(a, uid) {
    const url = `/api/message/part?f=${enc(S.folder)}&uid=${uid}&i=${a.i}`;
    const img = /^image\/(png|jpe?g|gif|webp)$/i.test(a.contentType);
    return `<a class="att" href="${url}&dl=1" title="${esc(a.filename)}">${img ? `<img class="thumb" src="${url}" alt="" loading="lazy">` : icon('file')}
      <span class="grow"><div class="nm">${esc(a.filename)}</div><div class="sz">${esc(fmtSize(a.size))}</div></span>
      ${/^(image\/(png|jpe?g|gif|webp)|application\/pdf|text\/plain)$/i.test(a.contentType) ? `<span class="btn ghost icon sm" data-view="${url}" title="${esc(t('open'))}">${icon('eye')}</span>` : ''}${icon('download')}</a>`;
  }
  document.addEventListener('click', e => {
    const v = e.target.closest('[data-view]');
    if (v) { e.preventDefault(); window.open(v.dataset.view, '_blank', 'noopener'); }
  });
  function frameDoc(m, extraCss = '') {
    const imgSrc = m.blocked ? "'self' data:" : "'self' data: https: http:";
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${imgSrc}; style-src 'unsafe-inline'; font-src data: https:">
      <base target="_blank"><style>
      html,body{margin:0;padding:0;background:#fff;color:#1d2433}
      body{font:14px/1.55 "Segoe UI",system-ui,-apple-system,Roboto,Arial,sans-serif;word-wrap:break-word;overflow-wrap:anywhere;padding:4px 2px}
      img{max-width:100%;height:auto} pre{white-space:pre-wrap} table{max-width:100%}
      blockquote{margin:0 0 0 4px;padding-left:12px;border-left:3px solid #c7d2fe;color:#4b5563}
      a{color:#2563eb} ${extraCss}</style></head><body>${m.html}</body></html>`;
  }
  function fillFrame(frame, m) {
    frame.srcdoc = frameDoc(m);
    const fit = () => {
      try {
        const d = frame.contentDocument;
        if (!d) return;
        frame.style.height = Math.max(120, d.documentElement.scrollHeight + 4) + 'px';
      } catch { /* bỏ qua */ }
    };
    frame.onload = () => {
      fit();
      try {
        const d = frame.contentDocument;
        $$('img', d).forEach(i => i.addEventListener('load', fit));
        new ResizeObserver(fit).observe(d.body);
      } catch { /* bỏ qua */ }
    };
  }
  async function readerAction(r, uid) {
    const m = S.msg;
    if (['reply', 'replyall', 'forward'].includes(r)) { location.hash = `#/compose?mode=${r}&f=${enc(S.folder)}&uid=${uid}`; return; }
    if (r === 'edit') { location.hash = `#/compose?mode=edit&f=${enc(S.folder)}&uid=${uid}`; return; }
    if (r === 'move') { const to = await pickFolder(); if (to) act('move', [uid], { to }); return; }
    if (r === 'source') {
      const src = await fetch(`/api/message/raw?f=${enc(S.folder)}&uid=${uid}`).then(x => x.text());
      modal({ title: t('act.source'), wide: true, body: `<pre class="code" style="white-space:pre-wrap;max-height:65vh;overflow:auto;margin:0">${esc(src)}</pre>` });
      return;
    }
    if (r === 'print') { printMessage(m); return; }
    if (r === 'addcontact') {
      const s = m.from[0];
      try { await api('POST', '/api/contacts', { email: s.address, name: s.name }); toast(t('contact.saved'), 'ok'); } catch (e) { toast(errText(e), 'error'); }
      return;
    }
    if (r === 'unread') { await act('unread', [uid]); closeReader(true); return; }
    act(r, [uid]);
  }
  function printMessage(m) {
    const w = window.open('', '_blank');
    if (!w) return;
    const head = `<h2 style="font:600 18px sans-serif">${esc(m.subject)}</h2><div style="font:13px sans-serif;color:#444;margin-bottom:14px">
      <div><b>${esc(t('fromLabel'))}:</b> ${addrLine(m.from)}</div><div><b>${esc(t('toLabel'))}:</b> ${addrLine(m.to)}</div>
      ${m.cc.length ? `<div><b>Cc:</b> ${addrLine(m.cc)}</div>` : ''}<div><b>${esc(t('dateLabel'))}:</b> ${esc(fmtDate(m.date, true))}</div></div><hr>`;
    w.document.write(frameDoc({ ...m, html: head + m.html }).replace("default-src 'none'", "default-src 'none'; script-src 'none'"));
    w.document.close();
    setTimeout(() => { w.focus(); w.print(); }, 300);
  }

  // =================== Soạn thư ===================
  let tinyLoading = null;
  function loadTiny() {
    if (window.tinymce) return Promise.resolve();
    if (!tinyLoading) {
      tinyLoading = new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = '/vendor/tinymce/tinymce.min.js';
        s.onload = res; s.onerror = rej;
        document.head.appendChild(s);
      });
    }
    return tinyLoading;
  }
  function destroyEditor() {
    if (S.compose?.timer) clearInterval(S.compose.timer);
    if (window.tinymce) window.tinymce.remove();
    if (S.view === 'compose') S.compose = null;
  }
  async function leaveCompose() {
    if (!S.compose || !S.compose.dirty) return true;
    const v = await modal({
      title: t('compose.leaveTitle'), body: `<p style="margin:0">${esc(t('compose.leaveText'))}</p>`,
      buttons: [{ label: t('cancel'), value: 'cancel' }, { label: t('compose.discard'), cls: 'danger', value: 'discard' }, { label: t('compose.saveDraft'), cls: 'primary', value: 'save' }],
    });
    if (v === 'save') { const ok = await saveDraft(true); if (!ok) return false; }
    else if (v !== 'discard') return false;
    if (S.compose) S.compose.dirty = false;
    destroyEditor();
    S.compose = null;
    return true;
  }
  const isDark = () => document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
  const sigText = () => (S.prefs.signature || '').trim();
  const sigHtml = () => (sigText() ? `<div class="wm-signature">-- <br>${esc(sigText()).replace(/\n/g, '<br>')}</div>` : '');
  const textToHtml = s => esc(s).replace(/\n/g, '<br>');

  async function renderCompose(params) {
    if (!S.me.canSend) { toast(t('err.sending_disabled'), 'error'); location.hash = '#/mail/' + enc(S.folder); return; }
    destroyEditor();
    S.view = 'compose';
    renderFolders();
    updateTitle();
    const mode = params.get('mode');
    const v = $('#view');
    v.innerHTML = '<div class="empty"><span class="spinner"></span></div>';
    let data = { to: params.get('to') || '', cc: '', bcc: '', subject: params.get('subject') || '', html: '', text: '', attachments: [] };
    try {
      if (mode && params.get('uid')) data = await api('GET', `/api/message/compose?mode=${mode}&f=${enc(params.get('f'))}&uid=${enc(params.get('uid'))}`);
    } catch (e) { toast(errText(e), 'error'); }
    const html = S.prefs.composeHtml !== false && !(mode === 'draft' && data.isHtml === false);
    // Nội dung ban đầu: chữ ký + trích dẫn.
    let body = '';
    let text = '';
    if (data.quote) {
      const q = data.quote;
      if (mode === 'forward') {
        const hdr = [`---------- ${t('compose.fwdHeader')} ----------`, `${t('fromLabel')}: ${q.from}`, `${t('dateLabel')}: ${fmtDate(q.date, true)}`, `${t('subjectLabel')}: ${q.subject}`, `${t('toLabel')}: ${q.to}`, q.cc ? `Cc: ${q.cc}` : ''].filter(Boolean);
        body = `<p><br></p>${sigHtml()}<br><div>${hdr.map(esc).join('<br>')}</div><br>${q.html}`;
        text = `\n\n${sigText() ? '-- \n' + sigText() + '\n\n' : ''}${hdr.join('\n')}\n\n${q.text}`;
      } else {
        const intro = t('compose.wrote', { date: fmtDate(q.date, true), from: q.from });
        const quoted = `<div>${esc(intro)}</div><blockquote type="cite" style="margin:0 0 0 4px;padding-left:12px;border-left:3px solid #c7d2fe">${q.html}</blockquote>`;
        const qtext = `${intro}\n${q.text.split('\n').map(l => '> ' + l).join('\n')}`;
        if (S.prefs.replyAbove !== false) { body = `<p><br></p>${sigHtml()}<br>${quoted}`; text = `\n\n${sigText() ? '-- \n' + sigText() + '\n\n' : ''}${qtext}`; }
        else { body = `${quoted}<p><br></p>${sigHtml()}`; text = `${qtext}\n\n\n${sigText() ? '-- \n' + sigText() : ''}`; }
      }
    } else if (mode === 'draft' || mode === 'edit') {
      body = data.html || textToHtml(data.text || '');
      text = data.text || '';
    } else {
      body = `<p><br></p>${sigHtml()}`;
      text = sigText() ? `\n\n-- \n${sigText()}` : '';
    }
    S.compose = {
      html, dirty: false, uploads: [], parts: (data.attachments || []).map(a => ({ ...a, key: `${a.f}:${a.uid}:${a.i}` })),
      draft: data.draft || null, origin: data.origin || null, inReplyTo: data.inReplyTo || null, references: data.references || [],
    };
    const me = S.me;
    v.innerHTML = `<div class="compose" id="compose">
      <div class="inner">
        <div class="toolbar">
          <button class="btn primary" id="csend">${icon('send')}<span data-i18n="send"></span></button>
          <button class="btn" id="cdraft">${icon('draft')}<span class="desktop-only" data-i18n="compose.saveDraft"></span></button>
          <label class="btn" title="${esc(t('compose.attach'))}">${icon('clip')}<span class="desktop-only" data-i18n="compose.attach"></span><input type="file" id="cfile" multiple hidden></label>
          <span class="grow"></span>
          <span class="muted small" id="cstatus"></span>
          <button class="btn ghost" id="cdiscard" title="${esc(t('compose.discard'))}">${icon('trash')}</button>
        </div>
        <div class="cfield"><label data-i18n="fromLabel"></label><div class="muted" style="overflow:hidden;text-overflow:ellipsis">${esc(S.prefs.displayName || me.displayName ? `${S.prefs.displayName || me.displayName} <${me.address}>` : me.address)}</div><span></span></div>
        <div class="cfield"><label for="cto" data-i18n="toLabel"></label><input id="cto" autocomplete="off" value="${esc(data.to)}">
          <span class="row" style="gap:2px"><button class="btn ghost sm" id="showcc">Cc</button><button class="btn ghost sm" id="showbcc">Bcc</button></span></div>
        <div class="cfield" id="ccrow" ${data.cc ? '' : 'hidden'}><label for="ccc">Cc</label><input id="ccc" autocomplete="off" value="${esc(data.cc)}"><span></span></div>
        <div class="cfield" id="bccrow" ${data.bcc ? '' : 'hidden'}><label for="cbcc">Bcc</label><input id="cbcc" autocomplete="off" value="${esc(data.bcc)}"><span></span></div>
        <div class="cfield"><label for="csubj" data-i18n="subjectLabel"></label><input id="csubj" value="${esc(data.subject)}"><span></span></div>
        <div class="attlist" id="catts"></div>
        <div class="opts">
          <label class="check"><input type="checkbox" id="chtml" ${html ? 'checked' : ''}><span data-i18n="compose.htmlMode"></span></label>
          <label class="row"><span data-i18n="compose.priority"></span><select class="input" id="cprio" style="width:auto;height:30px">
            <option value="normal" data-i18n="priority.normal"></option><option value="high" data-i18n="priority.high"></option><option value="low" data-i18n="priority.low"></option></select></label>
          <label class="check"><input type="checkbox" id="creceipt"><span data-i18n="compose.receipt"></span></label>
        </div>
        <div class="editor-wrap" id="cedwrap"></div>
      </div>
    </div>`;
    applyI18n(v);
    if (!data.to && !params.get('to')) $('#cto').focus(); else $('#csubj').focus();
    await mountEditor(html, html ? body : text);
    renderAttachments();
    const dirty = () => { if (S.compose) S.compose.dirty = true; };
    ['#cto', '#ccc', '#cbcc', '#csubj'].forEach(s => $(s).addEventListener('input', dirty));
    ['#cto', '#ccc', '#cbcc'].forEach(s => autocomplete($(s)));
    $('#showcc').onclick = () => { $('#ccrow').hidden = false; $('#ccc').focus(); };
    $('#showbcc').onclick = () => { $('#bccrow').hidden = false; $('#cbcc').focus(); };
    $('#chtml').onchange = e => switchMode(e.target.checked);
    $('#cfile').onchange = e => { uploadFiles([...e.target.files]); e.target.value = ''; };
    $('#csend').onclick = sendMail;
    $('#cdraft').onclick = () => saveDraft(false);
    $('#cdiscard').onclick = async () => {
      if (S.compose.dirty && !(await confirmBox(t('compose.confirmDiscard'), { danger: true, ok: t('compose.discard') }))) return;
      S.compose.dirty = false;
      history.back();
      setTimeout(() => { if (S.view === 'compose') location.hash = '#/mail/' + enc(S.folder); }, 150);
    };
    const c = $('#compose');
    c.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); c.classList.add('dragging'); } });
    c.addEventListener('dragleave', e => { if (!c.contains(e.relatedTarget)) c.classList.remove('dragging'); });
    c.addEventListener('drop', e => { if (e.dataTransfer.files.length) { e.preventDefault(); c.classList.remove('dragging'); uploadFiles([...e.dataTransfer.files]); } });
    const every = Math.max(20, Number(S.prefs.draftAutosave) || 0);
    if (S.prefs.draftAutosave) S.compose.timer = setInterval(() => { if (S.compose?.dirty && !S.compose.busy) saveDraft(true, true); }, every * 1000);
  }

  async function mountEditor(html, content) {
    const wrap = $('#cedwrap');
    if (!html) {
      wrap.innerHTML = '<textarea class="plain" id="cplain"></textarea>';
      $('#cplain').value = content;
      $('#cplain').addEventListener('input', () => { S.compose.dirty = true; });
      return;
    }
    wrap.innerHTML = '<textarea id="ced"></textarea>';
    $('#ced').value = content;
    try { await loadTiny(); } catch { toast(t('err.editor'), 'error'); return mountEditor(false, content.replace(/<[^>]+>/g, '')); }
    const vi = WM.getLang() === 'vi';
    await window.tinymce.init({
      target: $('#ced'),
      license_key: 'gpl',
      base_url: '/vendor/tinymce', suffix: '.min',
      language: vi ? 'vi' : undefined, language_url: vi ? '/vendor/tinymce-langs/vi.js' : undefined,
      skin: isDark() ? 'oxide-dark' : 'oxide', content_css: isDark() ? 'dark' : 'default',
      promotion: false, branding: false, browser_spellcheck: true, contextmenu: false,
      height: Math.max(380, window.innerHeight - 380), min_height: 300,
      menubar: 'edit view insert format table tools',
      plugins: 'advlist autolink lists link image charmap preview anchor searchreplace visualblocks visualchars code fullscreen insertdatetime table help wordcount emoticons directionality nonbreaking pagebreak quickbars',
      toolbar: 'undo redo | blocks fontfamily fontsize | bold italic underline strikethrough | forecolor backcolor | alignleft aligncenter alignright alignjustify | bullist numlist outdent indent | link image table emoticons charmap | blockquote hr removeformat | ltr rtl | searchreplace code preview fullscreen',
      toolbar_mode: 'sliding',
      quickbars_insert_toolbar: false,
      quickbars_selection_toolbar: 'bold italic underline | forecolor | quicklink blockquote',
      font_family_formats: 'Arial=arial,helvetica,sans-serif; Segoe UI=segoe ui,sans-serif; Georgia=georgia,serif; Times New Roman=times new roman,times,serif; Courier New=courier new,courier,monospace; Verdana=verdana,geneva,sans-serif; Tahoma=tahoma,sans-serif; Trebuchet MS=trebuchet ms,sans-serif',
      font_size_formats: '10px 12px 13px 14px 16px 18px 20px 24px 28px 36px 48px',
      content_style: 'body{font-family:Segoe UI,Arial,sans-serif;font-size:14px;line-height:1.5} blockquote{margin:0 0 0 4px;padding-left:12px;border-left:3px solid #c7d2fe;color:#4b5563}',
      convert_urls: false, relative_urls: false, remove_script_host: false,
      paste_data_images: true, automatic_uploads: false, image_advtab: true, image_caption: false,
      link_default_target: '_blank', link_assume_external_targets: 'https',
      file_picker_types: 'image',
      file_picker_callback: cb => {
        const inp = document.createElement('input');
        inp.type = 'file'; inp.accept = 'image/*';
        inp.onchange = () => {
          const file = inp.files[0];
          if (!file) return;
          if (file.size > 5 * 1024 * 1024) return toast(t('err.file_too_large'), 'error');
          const r = new FileReader();
          r.onload = () => cb(r.result, { alt: file.name });
          r.readAsDataURL(file);
        };
        inp.click();
      },
      setup: ed => {
        ed.on('input change undo redo', () => { if (S.compose) S.compose.dirty = true; });
        ed.addShortcut('ctrl+enter', 'Send', () => sendMail());
      },
    });
  }
  const editor = () => window.tinymce?.get('ced');
  function getBody() {
    if (S.compose.html) { const ed = editor(); return { isHtml: true, html: ed ? ed.getContent() : $('#ced')?.value || '' }; }
    return { isHtml: false, text: $('#cplain')?.value || '' };
  }
  async function switchMode(toHtml) {
    const cur = getBody();
    if (!toHtml && cur.isHtml) {
      if (!(await confirmBox(t('compose.toPlainWarn')))) { $('#chtml').checked = true; return; }
      const txt = editor() ? editor().getContent({ format: 'text' }) : '';
      window.tinymce?.remove();
      S.compose.html = false;
      await mountEditor(false, txt);
    } else if (toHtml && !cur.isHtml) {
      S.compose.html = true;
      await mountEditor(true, cur.text.split(/\n{2,}/).map(p => `<p>${textToHtml(p)}</p>`).join(''));
    }
    S.compose.dirty = true;
  }
  function renderAttachments() {
    const box = $('#catts');
    if (!box) return;
    const c = S.compose;
    box.innerHTML = [
      ...c.parts.map(p => `<span class="att">${icon('file')}<span class="grow"><div class="nm">${esc(p.filename)}</div><div class="sz">${esc(fmtSize(p.size))}</div></span><button class="btn ghost icon sm" data-rmpart="${esc(p.key)}">${icon('x')}</button></span>`),
      ...c.uploads.map((u, i) => `<span class="att">${icon('file')}<span class="grow"><div class="nm">${esc(u.name)}</div><div class="sz">${u.id ? esc(fmtSize(u.size)) : u.error ? `<span style="color:var(--danger)">${esc(u.error)}</span>` : `<span class="prog"><i style="width:${u.pct || 0}%"></i></span>`}</div></span><button class="btn ghost icon sm" data-rmup="${i}">${icon('x')}</button></span>`),
    ].join('');
    $$('[data-rmpart]', box).forEach(b => b.onclick = () => { c.parts = c.parts.filter(p => p.key !== b.dataset.rmpart); c.dirty = true; renderAttachments(); });
    $$('[data-rmup]', box).forEach(b => b.onclick = () => {
      const u = c.uploads[Number(b.dataset.rmup)];
      u.xhr?.abort();
      if (u.id) api('DELETE', '/api/upload/' + u.id).catch(() => {});
      c.uploads.splice(Number(b.dataset.rmup), 1); c.dirty = true; renderAttachments();
    });
  }
  function uploadFiles(files) {
    const c = S.compose;
    const max = (S.me.maxUploadMb || 25) * 1024 * 1024;
    for (const file of files) {
      const u = { name: file.name, size: file.size, pct: 0 };
      c.uploads.push(u);
      c.dirty = true;
      if (file.size > max) { u.error = t('err.file_too_large'); continue; }
      const fd = new FormData();
      fd.append('files', file, file.name);
      const xhr = new XMLHttpRequest();
      u.xhr = xhr;
      xhr.open('POST', '/api/upload');
      xhr.setRequestHeader('X-WM', '1');
      xhr.upload.onprogress = e => { u.pct = Math.round(e.loaded / e.total * 100); renderAttachments(); };
      xhr.onload = () => {
        try {
          const r = JSON.parse(xhr.responseText);
          const f = r.files?.[0];
          if (xhr.status === 200 && f?.id) Object.assign(u, { id: f.id, size: f.size }); else u.error = t('err.' + (f?.error || r.error || 'upload_failed'));
        } catch { u.error = t('err.upload_failed'); }
        u.xhr = null;
        renderAttachments();
      };
      xhr.onerror = () => { u.error = t('err.upload_failed'); renderAttachments(); };
      xhr.send(fd);
    }
    renderAttachments();
  }
  function composePayload() {
    const c = S.compose;
    return {
      to: $('#cto').value, cc: $('#ccc').value, bcc: $('#cbcc').value, subject: $('#csubj').value,
      ...getBody(),
      attachments: c.uploads.filter(u => u.id).map(u => u.id),
      parts: c.parts.map(p => ({ f: p.f, uid: p.uid, i: p.i })),
      inReplyTo: c.inReplyTo, references: c.references,
      priority: $('#cprio').value, receipt: $('#creceipt').checked,
      draft: c.draft, origin: c.origin,
    };
  }
  async function sendMail() {
    const c = S.compose;
    if (!c || c.busy) return;
    if (c.uploads.some(u => !u.id && !u.error)) return toast(t('compose.waitUploads'));
    const p = composePayload();
    if (!(p.to + p.cc + p.bcc).trim()) { toast(t('compose.needRecipient'), 'error'); $('#cto').focus(); return; }
    if (!p.subject.trim() && !(await confirmBox(t('compose.noSubject')))) return;
    c.busy = true;
    $('#csend').disabled = true;
    $('#cstatus').textContent = t('compose.sending');
    try {
      const r = await api('POST', '/api/send', p);
      c.dirty = false;
      toast(t('compose.sent'), 'ok');
      if (r.warnings?.includes('sent_copy_failed')) toast(t('compose.sentCopyFailed'), 'error');
      destroyEditor();
      S.compose = null;
      loadFolders();
      location.hash = '#/mail/' + enc(S.folder);
    } catch (e) {
      toast(errText(e), 'error');
      $('#cstatus').textContent = '';
      c.busy = false;
      $('#csend').disabled = false;
    }
  }
  async function saveDraft(silent = false, auto = false) {
    const c = S.compose;
    if (!c) return true;
    c.busy = true;
    $('#cstatus') && ($('#cstatus').textContent = t('compose.saving'));
    try {
      const r = await api('POST', '/api/draft', composePayload());
      c.draft = r.draft;
      c.dirty = false;
      // Tệp đính kèm giờ nằm trong bản nháp mới (bản cũ đã bị xóa): trỏ lại tới bản nháp mới.
      if (r.draft?.uid && (c.parts.length || c.uploads.length)) {
        try {
          const d = await api('GET', `/api/message/compose?mode=draft&f=${enc(r.draft.f)}&uid=${r.draft.uid}`);
          c.parts = d.attachments.map(a => ({ ...a, key: `${a.f}:${a.uid}:${a.i}` }));
          c.uploads = c.uploads.filter(u => !u.id);
          renderAttachments();
        } catch { /* giữ nguyên */ }
      }
      if ($('#cstatus')) $('#cstatus').textContent = t('compose.savedAt', { time: new Date().toLocaleTimeString(WM.getLang() === 'vi' ? 'vi-VN' : 'en-GB', { hour: '2-digit', minute: '2-digit' }) });
      if (!silent || !auto) toast(t('compose.draftSaved'), 'ok');
      loadFolders();
      return true;
    } catch (e) {
      if ($('#cstatus')) $('#cstatus').textContent = '';
      if (!auto) toast(errText(e), 'error');
      return false;
    } finally { c.busy = false; }
  }
  function autocomplete(input) {
    let box = null;
    let items = [];
    let idx = -1;
    let timer = null;
    const close = () => { box?.remove(); box = null; idx = -1; };
    const pick = i => {
      const c = items[i];
      if (!c) return;
      const parts = input.value.split(',');
      parts[parts.length - 1] = ' ' + (c.name ? `"${c.name.replace(/"/g, '')}" <${c.email}>` : c.email);
      input.value = parts.join(',').replace(/^\s+/, '') + ', ';
      S.compose.dirty = true;
      close();
      input.focus();
    };
    input.addEventListener('input', () => {
      clearTimeout(timer);
      const term = input.value.split(',').pop().trim();
      if (term.length < 1) return close();
      timer = setTimeout(async () => {
        try { items = (await api('GET', '/api/contacts/suggest?q=' + enc(term))).contacts; } catch { items = []; }
        close();
        if (!items.length) return;
        box = document.createElement('div');
        box.className = 'suggest';
        box.innerHTML = items.map((c, i) => `<div data-i="${i}">${c.name ? `<b>${esc(c.name)}</b> ` : ''}<span class="muted">${esc(c.email)}</span></div>`).join('');
        box.addEventListener('mousedown', e => { const d = e.target.closest('[data-i]'); if (d) { e.preventDefault(); pick(Number(d.dataset.i)); } });
        input.parentElement.appendChild(box);
      }, 180);
    });
    input.addEventListener('keydown', e => {
      if (!box) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        idx = (idx + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        $$('[data-i]', box).forEach((d, i) => d.classList.toggle('on', i === idx));
      } else if ((e.key === 'Enter' || e.key === 'Tab') && idx >= 0) { e.preventDefault(); pick(idx); } else if (e.key === 'Escape') close();
    });
    input.addEventListener('blur', () => setTimeout(close, 150));
  }

  // =================== Danh bạ ===================
  async function renderContacts(selectedId = null) {
    S.view = 'contacts';
    renderFolders();
    updateTitle();
    const v = $('#view');
    v.innerHTML = `<div class="page"><div class="inner">
      <div class="row wrap" style="margin-bottom:14px"><h2 class="grow" style="margin:0" data-i18n="nav.contacts"></h2>
        <button class="btn primary" id="cnew">${icon('plus')}<span data-i18n="contact.new"></span></button>
        <label class="btn">${icon('upload')}<span data-i18n="contact.import"></span><input type="file" id="cimport" accept=".vcf,text/vcard" hidden></label>
        <a class="btn" href="/api/contacts/export">${icon('download')}<span data-i18n="contact.export"></span></a></div>
      <div class="contacts">
        <div class="card"><div style="padding:10px;border-bottom:1px solid var(--border)" class="stack">
          <input class="input" id="csearch" data-i18n-ph="contact.search">
          <select class="input" id="cgroup"><option value="" data-i18n="contact.all"></option><option value="saved" data-i18n="contact.saved"></option><option value="collected" data-i18n="contact.collected"></option></select>
        </div><div class="clist" id="clist"></div></div>
        <div class="card" id="cdetail"><div class="empty">${icon('users')}<div data-i18n="contact.pick"></div></div></div>
      </div></div></div>`;
    applyI18n(v);
    let list = [];
    const load = async () => {
      const r = await api('GET', `/api/contacts?q=${enc($('#csearch').value)}&group=${$('#cgroup').value}`);
      list = r.contacts;
      $('#clist').innerHTML = list.length ? list.map(c => `<div class="citem" data-id="${c.id}">${avatar(c.name, c.email)}<div class="grow" style="min-width:0"><div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.name || c.email)}</div><div class="muted small" style="overflow:hidden;text-overflow:ellipsis">${esc(c.email)}</div></div>${c.collected ? `<span class="badge">${esc(t('contact.auto'))}</span>` : ''}</div>`).join('')
        : `<div class="empty">${esc(t('contact.none'))}</div>`;
      $$('.citem').forEach(el => el.onclick = () => edit(list.find(c => c.id === Number(el.dataset.id))));
      if (selectedId) { const c = list.find(x => x.id === selectedId); if (c) edit(c); }
    };
    const edit = (c = {}) => {
      $$('.citem').forEach(el => el.classList.toggle('on', Number(el.dataset.id) === c.id));
      $('#cdetail').innerHTML = `<div class="card-h">${c.id ? avatar(c.name, c.email) : icon('user')}<span class="grow">${esc(c.id ? c.name || c.email : t('contact.new'))}</span>
        ${c.id && S.me.canSend ? `<a class="btn sm" href="#/compose?to=${enc(c.email)}">${icon('pen')}${esc(t('compose'))}</a>` : ''}</div>
        <form class="card-b form-grid" id="cform">
          <label class="field"><span data-i18n="contact.name"></span><input class="input" name="name" value="${esc(c.name || '')}"></label>
          <label class="field"><span data-i18n="contact.email"></span><input class="input" name="email" type="email" required value="${esc(c.email || '')}"></label>
          <label class="field"><span data-i18n="contact.phone"></span><input class="input" name="phone" value="${esc(c.phone || '')}"></label>
          <label class="field"><span data-i18n="contact.org"></span><input class="input" name="org" value="${esc(c.org || '')}"></label>
          <label class="field full"><span data-i18n="contact.notes"></span><textarea class="input" name="notes" rows="3">${esc(c.notes || '')}</textarea></label>
          <div class="full row"><button class="btn primary" data-i18n="save"></button>${c.id ? `<button type="button" class="btn danger" id="cdel" data-i18n="delete"></button>` : ''}</div>
        </form>`;
      applyI18n($('#cdetail'));
      $('#cform').onsubmit = async e => {
        e.preventDefault();
        const body = Object.fromEntries(new FormData(e.target));
        try {
          if (c.id) await api('PUT', '/api/contacts/' + c.id, body); else await api('POST', '/api/contacts', body);
          toast(t('contact.saved'), 'ok');
          selectedId = c.id || null;
          await load();
        } catch (err) { toast(errText(err), 'error'); }
      };
      $('#cdel')?.addEventListener('click', async () => {
        if (!(await confirmBox(t('contact.confirmDelete'), { danger: true, ok: t('delete') }))) return;
        await api('POST', '/api/contacts/delete', { ids: [c.id] });
        selectedId = null;
        $('#cdetail').innerHTML = `<div class="empty">${icon('users')}</div>`;
        load();
      });
    };
    $('#cnew').onclick = () => edit({});
    let tm;
    $('#csearch').oninput = () => { clearTimeout(tm); tm = setTimeout(load, 200); };
    $('#cgroup').onchange = load;
    $('#cimport').onchange = async e => {
      const f = e.target.files[0];
      if (!f) return;
      try { const r = await api('POST', '/api/contacts/import', await f.text()); toast(t('contact.imported', { n: r.imported }), 'ok'); load(); } catch (err) { toast(errText(err), 'error'); }
      e.target.value = '';
    };
    try { await load(); } catch (e) { toast(errText(e), 'error'); }
  }

  // =================== Cài đặt ===================
  const TABS = ['general', 'identity', 'compose', 'privacy', 'folders', 'password', 'clients'];
  function renderSettings(tab) {
    if (!TABS.includes(tab)) tab = 'general';
    S.view = 'settings';
    renderFolders();
    updateTitle();
    const p = S.prefs;
    const v = $('#view');
    const sel = (name, opts) => `<select class="input" name="${name}">${opts.map(([val, label]) => `<option value="${val}" ${String(p[name]) === String(val) ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select>`;
    const chk = (name, key) => `<label class="check"><input type="checkbox" name="${name}" ${p[name] ? 'checked' : ''}><span>${esc(t(key))}</span></label>`;
    let body = '';
    if (tab === 'general') {
      body = `<form class="card-b form-grid" data-prefs>
        <label class="field"><span>${esc(t('settings.language'))}</span>${sel('lang', [['en', 'English'], ['vi', 'Tiếng Việt']])}</label>
        <label class="field"><span>${esc(t('settings.theme'))}</span>${sel('theme', [['auto', t('theme.auto')], ['light', t('theme.light')], ['dark', t('theme.dark')]])}</label>
        <label class="field"><span>${esc(t('settings.pageSize'))}</span>${sel('pageSize', [[25, 25], [50, 50], [100, 100], [200, 200]])}</label>
        <label class="field"><span>${esc(t('settings.refresh'))}</span>${sel('autoRefresh', [[0, t('never')], [30, t('seconds', { n: 30 })], [60, t('minutes', { n: 1 })], [180, t('minutes', { n: 3 })], [300, t('minutes', { n: 5 })], [600, t('minutes', { n: 10 })]])}</label>
        <div class="full stack">${chk('previewPane', 'settings.previewPane')}${chk('notifications', 'settings.notifications')}${chk('confirmDelete', 'settings.confirmDelete')}</div>
        <div class="full"><button class="btn primary">${esc(t('save'))}</button></div></form>`;
    } else if (tab === 'identity') {
      body = `<form class="card-b form-grid" data-prefs>
        <label class="field"><span>${esc(t('settings.address'))}</span><input class="input" value="${esc(S.me.address)}" readonly></label>
        <label class="field"><span>${esc(t('settings.displayName'))}</span><input class="input" name="displayName" maxlength="190" value="${esc(p.displayName)}"></label>
        <label class="field full"><span>${esc(t('settings.replyTo'))}</span><input class="input" type="email" name="replyTo" value="${esc(p.replyTo)}" placeholder="${esc(t('optional'))}"></label>
        <label class="field full"><span>${esc(t('settings.signature'))}</span><textarea class="input" name="signature" rows="6">${esc(p.signature)}</textarea></label>
        <div class="full"><button class="btn primary">${esc(t('save'))}</button></div></form>`;
    } else if (tab === 'compose') {
      body = `<form class="card-b form-grid" data-prefs>
        <div class="full stack">${chk('composeHtml', 'settings.composeHtml')}${chk('replyAbove', 'settings.replyAbove')}${chk('collectContacts', 'settings.collectContacts')}</div>
        <label class="field"><span>${esc(t('settings.autosave'))}</span>${sel('draftAutosave', [[0, t('never')], [30, t('seconds', { n: 30 })], [60, t('minutes', { n: 1 })], [180, t('minutes', { n: 3 })], [300, t('minutes', { n: 5 })]])}</label>
        <div class="full"><button class="btn primary">${esc(t('save'))}</button></div></form>`;
    } else if (tab === 'privacy') {
      body = `<form class="card-b stack" data-prefs>
        ${chk('blockRemote', 'settings.blockRemote')}<div class="muted small">${esc(t('settings.blockRemoteHint'))}</div>
        <div><button class="btn primary">${esc(t('save'))}</button></div></form>`;
    } else if (tab === 'folders') {
      body = `<div class="card-b"><div class="row" style="margin-bottom:12px"><span class="grow muted">${esc(t('settings.foldersHint'))}</span><button class="btn" id="fnew">${icon('plus')}${esc(t('folder.new'))}</button></div>
        <table class="grid"><thead><tr><th>${esc(t('folder.name'))}</th><th>${esc(t('settings.messages'))}</th><th>${esc(t('settings.unread'))}</th><th></th></tr></thead><tbody>
        ${sortedFolders().map(f => `<tr><td style="padding-left:${12 + depth(f) * 18}px">${icon(SPECIAL_ICON[f.special] || 'folder')} ${esc(folderLabel(f))}</td><td>${f.total}</td><td>${f.unread}</td>
          <td style="text-align:right">${f.special ? `<span class="badge">${esc(t('settings.system'))}</span>` : `<button class="btn sm" data-fm="${esc(f.path)}">${esc(t('more'))}</button>`}</td></tr>`).join('')}
        </tbody></table></div>`;
    } else if (tab === 'password') {
      body = S.me.kind === 'link' ? `<div class="card-b"><div class="alert">${esc(t('settings.linkNoPassword'))}</div></div>` : !S.me.canChangePassword ? `<div class="card-b"><div class="alert">${esc(t('settings.passwordManual'))}</div></div>` :
        `<form class="card-b stack" id="pwform" style="max-width:420px">
          <label class="field"><span>${esc(t('settings.currentPassword'))}</span><input class="input" type="password" name="current" autocomplete="current-password" required></label>
          <label class="field"><span>${esc(t('settings.newPassword'))}</span><input class="input" type="password" name="next" autocomplete="new-password" required></label>
          <label class="field"><span>${esc(t('settings.confirmPassword'))}</span><input class="input" type="password" name="confirm" autocomplete="new-password" required></label>
          <div class="muted small">${esc(t('password.rules'))}</div>
          <div><button class="btn primary">${esc(t('settings.changePassword'))}</button></div></form>`;
    } else if (tab === 'clients') {
      const s = S.me.servers;
      const line = (label, x, sec) => `<tr><td><b>${label}</b></td><td class="code">${esc(x.host)}</td><td>${x.port}</td><td>${esc(x.secure ? 'SSL/TLS' : sec)}</td></tr>`;
      body = `<div class="card-b stack"><p class="muted" style="margin:0">${esc(t('settings.clientsHint'))}</p>
        <table class="grid"><thead><tr><th>${esc(t('settings.protocol'))}</th><th>${esc(t('settings.server'))}</th><th>Port</th><th>${esc(t('settings.security'))}</th></tr></thead><tbody>
        ${line('IMAP', s.imap, 'STARTTLS')}${line('POP3', s.pop3, 'STARTTLS')}${line('SMTP', s.smtp, 'STARTTLS')}</tbody></table>
        <div class="muted small">${esc(t('settings.clientsUser', { address: S.me.address }))}</div></div>`;
    }
    v.innerHTML = `<div class="page"><div class="inner"><h2>${esc(t('nav.settings'))}</h2><div class="settings">
      <nav class="tabs card" style="padding:6px">${TABS.map(x => `<a href="#/settings/${x}" class="${x === tab ? 'on' : ''}">${esc(t('settings.tab.' + x))}</a>`).join('')}</nav>
      <div class="card"><div class="card-h">${esc(t('settings.tab.' + tab))}</div>${body}</div></div></div></div>`;
    $('[data-prefs]', v)?.addEventListener('submit', async e => {
      e.preventDefault();
      const f = e.target;
      const patch = {};
      $$('input[name], select[name], textarea[name]', f).forEach(el => {
        if (el.readOnly) return;
        patch[el.name] = el.type === 'checkbox' ? el.checked : (typeof S.prefs[el.name] === 'number' ? Number(el.value) : el.value);
      });
      try {
        const r = await api('PUT', '/api/prefs', patch);
        const langChanged = r.prefs.lang !== S.prefs.lang;
        S.prefs = r.prefs;
        S.size = S.prefs.pageSize;
        WM.setTheme(S.prefs.theme);
        if (patch.notifications && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
        startRefresh();
        toast(t('saved'), 'ok');
        if (langChanged) { WM.setLang(S.prefs.lang); renderShell(); renderFolders(); renderSettings(tab); }
      } catch (err) { toast(errText(err), 'error'); }
    });
    $('#fnew')?.addEventListener('click', async () => { await createFolder(); renderSettings('folders'); });
    $$('[data-fm]', v).forEach(b => b.onclick = async () => { await folderMenu(b.dataset.fm); renderSettings('folders'); });
    $('#pwform')?.addEventListener('submit', async e => {
      e.preventDefault();
      const f = e.target;
      if (f.next.value !== f.confirm.value) return toast(t('password.mismatch'), 'error');
      try {
        await api('POST', '/api/password', { current: f.current.value, next: f.next.value });
        toast(t('password.changed'), 'ok');
        f.reset();
      } catch (err) { toast(errText(err), 'error'); }
    });
  }

  // =================== Làm mới tự động & thông báo ===================
  function startRefresh() {
    clearInterval(S.timer);
    const sec = Number(S.prefs.autoRefresh);
    if (!sec) return;
    S.timer = setInterval(async () => {
      if (!S.me || document.hidden && !S.prefs.notifications) return;
      const before = folderBy(S.folder)?.total;
      await loadFolders();
      const after = folderBy(S.folder)?.total;
      if (S.view === 'mail' && before !== after && S.page === 1 && !S.q) loadList(true);
    }, Math.max(30, sec) * 1000);
  }
  function notifyNew(n) {
    if (S.view === 'mail' && S.folder === 'INBOX' && S.page === 1 && !S.q) loadList(true);
    if (!S.prefs.notifications || !('Notification' in window) || Notification.permission !== 'granted' || !document.hidden) return;
    try { new Notification(S.me.appName, { body: t('newMail', { n }), icon: '/favicon.svg', tag: 'wm-new' }); } catch { /* bỏ qua */ }
  }

  // =================== Phím tắt ===================
  document.addEventListener('keydown', e => {
    if (!S.me || typing(e) || e.ctrlKey || e.metaKey || e.altKey || $('.modal-back')) return;
    if (S.view !== 'mail') return;
    const k = e.key;
    if (k === 'c' && S.me.canSend) { location.hash = '#/compose'; e.preventDefault(); }
    else if (k === '/') { e.preventDefault(); $('#search input').focus(); }
    else if ((k === 'Delete' || k === '#') && targets().length) act('delete', targets());
    else if (S.uid && ['r', 'a', 'f'].includes(k) && S.me.canSend) readerAction({ r: 'reply', a: 'replyall', f: 'forward' }[k], S.uid);
    else if ((k === 'j' || k === 'k' || k === 'ArrowDown' || k === 'ArrowUp') && S.items.length) {
      const i = S.items.findIndex(m => m.uid === S.uid);
      const n = S.items[Math.min(S.items.length - 1, Math.max(0, i + (k === 'j' || k === 'ArrowDown' ? 1 : -1)))];
      if (n && n.uid !== S.uid) { e.preventDefault(); location.hash = `#/mail/${enc(S.folder)}/${n.uid}`; }
    } else if (k === 'Escape' && S.uid) location.hash = '#/mail/' + enc(S.folder);
  });

  boot();
})();
