# Prompts

The prompts given to Claude Code (model: Fable 5) to build this app, in
chronological order, kept for future reference on how it was built.

## 1. Initial app

> You're an expert Node full-stack developer. Initialize an empty git
> repository. Then create a CRM app with a clean interface, that manages
> clients, issues, and meetings. The app should have a login and user
> management, with a link for new users to register themselves. Users can add
> clients, with the usual data for them: company name, contact details, and a
> list of past and present issues. Users can create issues, which are problems
> clients are facing. Each issue should have a user assigned, who will interact
> with the client to try to solve him the issue. Issues may have planned and
> past meetings, which are online meetings that are managed outside the
> application, but the application should register meeting dates and a brief
> resume of the meeting. Issues should as well have an status. All this
> information should be displayed in a page with a left panel with the
> different options: Clients, Issues, Meetings, User profile; and a right panel
> where the actual information is shown. This information should be shown as
> cards in a grid, or as a calendar for the meetings, for instance. The
> application should use a light purple color as a branding, with the
> corresponding colors that combine with it for the UI. Start by adding first
> tests to assess that the features are implemented correctly. The application
> should use an in-memory database, so that it can be run with a single
> command.


## 2. OpenVidu Meet integration

> You are a node full-stack developer. Your mission is to integrate OpenVidu 3
> into this CRM application, using webcomponents. Read the OpenVidu 3.7.0
> (latest) docs in its entirety, and prepare a branch openvidu-meet-integration
> with: a) OpenVidu Meet embedded into the CRM app so that meetings happen
> inside the app, and not in an external tool; b) a deploy folder containing
> scripts to prepare a Docker image with the app and a docker compose deploying
> both OpenVidu 3.7.0 and the app. The docs for the webcomponent instructions
> are here: https://openvidu.io/latest/meet/embedded/reference/webcomponent/.
> There are several tutorials available here:
> https://openvidu.io/latest/meet/embedded/tutorials/. We will use a local
> deployment of OpenVidu with docker compose, as documented here:
> https://openvidu.io/latest/meet/deployment/local/#running-openvidu-meet-locally.
> When a meeting is scheduled, the app should create a room for this client, if
> it does not exist yet, adding the user and client as room members, and
> schedule a meeting within the room adding both the user and the client as
> participants.

## 3. Full stack

> Run the full stack

*(running it surfaced that the room members API used by the tutorials’ master
branch does not exist in OpenVidu Meet 3.7.0; the integration was adapted to
3.7.0’s role URLs — see the next prompt)*

## 4. Versioning clarification

> The master branch is the next development version, not 3.7.0. 3.7.0 is
> freezed in its own branch. What you saw is the members API which will be
> released as part of 3.8.0, scheduled for this week. Please, stop the stack.

## 5. Release

> Tag main branch as 1.0, then merge current branch into main, and tag it as
> 2.0

## 6. Access control with OpenVidu 3.8.0

> OpenVidu 3.8.0 has been released, with a more advanced support for user
> permissions. Create a new branch control-access-ov-380 and update the project
> so that it can use this new set of permissions. Specifically, the users of
> our CRM app should be able to add the client as an invited guest, initially
> with speaker permissions, but the user should be able to specify more
> fine-grained permissions in the UI. The user must be itself an invited guest
> with moderator role, created under the hood when the room for the client is
> created.

## 7. Full stack on 3.8.0

> Start the OpenVidu 3.8.0 stack with the crm app

*(live verification surfaced that 3.8.0 only returns a member's
`effectivePermissions` when requested via `extraFields`, which was fixed)*
