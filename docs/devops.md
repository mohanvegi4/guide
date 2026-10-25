---
title: DevOps quick guide
nav_order: 5
---

# DevOps quick guide

The short version of running Guide Engine on one server with the `deploy/` stack. Each task is a
few commands. The [Guide Engine reference](../README.md#deploying) has the full detail, and
[How Guide Engine is built](architecture.md#14-deployment-and-operations) explains why the stack
looks the way it does.

## What runs

| Container | Image | Job |
|---|---|---|
| `caddy` | `caddy:2-alpine` | HTTPS for the three hostnames (certificates are automatic) |
| `studio` | `ghcr.io/mohanvegi4/guide/studio` | The Studio website (nginx), forwards `/api` to the backend |
| `backend` | `ghcr.io/mohanvegi4/guide/backend` | The API and the agent script; runs database migrations when it starts |
| `keycloak` | `quay.io/keycloak/keycloak:26.0` | Studio sign-in |
| `postgres` | `postgres:16` | Two databases: `guide_engine` and `keycloak`, each with its own user |
| `backup` | `postgres:16` | Dumps both databases every night into `deploy/backups/` |
| `prometheus`, `alertmanager` | `prom/prometheus:v3`, `prom/alertmanager:v0.34.1` | Optional (`--profile monitoring`): metrics and alerts |

Only Caddy is reachable from outside, on ports 80 and 443. It serves three hostnames you choose:

| Hostname | Goes to |
|---|---|
| `STUDIO_HOST` | the Studio |
| `API_HOST` | the backend; customer websites load the agent from here |
| `AUTH_HOST` | Keycloak; its `/admin` console only from `ADMIN_ALLOW_CIDRS` |

## Files you touch

All in `deploy/` on the server:

| File | What it is |
|---|---|
| `.env` | Every setting and secret. Start from `.env.example`. Never commit it. |
| `docker-compose.yml` | The stack. You normally don't edit it. |
| `Caddyfile` | Hostnames, HTTPS, the Keycloak admin allowlist. |
| `keycloak-import/guide-engine-realm.json` | Written once by `render-realm.sh`; Keycloak reads it on first start only. |
| `backups/` | Nightly database dumps. Copy them off the server. |
| `monitoring/` | Prometheus scrape config, alert rules, Alertmanager receiver. |

## First install

1. Point three DNS names at the server: Studio, API and auth.
2. Install Docker with the compose plugin, and `jq`.
3. Get the `deploy/` folder onto the server (clone the repository, or copy the folder).
4. Fill in the settings:
   ```bash
   cd deploy
   cp .env.example .env
   openssl rand -hex 32   # run twice: PREVIEW_TOKEN_SECRET and SECRETS_KEY
   ```
   Set the three hostnames, `ACME_EMAIL`, the three database passwords, the Keycloak admin password,
   and `ADMIN_ALLOW_CIDRS` (your office or VPN range).
5. Prepare the Keycloak realm, then start everything:
   ```bash
   ./render-realm.sh
   docker compose up -d --wait
   ```
6. Create the first user in Keycloak at `https://AUTH_HOST/admin` (realm **guide-engine** →
   **Users → Add user**, tick **Email verified**, set a password on **Credentials**).
7. That person signs in to the Studio and creates the first organization.
8. Make them a platform admin, once:
   ```bash
   docker compose exec postgres psql -U postgres -d guide_engine \
     -c "UPDATE studio_user SET platform_admin = TRUE WHERE email = 'them@example.com';"
   ```

## Everyday tasks

**Is it healthy?**
```bash
docker compose ps
curl -s https://API_HOST/ready            # {"ok":true} when the backend reaches the database
curl -s https://API_HOST/agent/v1/version # which agent build customers get
```

**Read the logs.** One JSON line per request; add `| npx pino-pretty` to read them comfortably.
```bash
docker compose logs -f --tail=100 backend
```

**Deploy a new version.** CI publishes images tagged `latest` and with the commit SHA. Take a backup
first, then pull and restart. The backend migrates the database by itself.
```bash
docker compose run --rm backup now
docker compose pull backend studio
docker compose up -d --wait
```
To pin an exact build, set `BACKEND_IMAGE` and `STUDIO_IMAGE` in `.env` to
`ghcr.io/mohanvegi4/guide/backend:<sha>` and `…/studio:<sha>`.

**Roll back.** Set the two image variables to the previous SHA and run `docker compose up -d --wait`.
Customers' browsers pick up the older agent within five minutes.

**Back up and restore.** Dumps run every night at `BACKUP_AT` and are kept `BACKUP_KEEP_DAYS` days.
```bash
docker compose run --rm backup now
./restore.sh guide_engine backups/guide_engine-<stamp>.dump --yes   # or: keycloak
```
`restore.sh` takes a safety dump first, so a restore can itself be undone. Rehearse a restore once
on a spare server before you need it.

**Let someone into the Keycloak admin console.** Add their network to `ADMIN_ALLOW_CIDRS` in
`.env`, then `docker compose up -d caddy`.

**Turn guides off.** For one app: its **Guides on/off** switch in the Studio. For everyone: the
switch on the Studio's **Administration** page.

**More capacity.** Set `BACKEND_REPLICAS=2` (or more) in `.env` and `docker compose up -d --wait`.

**Monitoring.** Set `METRICS_TOKEN` and `ALERT_WEBHOOK_URL` in `.env`, then:
```bash
docker compose --profile monitoring up -d
```
Prometheus and Alertmanager listen on `127.0.0.1` only (ports 9090 and 9093); reach them over SSH.

## Secrets

| Secret | Where | If it leaks or is lost |
|---|---|---|
| Database and Keycloak admin passwords | `.env` | Change in `.env` and in the database or Keycloak, restart |
| `SECRETS_KEY` | `.env` | Every app must generate a new signing secret in the Studio. Back it up with `.env`. |
| `PREVIEW_TOKEN_SECRET` | `.env` | Change it and restart; open preview links stop working |
| `METRICS_TOKEN`, `ALERT_WEBHOOK_URL` | `.env` | Change and restart the monitoring profile |
| App public keys and signing secrets | the database, managed in the Studio | Rotate in the app's settings |

Keep `.env` and the backups in your secret store. Without `SECRETS_KEY`, a restored database can't
verify signed identities.

## When something is wrong

| Symptom | Look at |
|---|---|
| Studio says it can't reach the backend | `docker compose logs backend`; `curl https://API_HOST/ready` |
| Sign-in fails | `docker compose logs keycloak`; the Studio host in the realm's redirect URIs |
| A customer's site shows no guides | The site's origin in the app's **Websites**; the browser's Network tab for `/v1/agent/<key>/guides` |
| The backend restarts in a loop | `docker compose logs backend`: it refuses to start on a missing secret or unapplied migrations, and says which |
| Certificates fail | DNS for the three hostnames; ports 80 and 443 open; `docker compose logs caddy` |
| Disk filling up | `deploy/backups/` (lower `BACKUP_KEEP_DAYS`), `EVENT_RETENTION_DAYS` |
