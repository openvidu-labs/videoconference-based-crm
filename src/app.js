const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const session = require('express-session');

const store = require('./store');

function createApp() {
  const app = express();

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

  app.delete('/api/clients/:id', requireAuth, (req, res) => {
    if (!store.deleteClient(req.params.id)) {
      return res.status(404).json({ error: 'Client not found' });
    }
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

  app.post('/api/issues/:id/meetings', requireAuth, (req, res) => {
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
    res.status(201).json(decorateMeeting(meeting));
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
