// OpenVidu Meet integration.
//
// Talks to the OpenVidu Meet 3.7.0 REST API (/api/v1 on the deployment) to
// provision one video room per client. In 3.7.0 a room exposes two role-based
// access URLs (moderatorUrl / speakerUrl); participant identity is set by the
// <openvidu-meet> webcomponent's participant-name attribute. The CRM adds the
// assigned user (moderator) and the client contact (speaker) as the meeting's
// participants, each with their access URL.
//
// `serverUrl` is where THIS server reaches the Meet API (may be an internal
// Docker hostname); `publicUrl` is where the USER'S BROWSER reaches the same
// deployment. Access URLs returned by Meet are rewritten from serverUrl to
// publicUrl before being stored.

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
      }
    }
    const room = await api('POST', 'rooms', { roomName: client.companyName });
    client.meetRoom = {
      roomId: room.roomId,
      roomName: room.roomName,
      moderatorUrl: toPublicUrl(room.moderatorUrl),
      speakerUrl: toPublicUrl(room.speakerUrl),
    };
    return client.meetRoom;
  }

  // Provision everything a scheduled meeting needs: the client's room, with
  // the user joining as moderator and the client contact as speaker.
  // Returns { roomId, participants } for the meeting record.
  async function provisionMeeting(client, user) {
    const room = await ensureClientRoom(client);
    const clientContactName = client.contactName || client.companyName;
    return {
      roomId: room.roomId,
      participants: [
        { kind: 'user', userId: user.id, name: user.name, role: 'moderator', accessUrl: room.moderatorUrl },
        { kind: 'client', name: clientContactName, role: 'speaker', accessUrl: room.speakerUrl },
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
    provisionMeeting,
    deleteClientRoom,
  };
}

module.exports = { createMeetService };
