const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const { createApp } = require('../src/app');
const store = require('../src/store');

// Helper: returns a supertest agent (keeps session cookies) with a registered, logged-in user.
async function registeredAgent(app, overrides = {}) {
  const agent = request.agent(app);
  const user = {
    name: 'Alice Smith',
    email: `alice-${Math.random().toString(36).slice(2)}@example.com`,
    password: 'secret123',
    ...overrides,
  };
  const res = await agent.post('/api/register').send(user);
  assert.strictEqual(res.status, 201);
  return { agent, user: res.body, password: user.password };
}

describe('CRM API', () => {
  let app;

  beforeEach(() => {
    store.reset();
    app = createApp();
  });

  // ---------------------------------------------------------------- auth ---

  describe('authentication and user management', () => {
    test('new users can register themselves', async () => {
      const res = await request(app)
        .post('/api/register')
        .send({ name: 'Bob', email: 'bob@example.com', password: 'secret123' });
      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.name, 'Bob');
      assert.strictEqual(res.body.email, 'bob@example.com');
      assert.ok(res.body.id);
      assert.strictEqual(res.body.password, undefined, 'password must not be returned');
    });

    test('registration requires name, email and password', async () => {
      const res = await request(app).post('/api/register').send({ email: 'x@x.com' });
      assert.strictEqual(res.status, 400);
    });

    test('registration rejects duplicate emails', async () => {
      await request(app)
        .post('/api/register')
        .send({ name: 'Bob', email: 'bob@example.com', password: 'secret123' });
      const res = await request(app)
        .post('/api/register')
        .send({ name: 'Bobby', email: 'bob@example.com', password: 'other456' });
      assert.strictEqual(res.status, 409);
    });

    test('registered users can log in and get a session', async () => {
      await request(app)
        .post('/api/register')
        .send({ name: 'Bob', email: 'bob@example.com', password: 'secret123' });

      const agent = request.agent(app);
      const login = await agent
        .post('/api/login')
        .send({ email: 'bob@example.com', password: 'secret123' });
      assert.strictEqual(login.status, 200);
      assert.strictEqual(login.body.email, 'bob@example.com');

      const me = await agent.get('/api/me');
      assert.strictEqual(me.status, 200);
      assert.strictEqual(me.body.email, 'bob@example.com');
    });

    test('login fails with wrong credentials', async () => {
      await request(app)
        .post('/api/register')
        .send({ name: 'Bob', email: 'bob@example.com', password: 'secret123' });
      const res = await request(app)
        .post('/api/login')
        .send({ email: 'bob@example.com', password: 'wrong' });
      assert.strictEqual(res.status, 401);
    });

    test('logout ends the session', async () => {
      const { agent } = await registeredAgent(app);
      await agent.post('/api/logout').expect(204);
      const me = await agent.get('/api/me');
      assert.strictEqual(me.status, 401);
    });

    test('API resources require authentication', async () => {
      for (const path of ['/api/clients', '/api/issues', '/api/meetings', '/api/users']) {
        const res = await request(app).get(path);
        assert.strictEqual(res.status, 401, `${path} should require auth`);
      }
    });

    test('users can update their own profile', async () => {
      const { agent } = await registeredAgent(app);
      const res = await agent.put('/api/me').send({ name: 'Alice Updated' });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.name, 'Alice Updated');
    });

    test('authenticated users can list users (for assignment)', async () => {
      const { agent } = await registeredAgent(app);
      const res = await agent.get('/api/users');
      assert.strictEqual(res.status, 200);
      assert.ok(Array.isArray(res.body));
      assert.strictEqual(res.body.length, 1);
      assert.strictEqual(res.body[0].password, undefined);
    });
  });

  // ------------------------------------------------------------- clients ---

  describe('clients', () => {
    test('users can add clients with company name and contact details', async () => {
      const { agent } = await registeredAgent(app);
      const res = await agent.post('/api/clients').send({
        companyName: 'Acme Corp',
        contactName: 'John Doe',
        contactEmail: 'john@acme.com',
        contactPhone: '+34 600 000 000',
        address: '123 Main St, Springfield',
        notes: 'Big fish',
      });
      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.companyName, 'Acme Corp');
      assert.strictEqual(res.body.contactEmail, 'john@acme.com');
      assert.ok(res.body.id);
    });

    test('client creation requires a company name', async () => {
      const { agent } = await registeredAgent(app);
      const res = await agent.post('/api/clients').send({ contactName: 'John' });
      assert.strictEqual(res.status, 400);
    });

    test('clients can be listed, updated and deleted', async () => {
      const { agent } = await registeredAgent(app);
      const created = await agent.post('/api/clients').send({ companyName: 'Acme Corp' });
      const id = created.body.id;

      const list = await agent.get('/api/clients');
      assert.strictEqual(list.status, 200);
      assert.strictEqual(list.body.length, 1);

      const updated = await agent.put(`/api/clients/${id}`).send({ companyName: 'Acme Inc' });
      assert.strictEqual(updated.status, 200);
      assert.strictEqual(updated.body.companyName, 'Acme Inc');

      await agent.delete(`/api/clients/${id}`).expect(204);
      const after = await agent.get('/api/clients');
      assert.strictEqual(after.body.length, 0);
    });

    test('a client detail includes its list of issues', async () => {
      const { agent, user } = await registeredAgent(app);
      const client = (await agent.post('/api/clients').send({ companyName: 'Acme' })).body;
      await agent.post('/api/issues').send({
        title: 'Server down',
        clientId: client.id,
        assigneeId: user.id,
      });

      const res = await agent.get(`/api/clients/${client.id}`);
      assert.strictEqual(res.status, 200);
      assert.ok(Array.isArray(res.body.issues));
      assert.strictEqual(res.body.issues.length, 1);
      assert.strictEqual(res.body.issues[0].title, 'Server down');
    });

    test('unknown client returns 404', async () => {
      const { agent } = await registeredAgent(app);
      const res = await agent.get('/api/clients/nope');
      assert.strictEqual(res.status, 404);
    });
  });

  // -------------------------------------------------------------- issues ---

  describe('issues', () => {
    let agent, user, client;

    beforeEach(async () => {
      ({ agent, user } = await registeredAgent(app));
      client = (await agent.post('/api/clients').send({ companyName: 'Acme' })).body;
    });

    test('users can create issues for a client with an assigned user', async () => {
      const res = await agent.post('/api/issues').send({
        title: 'Login broken',
        description: 'Users cannot log in since Monday',
        clientId: client.id,
        assigneeId: user.id,
      });
      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.title, 'Login broken');
      assert.strictEqual(res.body.clientId, client.id);
      assert.strictEqual(res.body.assigneeId, user.id);
      assert.strictEqual(res.body.status, 'open', 'new issues default to open status');
    });

    test('issue creation requires title and an existing client', async () => {
      const noTitle = await agent.post('/api/issues').send({ clientId: client.id });
      assert.strictEqual(noTitle.status, 400);

      const badClient = await agent
        .post('/api/issues')
        .send({ title: 'X', clientId: 'nope' });
      assert.strictEqual(badClient.status, 400);
    });

    test('issue status must be one of the allowed values', async () => {
      const res = await agent.post('/api/issues').send({
        title: 'X',
        clientId: client.id,
        status: 'weird',
      });
      assert.strictEqual(res.status, 400);
    });

    test('issue status can be updated through its lifecycle', async () => {
      const issue = (
        await agent.post('/api/issues').send({ title: 'X', clientId: client.id })
      ).body;

      for (const status of ['in-progress', 'resolved', 'closed']) {
        const res = await agent.put(`/api/issues/${issue.id}`).send({ status });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.status, status);
      }
    });

    test('issues can be reassigned to another user', async () => {
      const other = (
        await request(app)
          .post('/api/register')
          .send({ name: 'Carol', email: 'carol@example.com', password: 'secret123' })
      ).body;
      const issue = (
        await agent.post('/api/issues').send({ title: 'X', clientId: client.id })
      ).body;

      const res = await agent.put(`/api/issues/${issue.id}`).send({ assigneeId: other.id });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.assigneeId, other.id);
    });

    test('issue detail includes its meetings and related names', async () => {
      const issue = (
        await agent
          .post('/api/issues')
          .send({ title: 'X', clientId: client.id, assigneeId: user.id })
      ).body;
      await agent.post(`/api/issues/${issue.id}/meetings`).send({
        date: '2026-07-10T10:00:00.000Z',
        resume: 'Kickoff call',
      });

      const res = await agent.get(`/api/issues/${issue.id}`);
      assert.strictEqual(res.status, 200);
      assert.ok(Array.isArray(res.body.meetings));
      assert.strictEqual(res.body.meetings.length, 1);
      assert.strictEqual(res.body.clientName, 'Acme');
      assert.strictEqual(res.body.assigneeName, user.name);
    });

    test('deleting an issue removes its meetings too', async () => {
      const issue = (
        await agent.post('/api/issues').send({ title: 'X', clientId: client.id })
      ).body;
      await agent
        .post(`/api/issues/${issue.id}/meetings`)
        .send({ date: '2026-07-10T10:00:00.000Z' });

      await agent.delete(`/api/issues/${issue.id}`).expect(204);
      const meetings = await agent.get('/api/meetings');
      assert.strictEqual(meetings.body.length, 0);
    });
  });

  // ------------------------------------------------------------ meetings ---

  describe('meetings', () => {
    let agent, user, client, issue;

    beforeEach(async () => {
      ({ agent, user } = await registeredAgent(app));
      client = (await agent.post('/api/clients').send({ companyName: 'Acme' })).body;
      issue = (
        await agent
          .post('/api/issues')
          .send({ title: 'Broken thing', clientId: client.id, assigneeId: user.id })
      ).body;
    });

    test('meetings can be planned for an issue with a date', async () => {
      const res = await agent.post(`/api/issues/${issue.id}/meetings`).send({
        date: '2099-01-15T09:30:00.000Z',
        resume: '',
      });
      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.issueId, issue.id);
      assert.strictEqual(res.body.date, '2099-01-15T09:30:00.000Z');
    });

    test('meeting creation requires a valid date', async () => {
      const missing = await agent.post(`/api/issues/${issue.id}/meetings`).send({});
      assert.strictEqual(missing.status, 400);
      const invalid = await agent
        .post(`/api/issues/${issue.id}/meetings`)
        .send({ date: 'not-a-date' });
      assert.strictEqual(invalid.status, 400);
    });

    test('a resume (summary) can be registered after the meeting happened', async () => {
      const meeting = (
        await agent
          .post(`/api/issues/${issue.id}/meetings`)
          .send({ date: '2026-01-05T10:00:00.000Z' })
      ).body;

      const res = await agent
        .put(`/api/meetings/${meeting.id}`)
        .send({ resume: 'Client agreed to upgrade plan; issue mitigated.' });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.resume, 'Client agreed to upgrade plan; issue mitigated.');
    });

    test('meetings list includes issue and client context and past/planned flag', async () => {
      await agent
        .post(`/api/issues/${issue.id}/meetings`)
        .send({ date: '2000-01-01T10:00:00.000Z', resume: 'Old meeting' });
      await agent
        .post(`/api/issues/${issue.id}/meetings`)
        .send({ date: '2099-01-01T10:00:00.000Z' });

      const res = await agent.get('/api/meetings');
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.length, 2);

      const past = res.body.find((m) => m.date.startsWith('2000'));
      const planned = res.body.find((m) => m.date.startsWith('2099'));
      assert.strictEqual(past.past, true);
      assert.strictEqual(planned.past, false);
      assert.strictEqual(past.issueTitle, 'Broken thing');
      assert.strictEqual(past.clientName, 'Acme');
    });

    test('meetings can be deleted', async () => {
      const meeting = (
        await agent
          .post(`/api/issues/${issue.id}/meetings`)
          .send({ date: '2026-07-10T10:00:00.000Z' })
      ).body;
      await agent.delete(`/api/meetings/${meeting.id}`).expect(204);
      const res = await agent.get('/api/meetings');
      assert.strictEqual(res.body.length, 0);
    });
  });

  // ------------------------------------------------------------ frontend ---

  describe('frontend', () => {
    test('serves the single-page app at the root', async () => {
      const res = await request(app).get('/');
      assert.strictEqual(res.status, 200);
      assert.match(res.headers['content-type'], /html/);
      assert.match(res.text, /CRM/i);
    });
  });
});
