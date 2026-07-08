// OpenVidu Meet integration.
//
// Talks to the OpenVidu Meet REST API (https://openvidu.io, /api/v1 on the
// deployment) to provision one video room per client and one identified-guest
// member per participant. Members get a personal access URL that the frontend
// feeds to the <openvidu-meet> webcomponent.
//
// `serverUrl` is where THIS server reaches the Meet API (may be an internal
// Docker hostname); `publicUrl` is where the USER'S BROWSER reaches the same
// deployment. Access URLs returned by Meet are based on the request host, so
// they are rewritten from serverUrl to publicUrl before being stored.

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
    const anonymous = (room.access && room.access.anonymous) || {};
    client.meetRoom = {
      roomId: room.roomId,
      roomName: room.roomName,
      moderatorUrl: toPublicUrl(anonymous.moderator && anonymous.moderator.url),
      speakerUrl: toPublicUrl(anonymous.speaker && anonymous.speaker.url),
    };
    client.meetMembers = {};
    return client.meetRoom;
  }

  // Add an identified guest to the client's room (once per person), returning
  // the member with their personal access URL.
  async function ensureMember(client, key, name, baseRole) {
    client.meetMembers = client.meetMembers || {};
    if (client.meetMembers[key]) return client.meetMembers[key];
    const member = await api('POST', `rooms/${client.meetRoom.roomId}/members`, {
      name,
      baseRole,
    });
    client.meetMembers[key] = {
      memberId: member.memberId,
      name: member.name,
      baseRole: member.baseRole,
      accessUrl: toPublicUrl(member.accessUrl),
    };
    return client.meetMembers[key];
  }

  // Provision everything a scheduled meeting needs: the client's room plus the
  // user (moderator) and client contact (speaker) as room members.
  // Returns { roomId, participants } for the meeting record.
  async function provisionMeeting(client, user) {
    const clientContactName = client.contactName || client.companyName;

    const provision = async () => {
      await ensureClientRoom(client);
      const userMember = await ensureMember(client, `user:${user.id}`, user.name, 'moderator');
      const clientMember = await ensureMember(client, 'client', clientContactName, 'speaker');
      return {
        roomId: client.meetRoom.roomId,
        participants: [
          { kind: 'user', userId: user.id, name: userMember.name, role: 'moderator', memberId: userMember.memberId, accessUrl: userMember.accessUrl },
          { kind: 'client', name: clientMember.name, role: 'speaker', memberId: clientMember.memberId, accessUrl: clientMember.accessUrl },
        ],
      };
    };

    try {
      return await provision();
    } catch (error) {
      // The room may have been deleted from the Meet console; recreate once.
      if (error.statusCode === 404 && client.meetRoom) {
        delete client.meetRoom;
        delete client.meetMembers;
        return provision();
      }
      throw error;
    }
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
    provisionMeeting,
    deleteClientRoom,
  };
}

module.exports = { createMeetService };
