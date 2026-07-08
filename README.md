# Lilac CRM

A small CRM to manage **clients**, **issues** and **meetings**, with login and
self-service user registration. All data lives in an **in-memory database**, so
it runs with a single command and resets on restart.

Online meetings happen **inside the app**, powered by
[OpenVidu Meet](https://openvidu.io) and its embedded webcomponent — see
[OpenVidu integration](#openvidu-meet-integration) and [`deploy/`](deploy/README.md).

## Run

```bash
npm install
npm start
```

Then open http://localhost:3000 (set `PORT` to change it).

## Test

```bash
npm test
```

Tests were written first and cover authentication, user management, clients,
issues (statuses, assignment), meetings (planning, summaries, past/planned)
and the SPA entry point.

## Features

- **Login / registration** — new users register themselves from the sign-in page.
- **Clients** — company name, contact details, notes, plus the client's list of
  present and past issues.
- **Issues** — problems a client is facing; each has an assigned user, a status
  (`open`, `in-progress`, `resolved`, `closed`), and its meetings.
- **Meetings** — online meetings held inside the app via OpenVidu Meet; the app
  registers the date and a brief resume. Shown as a monthly calendar or a
  planned/past list.
- **User profile** — update name, email and password.

## OpenVidu Meet integration

When a meeting is scheduled for an issue, the CRM:

1. Creates an OpenVidu Meet **room for the issue's client** (once per client,
   reused for later meetings).
2. Adds the assigned user (moderator) and the client contact (speaker) as
   **room members** — identified guests with personal access links.
3. Registers both as the meeting's **participants**.

From the UI you can then **join the meeting embedded in the app** (the
`<openvidu-meet>` webcomponent) and **copy the client's personal link** to send
them. If OpenVidu is not running, meetings are still registered — just without
a video room.

Configuration (defaults match the
[local OpenVidu deployment](https://openvidu.io/latest/meet/deployment/local/)):

| Env var | Default | Meaning |
|---|---|---|
| `OV_MEET_SERVER_URL` | `http://localhost:9080/meet` | Meet REST API base as reached by this server |
| `OV_MEET_PUBLIC_URL` | same as server URL | Meet base as reached by browsers (links are rewritten to it) |
| `OV_MEET_API_KEY` | `meet-api-key` | Meet REST API key |

To run everything (OpenVidu 3.7.0 + the CRM) with Docker, see
[`deploy/README.md`](deploy/README.md) — TL;DR: `cd deploy && ./up.sh`.

## Layout & stack

Left panel with navigation (Clients, Issues, Meetings, User profile); right
panel shows the content as card grids, detail pages, or the meetings calendar.
Light-purple branding throughout.

- Backend: Node.js + Express, session auth (`express-session`), scrypt password
  hashing, in-memory store (`src/store.js`).
- Frontend: dependency-free vanilla JS SPA in `public/`.
- Tests: `node:test` + supertest.
