/* Lilac CRM — single page app */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const content = $('#content');

  const STATUSES = ['open', 'in-progress', 'resolved', 'closed'];
  const STATUS_LABELS = {
    open: 'Open',
    'in-progress': 'In progress',
    resolved: 'Resolved',
    closed: 'Closed',
  };

  let currentUser = null;
  let appConfig = null; // { meetScriptUrl } — where the OpenVidu Meet webcomponent lives
  let meetScriptPromise = null;
  let issueFilter = 'all';
  let meetingView = 'calendar'; // 'calendar' | 'list'
  let calendarCursor = startOfMonth(new Date());

  // ------------------------------------------------------------------ api ---

  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && currentUser) {
      currentUser = null;
      showAuth();
      throw new Error('Session expired, please sign in again');
    }
    if (!res.ok) {
      let message = `Request failed (${res.status})`;
      try {
        const data = await res.json();
        if (data.error) message = data.error;
      } catch { /* non-JSON error body */ }
      throw new Error(message);
    }
    return res.status === 204 ? null : res.json();
  }

  // -------------------------------------------------------------- helpers ---

  function esc(value) {
    const div = document.createElement('div');
    div.textContent = value == null ? '' : String(value);
    return div.innerHTML;
  }

  function toast(message, isError = false) {
    const el = $('#toast');
    el.textContent = message;
    el.className = `toast${isError ? ' toast-error' : ''}`;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.classList.add('hidden'), 3200);
  }

  function fmtDate(iso) {
    return new Date(iso).toLocaleDateString(undefined, {
      day: 'numeric', month: 'short', year: 'numeric',
    });
  }

  function fmtDateTime(iso) {
    return new Date(iso).toLocaleString(undefined, {
      day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }

  function toLocalInputValue(iso) {
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function startOfMonth(d) {
    return new Date(d.getFullYear(), d.getMonth(), 1);
  }

  function statusBadge(status) {
    return `<span class="badge badge-${esc(status)}">${esc(STATUS_LABELS[status] || status)}</span>`;
  }

  // ---------------------------------------------------------------- modal ---

  function openModal(title, bodyHtml, onMount) {
    $('#modal-title').textContent = title;
    $('#modal-body').innerHTML = bodyHtml;
    $('#modal-backdrop').classList.remove('hidden');
    if (onMount) onMount($('#modal-body'));
  }

  function closeModal() {
    $('#modal-backdrop').classList.add('hidden');
    $('#modal-body').innerHTML = '';
  }

  $('#modal-close').addEventListener('click', closeModal);
  $('#modal-backdrop').addEventListener('click', (e) => {
    if (e.target === $('#modal-backdrop')) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });

  // Wire a modal form: collects field values by [name], calls submit(values).
  function bindForm(root, submit) {
    const form = $('form', root);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const values = {};
      for (const el of form.querySelectorAll('[name]')) values[el.name] = el.value;
      const errorEl = $('.form-error', form);
      try {
        await submit(values);
      } catch (err) {
        if (errorEl) {
          errorEl.textContent = err.message;
          errorEl.classList.remove('hidden');
        } else {
          toast(err.message, true);
        }
      }
    });
  }

  // ----------------------------------------------------------------- auth ---

  let authMode = 'login';

  function showAuth() {
    $('#app').classList.add('hidden');
    $('#auth-screen').classList.remove('hidden');
    renderAuthMode();
  }

  function renderAuthMode() {
    const isLogin = authMode === 'login';
    $('#auth-name-field').classList.toggle('hidden', isLogin);
    $('#auth-name').required = !isLogin;
    $('#auth-subtitle').textContent = isLogin
      ? 'Sign in to manage your clients, issues and meetings'
      : 'Create your account — it only takes a minute';
    $('#auth-submit').textContent = isLogin ? 'Sign in' : 'Create account';
    $('#auth-switch-text').textContent = isLogin ? 'New here?' : 'Already have an account?';
    $('#auth-switch-link').textContent = isLogin ? 'Create an account' : 'Sign in';
    $('#auth-error').classList.add('hidden');
  }

  $('#auth-switch-link').addEventListener('click', (e) => {
    e.preventDefault();
    authMode = authMode === 'login' ? 'register' : 'login';
    renderAuthMode();
  });

  $('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = $('#auth-error');
    errorEl.classList.add('hidden');
    try {
      const payload = {
        email: $('#auth-email').value.trim(),
        password: $('#auth-password').value,
      };
      if (authMode === 'register') payload.name = $('#auth-name').value.trim();
      currentUser = await api('POST', authMode === 'login' ? '/api/login' : '/api/register', payload);
      $('#auth-form').reset();
      showApp();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.remove('hidden');
    }
  });

  $('#logout-btn').addEventListener('click', async () => {
    await api('POST', '/api/logout');
    currentUser = null;
    location.hash = '#/clients';
    showAuth();
  });

  // ------------------------------------------------------------ app shell ---

  function showApp() {
    $('#auth-screen').classList.add('hidden');
    $('#app').classList.remove('hidden');
    $('#sidebar-user').innerHTML = `<strong>${esc(currentUser.name)}</strong>${esc(currentUser.email)}`;
    if (!appConfig) {
      api('GET', '/api/config')
        .then((cfg) => { appConfig = cfg; })
        .catch(() => { /* video features stay disabled */ });
    }
    if (!location.hash || location.hash === '#') location.hash = '#/clients';
    route();
  }

  // Load the OpenVidu Meet webcomponent bundle from the deployment (once).
  function loadMeetScript() {
    if (!appConfig || !appConfig.meetScriptUrl) {
      return Promise.reject(new Error('OpenVidu Meet is not configured'));
    }
    if (!meetScriptPromise) {
      meetScriptPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = appConfig.meetScriptUrl;
        script.onload = resolve;
        script.onerror = () => {
          meetScriptPromise = null;
          reject(new Error('Could not load OpenVidu Meet — is the deployment running?'));
        };
        document.head.appendChild(script);
      });
    }
    return meetScriptPromise;
  }

  function route() {
    if (!currentUser) return;
    const hash = location.hash || '#/clients';
    const [, section, id] = hash.replace('#/', '').split('/').length
      ? [null, ...hash.replace('#/', '').split('/')]
      : [null, 'clients'];

    for (const link of document.querySelectorAll('[data-nav]')) {
      link.classList.toggle('active', link.dataset.nav === section);
    }

    const views = {
      clients: id ? () => renderClientDetail(id) : renderClients,
      issues: id ? () => renderIssueDetail(id) : renderIssues,
      meetings: renderMeetings,
      profile: renderProfile,
    };
    (views[section] || renderClients)().catch((err) => toast(err.message, true));
  }

  window.addEventListener('hashchange', route);

  // --------------------------------------------------------------- clients ---

  async function renderClients() {
    const clients = await api('GET', '/api/clients');
    content.innerHTML = `
      <div class="page-header">
        <div>
          <h1>Clients</h1>
          <p class="page-sub">${clients.length} compan${clients.length === 1 ? 'y' : 'ies'} in your portfolio</p>
        </div>
        <div class="page-actions">
          <button class="btn btn-primary" id="add-client">+ Add client</button>
        </div>
      </div>
      ${clients.length === 0
        ? `<div class="empty-state"><span class="empty-icon">🏢</span>No clients yet. Add your first client to get started.</div>`
        : `<div class="card-grid">${clients.map(clientCard).join('')}</div>`}
    `;
    $('#add-client').addEventListener('click', () => clientFormModal());
    for (const card of content.querySelectorAll('[data-client]')) {
      card.addEventListener('click', () => (location.hash = `#/clients/${card.dataset.client}`));
    }
  }

  function clientCard(c) {
    return `
      <div class="card clickable" data-client="${esc(c.id)}">
        <div class="card-top">
          <div>
            <h3>${esc(c.companyName)}</h3>
            <div class="card-sub">${esc(c.contactName) || 'No contact person'}</div>
          </div>
        </div>
        <div class="card-body">
          ${c.contactEmail ? `✉️ ${esc(c.contactEmail)}<br>` : ''}
          ${c.contactPhone ? `📞 ${esc(c.contactPhone)}` : ''}
        </div>
        <div class="card-meta">
          <span class="badge badge-count">${c.issueCount} issue${c.issueCount === 1 ? '' : 's'}</span>
          ${c.openIssueCount ? `<span class="badge badge-open">${c.openIssueCount} active</span>` : ''}
        </div>
      </div>
    `;
  }

  function clientFormModal(client) {
    const isEdit = Boolean(client);
    client = client || {};
    openModal(isEdit ? 'Edit client' : 'Add client', `
      <form>
        <div class="field">
          <label>Company name *</label>
          <input name="companyName" required value="${esc(client.companyName || '')}" placeholder="Acme Corp" />
        </div>
        <div class="field">
          <label>Contact person</label>
          <input name="contactName" value="${esc(client.contactName || '')}" placeholder="Jane Doe" />
        </div>
        <div class="field-row">
          <div class="field">
            <label>Contact email</label>
            <input name="contactEmail" type="email" value="${esc(client.contactEmail || '')}" placeholder="jane@acme.com" />
          </div>
          <div class="field">
            <label>Phone</label>
            <input name="contactPhone" value="${esc(client.contactPhone || '')}" placeholder="+34 600 000 000" />
          </div>
        </div>
        <div class="field">
          <label>Address</label>
          <input name="address" value="${esc(client.address || '')}" placeholder="123 Main St" />
        </div>
        <div class="field">
          <label>Notes</label>
          <textarea name="notes" placeholder="Anything worth remembering…">${esc(client.notes || '')}</textarea>
        </div>
        <p class="form-error hidden"></p>
        <div class="form-actions">
          <button type="button" class="btn btn-ghost" data-cancel>Cancel</button>
          <button type="submit" class="btn btn-primary">${isEdit ? 'Save changes' : 'Add client'}</button>
        </div>
      </form>
    `, (body) => {
      $('[data-cancel]', body).addEventListener('click', closeModal);
      bindForm(body, async (values) => {
        if (isEdit) {
          await api('PUT', `/api/clients/${client.id}`, values);
          toast('Client updated');
        } else {
          await api('POST', '/api/clients', values);
          toast('Client added');
        }
        closeModal();
        route();
      });
    });
  }

  async function renderClientDetail(id) {
    const client = await api('GET', `/api/clients/${id}`);
    const pastStatuses = ['resolved', 'closed'];
    const present = client.issues.filter((i) => !pastStatuses.includes(i.status));
    const past = client.issues.filter((i) => pastStatuses.includes(i.status));

    content.innerHTML = `
      <a class="back-link" href="#/clients">← All clients</a>
      <div class="page-header">
        <div>
          <h1>${esc(client.companyName)}</h1>
          <p class="page-sub">Client since ${fmtDate(client.createdAt)}</p>
        </div>
        <div class="page-actions">
          <button class="btn btn-secondary" id="edit-client">Edit</button>
          <button class="btn btn-danger" id="delete-client">Delete</button>
        </div>
      </div>
      <div class="detail-grid">
        <div class="detail-panel">
          <h3>Contact details</h3>
          <ul class="detail-list">
            <li><span class="dt">Contact</span><span class="dd">${esc(client.contactName) || '—'}</span></li>
            <li><span class="dt">Email</span><span class="dd">${esc(client.contactEmail) || '—'}</span></li>
            <li><span class="dt">Phone</span><span class="dd">${esc(client.contactPhone) || '—'}</span></li>
            <li><span class="dt">Address</span><span class="dd">${esc(client.address) || '—'}</span></li>
            ${client.meetRoom ? `<li><span class="dt">Meeting room</span><span class="dd">🎥 ${esc(client.meetRoom.roomName)}</span></li>` : ''}
          </ul>
        </div>
        <div class="detail-panel">
          <h3>Notes</h3>
          <p style="font-size:14px; color:var(--ink-600); white-space:pre-wrap;">${esc(client.notes) || 'No notes yet.'}</p>
        </div>
      </div>
      <div class="section-header">
        <h2>Present issues (${present.length})</h2>
        <button class="btn btn-primary btn-small" id="add-issue-for-client">+ New issue</button>
      </div>
      ${present.length === 0
        ? `<div class="empty-state">No active issues — all clear! 🎉</div>`
        : `<div class="card-grid">${present.map(issueCard).join('')}</div>`}
      <div class="section-header"><h2>Past issues (${past.length})</h2></div>
      ${past.length === 0
        ? `<div class="empty-state">No resolved or closed issues yet.</div>`
        : `<div class="card-grid">${past.map(issueCard).join('')}</div>`}
    `;

    $('#edit-client').addEventListener('click', () => clientFormModal(client));
    $('#delete-client').addEventListener('click', () => {
      if (confirm(`Delete ${client.companyName} and all its issues and meetings?`)) {
        api('DELETE', `/api/clients/${id}`)
          .then(() => { toast('Client deleted'); location.hash = '#/clients'; })
          .catch((err) => toast(err.message, true));
      }
    });
    $('#add-issue-for-client').addEventListener('click', () => issueFormModal(null, client.id));
    bindIssueCards();
  }

  // ---------------------------------------------------------------- issues ---

  function issueCard(issue) {
    return `
      <div class="card clickable" data-issue="${esc(issue.id)}">
        <div class="card-top">
          <h3>${esc(issue.title)}</h3>
          ${statusBadge(issue.status)}
        </div>
        <div class="card-sub">${esc(issue.clientName) || 'Unknown client'}</div>
        ${issue.description ? `<div class="card-body">${esc(issue.description.length > 110 ? issue.description.slice(0, 110) + '…' : issue.description)}</div>` : ''}
        <div class="card-meta">
          <span class="badge badge-count">👤 ${esc(issue.assigneeName) || 'Unassigned'}</span>
          <span class="badge badge-count">📅 ${issue.meetingCount} meeting${issue.meetingCount === 1 ? '' : 's'}</span>
        </div>
      </div>
    `;
  }

  function bindIssueCards() {
    for (const card of content.querySelectorAll('[data-issue]')) {
      card.addEventListener('click', () => (location.hash = `#/issues/${card.dataset.issue}`));
    }
  }

  async function renderIssues() {
    const issues = await api('GET', '/api/issues');
    const filtered = issueFilter === 'all' ? issues : issues.filter((i) => i.status === issueFilter);

    content.innerHTML = `
      <div class="page-header">
        <div>
          <h1>Issues</h1>
          <p class="page-sub">${issues.length} issue${issues.length === 1 ? '' : 's'} across all clients</p>
        </div>
        <div class="page-actions">
          <button class="btn btn-primary" id="add-issue">+ New issue</button>
        </div>
      </div>
      <div class="filter-bar">
        ${['all', ...STATUSES].map((s) => `
          <button class="chip${issueFilter === s ? ' active' : ''}" data-filter="${s}">
            ${s === 'all' ? 'All' : STATUS_LABELS[s]}
          </button>`).join('')}
      </div>
      ${filtered.length === 0
        ? `<div class="empty-state"><span class="empty-icon">🎯</span>No ${issueFilter === 'all' ? '' : STATUS_LABELS[issueFilter].toLowerCase() + ' '}issues found.</div>`
        : `<div class="card-grid">${filtered.map(issueCard).join('')}</div>`}
    `;

    $('#add-issue').addEventListener('click', () => issueFormModal());
    for (const chip of content.querySelectorAll('[data-filter]')) {
      chip.addEventListener('click', () => {
        issueFilter = chip.dataset.filter;
        renderIssues();
      });
    }
    bindIssueCards();
  }

  async function issueFormModal(issue, presetClientId) {
    const [clients, users] = await Promise.all([
      api('GET', '/api/clients'),
      api('GET', '/api/users'),
    ]);
    if (clients.length === 0) {
      toast('Add a client first — issues belong to a client.', true);
      return;
    }
    const isEdit = Boolean(issue);
    issue = issue || {};
    const selectedClient = issue.clientId || presetClientId || '';
    const selectedAssignee = isEdit ? issue.assigneeId : currentUser.id;

    openModal(isEdit ? 'Edit issue' : 'New issue', `
      <form>
        <div class="field">
          <label>Title *</label>
          <input name="title" required value="${esc(issue.title || '')}" placeholder="What is the client facing?" />
        </div>
        <div class="field">
          <label>Description</label>
          <textarea name="description" placeholder="Describe the problem…">${esc(issue.description || '')}</textarea>
        </div>
        <div class="field-row">
          <div class="field">
            <label>Client *</label>
            <select name="clientId" required>
              <option value="" disabled ${selectedClient ? '' : 'selected'}>Select a client</option>
              ${clients.map((c) => `<option value="${esc(c.id)}" ${c.id === selectedClient ? 'selected' : ''}>${esc(c.companyName)}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label>Assigned to</label>
            <select name="assigneeId">
              ${users.map((u) => `<option value="${esc(u.id)}" ${u.id === selectedAssignee ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="field">
          <label>Status</label>
          <select name="status">
            ${STATUSES.map((s) => `<option value="${s}" ${(issue.status || 'open') === s ? 'selected' : ''}>${STATUS_LABELS[s]}</option>`).join('')}
          </select>
        </div>
        <p class="form-error hidden"></p>
        <div class="form-actions">
          <button type="button" class="btn btn-ghost" data-cancel>Cancel</button>
          <button type="submit" class="btn btn-primary">${isEdit ? 'Save changes' : 'Create issue'}</button>
        </div>
      </form>
    `, (body) => {
      $('[data-cancel]', body).addEventListener('click', closeModal);
      bindForm(body, async (values) => {
        if (isEdit) {
          await api('PUT', `/api/issues/${issue.id}`, values);
          toast('Issue updated');
        } else {
          await api('POST', '/api/issues', values);
          toast('Issue created');
        }
        closeModal();
        route();
      });
    });
  }

  async function renderIssueDetail(id) {
    const issue = await api('GET', `/api/issues/${id}`);
    const now = Date.now();
    const planned = issue.meetings.filter((m) => new Date(m.date).getTime() >= now);
    const past = issue.meetings.filter((m) => new Date(m.date).getTime() < now).reverse();

    content.innerHTML = `
      <a class="back-link" href="#/issues">← All issues</a>
      <div class="page-header">
        <div>
          <h1>${esc(issue.title)}</h1>
          <p class="page-sub">Opened ${fmtDate(issue.createdAt)} · <a href="#/clients/${esc(issue.clientId)}">${esc(issue.clientName)}</a></p>
        </div>
        <div class="page-actions">
          ${statusBadge(issue.status)}
          <button class="btn btn-secondary" id="edit-issue">Edit</button>
          <button class="btn btn-danger" id="delete-issue">Delete</button>
        </div>
      </div>
      <div class="detail-grid">
        <div class="detail-panel">
          <h3>Details</h3>
          <ul class="detail-list">
            <li><span class="dt">Client</span><span class="dd"><a href="#/clients/${esc(issue.clientId)}">${esc(issue.clientName)}</a></span></li>
            <li><span class="dt">Assigned to</span><span class="dd">${esc(issue.assigneeName) || 'Unassigned'}</span></li>
            <li><span class="dt">Status</span><span class="dd">${statusBadge(issue.status)}</span></li>
          </ul>
        </div>
        <div class="detail-panel">
          <h3>Description</h3>
          <p style="font-size:14px; color:var(--ink-600); white-space:pre-wrap;">${esc(issue.description) || 'No description.'}</p>
        </div>
      </div>
      <div class="section-header">
        <h2>Planned meetings (${planned.length})</h2>
        <button class="btn btn-primary btn-small" id="add-meeting">+ Schedule meeting</button>
      </div>
      <div class="detail-panel full">
        ${planned.length === 0
          ? '<p style="color:var(--ink-400); font-size:14px;">No meetings planned.</p>'
          : planned.map((m) => meetingRow(m, false)).join('')}
      </div>
      <div class="section-header"><h2>Past meetings (${past.length})</h2></div>
      <div class="detail-panel full">
        ${past.length === 0
          ? '<p style="color:var(--ink-400); font-size:14px;">No past meetings.</p>'
          : past.map((m) => meetingRow(m, true)).join('')}
      </div>
    `;

    $('#edit-issue').addEventListener('click', () => issueFormModal(issue));
    $('#delete-issue').addEventListener('click', () => {
      if (confirm(`Delete issue "${issue.title}" and its meetings?`)) {
        api('DELETE', `/api/issues/${id}`)
          .then(() => { toast('Issue deleted'); location.hash = '#/issues'; })
          .catch((err) => toast(err.message, true));
      }
    });
    $('#add-meeting').addEventListener('click', () => meetingFormModal(null, issue.id));
    bindMeetingActions(issue.meetings, { title: `${issue.clientName} — ${issue.title}` });
  }

  // --------------------------------------------------------------- meetings ---

  function meetingParticipant(m, kind) {
    return (m.participants || []).find((p) => p.kind === kind);
  }

  function meetingRow(m, isPast) {
    const canJoin = Boolean(meetingParticipant(m, 'user'));
    const clientLink = meetingParticipant(m, 'client');
    return `
      <div class="meeting-row" data-meeting="${esc(m.id)}">
        <div class="meeting-date">${fmtDateTime(m.date)}</div>
        <div class="meeting-info">
          ${m.issueTitle ? `<div class="meeting-context">${esc(m.clientName)} · ${esc(m.issueTitle)}</div>` : ''}
          <div class="meeting-resume">${esc(m.resume) || (isPast ? '<em>No summary registered yet</em>' : 'Online meeting — join from here when it starts')}</div>
          ${m.meetError ? `<div class="meeting-context" style="color:var(--red);">⚠ No video room: ${esc(m.meetError)}</div>` : ''}
        </div>
        <div class="meeting-actions">
          ${canJoin && !isPast ? `<button class="btn btn-primary btn-small" data-join-meeting="${esc(m.id)}">▶ Join</button>` : ''}
          ${clientLink && !isPast ? `<button class="btn btn-secondary btn-small" title="Copy the client's personal meeting link" data-copy-client-link="${esc(m.id)}">🔗 Client link</button>` : ''}
          <button class="btn btn-secondary btn-small" data-edit-meeting="${esc(m.id)}">${isPast && !m.resume ? 'Add summary' : 'Edit'}</button>
          <button class="btn btn-danger btn-small" data-delete-meeting="${esc(m.id)}">Delete</button>
        </div>
      </div>
    `;
  }

  // Wire join/copy/edit/delete buttons for the meeting rows currently in the
  // DOM. `meetings` is the list to resolve ids against; `context` provides
  // client/issue names when the meetings themselves aren't decorated.
  function bindMeetingActions(meetings, context) {
    for (const btn of content.querySelectorAll('[data-join-meeting]')) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        joinMeeting(meetings.find((m) => m.id === btn.dataset.joinMeeting), context);
      });
    }
    for (const btn of content.querySelectorAll('[data-copy-client-link]')) {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const meeting = meetings.find((m) => m.id === btn.dataset.copyClientLink);
        const participant = meetingParticipant(meeting, 'client');
        try {
          await navigator.clipboard.writeText(participant.accessUrl);
          toast(`Copied ${participant.name}'s personal meeting link`);
        } catch {
          prompt('Copy the client meeting link:', participant.accessUrl);
        }
      });
    }
    for (const btn of content.querySelectorAll('[data-edit-meeting]')) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const meeting = meetings.find((m) => m.id === btn.dataset.editMeeting);
        meetingFormModal(meeting, meeting.issueId);
      });
    }
    for (const btn of content.querySelectorAll('[data-delete-meeting]')) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm('Delete this meeting?')) {
          api('DELETE', `/api/meetings/${btn.dataset.deleteMeeting}`)
            .then(() => { toast('Meeting deleted'); route(); })
            .catch((err) => toast(err.message, true));
        }
      });
    }
  }

  // Embed the OpenVidu Meet webcomponent so the meeting happens inside the app.
  async function joinMeeting(meeting, context = {}) {
    const participant = meetingParticipant(meeting, 'user');
    if (!participant) {
      toast('This meeting has no video room', true);
      return;
    }
    try {
      await loadMeetScript();
    } catch (err) {
      toast(err.message, true);
      return;
    }

    const title = context.title || [meeting.clientName, meeting.issueTitle].filter(Boolean).join(' — ');
    content.innerHTML = `
      <div class="page-header">
        <div>
          <h1>${esc(title) || 'Online meeting'}</h1>
          <p class="page-sub">${fmtDateTime(meeting.date)} · joined as ${esc(currentUser.name)} (${esc(participant.role)})</p>
        </div>
        <div class="page-actions">
          <button class="btn btn-secondary" id="leave-meeting">Leave meeting</button>
        </div>
      </div>
      <div class="meet-container" id="meet-container"></div>
    `;

    const container = $('#meet-container');
    container.innerHTML = `<openvidu-meet room-url="${esc(participant.accessUrl)}" participant-name="${esc(currentUser.name)}"></openvidu-meet>`;
    const meetEl = $('openvidu-meet', container);
    meetEl.once('closed', () => route());
    $('#leave-meeting').addEventListener('click', () => {
      meetEl.leaveRoom();
      route();
    });
  }

  async function meetingFormModal(meeting, presetIssueId) {
    const issues = await api('GET', '/api/issues');
    if (issues.length === 0) {
      toast('Create an issue first — meetings belong to an issue.', true);
      return;
    }
    const isEdit = Boolean(meeting);
    meeting = meeting || {};
    const selectedIssue = meeting.issueId || presetIssueId || '';

    openModal(isEdit ? 'Edit meeting' : 'Schedule meeting', `
      <form>
        <div class="field">
          <label>Issue *</label>
          <select name="issueId" required ${isEdit ? 'disabled' : ''}>
            <option value="" disabled ${selectedIssue ? '' : 'selected'}>Select an issue</option>
            ${issues.map((i) => `<option value="${esc(i.id)}" ${i.id === selectedIssue ? 'selected' : ''}>${esc(i.clientName)} — ${esc(i.title)}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label>Date &amp; time *</label>
          <input name="date" type="datetime-local" required value="${meeting.date ? toLocalInputValue(meeting.date) : ''}" />
        </div>
        <div class="field">
          <label>Meeting summary</label>
          <textarea name="resume" placeholder="Brief resume of what was discussed (fill in after the meeting)…">${esc(meeting.resume || '')}</textarea>
        </div>
        <p class="form-error hidden"></p>
        <div class="form-actions">
          <button type="button" class="btn btn-ghost" data-cancel>Cancel</button>
          <button type="submit" class="btn btn-primary">${isEdit ? 'Save changes' : 'Schedule meeting'}</button>
        </div>
      </form>
    `, (body) => {
      $('[data-cancel]', body).addEventListener('click', closeModal);
      bindForm(body, async (values) => {
        const payload = { date: new Date(values.date).toISOString(), resume: values.resume };
        if (isEdit) {
          await api('PUT', `/api/meetings/${meeting.id}`, payload);
          toast('Meeting updated');
        } else {
          await api('POST', `/api/issues/${values.issueId}/meetings`, payload);
          toast('Meeting scheduled');
        }
        closeModal();
        route();
      });
    });
  }

  async function renderMeetings() {
    const meetings = await api('GET', '/api/meetings');
    content.innerHTML = `
      <div class="page-header">
        <div>
          <h1>Meetings</h1>
          <p class="page-sub">${meetings.length} meeting${meetings.length === 1 ? '' : 's'} registered</p>
        </div>
        <div class="page-actions">
          <div class="view-toggle">
            <button id="view-calendar" class="${meetingView === 'calendar' ? 'active' : ''}">Calendar</button>
            <button id="view-list" class="${meetingView === 'list' ? 'active' : ''}">List</button>
          </div>
          <button class="btn btn-primary" id="add-meeting-global">+ Schedule meeting</button>
        </div>
      </div>
      <div id="meetings-view"></div>
    `;

    $('#add-meeting-global').addEventListener('click', () => meetingFormModal());
    $('#view-calendar').addEventListener('click', () => { meetingView = 'calendar'; renderMeetings(); });
    $('#view-list').addEventListener('click', () => { meetingView = 'list'; renderMeetings(); });

    if (meetingView === 'calendar') renderCalendar(meetings);
    else renderMeetingList(meetings);
  }

  function renderMeetingList(meetings) {
    const now = Date.now();
    const planned = meetings.filter((m) => new Date(m.date).getTime() >= now);
    const past = meetings.filter((m) => new Date(m.date).getTime() < now).reverse();
    const rows = (list, isPast) =>
      list.length === 0
        ? `<p style="color:var(--ink-400); font-size:14px;">Nothing here.</p>`
        : list.map((m) => meetingRow(m, isPast)).join('');

    $('#meetings-view').innerHTML = `
      <div class="section-header" style="margin-top:0;"><h2>Planned (${planned.length})</h2></div>
      <div class="detail-panel full">${rows(planned, false)}</div>
      <div class="section-header"><h2>Past (${past.length})</h2></div>
      <div class="detail-panel full">${rows(past, true)}</div>
    `;
    bindMeetingActions(meetings);
  }

  function renderCalendar(meetings) {
    const year = calendarCursor.getFullYear();
    const month = calendarCursor.getMonth();
    const monthName = calendarCursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

    // Monday-first grid.
    const first = new Date(year, month, 1);
    const startOffset = (first.getDay() + 6) % 7;
    const gridStart = new Date(year, month, 1 - startOffset);

    const byDay = new Map();
    for (const m of meetings) {
      const d = new Date(m.date);
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(m);
    }

    const today = new Date();
    const weeks = [];
    const cursor = new Date(gridStart);
    do {
      const week = [];
      for (let i = 0; i < 7; i++) {
        const key = `${cursor.getFullYear()}-${cursor.getMonth()}-${cursor.getDate()}`;
        const dayMeetings = (byDay.get(key) || []).slice().sort((a, b) => a.date.localeCompare(b.date));
        const isToday =
          cursor.getFullYear() === today.getFullYear() &&
          cursor.getMonth() === today.getMonth() &&
          cursor.getDate() === today.getDate();
        week.push(`
          <div class="calendar-day${cursor.getMonth() !== month ? ' other-month' : ''}${isToday ? ' today' : ''}">
            <span class="day-number">${cursor.getDate()}</span>
            ${dayMeetings.map((m) => `
              <button class="calendar-event${m.past ? ' past-event' : ''}" data-event="${esc(m.id)}"
                title="${esc(m.clientName)} — ${esc(m.issueTitle)}${m.resume ? ' · ' + esc(m.resume) : ''}">
                ${new Date(m.date).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })} ${esc(m.clientName)}
              </button>`).join('')}
          </div>
        `);
        cursor.setDate(cursor.getDate() + 1);
      }
      weeks.push(`<div class="calendar-week">${week.join('')}</div>`);
    } while (cursor.getMonth() === month);

    $('#meetings-view').innerHTML = `
      <div class="calendar">
        <div class="calendar-header">
          <h2>${monthName}</h2>
          <div class="calendar-nav">
            <button id="cal-prev" aria-label="Previous month">‹</button>
            <button id="cal-today" style="width:auto; padding:0 10px; font-size:12px;">Today</button>
            <button id="cal-next" aria-label="Next month">›</button>
          </div>
        </div>
        <div class="calendar-weekdays">
          ${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => `<div>${d}</div>`).join('')}
        </div>
        ${weeks.join('')}
      </div>
    `;

    $('#cal-prev').addEventListener('click', () => {
      calendarCursor = new Date(year, month - 1, 1); renderMeetings();
    });
    $('#cal-next').addEventListener('click', () => {
      calendarCursor = new Date(year, month + 1, 1); renderMeetings();
    });
    $('#cal-today').addEventListener('click', () => {
      calendarCursor = startOfMonth(new Date()); renderMeetings();
    });
    for (const btn of content.querySelectorAll('[data-event]')) {
      btn.addEventListener('click', () => {
        const meeting = meetings.find((m) => m.id === btn.dataset.event);
        meetingDetailsModal(meeting);
      });
    }
  }

  function meetingDetailsModal(meeting) {
    const userPart = meetingParticipant(meeting, 'user');
    const clientPart = meetingParticipant(meeting, 'client');
    openModal(`${meeting.clientName} — ${meeting.issueTitle}`, `
      <ul class="detail-list">
        <li><span class="dt">When</span><span class="dd">${fmtDateTime(meeting.date)} ${meeting.past ? '<span class="badge badge-past">Past</span>' : '<span class="badge badge-planned">Planned</span>'}</span></li>
        <li><span class="dt">Participants</span><span class="dd">${(meeting.participants || []).map((p) => `${esc(p.name)} (${esc(p.role)})`).join(', ') || '—'}</span></li>
        <li><span class="dt">Summary</span><span class="dd">${esc(meeting.resume) || '—'}</span></li>
      </ul>
      <div class="form-actions">
        <button class="btn btn-ghost" data-md-edit>Edit</button>
        ${clientPart ? '<button class="btn btn-secondary" data-md-copy>🔗 Client link</button>' : ''}
        ${userPart ? '<button class="btn btn-primary" data-md-join>▶ Join</button>' : ''}
      </div>
    `, (body) => {
      $('[data-md-edit]', body).addEventListener('click', () => {
        closeModal();
        meetingFormModal(meeting, meeting.issueId);
      });
      const copyBtn = $('[data-md-copy]', body);
      if (copyBtn) copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(clientPart.accessUrl);
          toast(`Copied ${clientPart.name}'s personal meeting link`);
        } catch {
          prompt('Copy the client meeting link:', clientPart.accessUrl);
        }
      });
      const joinBtn = $('[data-md-join]', body);
      if (joinBtn) joinBtn.addEventListener('click', () => {
        closeModal();
        joinMeeting(meeting);
      });
    });
  }

  // ---------------------------------------------------------------- profile ---

  async function renderProfile() {
    const me = await api('GET', '/api/me');
    content.innerHTML = `
      <div class="page-header">
        <div>
          <h1>User profile</h1>
          <p class="page-sub">Member since ${fmtDate(me.createdAt)}</p>
        </div>
      </div>
      <div class="detail-panel" style="max-width:480px;">
        <h3>Your details</h3>
        <form id="profile-form">
          <div class="field">
            <label>Full name</label>
            <input name="name" required value="${esc(me.name)}" />
          </div>
          <div class="field">
            <label>Email</label>
            <input name="email" type="email" required value="${esc(me.email)}" />
          </div>
          <div class="field">
            <label>New password <span style="font-weight:400; color:var(--ink-400);">(leave blank to keep current)</span></label>
            <input name="password" type="password" minlength="6" placeholder="••••••••" autocomplete="new-password" />
          </div>
          <p class="form-error hidden"></p>
          <div class="form-actions">
            <button type="submit" class="btn btn-primary">Save profile</button>
          </div>
        </form>
      </div>
    `;

    bindForm(content, async (values) => {
      if (!values.password) delete values.password;
      currentUser = await api('PUT', '/api/me', values);
      $('#sidebar-user').innerHTML = `<strong>${esc(currentUser.name)}</strong>${esc(currentUser.email)}`;
      toast('Profile saved');
      renderProfile();
    });
  }

  // ------------------------------------------------------------------ boot ---

  (async () => {
    try {
      currentUser = await api('GET', '/api/me');
      showApp();
    } catch {
      showAuth();
    }
  })();
})();
