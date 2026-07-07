// In-memory database. Everything lives in these Maps; restarting the app
// starts from a clean slate.
const crypto = require('node:crypto');

const db = {
  users: new Map(),
  clients: new Map(),
  issues: new Map(),
  meetings: new Map(),
};

const ISSUE_STATUSES = ['open', 'in-progress', 'resolved', 'closed'];

function id() {
  return crypto.randomUUID();
}

function reset() {
  for (const collection of Object.values(db)) collection.clear();
}

// ------------------------------------------------------------------ users ---

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(password, salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(candidate, 'hex'));
}

function publicUser(user) {
  if (!user) return null;
  const { passwordHash, ...safe } = user;
  return safe;
}

function createUser({ name, email, password }) {
  const user = {
    id: id(),
    name,
    email: email.toLowerCase(),
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString(),
  };
  db.users.set(user.id, user);
  return user;
}

function findUserByEmail(email) {
  const needle = String(email).toLowerCase();
  return [...db.users.values()].find((u) => u.email === needle) || null;
}

// ---------------------------------------------------------------- clients ---

function createClient(data) {
  const client = {
    id: id(),
    companyName: data.companyName,
    contactName: data.contactName || '',
    contactEmail: data.contactEmail || '',
    contactPhone: data.contactPhone || '',
    address: data.address || '',
    notes: data.notes || '',
    createdAt: new Date().toISOString(),
  };
  db.clients.set(client.id, client);
  return client;
}

function issuesForClient(clientId) {
  return [...db.issues.values()].filter((i) => i.clientId === clientId);
}

function deleteClient(clientId) {
  for (const issue of issuesForClient(clientId)) deleteIssue(issue.id);
  return db.clients.delete(clientId);
}

// ----------------------------------------------------------------- issues ---

function createIssue(data) {
  const issue = {
    id: id(),
    title: data.title,
    description: data.description || '',
    clientId: data.clientId,
    assigneeId: data.assigneeId || null,
    status: data.status || 'open',
    createdAt: new Date().toISOString(),
  };
  db.issues.set(issue.id, issue);
  return issue;
}

function meetingsForIssue(issueId) {
  return [...db.meetings.values()]
    .filter((m) => m.issueId === issueId)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function deleteIssue(issueId) {
  for (const meeting of meetingsForIssue(issueId)) db.meetings.delete(meeting.id);
  return db.issues.delete(issueId);
}

// --------------------------------------------------------------- meetings ---

function createMeeting({ issueId, date, resume }) {
  const meeting = {
    id: id(),
    issueId,
    date,
    resume: resume || '',
    createdAt: new Date().toISOString(),
  };
  db.meetings.set(meeting.id, meeting);
  return meeting;
}

module.exports = {
  db,
  ISSUE_STATUSES,
  reset,
  hashPassword,
  verifyPassword,
  publicUser,
  createUser,
  findUserByEmail,
  createClient,
  issuesForClient,
  deleteClient,
  createIssue,
  meetingsForIssue,
  deleteIssue,
  createMeeting,
};
