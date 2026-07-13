const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const express = require('express');

const { createApp } = require('../src/app');
const store = require('../src/store');
const { PERMISSION_KEYS } = require('../src/meet');

// Default per-role permissions of OpenVidu Meet 3.8.0
// (from meet-ce/backend/src/services/room.service.ts, tag v3.8.0).
const MODERATOR_DEFAULTS = Object.fromEntries(PERMISSION_KEYS.map((k) => [k, true]));
const SPEAKER_DEFAULTS = {
  ...MODERATOR_DEFAULTS,
  canRecord: false,
  canDeleteRecordings: false,
  canShareAccessLinks: false,
  canMakeModerator: false,
  canKickParticipants: false,
  canEndMeeting: false,
};

// Fake OpenVidu Meet 3.8.0 server implementing the subset of the REST API the
// CRM uses: rooms plus the room-members API with baseRole/customPermissions.
function startFakeMeet() {
  const app = express();
  app.use(express.json());

  const state = {
    calls: [],
    rooms: new Map(), // roomId -> { room, members: Map<memberId, member> }
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

  function effectivePermissions(baseRole, customPermissions) {
    const defaults = baseRole === 'moderator' ? MODERATOR_DEFAULTS : SPEAKER_DEFAULTS;
    return { ...defaults, ...(customPermissions || {}) };
  }

  app.post('/meet/api/v1/rooms', (req, res) => {
    const { roomName } = req.body;
    if (!roomName) return res.status(422).json({ message: 'roomName is required' });
    const roomId = `${roomName.toLowerCase().replace(/\s+/g, '_')}-${++state.counter}`;
    const room = { roomId, roomName, status: 'open' };
    state.rooms.set(roomId, { room, members: new Map() });
    res.status(201).json(room);
  });

  app.get('/meet/api/v1/rooms/:roomId', (req, res) => {
    const entry = state.rooms.get(req.params.roomId);
    if (!entry) return res.status(404).json({ message: 'Room not found' });
    res.json(entry.room);
  });

  app.delete('/meet/api/v1/rooms/:roomId', (req, res) => {
    if (!state.rooms.delete(req.params.roomId)) {
      return res.status(404).json({ message: 'Room not found' });
    }
    res.status(200).json({ message: 'deleted' });
  });

  app.post('/meet/api/v1/rooms/:roomId/members', (req, res) => {
    const entry = state.rooms.get(req.params.roomId);
    if (!entry) return res.status(404).json({ message: 'Room not found' });
    const { name, userId, baseRole, customPermissions } = req.body;
    if ((!name && !userId) || (name && userId)) {
      return res.status(422).json({ message: 'Either userId or name must be provided, but not both' });
    }
    if (!['moderator', 'speaker'].includes(baseRole)) {
      return res.status(422).json({ message: 'invalid baseRole' });
    }
    const memberId = `ig-${++state.counter}`;
    const member = {
      memberId,
      roomId: entry.room.roomId,
      type: 'identified_guest',
      name,
      baseRole,
      customPermissions,
      effectivePermissions: effectivePermissions(baseRole, customPermissions),
      accessUrl: `${state.baseUrl}/room/${entry.room.roomId}?member=${memberId}`,
      membershipDate: 1780000000000,
    };
    entry.members.set(memberId, member);
    res.status(201).json(memberResponse(member, req));
  });

  app.put('/meet/api/v1/rooms/:roomId/members/:memberId', (req, res) => {
    const entry = state.rooms.get(req.params.roomId);
    const member = entry && entry.members.get(req.params.memberId);
    if (!member) return res.status(404).json({ message: 'Member not found' });
    const { baseRole, customPermissions } = req.body;
    if (baseRole !== undefined) member.baseRole = baseRole;
    if (customPermissions !== undefined) member.customPermissions = customPermissions;
    member.effectivePermissions = effectivePermissions(member.baseRole, member.customPermissions);
    res.json(memberResponse(member, req));
  });

  // Like the real 3.8.0 API, effectivePermissions is only returned when
  // requested through the extraFields query param (or X-ExtraFields header).
  function memberResponse(member, req) {
    const extra = req.query.extraFields || req.headers['x-extrafields'] || '';
    if (String(extra).split(',').includes('effectivePermissions')) return member;
    const { effectivePermissions: _omitted, ...rest } = member;
    return rest;
  }

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

describe('OpenVidu Meet 3.8.0 integration', () => {
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

  function memberCalls() {
    return fake.state.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/members'));
  }

  describe('meeting scheduling', () => {
    test('creates the client room with user (moderator) and client (speaker) as invited guests', async () => {
      const app = makeApp();
      const { agent, user, issue } = await seed(app);

      const res = await agent
        .post(`/api/issues/${issue.id}/meetings`)
        .send({ date: '2099-03-01T10:00:00.000Z' });
      assert.strictEqual(res.status, 201);

      const meeting = res.body;
      assert.ok(meeting.roomId);
      assert.strictEqual(meeting.meetError, undefined);

      const roomCalls = fake.state.calls.filter((c) => c.method === 'POST' && c.path === '/meet/api/v1/rooms');
      assert.strictEqual(roomCalls.length, 1);
      assert.strictEqual(roomCalls[0].body.roomName, 'Acme Corp');
      assert.strictEqual(roomCalls[0].apiKey, 'meet-api-key');

      // Both invited-guest members created: user as moderator, contact as speaker.
      const members = memberCalls();
      assert.strictEqual(members.length, 2);
      const byRole = Object.fromEntries(members.map((c) => [c.body.baseRole, c.body.name]));
      assert.strictEqual(byRole.moderator, user.name);
      assert.strictEqual(byRole.speaker, 'John Acme');

      // Participants carry each member's personal access URL.
      const userPart = meeting.participants.find((p) => p.kind === 'user');
      const clientPart = meeting.participants.find((p) => p.kind === 'client');
      assert.strictEqual(userPart.role, 'moderator');
      assert.strictEqual(clientPart.role, 'speaker');
      assert.match(userPart.accessUrl, /member=ig-/);
      assert.match(clientPart.accessUrl, /member=ig-/);
      assert.notStrictEqual(userPart.accessUrl, clientPart.accessUrl);
    });

    test('a second meeting reuses the room and the guest memberships', async () => {
      const app = makeApp();
      const { agent, issue } = await seed(app);

      const first = await agent
        .post(`/api/issues/${issue.id}/meetings`)
        .send({ date: '2099-03-01T10:00:00.000Z' });
      const second = await agent
        .post(`/api/issues/${issue.id}/meetings`)
        .send({ date: '2099-04-01T10:00:00.000Z' });

      assert.strictEqual(first.body.roomId, second.body.roomId);
      assert.strictEqual(
        fake.state.calls.filter((c) => c.method === 'POST' && c.path === '/meet/api/v1/rooms').length,
        1
      );
      assert.strictEqual(memberCalls().length, 2, 'members are not re-created');
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
    });

    test('an unassigned issue uses the scheduling user as moderator', async () => {
      const app = makeApp();
      const { agent, user, client } = await seed(app);
      const unassigned = (
        await agent.post('/api/issues').send({ title: 'No assignee', clientId: client.id })
      ).body;

      const res = await agent
        .post(`/api/issues/${unassigned.id}/meetings`)
        .send({ date: '2099-05-01T10:00:00.000Z' });
      const userPart = res.body.participants.find((p) => p.kind === 'user');
      assert.strictEqual(userPart.name, user.name);
      assert.strictEqual(userPart.role, 'moderator');
    });

    test('if the Meet room was deleted externally, scheduling recreates room and members', async () => {
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
      assert.notStrictEqual(second.body.roomId, first.body.roomId);
      assert.strictEqual(second.body.participants.length, 2);
      assert.strictEqual(memberCalls().length, 4, 'members are re-created in the new room');
    });

    test('meetings are still registered when OpenVidu Meet is unreachable', async () => {
      const app = createApp({
        meet: { serverUrl: 'http://127.0.0.1:1/meet', apiKey: 'meet-api-key' },
      });
      const { agent, issue } = await seed(app);

      const res = await agent
        .post(`/api/issues/${issue.id}/meetings`)
        .send({ date: '2099-03-01T10:00:00.000Z' });
      assert.strictEqual(res.status, 201);
      assert.ok(res.body.meetError);
      assert.strictEqual(res.body.roomId, undefined);
    });

    test('access URLs are rewritten to the public URL when it differs from the API URL', async () => {
      const app = makeApp({ publicUrl: 'http://localhost:9080/meet' });
      const { agent, issue } = await seed(app);

      const res = await agent
        .post(`/api/issues/${issue.id}/meetings`)
        .send({ date: '2099-03-01T10:00:00.000Z' });
      for (const p of res.body.participants) {
        assert.ok(p.accessUrl.startsWith('http://localhost:9080/meet/'), p.accessUrl);
      }
    });
  });

  describe('per-user room access', () => {
    test('joining a meeting adds the logged-in user as a moderator guest under the hood', async () => {
      const app = makeApp();
      const { agent, issue } = await seed(app);
      const meeting = (
        await agent.post(`/api/issues/${issue.id}/meetings`).send({ date: '2099-03-01T10:00:00.000Z' })
      ).body;

      // A second CRM user (not the assignee) joins the same meeting.
      const colleague = request.agent(app);
      await colleague
        .post('/api/register')
        .send({ name: 'Bob Backup', email: 'bob@example.com', password: 'secret123' });
      const res = await colleague.post(`/api/meetings/${meeting.id}/join`);

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.name, 'Bob Backup');
      assert.strictEqual(res.body.role, 'moderator');
      const userPart = meeting.participants.find((p) => p.kind === 'user');
      assert.notStrictEqual(res.body.accessUrl, userPart.accessUrl, 'each user gets their own membership');

      // Joining again reuses the membership.
      await colleague.post(`/api/meetings/${meeting.id}/join`);
      const bobMembers = memberCalls().filter((c) => c.body.name === 'Bob Backup');
      assert.strictEqual(bobMembers.length, 1);
    });
  });

  describe('client guest access and fine-grained permissions', () => {
    test('the client can be added as an invited guest with speaker permissions by default', async () => {
      const app = makeApp();
      const { agent, client } = await seed(app);

      const res = await agent.post(`/api/clients/${client.id}/meet-access`).send({});
      assert.strictEqual(res.status, 201);
      assert.ok(res.body.meetRoom.roomId, 'room is created if it does not exist');
      assert.strictEqual(res.body.member.name, 'John Acme');
      assert.strictEqual(res.body.member.baseRole, 'speaker');
      // Speaker defaults from OpenVidu Meet 3.8.0.
      assert.strictEqual(res.body.member.effectivePermissions.canJoinMeeting, true);
      assert.strictEqual(res.body.member.effectivePermissions.canPublishVideo, true);
      assert.strictEqual(res.body.member.effectivePermissions.canEndMeeting, false);
      assert.strictEqual(res.body.member.effectivePermissions.canKickParticipants, false);
    });

    test('custom permissions can be set when adding the guest', async () => {
      const app = makeApp();
      const { agent, client } = await seed(app);

      const res = await agent
        .post(`/api/clients/${client.id}/meet-access`)
        .send({ customPermissions: { canShareScreen: false, canRecord: true } });
      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.member.effectivePermissions.canShareScreen, false);
      assert.strictEqual(res.body.member.effectivePermissions.canRecord, true);
    });

    test('the guest permissions can be updated with fine-grained values', async () => {
      const app = makeApp();
      const { agent, client } = await seed(app);
      await agent.post(`/api/clients/${client.id}/meet-access`).send({});

      const res = await agent
        .put(`/api/clients/${client.id}/meet-access`)
        .send({ baseRole: 'speaker', customPermissions: { canWriteChat: false, canShareAccessLinks: true } });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.member.effectivePermissions.canWriteChat, false);
      assert.strictEqual(res.body.member.effectivePermissions.canShareAccessLinks, true);
      assert.strictEqual(res.body.member.effectivePermissions.canPublishAudio, true);

      // The update was sent to the Meet members API.
      const putCalls = fake.state.calls.filter((c) => c.method === 'PUT' && c.path.includes('/members/'));
      assert.strictEqual(putCalls.length, 1);
      assert.deepStrictEqual(putCalls[0].body.customPermissions, {
        canWriteChat: false,
        canShareAccessLinks: true,
      });
    });

    test('the guest can be promoted to moderator', async () => {
      const app = makeApp();
      const { agent, client } = await seed(app);
      await agent.post(`/api/clients/${client.id}/meet-access`).send({});

      const res = await agent
        .put(`/api/clients/${client.id}/meet-access`)
        .send({ baseRole: 'moderator' });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.member.baseRole, 'moderator');
      assert.strictEqual(res.body.member.effectivePermissions.canEndMeeting, true);
    });

    test('invalid roles and unknown permissions are rejected', async () => {
      const app = makeApp();
      const { agent, client } = await seed(app);
      await agent.post(`/api/clients/${client.id}/meet-access`).send({});

      const badRole = await agent
        .put(`/api/clients/${client.id}/meet-access`)
        .send({ baseRole: 'admin' });
      assert.strictEqual(badRole.status, 400);

      const badPermission = await agent
        .put(`/api/clients/${client.id}/meet-access`)
        .send({ customPermissions: { canFly: true } });
      assert.strictEqual(badPermission.status, 400);

      const badValue = await agent
        .put(`/api/clients/${client.id}/meet-access`)
        .send({ customPermissions: { canRecord: 'yes' } });
      assert.strictEqual(badValue.status, 400);
    });

    test('updating permissions before the guest exists fails cleanly', async () => {
      const app = makeApp();
      const { agent, client } = await seed(app);

      const res = await agent
        .put(`/api/clients/${client.id}/meet-access`)
        .send({ baseRole: 'moderator' });
      assert.strictEqual(res.status, 409);
    });

    test('client detail exposes the room and the guest membership with its permissions', async () => {
      const app = makeApp();
      const { agent, client } = await seed(app);
      await agent.post(`/api/clients/${client.id}/meet-access`).send({});

      const res = await agent.get(`/api/clients/${client.id}`);
      assert.ok(res.body.meetRoom.roomId);
      const member = res.body.meetMembers.client;
      assert.strictEqual(member.baseRole, 'speaker');
      assert.ok(member.accessUrl);
      assert.strictEqual(typeof member.effectivePermissions.canJoinMeeting, 'boolean');
    });
  });

  describe('housekeeping', () => {
    test('deleting a client deletes its Meet room too', async () => {
      const app = makeApp();
      const { agent, client, issue } = await seed(app);
      const meeting = await agent
        .post(`/api/issues/${issue.id}/meetings`)
        .send({ date: '2099-03-01T10:00:00.000Z' });
      assert.ok(fake.state.rooms.has(meeting.body.roomId));

      await agent.delete(`/api/clients/${client.id}`).expect(204);
      await new Promise((r) => setTimeout(r, 100));
      assert.ok(!fake.state.rooms.has(meeting.body.roomId));
    });

    test('the frontend config endpoint exposes the webcomponent script URL', async () => {
      const app = makeApp({ publicUrl: 'http://localhost:9080/meet' });
      const { agent } = await seed(app);

      const res = await agent.get('/api/config');
      assert.strictEqual(res.body.meetScriptUrl, 'http://localhost:9080/meet/v1/openvidu-meet.js');
    });
  });
});
