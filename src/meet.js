// OpenVidu Meet integration.
//
// Talks to the OpenVidu Meet 3.8.0 REST API (/api/v1 on the deployment) to
// provision one video room per client and per-person "invited guest" room
// members (identified guests): each CRM user joins as a moderator guest —
// created under the hood when needed — and the client contact is added as a
// speaker guest whose role/permissions can be tuned from the CRM UI through
// the members API (baseRole + customPermissions).
//
// `serverUrl` is where THIS server reaches the Meet API (may be an internal
// Docker hostname); `publicUrl` is where the USER'S BROWSER reaches the same
// deployment. Access URLs returned by Meet are rewritten from serverUrl to
// publicUrl before being stored.

// The fine-grained member permissions of OpenVidu Meet 3.8.0.
const PERMISSION_KEYS = [
  'canRecord',
  'canRetrieveRecordings',
  'canDeleteRecordings',
  'canJoinMeeting',
  'canShareAccessLinks',
  'canMakeModerator',
  'canKickParticipants',
  'canEndMeeting',
  'canPublishVideo',
  'canPublishAudio',
  'canShareScreen',
  'canReadChat',
  'canWriteChat',
  'canChangeVirtualBackground',
];

const MEMBER_ROLES = ['moderator', 'speaker'];

// Key of the client contact's guest membership in client.meetMembers.
const CLIENT_MEMBER_KEY = 'client';

function createMeetService(options = {}) {
  const serverUrl = (options.serverUrl || process.env.OV_MEET_SERVER_URL || 'http://localhost:9080/meet')
    .replace(/\/$/, '');
  const publicUrl = (options.publicUrl || process.env.OV_MEET_PUBLIC_URL || serverUrl)
    .replace(/\/$/, '');
  const apiKey = options.apiKey || process.env.OV_MEET_API_KEY || 'meet-api-key';

  async function api(method, path, body) {
    const response = await fetch(`${serverUrl}/api/v1/${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': apiKey,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    let responseBody = null;
    try {
      responseBody = await response.json();
    } catch { /* some responses have no JSON body */ }
    if (!response.ok) {
      const error = new Error(
        (responseBody && responseBody.message) || `OpenVidu Meet API error (${response.status})`
      );
      error.statusCode = response.status;
      throw error;
    }
    return responseBody;
  }

  function toPublicUrl(url) {
    if (typeof url === 'string' && url.startsWith(serverUrl)) {
      return publicUrl + url.slice(serverUrl.length);
    }
    return url;
  }

  function storeMember(client, key, member) {
    client.meetMembers = client.meetMembers || {};
    client.meetMembers[key] = {
      memberId: member.memberId,
      name: member.name,
      baseRole: member.baseRole,
      accessUrl: toPublicUrl(member.accessUrl),
      customPermissions: member.customPermissions || null,
      effectivePermissions: member.effectivePermissions || null,
    };
    return client.meetMembers[key];
  }

  // Create the client's Meet room if it does not exist yet. A cached room is
  // verified against the API in case it was deleted from the Meet console.
  async function ensureClientRoom(client) {
    if (client.meetRoom && client.meetRoom.roomId) {
      try {
        await api('GET', `rooms/${client.meetRoom.roomId}`);
        return client.meetRoom;
      } catch (error) {
        if (error.statusCode !== 404) throw error;
        delete client.meetRoom;
        delete client.meetMembers;
      }
    }
    const room = await api('POST', 'rooms', { roomName: client.companyName });
    client.meetRoom = { roomId: room.roomId, roomName: room.roomName };
    client.meetMembers = {};
    return client.meetRoom;
  }

  // Add an invited guest (identified guest member) to the client's room, once
  // per key. Returns the stored member with their personal access URL.
  async function ensureMember(client, key, { name, baseRole, customPermissions }) {
    client.meetMembers = client.meetMembers || {};
    if (client.meetMembers[key]) return client.meetMembers[key];
    const body = { name, baseRole };
    if (customPermissions && Object.keys(customPermissions).length > 0) {
      body.customPermissions = customPermissions;
    }
    // effectivePermissions is an opt-in extra field of the members API.
    const member = await api(
      'POST',
      `rooms/${client.meetRoom.roomId}/members?extraFields=effectivePermissions`,
      body
    );
    return storeMember(client, key, member);
  }

  // The CRM user joins as an invited guest with moderator role, created under
  // the hood the first time this user needs access to the client's room.
  async function ensureUserMember(client, user) {
    await ensureClientRoom(client);
    return ensureMember(client, `user:${user.id}`, { name: user.name, baseRole: 'moderator' });
  }

  // The client contact is added as an invited guest, a speaker by default;
  // finer-grained access is set later via updateClientMemberPermissions().
  async function ensureClientMember(client, options = {}) {
    await ensureClientRoom(client);
    return ensureMember(client, CLIENT_MEMBER_KEY, {
      name: client.contactName || client.companyName,
      baseRole: options.baseRole || 'speaker',
      customPermissions: options.customPermissions,
    });
  }

  // Update the client guest's role and/or fine-grained permissions.
  async function updateClientMemberPermissions(client, { baseRole, customPermissions }) {
    const existing = client.meetMembers && client.meetMembers[CLIENT_MEMBER_KEY];
    if (!existing) {
      throw Object.assign(new Error('The client is not a member of the meeting room yet'), {
        statusCode: 409,
      });
    }
    const body = {};
    if (baseRole !== undefined) body.baseRole = baseRole;
    if (customPermissions !== undefined) body.customPermissions = customPermissions;
    const member = await api(
      'PUT',
      `rooms/${client.meetRoom.roomId}/members/${existing.memberId}?extraFields=effectivePermissions`,
      body
    );
    return storeMember(client, CLIENT_MEMBER_KEY, member);
  }

  function clientMember(client) {
    return (client.meetMembers && client.meetMembers[CLIENT_MEMBER_KEY]) || null;
  }

  // Provision everything a scheduled meeting needs: the client's room, the
  // user's moderator guest membership and the client's speaker guest
  // membership. Returns { roomId, participants } for the meeting record.
  async function provisionMeeting(client, user) {
    const userMember = await ensureUserMember(client, user);
    const contactMember = await ensureClientMember(client);
    return {
      roomId: client.meetRoom.roomId,
      participants: [
        {
          kind: 'user',
          userId: user.id,
          name: userMember.name,
          role: userMember.baseRole,
          memberId: userMember.memberId,
          accessUrl: userMember.accessUrl,
        },
        {
          kind: 'client',
          name: contactMember.name,
          role: contactMember.baseRole,
          memberId: contactMember.memberId,
          accessUrl: contactMember.accessUrl,
        },
      ],
    };
  }

  // Best-effort room removal (used when a client is deleted).
  async function deleteClientRoom(client) {
    if (!client.meetRoom || !client.meetRoom.roomId) return;
    try {
      await api('DELETE', `rooms/${client.meetRoom.roomId}?withMeeting=force&withRecordings=force`);
    } catch (error) {
      console.error(`Could not delete Meet room '${client.meetRoom.roomId}': ${error.message}`);
    }
  }

  return {
    publicUrl,
    scriptUrl: `${publicUrl}/v1/openvidu-meet.js`,
    ensureUserMember,
    ensureClientMember,
    updateClientMemberPermissions,
    clientMember,
    provisionMeeting,
    deleteClientRoom,
  };
}

module.exports = { createMeetService, PERMISSION_KEYS, MEMBER_ROLES };
