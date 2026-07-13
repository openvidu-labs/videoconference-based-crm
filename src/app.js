const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const session = require('express-session');

const store = require('./store');
const { createMeetService, PERMISSION_KEYS, MEMBER_ROLES } = require('./meet');

function createApp(config = {}) {
  const app = express();
  const meet = createMeetService(config.meet);

  app.use(express.json());
  app.use(
    session({
      secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, sameSite: 'lax' },
    })
  );
  app.use(express.static(path.join(__dirname, '..', 'public')));

  const requireAuth = (req, res, next) => {
    if (!req.session.userId || !store.db.users.has(req.session.userId)) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    next();
  };

  // ---------------------------------------------------------------- auth ---

  app.post('/api/register', (req, res) => {
    const { name, email, password } = req.body || {};
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'name, email and password are required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'password must be at least 6 characters' });
    }
    if (store.findUserByEmail(email)) {
      return res.status(409).json({ error: 'A user with that email already exists' });
    }
    const user = store.createUser({ name, email, password });
    req.session.userId = user.id;
    res.status(201).json(store.publicUser(user));
  });

  app.post('/api/login', (req, res) => {
    const { email, password } = req.body || {};
    const user = email && password ? store.findUserByEmail(email) : null;
    if (!user || !store.verifyPassword(password, user.passwordHash)) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    req.session.userId = user.id;
    res.json(store.publicUser(user));
  });

  app.post('/api/logout', (req, res) => {
    req.session.destroy(() => res.status(204).end());
  });

  app.get('/api/me', requireAuth, (req, res) => {
    res.json(store.publicUser(store.db.users.get(req.session.userId)));
  });

  app.put('/api/me', requireAuth, (req, res) => {
    const user = store.db.users.get(req.session.userId);
    const { name, email, password } = req.body || {};
    if (email && email.toLowerCase() !== user.email) {
      const existing = store.findUserByEmail(email);
      if (existing && existing.id !== user.id) {
        return res.status(409).json({ error: 'A user with that email already exists' });
      }
      user.email = email.toLowerCase();
    }
    if (name) user.name = name;
    if (password) {
      if (password.length < 6) {
        return res.status(400).json({ error: 'password must be at least 6 characters' });
      }
      user.passwordHash = store.hashPassword(password);
    }
    res.json(store.publicUser(user));
  });

  // Frontend runtime configuration (where to load the Meet webcomponent from).
  app.get('/api/config', requireAuth, (req, res) => {
    res.json({ meetScriptUrl: meet.scriptUrl, meetPublicUrl: meet.publicUrl });
  });

  app.get('/api/users', requireAuth, (req, res) => {
    res.json([...store.db.users.values()].map(store.publicUser));
  });

  // ------------------------------------------------------------- clients ---

  app.get('/api/clients', requireAuth, (req, res) => {
    const clients = [...store.db.clients.values()].map((c) => ({
      ...c,
      issueCount: store.issuesForClient(c.id).length,
      openIssueCount: store
        .issuesForClient(c.id)
        .filter((i) => i.status === 'open' || i.status === 'in-progress').length,
    }));
    res.json(clients);
  });

  app.post('/api/clients', requireAuth, (req, res) => {
    const { companyName } = req.body || {};
    if (!companyName || !String(companyName).trim()) {
      return res.status(400).json({ error: 'companyName is required' });
    }
    res.status(201).json(store.createClient(req.body));
  });

  app.get('/api/clients/:id', requireAuth, (req, res) => {
    const client = store.db.clients.get(req.params.id);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    res.json({ ...client, issues: store.issuesForClient(client.id).map(decorateIssue) });
  });

  app.put('/api/clients/:id', requireAuth, (req, res) => {
    const client = store.db.clients.get(req.params.id);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    const fields = ['companyName', 'contactName', 'contactEmail', 'contactPhone', 'address', 'notes'];
    for (const f of fields) {
      if (req.body[f] !== undefined) client[f] = req.body[f];
    }
    if (!String(client.companyName).trim()) {
      return res.status(400).json({ error: 'companyName cannot be empty' });
    }
    res.json(client);
  });

  // Validate a {baseRole, customPermissions} payload for the client's guest
  // membership. Returns an error string or null.
  function validateMeetAccessPayload({ baseRole, customPermissions }) {
    if (baseRole !== undefined && !MEMBER_ROLES.includes(baseRole)) {
      return `baseRole must be one of: ${MEMBER_ROLES.join(', ')}`;
    }
    if (customPermissions !== undefined) {
      if (typeof customPermissions !== 'object' || customPermissions === null || Array.isArray(customPermissions)) {
        return 'customPermissions must be an object';
      }
      for (const [key, value] of Object.entries(customPermissions)) {
        if (!PERMISSION_KEYS.includes(key)) {
          return `unknown permission '${key}' (valid: ${PERMISSION_KEYS.join(', ')})`;
        }
        if (typeof value !== 'boolean') {
          return `permission '${key}' must be a boolean`;
        }
      }
    }
    return null;
  }

  function meetErrorResponse(res, error) {
    const status = error.statusCode === 409 ? 409 : 502;
    res.status(status).json({ error: `OpenVidu Meet: ${error.message}` });
  }

  // Add the client contact to the meeting room as an invited guest (speaker by
  // default), creating the client's room if it does not exist yet.
  app.post('/api/clients/:id/meet-access', requireAuth, async (req, res) => {
    const client = store.db.clients.get(req.params.id);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    const { baseRole, customPermissions } = req.body || {};
    const invalid = validateMeetAccessPayload({ baseRole, customPermissions });
    if (invalid) return res.status(400).json({ error: invalid });
    try {
      const member = await meet.ensureClientMember(client, { baseRole, customPermissions });
      res.status(201).json({ meetRoom: client.meetRoom, member });
    } catch (error) {
      meetErrorResponse(res, error);
    }
  });

  // Update the client guest's role / fine-grained permissions.
  app.put('/api/clients/:id/meet-access', requireAuth, async (req, res) => {
    const client = store.db.clients.get(req.params.id);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    const { baseRole, customPermissions } = req.body || {};
    if (baseRole === undefined && customPermissions === undefined) {
      return res.status(400).json({ error: 'baseRole or customPermissions is required' });
    }
    const invalid = validateMeetAccessPayload({ baseRole, customPermissions });
    if (invalid) return res.status(400).json({ error: invalid });
    try {
      const member = await meet.updateClientMemberPermissions(client, { baseRole, customPermissions });
      res.json({ meetRoom: client.meetRoom, member });
    } catch (error) {
      meetErrorResponse(res, error);
    }
  });

  app.delete('/api/clients/:id', requireAuth, (req, res) => {
    const client = store.db.clients.get(req.params.id);
    if (!store.deleteClient(req.params.id)) {
      return res.status(404).json({ error: 'Client not found' });
    }
    meet.deleteClientRoom(client); // best-effort, does not block the response
    res.status(204).end();
  });

  // -------------------------------------------------------------- issues ---

  function decorateIssue(issue) {
    const client = store.db.clients.get(issue.clientId);
    const assignee = issue.assigneeId ? store.db.users.get(issue.assigneeId) : null;
    return {
      ...issue,
      clientName: client ? client.companyName : null,
      assigneeName: assignee ? assignee.name : null,
      meetingCount: store.meetingsForIssue(issue.id).length,
    };
  }

  app.get('/api/issues', requireAuth, (req, res) => {
    res.json([...store.db.issues.values()].map(decorateIssue));
  });

  app.post('/api/issues', requireAuth, (req, res) => {
    const { title, clientId, assigneeId, status } = req.body || {};
    if (!title || !String(title).trim()) {
      return res.status(400).json({ error: 'title is required' });
    }
    if (!clientId || !store.db.clients.has(clientId)) {
      return res.status(400).json({ error: 'clientId must reference an existing client' });
    }
    if (assigneeId && !store.db.users.has(assigneeId)) {
      return res.status(400).json({ error: 'assigneeId must reference an existing user' });
    }
    if (status && !store.ISSUE_STATUSES.includes(status)) {
      return res
        .status(400)
        .json({ error: `status must be one of: ${store.ISSUE_STATUSES.join(', ')}` });
    }
    res.status(201).json(decorateIssue(store.createIssue(req.body)));
  });

  app.get('/api/issues/:id', requireAuth, (req, res) => {
    const issue = store.db.issues.get(req.params.id);
    if (!issue) return res.status(404).json({ error: 'Issue not found' });
    res.json({ ...decorateIssue(issue), meetings: store.meetingsForIssue(issue.id) });
  });

  app.put('/api/issues/:id', requireAuth, (req, res) => {
    const issue = store.db.issues.get(req.params.id);
    if (!issue) return res.status(404).json({ error: 'Issue not found' });
    const { title, description, clientId, assigneeId, status } = req.body || {};
    if (title !== undefined) {
      if (!String(title).trim()) return res.status(400).json({ error: 'title cannot be empty' });
      issue.title = title;
    }
    if (description !== undefined) issue.description = description;
    if (clientId !== undefined) {
      if (!store.db.clients.has(clientId)) {
        return res.status(400).json({ error: 'clientId must reference an existing client' });
      }
      issue.clientId = clientId;
    }
    if (assigneeId !== undefined) {
      if (assigneeId !== null && !store.db.users.has(assigneeId)) {
        return res.status(400).json({ error: 'assigneeId must reference an existing user' });
      }
      issue.assigneeId = assigneeId;
    }
    if (status !== undefined) {
      if (!store.ISSUE_STATUSES.includes(status)) {
        return res
          .status(400)
          .json({ error: `status must be one of: ${store.ISSUE_STATUSES.join(', ')}` });
      }
      issue.status = status;
    }
    res.json(decorateIssue(issue));
  });

  app.delete('/api/issues/:id', requireAuth, (req, res) => {
    if (!store.deleteIssue(req.params.id)) {
      return res.status(404).json({ error: 'Issue not found' });
    }
    res.status(204).end();
  });

  // ------------------------------------------------------------ meetings ---

  function decorateMeeting(meeting) {
    const issue = store.db.issues.get(meeting.issueId);
    const client = issue ? store.db.clients.get(issue.clientId) : null;
    return {
      ...meeting,
      past: new Date(meeting.date).getTime() < Date.now(),
      issueTitle: issue ? issue.title : null,
      clientName: client ? client.companyName : null,
    };
  }

  app.get('/api/meetings', requireAuth, (req, res) => {
    const meetings = [...store.db.meetings.values()]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map(decorateMeeting);
    res.json(meetings);
  });

  app.post('/api/issues/:id/meetings', requireAuth, async (req, res) => {
    const issue = store.db.issues.get(req.params.id);
    if (!issue) return res.status(404).json({ error: 'Issue not found' });
    const { date, resume } = req.body || {};
    if (!date || Number.isNaN(new Date(date).getTime())) {
      return res.status(400).json({ error: 'a valid date is required' });
    }
    const meeting = store.createMeeting({
      issueId: issue.id,
      date: new Date(date).toISOString(),
      resume,
    });

    // Provision the online meeting in OpenVidu Meet: one room per client, with
    // the assigned user (or the scheduling user) and the client contact as
    // members. If Meet is unreachable the CRM meeting is still registered.
    const client = store.db.clients.get(issue.clientId);
    const user =
      (issue.assigneeId && store.db.users.get(issue.assigneeId)) ||
      store.db.users.get(req.session.userId);
    try {
      const { roomId, participants } = await meet.provisionMeeting(client, user);
      meeting.roomId = roomId;
      meeting.participants = participants;
    } catch (error) {
      console.error(`OpenVidu Meet provisioning failed: ${error.message}`);
      meeting.meetError = `OpenVidu Meet unavailable: ${error.message}`;
    }
    res.status(201).json(decorateMeeting(meeting));
  });

  // Personal access for the logged-in user to a meeting's room. The user is
  // added under the hood as an invited guest with moderator role (once per
  // user and room) and gets their own access URL.
  app.post('/api/meetings/:id/join', requireAuth, async (req, res) => {
    const meeting = store.db.meetings.get(req.params.id);
    if (!meeting) return res.status(404).json({ error: 'Meeting not found' });
    const issue = store.db.issues.get(meeting.issueId);
    const client = issue && store.db.clients.get(issue.clientId);
    if (!client) return res.status(409).json({ error: 'The meeting has no client room' });
    const user = store.db.users.get(req.session.userId);
    try {
      const member = await meet.ensureUserMember(client, user);
      res.json({ accessUrl: member.accessUrl, name: member.name, role: member.baseRole });
    } catch (error) {
      meetErrorResponse(res, error);
    }
  });

  app.put('/api/meetings/:id', requireAuth, (req, res) => {
    const meeting = store.db.meetings.get(req.params.id);
    if (!meeting) return res.status(404).json({ error: 'Meeting not found' });
    const { date, resume } = req.body || {};
    if (date !== undefined) {
      if (Number.isNaN(new Date(date).getTime())) {
        return res.status(400).json({ error: 'date must be a valid date' });
      }
      meeting.date = new Date(date).toISOString();
    }
    if (resume !== undefined) meeting.resume = resume;
    res.json(decorateMeeting(meeting));
  });

  app.delete('/api/meetings/:id', requireAuth, (req, res) => {
    if (!store.db.meetings.delete(req.params.id)) {
      return res.status(404).json({ error: 'Meeting not found' });
    }
    res.status(204).end();
  });

  return app;
}

module.exports = { createApp };
