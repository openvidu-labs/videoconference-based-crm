# Deploying Lilac CRM with OpenVidu Meet

This folder deploys the CRM together with a local
[OpenVidu Meet 3.7.0 deployment](https://openvidu.io/latest/meet/deployment/local/),
so that meetings scheduled in the CRM happen inside the app through the
[OpenVidu Meet webcomponent](https://openvidu.io/latest/meet/embedded/reference/webcomponent/).

## Prerequisites

- Docker Engine / Docker Desktop >= 28.4.0 (Compose with OCI artifact support)
- ~10 GB free disk space (OpenVidu images), 4+ CPU cores, 8+ GB RAM

## Quick start

```bash
./up.sh
```

This will:

1. Build the CRM image (`lilac-crm:latest`) from `Dockerfile`.
2. Pull the official OpenVidu local deployment compose artifact
   (`oci://openvidu/local-meet:3.7.0`) and merge `docker-compose.app.yml` into
   the same Compose project, so the CRM container shares the OpenVidu network.
3. Start everything detached.

When it finishes:

| Service | URL | Credentials |
|---|---|---|
| CRM app | http://localhost:3000 | register your own user |
| OpenVidu Meet console | http://localhost:9080 | `admin` / `admin` |
| Meet REST API docs | http://localhost:9080/meet/api/v1/docs/ | API key `meet-api-key` |

To stop everything:

```bash
./down.sh        # keep OpenVidu data volumes
./down.sh -v     # also remove volumes
```

## How the CRM talks to OpenVidu

| Variable | Default (compose) | Meaning |
|---|---|---|
| `OV_MEET_SERVER_URL` | `http://caddy-proxy:9080/meet` | Where the CRM **server** reaches the Meet REST API (internal Docker network, through the deployment's Caddy proxy). |
| `OV_MEET_PUBLIC_URL` | `http://localhost:9080/meet` | Where the **browser** reaches the deployment. Meeting/room links returned by the Meet API are rewritten to this origin, and the webcomponent script is loaded from it. |
| `OV_MEET_API_KEY` | `meet-api-key` | Meet REST API key (`X-API-KEY` header). This is the local deployment's initial key. |

If you access the CRM from another machine on your LAN, follow the
[OpenVidu LAN instructions](https://openvidu.io/latest/meet/deployment/local/)
(`LAN_PRIVATE_IP`) and set `OV_MEET_PUBLIC_URL` accordingly before running
`./up.sh`, e.g.:

```bash
export OV_MEET_PUBLIC_URL="https://192-168-1-100.openvidu-local.dev:9443/meet"
./up.sh
```

## Running without Docker (development)

The defaults in the app (`http://localhost:9080/meet`, key `meet-api-key`)
already match the local OpenVidu deployment, so you can also run OpenVidu with
the official command and the CRM with plain Node:

```bash
docker compose -p openvidu-meet -f oci://openvidu/local-meet:3.7.0 up -y openvidu-meet-init
npm start
```
