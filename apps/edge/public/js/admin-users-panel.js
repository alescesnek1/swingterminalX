// ─────────────────────────────────────────────────────────────
// Swing Terminal — admin user management panel + forced password change
//
// The UI for /api/admin-users (native accounts). Loaded as a classic
// <script>; kept out of terminal.js so that file does not grow another
// 400 lines.
//
// Visible only when window.__isAdmin is true. That is a UI convenience,
// NOT the security boundary: the real gate is server-side
// (netlify/functions/admin-users.mjs → isAdmin() over BOT_ADMIN_EMAILS
// plus identity.verified === true). Faking __isAdmin in the console
// reveals nothing — every request still has to pass that check.
//
// Every value that comes back from the server is HTML-escaped before it
// reaches innerHTML: an email is attacker-influenced text once anyone
// can be invited.
//
// Error handling follows CLAUDE.md: every failure shows a specific
// reason in the panel AND is recorded in the central error log, and
// "no users" never renders the same as "the request failed".
//
// window.AdminUsersPanel = { open, close, syncButton, promptForcedPasswordChange }
// ─────────────────────────────────────────────────────────────

(function () {
  const ENDPOINT = '/api/admin-users';
  let _root = null;
  let _stylesInjected = false;

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function report(title, reason, extra) {
    window.ErrorLog?.record({
      level: 'error', kind: 'admin-users', title, reason, endpoint: ENDPOINT, ...(extra || {}),
    });
  }

  function injectStyles() {
    if (_stylesInjected) return;
    _stylesInjected = true;
    const style = document.createElement('style');
    style.textContent = `
      .au-modal{position:fixed;inset:0;z-index:2147482000;display:flex;align-items:flex-start;
        justify-content:center;padding:40px 16px;overflow:auto;background:rgba(0,0,0,.72)}
      .au-modal[hidden]{display:none}
      .au-card{background:var(--bg2,#12151c);border:1px solid var(--bd,#2a2f3a);border-radius:8px;
        width:100%;max-width:1000px;color:var(--txt,#e6e8ee);font-size:13px}
      .au-head{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;
        border-bottom:1px solid var(--bd,#2a2f3a)}
      .au-title{font-weight:700;letter-spacing:.04em}
      .au-close{background:none;border:none;color:var(--txt3,#8b93a7);font-size:22px;cursor:pointer;line-height:1}
      .au-body{padding:16px}
      .au-msg{padding:10px 12px;border-radius:6px;margin-bottom:12px;line-height:1.45}
      .au-msg--err{background:rgba(248,113,113,.12);border:1px solid rgba(248,113,113,.45);color:#fca5a5}
      .au-msg--ok{background:rgba(74,222,128,.12);border:1px solid rgba(74,222,128,.45);color:#86efac}
      .au-msg--warn{background:rgba(250,204,21,.1);border:1px solid rgba(250,204,21,.4);color:#fde68a}
      .au-secret{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:15px;
        background:rgba(0,0,0,.45);padding:8px 10px;border-radius:5px;word-break:break-all;
        display:block;margin:8px 0}
      .au-table{width:100%;border-collapse:collapse;margin-top:6px}
      .au-table th,.au-table td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--bd,#2a2f3a);
        vertical-align:middle}
      .au-table th{color:var(--txt3,#8b93a7);font-weight:600;text-transform:uppercase;font-size:10.5px;
        letter-spacing:.06em}
      .au-pill{display:inline-block;padding:1px 7px;border-radius:10px;font-size:10.5px;font-weight:700}
      .au-pill--active{background:rgba(74,222,128,.16);color:#86efac}
      .au-pill--disabled{background:rgba(248,113,113,.16);color:#fca5a5}
      .au-pill--locked{background:rgba(250,204,21,.16);color:#fde68a}
      .au-pill--admin{background:rgba(96,165,250,.16);color:#93c5fd}
      .au-btn{background:var(--bg3,#1b2029);border:1px solid var(--bd,#2a2f3a);color:var(--txt,#e6e8ee);
        border-radius:5px;padding:4px 9px;font-size:11.5px;cursor:pointer;margin-right:5px}
      .au-btn:hover:not(:disabled){border-color:var(--acc,#60a5fa)}
      .au-btn:disabled{opacity:.5;cursor:default}
      .au-btn--danger:hover:not(:disabled){border-color:#f87171;color:#fca5a5}
      .au-form{display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin:14px 0 4px;
        padding-top:14px;border-top:1px solid var(--bd,#2a2f3a)}
      .au-form label{display:block;color:var(--txt3,#8b93a7);font-size:10.5px;margin-bottom:3px;
        text-transform:uppercase;letter-spacing:.06em}
      .au-form input,.au-form select{background:var(--bg,#0c0f14);border:1px solid var(--bd,#2a2f3a);
        color:var(--txt,#e6e8ee);border-radius:5px;padding:6px 8px;font-size:12.5px;min-width:210px}
      .au-sub{color:var(--txt3,#8b93a7);font-size:11px;margin-top:14px;line-height:1.5}
      .au-audit{margin-top:8px;max-height:170px;overflow:auto;font-size:11px;
        font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--txt2,#aab2c5)}
      .au-audit div{padding:2px 0;border-bottom:1px solid rgba(255,255,255,.04)}
    `;
    document.head.appendChild(style);
  }

  // ── server calls ──
  // Both helpers return a discriminated result so no caller has to guess whether
  // an empty list meant "none" or "it broke".
  async function apiGet() {
    const headers = { Accept: 'application/json', ...(await authHeaders()) };
    let res;
    try {
      res = await fetch(ENDPOINT, { headers });
    } catch (err) {
      report('Could not load users', (err && err.message) || 'network error');
      return { ok: false, reason: 'NETWORK', message: (err && err.message) || 'Network error' };
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.ok) {
      report('Could not load users', body.reason || `HTTP ${res.status}`, { code: res.status });
      return { ok: false, reason: body.reason || `HTTP ${res.status}`, message: body.error || 'Request failed.' };
    }
    return { ok: true, ...body };
  }

  async function apiPost(payload) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json', ...(await authHeaders()) };
    let res;
    try {
      res = await fetch(ENDPOINT, { method: 'POST', headers, body: JSON.stringify(payload) });
    } catch (err) {
      report(`Action ${payload.action} failed`, (err && err.message) || 'network error');
      return { ok: false, reason: 'NETWORK', message: (err && err.message) || 'Network error' };
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.ok) {
      report(`Action ${payload.action} failed`, body.reason || `HTTP ${res.status}`, { code: res.status });
      return { ok: false, reason: body.reason || `HTTP ${res.status}`, message: body.error || 'Request failed.' };
    }
    return { ok: true, ...body };
  }

  async function authHeaders() {
    const token = window.AuthClient ? await window.AuthClient.getAccessToken() : null;
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  // ── rendering ──
  function ensureRoot() {
    injectStyles();
    if (_root && document.body.contains(_root)) return _root;
    _root = document.createElement('div');
    _root.className = 'au-modal';
    _root.hidden = true;
    _root.setAttribute('role', 'dialog');
    _root.setAttribute('aria-label', 'User management');
    document.body.appendChild(_root);
    _root.addEventListener('click', (e) => {
      if (e.target === _root) close();
    });
    return _root;
  }

  function statusPill(user) {
    if (user.status !== 'active') return '<span class="au-pill au-pill--disabled">DISABLED</span>';
    // A lockout is shown here because the LOGIN endpoint deliberately refuses to
    // disclose it (that would let anyone enumerate accounts). This panel is the
    // owner's way to see it.
    if (user.lockedUntil && Date.parse(user.lockedUntil) > Date.now()) {
      return '<span class="au-pill au-pill--locked">LOCKED</span>';
    }
    return '<span class="au-pill au-pill--active">ACTIVE</span>';
  }

  function fmtTime(iso) {
    if (!iso) return '—';
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '—';
    return new Date(t).toISOString().slice(0, 16).replace('T', ' ');
  }

  function renderShell(inner) {
    ensureRoot().innerHTML = `
      <div class="au-card">
        <div class="au-head">
          <div class="au-title">SPRÁVA UŽIVATELŮ</div>
          <button class="au-close" data-au-close aria-label="Zavřít">&times;</button>
        </div>
        <div class="au-body">${inner}</div>
      </div>`;
    _root.querySelector('[data-au-close]')?.addEventListener('click', close);
  }

  function renderLoading() {
    renderShell('<div class="au-sub">Načítám účty…</div>');
  }

  function renderError(result) {
    // Never a blank panel: an error states what failed and why.
    renderShell(`
      <div class="au-msg au-msg--err">
        <strong>Účty se nepodařilo načíst.</strong><br>
        ${esc(result.message || 'Neznámá chyba')} <em>(${esc(result.reason || 'unknown')})</em>
        ${result.reason === 'NATIVE_AUTH_DISABLED'
    ? '<br><br>Nativní auth zatím není zapnutá (NATIVE_AUTH_ENABLED). Účty lze vytvářet i tak.'
    : ''}
        ${result.reason === 'DB_UNAVAILABLE'
    ? '<br><br>Databáze je nedostupná — tohle NENÍ prázdný seznam, ale selhání čtení.'
    : ''}
      </div>
      <button class="au-btn" data-au-retry>Zkusit znovu</button>`);
    _root.querySelector('[data-au-retry]')?.addEventListener('click', refresh);
  }

  function renderData(data, banner) {
    const users = Array.isArray(data.users) ? data.users : [];
    const minLength = data.passwordPolicy?.minLength || 12;

    const rows = users.length
      ? users.map((u) => `
          <tr>
            <td>${esc(u.email)}</td>
            <td>${statusPill(u)}${u.role === 'admin' ? ' <span class="au-pill au-pill--admin">ADMIN</span>' : ''}</td>
            <td>${u.mustChangePassword ? 'ano' : '—'}</td>
            <td>${esc(fmtTime(u.lastLoginAt))}</td>
            <td>${u.failedLoginCount ? esc(u.failedLoginCount) : '—'}</td>
            <td style="white-space:nowrap">
              <button class="au-btn" data-au-reset="${esc(u.id)}" data-au-email="${esc(u.email)}">Reset hesla</button>
              ${u.status === 'active'
    ? `<button class="au-btn au-btn--danger" data-au-disable="${esc(u.id)}" data-au-email="${esc(u.email)}">Zakázat</button>`
    : `<button class="au-btn" data-au-enable="${esc(u.id)}" data-au-email="${esc(u.email)}">Povolit</button>`}
            </td>
          </tr>`).join('')
      // "No accounts" is a real, distinct state — and it is worth spelling out,
      // because it is what the owner sees before the first account exists.
      : '<tr><td colspan="6" class="au-sub">Žádné nativní účty. Vytvoř první níže — klidně teď, ještě před zapnutím NATIVE_AUTH_ENABLED.</td></tr>';

    const auditHtml = data.auditError
      ? `<div class="au-msg au-msg--warn">Historii se nepodařilo načíst (${esc(data.auditError)}) — tohle není „žádná historie".</div>`
      : (Array.isArray(data.audit) && data.audit.length
        ? `<div class="au-audit">${data.audit.map((a) => `<div>${esc(fmtTime(a.ts))} · ${esc(a.action)} · ${esc(a.target_email || '—')}${a.actor_email ? ` · by ${esc(a.actor_email)}` : ''}</div>`).join('')}</div>`
        : '<div class="au-sub">Žádné záznamy.</div>');

    renderShell(`
      ${banner || ''}
      <table class="au-table">
        <thead><tr><th>Email</th><th>Stav</th><th>Musí změnit heslo</th><th>Poslední přihlášení</th><th>Neúspěšné pokusy</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>

      <div class="au-form">
        <div>
          <label for="au-new-email">Nový uživatel — email</label>
          <input type="email" id="au-new-email" placeholder="user@example.com" autocomplete="off">
        </div>
        <div>
          <label for="au-new-role">Role</label>
          <select id="au-new-role">
            <option value="user">user</option>
            <option value="admin">admin (jen popisek)</option>
          </select>
        </div>
        <button class="au-btn" data-au-create>Vytvořit účet</button>
      </div>
      <div class="au-sub">
        Heslo se vygeneruje a zobrazí <strong>jednou</strong> — neukládá se v čitelné podobě a nejde obnovit.
        Uživatel si ho musí při prvním přihlášení změnit (minimálně ${esc(minLength)} znaků).<br>
        Role <code>admin</code> je jen popisek — skutečná admin práva dává výhradně <code>BOT_ADMIN_EMAILS</code> v Netlify.<br>
        Zakázání účtu i reset hesla ukončí přihlášení do ${'≈'}1 hodiny (při dalším obnovení tokenu). Okamžitě to udělá jen rotace <code>AUTH_JWT_SECRET</code>.
      </div>

      <div class="au-sub"><strong>Poslední akce</strong></div>
      ${auditHtml}`);

    wireActions();
  }

  function wireActions() {
    _root.querySelector('[data-au-create]')?.addEventListener('click', async (e) => {
      const email = _root.querySelector('#au-new-email')?.value.trim();
      const role = _root.querySelector('#au-new-role')?.value;
      if (!email) return;
      e.target.disabled = true;
      const result = await apiPost({ action: 'create', email, role });
      await afterAction(result, `Účet ${email} vytvořen.`);
    });

    for (const [attr, action, confirmText] of [
      ['data-au-reset', 'reset-password', 'Resetovat heslo pro'],
      ['data-au-disable', 'disable', 'Zakázat účet'],
      ['data-au-enable', 'enable', null],
    ]) {
      _root.querySelectorAll(`[${attr}]`).forEach((btn) => {
        btn.addEventListener('click', async () => {
          const userId = btn.getAttribute(attr);
          const email = btn.getAttribute('data-au-email') || '';
          if (confirmText && !confirm(`${confirmText} ${email}?`)) return;
          btn.disabled = true;
          const result = await apiPost({ action, userId });
          await afterAction(result, `${action} — ${email}: hotovo.`);
        });
      });
    }
  }

  async function afterAction(result, successText) {
    if (!result.ok) {
      // Re-render with the list intact plus a specific, visible reason.
      const data = await apiGet();
      const banner = `<div class="au-msg au-msg--err">${esc(result.message || 'Akce se nepovedla')} <em>(${esc(result.reason)})</em></div>`;
      if (data.ok) renderData(data, banner);
      else renderError(result);
      return;
    }

    let banner = `<div class="au-msg au-msg--ok">${esc(successText)}</div>`;
    if (result.generatedPassword) {
      // Shown exactly once. Never logged, never re-fetchable.
      banner = `
        <div class="au-msg au-msg--warn">
          <strong>Zkopíruj heslo teď — zobrazí se jen jednou.</strong>
          <code class="au-secret">${esc(result.generatedPassword)}</code>
          <button class="au-btn" data-au-copy>Kopírovat</button>
          ${esc(result.notice || '')}
        </div>`;
    }
    const data = await apiGet();
    if (data.ok) renderData(data, banner);
    else renderError(data);

    _root.querySelector('[data-au-copy]')?.addEventListener('click', async (e) => {
      try {
        await navigator.clipboard.writeText(result.generatedPassword);
        e.target.textContent = 'Zkopírováno';
      } catch (err) {
        // Clipboard can be blocked by permissions — say so instead of looking dead.
        e.target.textContent = 'Nelze zkopírovat — vyber ručně';
        console.warn('[ADMIN_USERS] clipboard write failed', { name: err && err.name });
      }
    });
  }

  async function refresh() {
    renderLoading();
    const data = await apiGet();
    if (data.ok) renderData(data);
    else renderError(data);
  }

  // ── public ──
  function open() {
    ensureRoot().hidden = false;
    refresh();
  }

  function close() {
    if (_root) _root.hidden = true;
  }

  function syncButton() {
    const btn = document.getElementById('admin-users-btn');
    if (btn) btn.hidden = window.__isAdmin !== true;
  }

  /**
   * Blocking-ish prompt for a user whose account still has
   * must_change_password set. Uses the same modal shell.
   */
  function promptForcedPasswordChange() {
    injectStyles();
    ensureRoot().hidden = false;
    renderShell(`
      <div class="au-msg au-msg--warn">
        Tvoje heslo nastavil administrátor, takže ho zná. Než budeš pokračovat, nastav si vlastní.
      </div>
      <div id="au-pw-error"></div>
      <div class="au-form" style="border-top:none;padding-top:0">
        <div>
          <label for="au-pw-current">Současné heslo</label>
          <input type="password" id="au-pw-current" autocomplete="current-password">
        </div>
        <div>
          <label for="au-pw-new">Nové heslo</label>
          <input type="password" id="au-pw-new" autocomplete="new-password">
        </div>
        <button class="au-btn" data-au-pw-save>Změnit heslo</button>
      </div>
      <div class="au-sub">Minimálně 12 znaků. Ostatní přihlášení tohoto účtu skončí při dalším obnovení tokenu.</div>`);

    // No close button on this one: the point is that it must be dealt with.
    _root.querySelector('[data-au-close]')?.remove();

    _root.querySelector('[data-au-pw-save]')?.addEventListener('click', async (e) => {
      const current = _root.querySelector('#au-pw-current')?.value || '';
      const next = _root.querySelector('#au-pw-new')?.value || '';
      const errBox = _root.querySelector('#au-pw-error');
      e.target.disabled = true;

      const result = await window.AuthClient.changePassword(current, next);
      if (!result.ok) {
        errBox.innerHTML = `<div class="au-msg au-msg--err">${esc(result.message || 'Nepovedlo se')} <em>(${esc(result.reason)})</em></div>`;
        e.target.disabled = false;
        report('Password change failed', result.reason || 'unknown', { endpoint: '/api/auth-change-password' });
        return;
      }
      close();
      window.Toast?.success('Heslo změněno', result.reSignInRequired
        ? 'Přihlas se prosím znovu novým heslem.'
        : 'Hotovo.');
    });
  }

  window.AdminUsersPanel = { open, close, syncButton, promptForcedPasswordChange };
})();
