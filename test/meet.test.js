const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const express = require('express');

const { createApp } = require('../src/app');
const store = require('../src/store');

// Fake OpenVidu Meet 3.7.0 server implementing the subset of the REST API the
// CRM uses: POST /rooms, GET /rooms/:id, DELETE /rooms/:id. Shapes verified
// against a real local deployment (rooms carry moderatorUrl/speakerUrl).
function startFakeMeet() {
  const app = express();
  app.use(express.json());

  const state = {
    calls: [],
    rooms: new Map(),
    counter: 0,
    baseUrl: null,
  };

  app.use((req, res, next) => {
    state.calls.push({
      method: req.method,
      path: req.path,
      apiKey: req.headers['x-api-key'],
      body: req.body,
    });
    next();
  });

  app.post('/meet/api/v1/rooms', (req, res) => {
    const { roomName } = req.body;
    if (!roomName) return res.status(400).json({ message: 'roomName is required' });
    const roomId = `${roomName.toLowerCase().replace(/\s+/g, '_')}-${++state.counter}`;
    const room = {
      roomId,
      roomName,
      status: 'open',
      moderatorUrl: `${state.baseUrl}/room/${roomId}?secret=mod-${state.counter}`,
      speakerUrl: `${state.baseUrl}/room/${roomId}?secret=spk-${state.counter}`,
    };
    state.rooms.set(roomId, room);
    res.status(201).json(room);
  });

  app.get('/meet/api/v1/rooms/:roomId', (req, res) => {
    const room = state.rooms.get(req.params.roomId);
    if (!room) return res.status(404).json({ message: 'Room not found' });
    res.json(room);
  });

  app.delete('/meet/api/v1/rooms/:roomId', (req, res) => {
    if (!state.rooms.delete(req.params.roomId)) {
      return res.status(404).json({ message: 'Room not found' });
    }
    res.status(200).json({ message: 'deleted' });
  });

  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      state.baseUrl = `http://127.0.0.1:${server.address().port}/meet`;
      resolve({ server, state });
    });
  });
}

// Register a user, create a client and an issue assigned to that user.
async function seed(app) {
  const agent = request.agent(app);
  const user = (
    await agent
      .post('/api/register')
      .send({ name: 'Alice Agent', email: 'alice@example.com', password: 'secret123' })
  ).body;
  const client = (
    await agent.post('/api/clients').send({ companyName: 'Acme Corp', contactName: 'John Acme' })
  ).body;
  const issue = (
    await agent
      .post('/api/issues')
      .send({ title: 'VPN outage', clientId: client.id, assigneeId: user.id })
  ).body;
  return { agent, user, client, issue };
}

