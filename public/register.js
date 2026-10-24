/* Trang đăng ký địa chỉ email mới (cần admin duyệt). */
(() => {
  const { $, esc, t, api, errText, applyI18n, icon, fmtDate, copy } = WM;
  const app = $('#app');
  let cfg = null;
  const statusToken = new URLSearchParams(location.search).get('status');

  async function boot() {
    try { cfg = await api('GET', '/api/public/config'); } catch (e) {
      app.innerHTML = `<div class="auth-wrap"><div class="alert error">${esc(errText(e))}</div></div>`; return;
    }
    if (statusToken) return renderStatus(statusToken);
    renderForm();
  }
  document.addEventListener('langchange', () => (statusToken ? renderStatus(statusToken) : renderForm(true)));

  const shell = inner => `<div class="auth-wrap"><div class="auth-card wide stack">
    <div class="row"><a class="brand grow" href="/" style="color:inherit;text-decoration:none">${WM.LOGO}<span>${esc(cfg.appName)}</span></a>${WM.langSwitch()}</div>${inner}</div></div>`;

  function renderForm(keep = false) {
    const prev = keep && $('#rf') ? Object.fromEntries(new FormData($('#rf'))) : {};
    document.title = t('reg.title');
    if (!cfg.registrationOpen) {
      app.innerHTML = shell(`<h2 style="margin:0;font-size:20px" data-i18n="reg.title"></h2><div class="alert warn" data-i18n="reg.closed"></div><a class="btn" href="/" data-i18n="reg.backToLogin"></a>`);
      return applyI18n(app);
    }
    app.innerHTML = shell(`<div><h2 style="margin:0 0 4px;font-size:20px" data-i18n="reg.title"></h2><div class="muted" data-i18n="reg.sub"></div></div>
      <form class="stack" id="rf" novalidate>
        <div class="alert error" id="rerr" hidden></div>
        <label class="field"><span data-i18n="reg.address"></span>
          <div class="row"><input class="input" name="local" required maxlength="64" autocomplete="off" placeholder="your.name" value="${esc(prev.local || '')}">
          <select class="input" name="domainId" style="width:auto;max-width:55%">${cfg.domains.map(d => `<option value="${d.id}" ${String(prev.domainId) === String(d.id) ? 'selected' : ''}>@${esc(d.domain)}</option>`).join('')}</select></div>
          <div class="small" id="avail" style="margin-top:4px;min-height:18px"></div></label>
        <label class="field"><span data-i18n="reg.name"></span><input class="input" name="displayName" maxlength="190" required value="${esc(prev.displayName || '')}"></label>
        <div class="row wrap" style="align-items:flex-start">
          <label class="field grow"><span data-i18n="login.password"></span><input class="input" type="password" name="password" required autocomplete="new-password"></label>
          <label class="field grow"><span data-i18n="settings.confirmPassword"></span><input class="input" type="password" name="confirm" required autocomplete="new-password"></label>
        </div>
        <div class="muted small" data-i18n="password.rules"></div>
        <label class="field"><span data-i18n="reg.contactEmail"></span><input class="input" type="email" name="contactEmail" maxlength="254" value="${esc(prev.contactEmail || '')}" placeholder="name@gmail.com"><span class="muted small" style="display:block;margin-top:4px" data-i18n="reg.contactHint"></span></label>
        <label class="field"><span data-i18n="reg.reason"></span><textarea class="input" name="reason" rows="3" maxlength="1000" data-i18n-ph="reg.reasonPh">${esc(prev.reason || '')}</textarea></label>
        <input type="text" name="website" tabindex="-1" autocomplete="off" style="position:absolute;left:-5000px" aria-hidden="true">
        <div class="alert small" data-i18n="reg.approvalNote"></div>
        <button class="btn primary" style="height:40px" data-i18n="reg.submit"></button>
        <div class="small muted" style="text-align:center"><span data-i18n="reg.haveAccount"></span> <a href="/" data-i18n="login.submit"></a></div>
      </form>`);
    applyI18n(app);
    const f = $('#rf');
    let tm;
    const check = () => {
      clearTimeout(tm);
      const local = f.local.value.trim().toLowerCase();
      const out = $('#avail');
      if (!local) { out.textContent = ''; return; }
      tm = setTimeout(async () => {
        try {
          const r = await api('GET', `/api/public/check?local=${encodeURIComponent(local)}&domainId=${f.domainId.value}`);
          out.style.color = r.available ? 'var(--ok)' : 'var(--danger)';
          out.textContent = r.available ? t('reg.available') : t(r.reason === 'invalid' ? 'err.invalid_local_part' : r.reason === 'reserved' ? 'err.reserved_address' : 'err.address_taken');
        } catch { out.textContent = ''; }
      }, 300);
    };
    f.local.addEventListener('input', () => { f.local.value = f.local.value.toLowerCase().replace(/\s/g, ''); check(); });
    f.domainId.addEventListener('change', check);
    f.onsubmit = async e => {
      e.preventDefault();
      const err = $('#rerr');
      err.hidden = true;
      const show = m => { err.textContent = m; err.hidden = false; err.scrollIntoView({ block: 'center', behavior: 'smooth' }); };
      if (!f.local.value || !f.displayName.value.trim()) return show(t('reg.fillRequired'));
      if (f.password.value !== f.confirm.value) return show(t('password.mismatch'));
      const btn = $('button.primary', f);
      btn.disabled = true;
      try {
        const body = Object.fromEntries(new FormData(f));
        delete body.confirm;
        const r = await api('POST', '/api/public/register', { ...body, lang: WM.getLang() });
        history.replaceState(null, '', '/register?status=' + encodeURIComponent(r.token));
        renderDone(r);
      } catch (x) { show(errText(x)); btn.disabled = false; }
    };
  }

  function renderDone(r) {
    const url = `${location.origin}/register?status=${encodeURIComponent(r.token)}`;
    app.innerHTML = shell(`<div class="alert ok row">${icon('check')}<b data-i18n="reg.submitted"></b></div>
      <p style="margin:0">${esc(t('reg.submittedText', { address: r.address }))}</p>
      <div class="field"><span class="muted small" data-i18n="reg.statusLink"></span><div class="copyline" style="margin-top:4px"><span class="code">${esc(url)}</span><button class="btn sm icon" id="cp">${icon('copy')}</button></div></div>
      <a class="btn" href="/" data-i18n="reg.backToLogin"></a>`);
    applyI18n(app);
    $('#cp').onclick = () => copy(url);
  }

  async function renderStatus(token) {
    document.title = t('reg.statusTitle');
    let r;
    try { r = await api('GET', '/api/public/register/status?token=' + encodeURIComponent(token)); } catch (e) {
      app.innerHTML = shell(`<div class="alert error">${esc(errText(e))}</div><a class="btn" href="/register" data-i18n="reg.title"></a>`);
      return applyI18n(app);
    }
    const cls = { pending: 'warn', approved: 'ok', rejected: 'error' }[r.status];
    app.innerHTML = shell(`<h2 style="margin:0;font-size:20px" data-i18n="reg.statusTitle"></h2>
      <div class="code" style="padding:10px;font-size:14px">${esc(r.address)}</div>
      <div class="alert ${cls}"><b>${esc(t('reg.' + r.status))}</b> – ${esc(t('reg.statusText.' + r.status))}${r.reason ? `<div style="margin-top:6px">${esc(t('reg.rejectReason'))}: ${esc(r.reason)}</div>` : ''}</div>
      <div class="muted small">${esc(t('reg.submittedOn', { date: fmtDate(r.createdAt, true) }))}</div>
      <div class="row">${r.status === 'approved' ? `<a class="btn primary" href="/" data-i18n="login.submit"></a>` : `<button class="btn" id="rl">${icon('refresh')}<span data-i18n="refresh"></span></button>`}<a class="btn ghost" href="/" data-i18n="reg.backToLogin"></a></div>`);
    applyI18n(app);
    $('#rl')?.addEventListener('click', () => renderStatus(token));
  }

  boot();
})();
