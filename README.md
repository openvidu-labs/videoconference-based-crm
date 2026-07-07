# Lilac CRM

A small CRM to manage **clients**, **issues** and **meetings**, with login and
self-service user registration. All data lives in an **in-memory database**, so
it runs with a single command and resets on restart.

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
- **Meetings** — online meetings managed outside the app; the app registers the
  date and a brief resume. Shown as a monthly calendar or a planned/past list.
- **User profile** — update name, email and password.

## Layout & stack

Left panel with navigation (Clients, Issues, Meetings, User profile); right
panel shows the content as card grids, detail pages, or the meetings calendar.
Light-purple branding throughout.

- Backend: Node.js + Express, session auth (`express-session`), scrypt password
  hashing, in-memory store (`src/store.js`).
- Frontend: dependency-free vanilla JS SPA in `public/`.
- Tests: `node:test` + supertest.
