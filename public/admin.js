/* Trang quản trị webmail. */
(() => {
  const { $, $$, esc, t, api, toast, modal, confirmBox, icon, fmtDate, errText, applyI18n, copy } = WM;
  const app = $('#app');
  const A = { status: null, domains: [], pending: 0, view: 'dashboard' };
  const enc = encodeURIComponent;
  const NAV = [
    ['dashboard', 'home'], ['mailboxes', 'mail'], ['random', 'dice'], ['registrations', 'users'], ['domains', 'globe'],
    ['settings', 'server'], ['admins', 'shield'], ['audit', 'list'],
  ];
  window.onUnauthorized = () => { if (A.status?.loggedIn) location.reload(); };

  async function boot() {
    try { A.status = await api('GET', '/api/admin/status', undefined, { onUnauthorized: false }); } catch (e) {
      app.innerHTML = `<div class="auth-wrap"><div class="alert error">${esc(errText(e))}</div></div>`; return;
    }
    if (A.status.needsSetup) return renderSetup();
    if (!A.status.loggedIn) return renderLogin();
    renderShell();
    route();
  }

  function authCard(inner) {
    app.innerHTML = `<div class="auth-wrap"><form class="auth-card stack" id="af">
      <div class="row"><div class="brand grow">${WM.LOGO}<span>${esc(A.status.appName)}</span></div>${WM.langSwitch()}</div>${inner}</form></div>`;
    applyI18n(app);
    return $('#af');
  }
  function renderLogin() {
    document.title = t('admin.title');
    const f = authCard(`<h2 style="margin:4px 0 0;font-size:20px" data-i18n="admin.loginHeading"></h2>
      <div class="alert error" id="aerr" hidden></div>
      <label class="field"><span data-i18n="admin.username"></span><input class="input" name="username" autocomplete="username" required autofocus></label>
      <label class="field"><span data-i18n="login.password"></span><input class="input" type="password" name="password" autocomplete="current-password" required></label>
      <button class="btn primary" style="height:40px" data-i18n="login.submit"></button>
      <div class="small muted" style="text-align:center"><a href="/" data-i18n="admin.toWebmail"></a></div>`);
    f.onsubmit = async e => {
      e.preventDefault();
      try { await api('POST', '/api/admin/login', { username: f.username.value, password: f.password.value }, { onUnauthorized: false }); boot(); } catch (err) {
        $('#aerr').textContent = errText(err); $('#aerr').hidden = false;
      }
    };
  }
  function renderSetup() {
    const f = authCard(`<h2 style="margin:4px 0 0;font-size:20px" data-i18n="admin.setupHeading"></h2><div class="muted small" data-i18n="admin.setupHint"></div>
      <div class="alert error" id="aerr" hidden></div>
      <label class="field"><span data-i18n="admin.setupCode"></span><input class="input mono" name="code" required autofocus></label>
      <label class="field"><span data-i18n="admin.username"></span><input class="input" name="username" required pattern="[a-zA-Z0-9._\\-]{3,64}"></label>
      <label class="field"><span data-i18n="login.password"></span><input class="input" type="password" name="password" required autocomplete="new-password"></label>
      <div class="muted small" data-i18n="password.rules"></div>
      <button class="btn primary" data-i18n="admin.createAdmin"></button>`);
    f.onsubmit = async e => {
      e.preventDefault();
      try { await api('POST', '/api/admin/setup', Object.fromEntries(new FormData(f))); toast(t('saved'), 'ok'); boot(); } catch (err) {
        $('#aerr').textContent = errText(err); $('#aerr').hidden = false;
      }
    };
  }

  function renderShell() {
    app.innerHTML = `<div class="amobile"><button class="btn ghost icon" id="anav">${icon('menu')}</button><b>${esc(A.status.appName)}</b></div>
    <div class="ashell">
      <aside class="aside">
        <div class="brand">${WM.LOGO}<span>${esc(A.status.appName)}<small data-i18n="admin.panel"></small></span></div>
        <nav id="anavlist">${NAV.map(([k, ic]) => `<a href="#/${k}" data-k="${k}">${icon(ic)}<span data-i18n="admin.nav.${k}"></span>${k === 'registrations' ? '<span class="badge red" id="pendbadge" hidden></span>' : ''}</a>`).join('')}</nav>
        <div class="foot">${WM.langSwitch()}<span class="grow"></span><span class="small muted">${esc(A.status.username || '')}</span><button class="btn ghost icon sm" id="alogout" data-i18n-title="nav.logout">${icon('logout')}</button></div>
      </aside>
      <main class="amain"><div class="inner" id="aview"></div></main>
    </div>`;
    applyI18n(app);
    $('#anav').onclick = () => document.body.classList.toggle('nav-open');
    $('#alogout').onclick = async () => { await api('POST', '/api/admin/logout').catch(() => {}); location.reload(); };
  }
  document.addEventListener('langchange', () => { if (A.status?.loggedIn) { renderShell(); route(); } else boot(); });
  window.addEventListener('hashchange', route);

  async function refreshBadge() {
    try {
      const s = await api('GET', '/api/admin/stats');
      const b = $('#pendbadge');
      if (b) { b.hidden = !s.pendingRegistrations; b.textContent = s.pendingRegistrations; }
      return s;
    } catch { return null; }
  }
  async function loadDomains() { A.domains = (await api('GET', '/api/admin/domains')).domains; return A.domains; }

  async function route() {
    if (!A.status?.loggedIn) return;
    const [k, ...rest] = (location.hash.slice(2) || 'dashboard').split('/');
    A.view = NAV.some(n => n[0] === k) ? k : 'dashboard';
    document.body.classList.remove('nav-open');
    $$('#anavlist a').forEach(a => a.classList.toggle('on', a.dataset.k === A.view));
    document.title = `${t('admin.nav.' + A.view)} – ${t('admin.title')}`;
    const v = $('#aview');
    v.innerHTML = '<div class="empty"><span class="spinner"></span></div>';
    try {
      await ({ dashboard, mailboxes, random, registrations, domains, settings, admins, audit })[A.view](v, rest);
      applyI18n(v);
    } catch (e) { v.innerHTML = `<div class="alert error">${esc(errText(e))}</div>`; }
    refreshBadge();
  }
  const head = (key, actions = '') => `<div class="ahead"><h1 data-i18n="admin.nav.${key}"></h1>${actions}</div>`;
  const kindBadge = k => `<span class="badge ${{ random: 'amber', registered: 'blue', admin: 'green' }[k] || ''}">${esc(t('kind.' + k))}</span>`;
  const statusBadge = s => `<span class="badge ${{ active: 'green', disabled: 'red', pending_provision: 'amber' }[s] || ''}">${esc(t('status.' + s))}</span>`;
  const domainOptions = (sel, onlyActive = true) => A.domains.filter(d => !onlyActive || d.active).map(d => `<option value="${d.id}" ${Number(sel) === d.id ? 'selected' : ''}>@${esc(d.domain)}</option>`).join('');

  // ---------- Tổng quan ----------
  async function dashboard(v) {
    const s = await api('GET', '/api/admin/stats');
    const kinds = Object.fromEntries(s.byKind.map(x => [x.kind, Number(x.n)]));
    const card = (n, l, href) => `<a class="card stat" href="${href}" style="color:inherit;text-decoration:none"><div class="n">${n}</div><div class="l">${esc(l)}</div></a>`;
    v.innerHTML = head('dashboard') + `
      ${s.provisioner === 'manual' ? `<div class="alert warn" style="margin-bottom:16px">${esc(t('admin.manualModeWarn'))}</div>` : ''}
      <div class="stats">
        ${card(s.mailboxes, t('admin.stat.mailboxes'), '#/mailboxes')}
        ${card(s.pendingRegistrations, t('admin.stat.pending'), '#/registrations')}
        ${card(kinds.random || 0, t('admin.stat.random'), '#/mailboxes?kind=random')}
        ${card(s.activeLinks, t('admin.stat.links'), '#/mailboxes?kind=random')}
        ${card(s.activeSessions, t('admin.stat.sessions'), '#/audit')}
        ${card(s.domains, t('admin.stat.domains'), '#/domains')}
      </div>
      <div class="card" style="margin-bottom:16px"><div class="card-h">${icon('server')}<span data-i18n="admin.system"></span></div><div class="card-b kv">
        <div data-i18n="admin.provisioner"></div><div>${esc(t('prov.' + s.provisioner))}</div>
        <div data-i18n="admin.protocol"></div><div>${esc(s.protocol.toUpperCase())}</div>
        ${s.pendingProvision ? `<div data-i18n="admin.stat.pendingProvision"></div><div><a href="#/mailboxes?status=pending_provision">${s.pendingProvision}</a></div>` : ''}
      </div></div>
      <div class="card"><div class="card-h">${icon('list')}<span data-i18n="admin.recent"></span></div><div class="tablewrap"><table class="grid"><tbody>
        ${s.recent.map(r => `<tr><td class="nowrap muted small">${esc(fmtDate(r.created_at, true))}</td><td>${esc(r.actor)}</td><td><span class="badge">${esc(r.action)}</span></td><td class="mono">${esc(r.target)}</td></tr>`).join('') || `<tr><td class="muted">—</td></tr>`}
      </tbody></table></div></div>`;
  }

  // ---------- Hộp thư ----------
  async function mailboxes(v) {
    await loadDomains();
    const params = new URLSearchParams(location.hash.split('?')[1] || '');
    const st = { q: params.get('q') || '', kind: params.get('kind') || '', status: params.get('status') || '', domainId: params.get('domainId') || '', page: 1 };
    v.innerHTML = head('mailboxes', `<button class="btn" id="msync">${icon('refresh')}<span data-i18n="admin.syncHostinger"></span></button>
      <a class="btn" href="#/random">${icon('dice')}<span data-i18n="admin.nav.random"></span></a>
      <button class="btn primary" id="mnew">${icon('plus')}<span data-i18n="admin.newMailbox"></span></button>`) +
      `<div class="card"><form class="filters" id="mf">
        <input class="input grow" name="q" data-i18n-ph="admin.searchMailbox" value="${esc(st.q)}">
        <select class="input" name="kind"><option value="" data-i18n="admin.allKinds"></option>${['admin', 'registered', 'random', 'external'].map(k => `<option value="${k}" ${st.kind === k ? 'selected' : ''}>${esc(t('kind.' + k))}</option>`).join('')}</select>
        <select class="input" name="status"><option value="" data-i18n="admin.allStatus"></option>${['active', 'disabled', 'pending_provision'].map(k => `<option value="${k}" ${st.status === k ? 'selected' : ''}>${esc(t('status.' + k))}</option>`).join('')}</select>
        <select class="input" name="domainId"><option value="" data-i18n="admin.allDomains"></option>${domainOptions(st.domainId, false)}</select>
      </form><div class="tablewrap" id="mlist"></div></div>`;
    const load = async () => {
      const qs = new URLSearchParams({ ...st });
      const r = await api('GET', '/api/admin/mailboxes?' + qs);
      $('#mlist').innerHTML = `<table class="grid"><thead><tr><th data-i18n="admin.address"></th><th data-i18n="admin.kind"></th><th data-i18n="admin.status"></th><th data-i18n="admin.links"></th><th data-i18n="admin.lastLogin"></th><th data-i18n="admin.created"></th></tr></thead><tbody>
        ${r.mailboxes.map(m => `<tr style="cursor:pointer" data-id="${m.id}"><td><div class="addr">${esc(m.address)}</div>${m.display_name || m.note ? `<div class="muted small">${esc([m.display_name, m.note].filter(Boolean).join(' · '))}</div>` : ''}</td>
          <td>${kindBadge(m.kind)}</td><td>${statusBadge(m.status)}</td><td>${m.links ? `<span class="badge blue">${icon('link')} ${m.links}</span>` : '—'}</td>
          <td class="small muted nowrap">${esc(fmtDate(m.last_login) || '—')}</td><td class="small muted nowrap">${esc(fmtDate(m.created_at))}</td></tr>`).join('') || `<tr><td colspan="6" class="muted" data-i18n="admin.none"></td></tr>`}
        </tbody></table>
        <div class="row" style="padding:10px 12px"><span class="grow muted small">${esc(t('pager', { from: r.total ? (r.page - 1) * r.size + 1 : 0, to: Math.min(r.total, r.page * r.size), total: r.total }))}</span>
        <button class="btn sm" id="mprev" ${r.page <= 1 ? 'disabled' : ''}>${icon('left')}</button><button class="btn sm" id="mnext" ${r.page * r.size >= r.total ? 'disabled' : ''}>${icon('right')}</button></div>`;
      applyI18n($('#mlist'));
      $$('#mlist tr[data-id]').forEach(tr => tr.onclick = () => mailboxDetail(Number(tr.dataset.id), load));
      $('#mprev').onclick = () => { st.page--; load(); };
      $('#mnext').onclick = () => { st.page++; load(); };
    };
    let tm;
    $('#mf').oninput = e => {
      Object.assign(st, Object.fromEntries(new FormData($('#mf'))), { page: 1 });
      clearTimeout(tm); tm = setTimeout(load, e.target.name === 'q' ? 250 : 0);
    };
    $('#mf').onsubmit = e => e.preventDefault();
    $('#mnew').onclick = () => newMailbox(load);
    $('#msync').onclick = async () => {
      try { const r = await api('POST', '/api/admin/mailboxes/sync', {}); toast(t('admin.synced', { n: r.added }), 'ok'); if (r.errors.length) toast(r.errors.join('; '), 'error'); load(); } catch (e) { toast(errText(e), 'error'); }
    };
    await load();
  }

  async function newMailbox(reload) {
    if (!A.domains.length) await loadDomains();
    await modal({
      title: t('admin.newMailbox'),
      body: `<form class="stack" id="nmf">
        <label class="field"><span data-i18n="admin.address"></span><div class="row"><input class="input" name="local" required pattern="[a-z0-9._\\-]+" autocomplete="off" placeholder="john.doe"><select class="input" name="domainId" style="width:auto">${domainOptions()}</select></div></label>
        <label class="field"><span data-i18n="settings.displayName"></span><input class="input" name="displayName"></label>
        <label class="field"><span data-i18n="login.password"></span><div class="row"><input class="input mono" name="password" placeholder="${esc(t('admin.autoGenerate'))}" autocomplete="new-password"><button type="button" class="btn icon" id="gen" title="${esc(t('admin.generate'))}">${icon('dice')}</button></div></label>
        <div class="muted small" data-i18n="password.rules"></div>
        <label class="field"><span data-i18n="admin.note"></span><input class="input" name="note"></label>
        <label class="check"><input type="checkbox" name="keepPassword"><span data-i18n="admin.keepPassword"></span></label>
        <label class="check"><input type="checkbox" name="createLink"><span data-i18n="admin.createLinkToo"></span></label>
      </form>`,
      onOpen: b => { $('#gen', b).onclick = () => { $('[name=password]', b).value = genPassword(); }; },
      buttons: [{ label: t('cancel') }, {
        label: t('admin.create'), cls: 'primary', onClick: async b => {
          const f = $('#nmf', b);
          if (!f.reportValidity()) return false;
          const body = Object.fromEntries(new FormData(f));
          body.keepPassword = f.keepPassword.checked;
          body.createLink = f.createLink.checked;
          if (body.createLink) body.keepPassword = true;
          try {
            const r = await api('POST', '/api/admin/mailboxes', body);
            reload?.();
            showCreated([r]);
          } catch (e) { toast(errText(e), 'error'); return false; }
        },
      }],
    });
  }
  function genPassword() {
    const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#$%^&*-_=+?'];
    const all = sets.join('');
    const r = n => { const a = new Uint32Array(n); crypto.getRandomValues(a); return [...a]; };
    const chars = sets.map(s => s[r(1)[0] % s.length]).concat(r(12).map(x => all[x % all.length]));
    for (let i = chars.length - 1; i > 0; i--) { const j = r(1)[0] % (i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
    return chars.join('');
  }
  function showCreated(list) {
    const items = list.filter(x => !x.error);
    modal({
      title: t('admin.createdTitle', { n: items.length }), wide: true,
      body: `<div class="result-list">${items.map(r => `<div class="result-item stack">
        <div class="row"><b class="grow mono" style="font-size:14px">${esc(r.address)}</b>${statusBadge(r.status)}</div>
        ${r.password ? `<div class="copyline"><span class="muted small nowrap">${esc(t('login.password'))}</span><span class="code">${esc(r.password)}</span><button class="btn sm icon" data-copy="${esc(r.password)}">${icon('copy')}</button></div>` : ''}
        ${r.link ? `<div class="copyline"><span class="muted small nowrap">${icon('link')}</span><span class="code">${esc(r.link.url)}</span><button class="btn sm icon" data-copy="${esc(r.link.url)}">${icon('copy')}</button></div>` : ''}
        ${r.status === 'pending_provision' ? `<div class="alert warn small">${esc(t('admin.manualCreateHint'))}</div>` : ''}
      </div>`).join('')}${list.some(x => x.error) ? `<div class="alert error">${esc(list.find(x => x.error).error)}</div>` : ''}</div>`,
      buttons: [...(items.length > 1 ? [{ label: t('admin.copyAll'), onClick: () => { copy(items.map(r => [r.address, r.link?.url, r.password].filter(Boolean).join('\t')).join('\n')); return false; } }] : []), { label: t('close'), cls: 'primary' }],
      onOpen: b => $$('[data-copy]', b).forEach(x => x.onclick = () => copy(x.dataset.copy)),
    });
  }

  async function mailboxDetail(id, reload) {
    const r = await api('GET', '/api/admin/mailboxes/' + id);
    const m = r.mailbox;
    const linkRow = l => {
      const expired = l.expires_at && new Date(l.expires_at.replace(' ', 'T') + 'Z') < new Date();
      return `<div class="result-item stack" data-link="${l.id}">
        <div class="copyline"><span class="code">${esc(l.url)}</span><button class="btn sm icon" data-copy="${esc(l.url)}">${icon('copy')}</button></div>
        <div class="row wrap small muted">
          ${l.revoked ? `<span class="badge red">${esc(t('link.revoked'))}</span>` : expired ? `<span class="badge red">${esc(t('link.expired'))}</span>` : `<span class="badge green">${esc(t('status.active'))}</span>`}
          <span>${esc(l.can_send ? t('link.canSend') : t('link.readOnlyShort'))}</span>
          <span>· ${esc(l.expires_at ? t('link.expiresOn', { date: fmtDate(l.expires_at, true) }) : t('link.noExpiry'))}</span>
          <span>· ${esc(t('link.used', { n: l.use_count }))}</span>
          <span class="grow"></span>
          <button class="btn sm" data-la="send">${esc(l.can_send ? t('link.makeReadOnly') : t('link.allowSend'))}</button>
          <button class="btn sm" data-la="revoke">${esc(l.revoked ? t('link.restore') : t('link.revoke'))}</button>
          <button class="btn sm danger icon" data-la="delete" title="${esc(t('delete'))}">${icon('trash')}</button>
        </div></div>`;
    };
    await modal({
      title: m.address, wide: true,
      body: `<div class="stack">
        <div class="kv">
          <div data-i18n="admin.kind"></div><div>${kindBadge(m.kind)}</div>
          <div data-i18n="admin.status"></div><div>${statusBadge(m.status)}</div>
          <div data-i18n="settings.displayName"></div><div><input class="input" id="mdname" value="${esc(m.display_name)}"></div>
          <div data-i18n="admin.note"></div><div><input class="input" id="mdnote" value="${esc(m.note)}"></div>
          <div data-i18n="admin.created"></div><div>${esc(fmtDate(m.created_at, true))} · ${esc(m.created_by || '')}</div>
          <div data-i18n="admin.lastLogin"></div><div>${esc(fmtDate(m.last_login, true) || '—')} · ${esc(t('admin.sessionsN', { n: r.sessions }))}</div>
          <div data-i18n="admin.storedPassword"></div><div>${m.has_password ? `<button class="btn sm" id="mdreveal">${icon('eye')}${esc(t('admin.reveal'))}</button> <span class="code" id="mdpw" hidden></span>` : `<span class="muted">${esc(t('admin.notStored'))}</span>`}</div>
        </div>
        ${m.status === 'pending_provision' ? `<div class="alert warn row wrap"><span class="grow">${esc(t('admin.pendingProvisionHint'))}</span><button class="btn sm" id="mdverify">${icon('check')}${esc(t('admin.verify'))}</button></div>` : ''}
        <div class="row wrap">
          <button class="btn" id="mdsave">${icon('check')}${esc(t('save'))}</button>
          <button class="btn" id="mdpass">${icon('key')}${esc(t('admin.resetPassword'))}</button>
          ${m.status !== 'pending_provision' ? `<button class="btn" id="mdstatus">${esc(m.status === 'disabled' ? t('admin.enable') : t('admin.disable'))}</button>` : ''}
          <span class="grow"></span>
          <button class="btn danger" id="mddelete">${icon('trash')}${esc(t('delete'))}</button>
        </div>
        <div class="row" style="margin-top:18px"><b class="grow">${icon('link')} ${esc(t('admin.accessLinks'))}</b>${m.has_password ? `<button class="btn sm primary" id="mdnewlink">${icon('plus')}${esc(t('admin.newLink'))}</button>` : ''}</div>
        ${m.has_password ? '' : `<div class="muted small">${esc(t('admin.linkNeedsPassword'))}</div>`}
        <div class="result-list" id="mdlinks">${r.links.map(linkRow).join('') || `<div class="muted small">${esc(t('admin.noLinks'))}</div>`}</div>
      </div>`,
      onOpen: (b, close) => {
        const again = () => { close(); reload?.(); mailboxDetail(id, reload); };
        $$('[data-copy]', b).forEach(x => x.onclick = () => copy(x.dataset.copy));
        $('#mdreveal', b)?.addEventListener('click', async () => {
          try { const p = await api('POST', `/api/admin/mailboxes/${id}/reveal`, {}); $('#mdpw', b).textContent = p.password; $('#mdpw', b).hidden = false; } catch (e) { toast(errText(e), 'error'); }
        });
        $('#mdsave', b).onclick = async () => { await api('PATCH', '/api/admin/mailboxes/' + id, { displayName: $('#mdname', b).value, note: $('#mdnote', b).value }); toast(t('saved'), 'ok'); reload?.(); };
        $('#mdstatus', b)?.addEventListener('click', async () => { await api('PATCH', '/api/admin/mailboxes/' + id, { status: m.status === 'disabled' ? 'active' : 'disabled' }); again(); });
        $('#mdverify', b)?.addEventListener('click', async () => {
          try { const x = await api('POST', `/api/admin/mailboxes/${id}/verify`, {}); toast(x.ok ? t('admin.verifiedOk') : t('admin.verifiedFail'), x.ok ? 'ok' : 'error'); if (x.ok) again(); } catch (e) { toast(errText(e), 'error'); }
        });
        $('#mdpass', b).onclick = async () => {
          const pw = await modal({
            title: t('admin.resetPassword'),
            body: `<label class="field"><span data-i18n="settings.newPassword"></span><div class="row"><input class="input mono" id="rpw" placeholder="${esc(t('admin.autoGenerate'))}"><button type="button" class="btn icon" id="rgen">${icon('dice')}</button></div></label><div class="muted small" style="margin-top:8px" data-i18n="password.rules"></div>`,
            onOpen: bb => { $('#rgen', bb).onclick = () => { $('#rpw', bb).value = genPassword(); }; },
            buttons: [{ label: t('cancel'), value: null }, { label: t('admin.resetPassword'), cls: 'primary', onClick: bb => ({ password: $('#rpw', bb).value }) }],
          });
          if (!pw) return;
          try {
            const x = await api('POST', `/api/admin/mailboxes/${id}/password`, pw);
            modal({ title: t('admin.passwordChanged'), body: `<div class="copyline"><span class="code">${esc(x.password)}</span><button class="btn sm icon" data-copy="${esc(x.password)}">${icon('copy')}</button></div>${x.providerUpdated ? '' : `<div class="alert warn small" style="margin-top:10px">${esc(t('admin.passwordStoredOnly'))}</div>`}`, buttons: [{ label: t('close'), cls: 'primary' }], onOpen: bb => $$('[data-copy]', bb).forEach(y => y.onclick = () => copy(y.dataset.copy)) });
          } catch (e) { toast(errText(e), 'error'); }
        };
        $('#mddelete', b).onclick = async () => {
          const choice = await modal({
            title: t('admin.deleteMailbox'),
            body: `<p style="margin-top:0">${esc(t('admin.deleteMailboxText', { address: m.address }))}</p><label class="check"><input type="checkbox" id="delremote" ${m.status === 'pending_provision' ? 'disabled' : 'checked'}><span>${esc(t('admin.deleteRemote'))}</span></label>`,
            buttons: [{ label: t('cancel'), value: null }, { label: t('delete'), cls: 'danger solid', onClick: bb => ({ remote: $('#delremote', bb).checked }) }],
          });
          if (!choice) return;
          try { await api('DELETE', `/api/admin/mailboxes/${id}${choice.remote ? '?remote=1' : ''}`); toast(t('admin.deleted'), 'ok'); close(); reload?.(); } catch (e) { toast(errText(e), 'error'); }
        };
        $('#mdnewlink', b)?.addEventListener('click', async () => {
          const o = await linkOptions();
          if (!o) return;
          try { await api('POST', `/api/admin/mailboxes/${id}/links`, o); again(); } catch (e) { toast(errText(e), 'error'); }
        });
        $$('[data-link]', b).forEach(row => $$('[data-la]', row).forEach(btn => btn.onclick = async () => {
          const lid = row.dataset.link;
          const l = r.links.find(x => String(x.id) === lid);
          try {
            if (btn.dataset.la === 'delete') { if (!(await confirmBox(t('link.confirmDelete'), { danger: true, ok: t('delete') }))) return; await api('DELETE', '/api/admin/links/' + lid); }
            if (btn.dataset.la === 'revoke') await api('PATCH', '/api/admin/links/' + lid, { revoked: !l.revoked });
            if (btn.dataset.la === 'send') await api('PATCH', '/api/admin/links/' + lid, { canSend: !l.can_send });
            again();
          } catch (e) { toast(errText(e), 'error'); }
        }));
      },
    });
  }
  function linkOptions() {
    return modal({
      title: t('admin.newLink'),
      body: `<div class="stack"><label class="field"><span data-i18n="admin.expiry"></span><select class="input" id="lexp">${[0, 1, 7, 30, 90, 365].map(d => `<option value="${d}">${esc(d ? t('days', { n: d }) : t('link.noExpiry'))}</option>`).join('')}</select></label>
        <label class="check"><input type="checkbox" id="lsend" checked><span data-i18n="link.canSend"></span></label></div>`,
      buttons: [{ label: t('cancel'), value: null }, { label: t('admin.create'), cls: 'primary', onClick: b => ({ expiresDays: Number($('#lexp', b).value), canSend: $('#lsend', b).checked }) }],
    });
  }

  // ---------- Tạo địa chỉ ngẫu nhiên ----------
  async function random(v) {
    await loadDomains();
    v.innerHTML = head('random') + `<div class="card"><div class="card-b">
      <p class="muted" style="margin-top:0" data-i18n="admin.randomIntro"></p>
      <form class="form-grid" id="rf" style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
        <label class="field"><span data-i18n="admin.domain"></span><select class="input" name="domainId">${domainOptions()}</select></label>
        <label class="field"><span data-i18n="admin.length"></span><input class="input" type="number" name="length" min="4" max="40" value="10" required></label>
        <label class="field"><span data-i18n="admin.charset"></span><select class="input" name="charset">${['alnum', 'letters', 'digits', 'hex'].map(c => `<option value="${c}">${esc(t('charset.' + c))}</option>`).join('')}</select></label>
        <label class="field"><span data-i18n="admin.prefix"></span><input class="input" name="prefix" maxlength="20" pattern="[a-z0-9][a-z0-9._\\-]*" placeholder="${esc(t('optional'))}"></label>
        <label class="field"><span data-i18n="admin.count"></span><input class="input" type="number" name="count" min="1" max="50" value="1"></label>
        <label class="field"><span data-i18n="admin.expiry"></span><select class="input" name="expiresDays">${[0, 1, 7, 30, 90, 365].map(d => `<option value="${d}" ${d === 30 ? 'selected' : ''}>${esc(d ? t('days', { n: d }) : t('link.noExpiry'))}</option>`).join('')}</select></label>
        <label class="field"><span data-i18n="settings.displayName"></span><input class="input" name="displayName" placeholder="${esc(t('optional'))}"></label>
        <label class="field"><span data-i18n="admin.note"></span><input class="input" name="note" placeholder="${esc(t('admin.notePh'))}"></label>
        <label class="check" style="grid-column:1/-1"><input type="checkbox" name="canSend" checked><span data-i18n="link.canSend"></span></label>
        <div style="grid-column:1/-1" class="row"><div class="muted small grow" id="rpreview"></div><button class="btn primary">${icon('dice')}<span data-i18n="admin.generateBtn"></span></button></div>
      </form></div></div>`;
    const f = $('#rf');
    const preview = () => {
      const sets = { alnum: 'abcdefghijklmnopqrstuvwxyz0123456789', letters: 'abcdefghijklmnopqrstuvwxyz', digits: '0123456789', hex: '0123456789abcdef' };
      const s = sets[f.charset.value];
      const n = Math.min(40, Math.max(4, Number(f.length.value) || 10));
      const a = new Uint32Array(n); crypto.getRandomValues(a);
      const d = A.domains.find(x => String(x.id) === f.domainId.value);
      $('#rpreview').textContent = t('admin.example') + ': ' + (f.prefix.value || '') + [...a].map(x => s[x % s.length]).join('') + '@' + (d?.domain || '');
    };
    f.oninput = preview;
    preview();
    f.onsubmit = async e => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(f));
      body.canSend = f.canSend.checked;
      const btn = $('button.primary', f);
      btn.disabled = true;
      try { const r = await api('POST', '/api/admin/mailboxes/random', body); showCreated(r.created); } catch (err) { toast(errText(err), 'error'); }
      btn.disabled = false;
    };
  }

  // ---------- Đơn đăng ký ----------
  async function registrations(v) {
    const status = new URLSearchParams(location.hash.split('?')[1] || '').get('status') || 'pending';
    const r = await api('GET', '/api/admin/registrations?status=' + status);
    v.innerHTML = head('registrations', `<div class="lang-switch">${['pending', 'approved', 'rejected'].map(s => `<button class="${s === status ? 'on' : ''}" data-st="${s}">${esc(t('reg.' + s))}</button>`).join('')}</div>`) +
      `<div class="card tablewrap"><table class="grid"><thead><tr><th data-i18n="admin.address"></th><th data-i18n="reg.applicant"></th><th data-i18n="reg.reason"></th><th data-i18n="admin.created"></th><th></th></tr></thead><tbody>
      ${r.registrations.map(x => `<tr data-id="${x.id}"><td><div class="addr">${esc(x.local_part)}@${esc(x.domain)}</div></td>
        <td>${esc(x.display_name)}<div class="muted small">${esc(x.contact_email || '—')} · ${esc(x.lang.toUpperCase())} · ${esc(x.ip)}</div></td>
        <td class="small" style="max-width:320px">${esc(x.reason || '—')}${x.reject_reason ? `<div class="muted">${esc(t('reg.rejectReason'))}: ${esc(x.reject_reason)}</div>` : ''}</td>
        <td class="small muted nowrap">${esc(fmtDate(x.created_at, true))}${x.decided_at ? `<div>${esc(x.decided_by || '')} · ${esc(fmtDate(x.decided_at))}</div>` : ''}</td>
        <td class="nowrap" style="text-align:right">${x.status === 'pending' ? `<button class="btn sm primary" data-a="approve">${icon('check')}${esc(t('reg.approve'))}</button> <button class="btn sm danger" data-a="reject">${esc(t('reg.reject'))}</button>` : `<button class="btn sm ghost icon" data-a="remove" title="${esc(t('delete'))}">${icon('trash')}</button>`}</td></tr>`).join('') || `<tr><td colspan="5" class="muted" data-i18n="admin.none"></td></tr>`}
      </tbody></table></div>`;
    $$('[data-st]', v).forEach(b => b.onclick = () => { location.hash = '#/registrations?status=' + b.dataset.st; });
    $$('tr[data-id] [data-a]', v).forEach(b => b.onclick = async () => {
      const id = b.closest('tr').dataset.id;
      const x = r.registrations.find(y => String(y.id) === id);
      try {
        if (b.dataset.a === 'approve') {
          if (!(await confirmBox(t('reg.confirmApprove', { address: `${x.local_part}@${x.domain}` }), { ok: t('reg.approve') }))) return;
          const res = await api('POST', `/api/admin/registrations/${id}/approve`, {});
          toast(res.mailbox.status === 'pending_provision' ? t('admin.manualCreateHint') : t('reg.approved'), res.mailbox.status === 'pending_provision' ? '' : 'ok');
        } else if (b.dataset.a === 'reject') {
          const reason = await modal({
            title: t('reg.reject'), body: `<label class="field"><span data-i18n="reg.rejectReason"></span><textarea class="input" id="rr" rows="3" placeholder="${esc(t('optional'))}"></textarea></label>`,
            buttons: [{ label: t('cancel'), value: null }, { label: t('reg.reject'), cls: 'danger solid', onClick: bb => ({ reason: $('#rr', bb).value }) }],
          });
          if (!reason) return;
          await api('POST', `/api/admin/registrations/${id}/reject`, reason);
          toast(t('reg.rejected'), 'ok');
        } else await api('DELETE', '/api/admin/registrations/' + id);
        route();
      } catch (e) { toast(errText(e), 'error'); }
    });
  }

  // ---------- Tên miền ----------
  async function domains(v) {
    await loadDomains();
    const st = await api('GET', '/api/admin/settings');
    let orders = null;
    if (st.provisioner === 'hostinger') { try { orders = (await api('GET', '/api/admin/hostinger/orders')).orders; } catch (e) { orders = { error: errText(e) }; } }
    v.innerHTML = head('domains', `<button class="btn primary" id="dnew">${icon('plus')}<span data-i18n="admin.addDomain"></span></button>`) +
      `<div class="alert" style="margin-bottom:14px">${esc(t('admin.domainsHint'))}</div>
      <div class="card tablewrap"><table class="grid"><thead><tr><th data-i18n="admin.domain"></th><th data-i18n="admin.nav.mailboxes"></th><th data-i18n="admin.allowRegistration"></th><th data-i18n="admin.status"></th><th>Hostinger</th><th></th></tr></thead><tbody>
      ${A.domains.map(d => `<tr data-id="${d.id}"><td class="addr">@${esc(d.domain)}</td><td><a href="#/mailboxes?domainId=${d.id}">${d.mailboxes}</a></td>
        <td><label class="check"><input type="checkbox" data-f="allowRegistration" ${d.allow_registration ? 'checked' : ''}></label></td>
        <td><label class="check"><input type="checkbox" data-f="active" ${d.active ? 'checked' : ''}><span class="small">${esc(t(d.active ? 'status.active' : 'status.disabled'))}</span></label></td>
        <td class="mono small">${esc(d.hostinger_order_id || '—')}</td>
        <td style="text-align:right"><button class="btn sm ghost icon" data-del title="${esc(t('delete'))}">${icon('trash')}</button></td></tr>`).join('') || `<tr><td colspan="6" class="muted" data-i18n="admin.none"></td></tr>`}
      </tbody></table></div>
      ${orders ? `<div class="card" style="margin-top:16px"><div class="card-h">${icon('server')}<span data-i18n="admin.hostingerOrders"></span></div><div class="card-b">${orders.error ? `<div class="alert error">${esc(orders.error)}</div>` :
        `<table class="grid"><thead><tr><th data-i18n="admin.domain"></th><th>Order</th><th data-i18n="admin.status"></th><th>Seats</th><th></th></tr></thead><tbody>${orders.map(o => `<tr><td>${esc(o.domain)}</td><td class="mono small">${esc(o.id)}</td><td>${esc(o.status)}</td><td>${esc(o.seats ?? '')}</td>
          <td style="text-align:right">${A.domains.some(d => d.domain === o.domain) ? '' : `<button class="btn sm" data-addorder="${esc(o.domain)}" data-oid="${esc(o.id)}">${icon('plus')}${esc(t('admin.addDomain'))}</button>`}</td></tr>`).join('') || `<tr><td class="muted" colspan="5" data-i18n="admin.none"></td></tr>`}</tbody></table>`}</div></div>` : ''}`;
    const add = async (domain = '', orderId = '') => {
      const r = await modal({
        title: t('admin.addDomain'),
        body: `<div class="stack"><label class="field"><span data-i18n="admin.domain"></span><input class="input" id="dd" placeholder="example.com" value="${esc(domain)}"></label>
          <label class="field"><span>Hostinger mail order ID</span><input class="input mono" id="doid" value="${esc(orderId)}" placeholder="${esc(t('admin.autoDetect'))}"></label>
          <label class="check"><input type="checkbox" id="dreg"><span data-i18n="admin.allowRegistration"></span></label></div>`,
        buttons: [{ label: t('cancel'), value: null }, { label: t('admin.addDomain'), cls: 'primary', onClick: b => ({ domain: $('#dd', b).value.trim(), hostingerOrderId: $('#doid', b).value.trim(), allowRegistration: $('#dreg', b).checked }) }],
      });
      if (!r) return;
      try { const x = await api('POST', '/api/admin/domains', r); if (x.warning) toast(x.warning === 'no_hostinger_order' ? t('admin.noOrderWarn') : x.warning, 'error'); else toast(t('saved'), 'ok'); route(); } catch (e) { toast(errText(e), 'error'); }
    };
    $('#dnew').onclick = () => add();
    $$('[data-addorder]', v).forEach(b => b.onclick = () => add(b.dataset.addorder, b.dataset.oid));
    $$('tr[data-id]', v).forEach(tr => {
      const id = tr.dataset.id;
      $$('[data-f]', tr).forEach(c => c.onchange = async () => { try { await api('PATCH', '/api/admin/domains/' + id, { [c.dataset.f]: c.checked }); toast(t('saved'), 'ok'); } catch (e) { toast(errText(e), 'error'); } });
      $('[data-del]', tr).onclick = async () => {
        if (!(await confirmBox(t('admin.confirmDeleteDomain'), { danger: true, ok: t('delete') }))) return;
        try { await api('DELETE', '/api/admin/domains/' + id); route(); } catch (e) { toast(errText(e), 'error'); }
      };
    });
  }

  // ---------- Cài đặt ----------
  async function settings(v) {
    const r = await api('GET', '/api/admin/settings');
    const s = r.settings;
    const srv = (k, label) => `<div class="card" style="margin-bottom:14px"><div class="card-h">${esc(label)}</div><div class="card-b form-grid" style="display:grid;grid-template-columns:2fr 1fr 1fr;gap:12px">
      <label class="field"><span data-i18n="settings.server"></span><input class="input" name="${k}.host" value="${esc(s[k].host)}"></label>
      <label class="field"><span>Port</span><input class="input" type="number" name="${k}.port" value="${esc(s[k].port)}"></label>
      <label class="field"><span data-i18n="settings.security"></span><select class="input" name="${k}.secure"><option value="1" ${s[k].secure ? 'selected' : ''}>SSL/TLS</option><option value="0" ${s[k].secure ? '' : 'selected'}>STARTTLS / ${esc(t('admin.none'))}</option></select></label></div></div>`;
    v.innerHTML = head('settings') + `<form id="sf">
      <div class="card" style="margin-bottom:14px"><div class="card-h" data-i18n="admin.general"></div><div class="card-b stack">
        <label class="field"><span data-i18n="admin.appName"></span><input class="input" name="appName" value="${esc(s.appName)}"></label>
        <label class="field"><span data-i18n="admin.receiveProtocol"></span><select class="input" name="protocol"><option value="imap" ${s.protocol === 'imap' ? 'selected' : ''}>IMAP (${esc(t('admin.recommended'))})</option><option value="pop3" ${s.protocol === 'pop3' ? 'selected' : ''}>POP3</option></select></label>
        <div class="muted small" data-i18n="admin.protocolHint"></div>
        <label class="check"><input type="checkbox" name="pop3LeaveCopy" ${s.pop3LeaveCopy ? 'checked' : ''}><span data-i18n="admin.pop3LeaveCopy"></span></label>
        <label class="check"><input type="checkbox" name="registrationOpen" ${s.registrationOpen ? 'checked' : ''}><span data-i18n="admin.registrationOpen"></span></label>
        <label class="field"><span data-i18n="admin.maxUpload"></span><input class="input" type="number" min="1" max="50" name="maxUploadMb" value="${esc(s.maxUploadMb)}" style="max-width:140px"></label>
      </div></div>
      <div class="card" style="margin-bottom:14px"><div class="card-h" data-i18n="admin.demo"></div><div class="card-b stack">
        <div class="muted small" data-i18n="admin.demoHint"></div>
        <label class="check"><input type="checkbox" name="demoEnabled" ${s.demoEnabled ? 'checked' : ''}><span data-i18n="admin.demoEnabled"></span></label>
        <div class="row wrap"><label class="field grow"><span data-i18n="login.email"></span><input class="input" name="demoEmail" type="email" value="${esc(s.demoEmail)}"></label>
        <label class="field grow"><span data-i18n="login.password"></span><input class="input" name="demoPassword" value="${esc(s.demoPassword)}"></label></div>
      </div></div>
      ${srv('imap', 'IMAP')}${srv('pop3', 'POP3')}${srv('smtp', 'SMTP')}
      <div class="card" style="margin-bottom:14px"><div class="card-h" data-i18n="admin.notifications"></div><div class="card-b stack">
        <div class="muted small" data-i18n="admin.notificationsHint"></div>
        <label class="field"><span data-i18n="admin.systemMailbox"></span><select class="input" name="systemMailboxId"><option value="">—</option>${r.systemMailboxes.map(m => `<option value="${m.id}" ${Number(s.systemMailboxId) === m.id ? 'selected' : ''}>${esc(m.address)}</option>`).join('')}</select></label>
        <label class="field"><span data-i18n="admin.notifyEmail"></span><input class="input" type="email" name="notifyEmail" value="${esc(s.notifyEmail)}"></label>
      </div></div>
      <div class="row" style="margin-bottom:22px"><button class="btn primary">${icon('check')}<span data-i18n="save"></span></button><button type="button" class="btn" id="shost">${esc(t('admin.defaultsHostinger'))}</button></div>
    </form>
    <div class="card" style="margin-bottom:14px"><div class="card-h">${icon('server')}<span data-i18n="admin.provisioning"></span></div><div class="card-b kv">
      <div data-i18n="admin.provisioner"></div><div>${esc(t('prov.' + r.provisioner))}</div>
      <div>HOSTINGER_API_TOKEN</div><div>${r.hostingerConfigured ? `<span class="badge green">${esc(t('admin.configured'))}</span>` : `<span class="badge">${esc(t('admin.notConfigured'))}</span>`}</div>
      <div>PUBLIC_URL</div><div class="mono">${esc(r.publicUrl)}</div>
    </div><div class="card-b" style="padding-top:0"><div class="muted small" data-i18n="admin.tokenHint"></div></div></div>
    <div class="card"><div class="card-h">${icon('check')}<span data-i18n="admin.testConnection"></span></div><form class="card-b stack" id="tf">
      <div class="muted small" data-i18n="admin.testHint"></div>
      <div class="row wrap"><input class="input grow" name="address" type="email" data-i18n-ph="login.email" style="min-width:200px"><input class="input grow" name="password" type="password" data-i18n-ph="login.password" style="min-width:160px" autocomplete="off"></div>
      ${r.hostingerConfigured ? `<label class="check"><input type="checkbox" name="hostinger" checked><span data-i18n="admin.testHostinger"></span></label>` : ''}
      <div><button class="btn">${icon('refresh')}<span data-i18n="admin.runTest"></span></button></div>
      <div id="tres"></div></form></div>`;
    const f = $('#sf');
    $('#shost').onclick = () => {
      Object.entries({ 'imap.host': 'imap.hostinger.com', 'imap.port': 993, 'pop3.host': 'pop.hostinger.com', 'pop3.port': 995, 'smtp.host': 'smtp.hostinger.com', 'smtp.port': 465 }).forEach(([k, val]) => { f[k].value = val; });
      ['imap.secure', 'pop3.secure', 'smtp.secure'].forEach(k => { f[k].value = '1'; });
    };
    f.onsubmit = async e => {
      e.preventDefault();
      const g = n => f[n].value;
      const body = {
        appName: g('appName'), protocol: g('protocol'), pop3LeaveCopy: f.pop3LeaveCopy.checked, registrationOpen: f.registrationOpen.checked,
        maxUploadMb: Number(g('maxUploadMb')), demoEnabled: f.demoEnabled.checked, demoEmail: g('demoEmail'), demoPassword: g('demoPassword'), notifyEmail: g('notifyEmail'), systemMailboxId: g('systemMailboxId') || null,
      };
      for (const k of ['imap', 'pop3', 'smtp']) body[k] = { host: g(k + '.host'), port: Number(g(k + '.port')), secure: g(k + '.secure') === '1' };
      try { await api('PUT', '/api/admin/settings', body); toast(t('saved'), 'ok'); } catch (err) { toast(errText(err), 'error'); }
    };
    $('#tf').onsubmit = async e => {
      e.preventDefault();
      const tf = e.target;
      $('#tres').innerHTML = '<span class="spinner"></span>';
      try {
        const x = await api('POST', '/api/admin/settings/test', { address: tf.address.value, password: tf.password.value, hostinger: tf.hostinger?.checked });
        $('#tres').innerHTML = Object.entries(x.results).map(([k, res]) => `<div class="row"><span class="badge ${res.ok ? 'green' : 'red'}">${esc(k.toUpperCase())}</span><span>${esc(res.ok ? t('admin.testOk') : res.error || t('admin.testFail'))}</span><span class="muted small">${res.ms} ms</span></div>`).join('') || `<span class="muted">${esc(t('admin.testNothing'))}</span>`;
      } catch (err) { $('#tres').innerHTML = `<div class="alert error">${esc(errText(err))}</div>`; }
    };
  }

  // ---------- Quản trị viên ----------
  async function admins(v) {
    const r = await api('GET', '/api/admin/admins');
    v.innerHTML = head('admins', `<button class="btn primary" id="anew">${icon('plus')}<span data-i18n="admin.addAdmin"></span></button>`) +
      `<div class="card tablewrap" style="margin-bottom:16px"><table class="grid"><thead><tr><th data-i18n="admin.username"></th><th data-i18n="admin.created"></th><th data-i18n="admin.lastLogin"></th><th></th></tr></thead><tbody>
      ${r.admins.map(a => `<tr><td><b>${esc(a.username)}</b></td><td class="small muted">${esc(fmtDate(a.created_at, true))}</td><td class="small muted">${esc(fmtDate(a.last_login, true) || '—')}</td>
        <td style="text-align:right">${a.username === A.status.username ? `<span class="badge blue">${esc(t('admin.you'))}</span>` : `<button class="btn sm ghost icon" data-del="${a.id}">${icon('trash')}</button>`}</td></tr>`).join('')}</tbody></table></div>
      <div class="card"><div class="card-h">${icon('key')}<span data-i18n="settings.changePassword"></span></div><form class="card-b stack" id="apw" style="max-width:420px">
        <label class="field"><span data-i18n="settings.currentPassword"></span><input class="input" type="password" name="current" required autocomplete="current-password"></label>
        <label class="field"><span data-i18n="settings.newPassword"></span><input class="input" type="password" name="next" required autocomplete="new-password"></label>
        <div class="muted small" data-i18n="password.rules"></div><div><button class="btn primary" data-i18n="settings.changePassword"></button></div></form></div>`;
    $('#anew').onclick = async () => {
      const x = await modal({
        title: t('admin.addAdmin'),
        body: `<div class="stack"><label class="field"><span data-i18n="admin.username"></span><input class="input" id="nau"></label><label class="field"><span data-i18n="login.password"></span><input class="input" type="password" id="nap" autocomplete="new-password"></label><div class="muted small" data-i18n="password.rules"></div></div>`,
        buttons: [{ label: t('cancel'), value: null }, { label: t('admin.create'), cls: 'primary', onClick: b => ({ username: $('#nau', b).value, password: $('#nap', b).value }) }],
      });
      if (!x) return;
      try { await api('POST', '/api/admin/admins', x); route(); } catch (e) { toast(errText(e), 'error'); }
    };
    $$('[data-del]', v).forEach(b => b.onclick = async () => {
      if (!(await confirmBox(t('admin.confirmDeleteAdmin'), { danger: true, ok: t('delete') }))) return;
      try { await api('DELETE', '/api/admin/admins/' + b.dataset.del); route(); } catch (e) { toast(errText(e), 'error'); }
    });
    $('#apw').onsubmit = async e => {
      e.preventDefault();
      try { await api('POST', '/api/admin/password', Object.fromEntries(new FormData(e.target))); toast(t('password.changed'), 'ok'); e.target.reset(); } catch (err) { toast(errText(err), 'error'); }
    };
  }

  // ---------- Nhật ký ----------
  async function audit(v) {
    let page = 1;
    v.innerHTML = head('audit') + '<div class="card tablewrap" id="alist"></div>';
    const load = async () => {
      const r = await api('GET', '/api/admin/audit?page=' + page);
      $('#alist').innerHTML = `<table class="grid"><thead><tr><th data-i18n="admin.time"></th><th data-i18n="admin.actor"></th><th data-i18n="admin.action"></th><th data-i18n="admin.target"></th><th data-i18n="admin.detail"></th><th>IP</th></tr></thead><tbody>
        ${r.entries.map(x => `<tr><td class="nowrap small muted">${esc(fmtDate(x.created_at, true))}</td><td class="small">${esc(x.actor)}</td><td><span class="badge">${esc(x.action)}</span></td><td class="mono">${esc(x.target)}</td><td class="small muted" style="max-width:280px;word-break:break-word">${esc(x.detail)}</td><td class="small muted">${esc(x.ip)}</td></tr>`).join('') || `<tr><td colspan="6" class="muted" data-i18n="admin.none"></td></tr>`}
        </tbody></table><div class="row" style="padding:10px"><span class="grow"></span><button class="btn sm" id="ap" ${page <= 1 ? 'disabled' : ''}>${icon('left')}</button><button class="btn sm" id="an" ${r.entries.length < 100 ? 'disabled' : ''}>${icon('right')}</button></div>`;
      applyI18n($('#alist'));
      $('#ap').onclick = () => { page--; load(); };
      $('#an').onclick = () => { page++; load(); };
    };
    await load();
  }

  boot();
})();