describe('OpenVidu Meet integration', () => {
  let fake;

  beforeEach(async () => {
    store.reset();
    fake = await startFakeMeet();
  });

  afterEach(() => {
    fake.server.close();
  });

  function makeApp(overrides = {}) {
    return createApp({
      meet: { serverUrl: fake.state.baseUrl, apiKey: 'meet-api-key', ...overrides },
    });
  }

  test('scheduling a meeting creates a Meet room for the client with user and client as participants', async () => {
    const app = makeApp();
    const { agent, user, issue } = await seed(app);

    const res = await agent
      .post(`/api/issues/${issue.id}/meetings`)
      .send({ date: '2099-03-01T10:00:00.000Z' });
    assert.strictEqual(res.status, 201);

    const meeting = res.body;
    assert.ok(meeting.roomId, 'meeting should reference the Meet room');
    assert.strictEqual(meeting.meetError, undefined);

    // Room created once, with the client company as room name and the API key header.
    const roomCalls = fake.state.calls.filter((c) => c.method === 'POST' && c.path === '/meet/api/v1/rooms');
    assert.strictEqual(roomCalls.length, 1);
    assert.strictEqual(roomCalls[0].body.roomName, 'Acme Corp');
    assert.strictEqual(roomCalls[0].apiKey, 'meet-api-key');

    // The assigned user (moderator) and the client contact (speaker) are the
    // meeting's participants, each with a role-specific access URL.
    assert.strictEqual(meeting.participants.length, 2);
    const userPart = meeting.participants.find((p) => p.kind === 'user');
    const clientPart = meeting.participants.find((p) => p.kind === 'client');
    assert.strictEqual(userPart.name, user.name);
    assert.strictEqual(userPart.role, 'moderator');
    assert.match(userPart.accessUrl, /\/room\/.*secret=mod-/);
    assert.strictEqual(clientPart.name, 'John Acme');
    assert.strictEqual(clientPart.role, 'speaker');
    assert.match(clientPart.accessUrl, /\/room\/.*secret=spk-/);
    assert.notStrictEqual(userPart.accessUrl, clientPart.accessUrl);
  });

  test('a second meeting for the same client reuses the room', async () => {
    const app = makeApp();
    const { agent, issue } = await seed(app);

    const first = await agent
      .post(`/api/issues/${issue.id}/meetings`)
      .send({ date: '2099-03-01T10:00:00.000Z' });
    const second = await agent
      .post(`/api/issues/${issue.id}/meetings`)
      .send({ date: '2099-04-01T10:00:00.000Z' });

    assert.strictEqual(second.status, 201);
    assert.strictEqual(first.body.roomId, second.body.roomId);

    const roomCalls = fake.state.calls.filter((c) => c.method === 'POST' && c.path === '/meet/api/v1/rooms');
    assert.strictEqual(roomCalls.length, 1, 'room must be created only once per client');

    // Same participants (same access URLs) on both meetings.
    assert.deepStrictEqual(
      first.body.participants.map((p) => p.accessUrl).sort(),
      second.body.participants.map((p) => p.accessUrl).sort()
    );
  });

  test('meetings for different clients get different rooms', async () => {
    const app = makeApp();
    const { agent, user, issue } = await seed(app);
    const otherClient = (
      await agent.post('/api/clients').send({ companyName: 'Globex', contactName: 'Gloria' })
    ).body;
    const otherIssue = (
      await agent
        .post('/api/issues')
        .send({ title: 'Billing bug', clientId: otherClient.id, assigneeId: user.id })
    ).body;

    const m1 = await agent
      .post(`/api/issues/${issue.id}/meetings`)
      .send({ date: '2099-03-01T10:00:00.000Z' });
    const m2 = await agent
      .post(`/api/issues/${otherIssue.id}/meetings`)
      .send({ date: '2099-03-02T10:00:00.000Z' });

    assert.notStrictEqual(m1.body.roomId, m2.body.roomId);
    const roomCalls = fake.state.calls.filter((c) => c.method === 'POST' && c.path === '/meet/api/v1/rooms');
    assert.deepStrictEqual(roomCalls.map((c) => c.body.roomName).sort(), ['Acme Corp', 'Globex']);
  });

  test('an unassigned issue uses the scheduling user as the meeting moderator', async () => {
    const app = makeApp();
    const { agent, user, client } = await seed(app);
    const unassigned = (
      await agent.post('/api/issues').send({ title: 'No assignee', clientId: client.id })
    ).body;

    const res = await agent
      .post(`/api/issues/${unassigned.id}/meetings`)
      .send({ date: '2099-05-01T10:00:00.000Z' });
    assert.strictEqual(res.status, 201);
    const userPart = res.body.participants.find((p) => p.kind === 'user');
    assert.strictEqual(userPart.name, user.name);
  });

  test('if the Meet room was deleted externally, scheduling recreates it', async () => {
    const app = makeApp();
    const { agent, issue } = await seed(app);

    const first = await agent
      .post(`/api/issues/${issue.id}/meetings`)
      .send({ date: '2099-03-01T10:00:00.000Z' });
    fake.state.rooms.delete(first.body.roomId);

    const second = await agent
      .post(`/api/issues/${issue.id}/meetings`)
      .send({ date: '2099-06-01T10:00:00.000Z' });
    assert.strictEqual(second.status, 201);
    assert.strictEqual(second.body.meetError, undefined);
    assert.ok(second.body.roomId);
    assert.notStrictEqual(second.body.roomId, first.body.roomId);
    assert.strictEqual(second.body.participants.length, 2);
  });

  test('meetings are still registered when OpenVidu Meet is unreachable', async () => {
    const app = createApp({
      meet: { serverUrl: 'http://127.0.0.1:1/meet', apiKey: 'meet-api-key' },
    });
    const { agent, issue } = await seed(app);

    const res = await agent
      .post(`/api/issues/${issue.id}/meetings`)
      .send({ date: '2099-03-01T10:00:00.000Z' });
    assert.strictEqual(res.status, 201, 'CRM meeting must be created even without video');
    assert.ok(res.body.meetError, 'response should carry the provisioning error');
    assert.strictEqual(res.body.roomId, undefined);

    const list = await agent.get('/api/meetings');
    assert.strictEqual(list.body.length, 1);
  });

  test('access URLs are rewritten to the public URL when it differs from the API URL', async () => {
    const app = makeApp({ publicUrl: 'http://localhost:9080/meet' });
    const { agent, issue } = await seed(app);

    const res = await agent
      .post(`/api/issues/${issue.id}/meetings`)
      .send({ date: '2099-03-01T10:00:00.000Z' });
    assert.strictEqual(res.status, 201);
    for (const p of res.body.participants) {
      assert.ok(
        p.accessUrl.startsWith('http://localhost:9080/meet/'),
        `accessUrl should use the public URL, got ${p.accessUrl}`
      );
    }
  });

  test('client detail exposes its Meet room after a meeting is scheduled', async () => {
    const app = makeApp();
    const { agent, client, issue } = await seed(app);

    await agent.post(`/api/issues/${issue.id}/meetings`).send({ date: '2099-03-01T10:00:00.000Z' });
    const res = await agent.get(`/api/clients/${client.id}`);
    assert.ok(res.body.meetRoom);
    assert.ok(res.body.meetRoom.roomId);
  });

  test('deleting a client deletes its Meet room too', async () => {
    const app = makeApp();
    const { agent, client, issue } = await seed(app);

    const meeting = await agent
      .post(`/api/issues/${issue.id}/meetings`)
      .send({ date: '2099-03-01T10:00:00.000Z' });
    const roomId = meeting.body.roomId;
    assert.ok(fake.state.rooms.has(roomId));

    await agent.delete(`/api/clients/${client.id}`).expect(204);
    // Room deletion is fire-and-forget; give the request a moment to land.
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(!fake.state.rooms.has(roomId), 'Meet room should be deleted with the client');
  });

  test('the frontend config endpoint exposes the webcomponent script URL', async () => {
    const app = makeApp({ publicUrl: 'http://localhost:9080/meet' });
    const { agent } = await seed(app);

    const res = await agent.get('/api/config');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.meetScriptUrl, 'http://localhost:9080/meet/v1/openvidu-meet.js');
  });
});
