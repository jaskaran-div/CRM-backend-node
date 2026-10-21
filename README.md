# Derivion CRM — Node.js backend

Express 5 + TypeScript + Drizzle ORM (over `pg`) replacement for the Spring Boot backend. It uses the
existing Supabase database **as-is**: no migrations, no schema changes. Routes, methods, payloads and
response shapes match the Spring API, except for the documented security fixes below.

## Commands

```bash
npm ci            # install
npm run build     # compile to dist/
npm test          # 257 tests: unit + integration on a disposable local PostgreSQL 17
npm start         # node dist/server.js (reads env, see .env.example)
```

The tests never touch production. `test/schema.sql` is a replica of the audited production schema.

## Design notes

- **Round trips are the cost.** EC2 to Supabase is ~140 ms per query (measured), while the queries
  themselves run in under 1 ms. Most endpoints therefore make one SQL statement. Multi-step writes
  (status change + assignment deactivation, follow-up + notification + lead status, lead delete
  cascade) are single data-modifying CTE statements: atomic, with no BEGIN/COMMIT round trips.
- **Authenticated user cache**: 30 s TTL, invalidated on user writes. It replaces Spring's per-call
  `findByEmail` (40k executions in `pg_stat_statements`).
- **Time**: business dates and times are explicit `Asia/Kolkata`. JSON timestamps use Jackson's
  `LocalDateTime` format with no offset. The frontend parses them as local time.
- **Tokens**: same secret, algorithm and claims as jjwt, so tokens from either backend work on the
  other. **Passwords**: bcrypt `$2a$`, verifiable by Spring, so rollback is safe.
- **Scheduler**: follow-up reminders every 60 s. Off unless `SCHEDULER_ENABLED=true`. Uses an advisory
  lock and idempotent writes.

## Intentional behaviour changes vs Spring

| Area | Spring | Node |
|---|---|---|
| Lead assignments | AGENT could bulk-assign, create, reopen, change status, delete, list all | ADMIN/MANAGER only; AGENT reads own assignments and may transfer only leads actively assigned to them |
| Attendance/break `agentId` | Trusted from the client: anyone could act for any agent | Own id only; ADMIN may act for any agent; MANAGER may read |
| `POST /api/auth/logout/{agentId}` | Any user could close any agent's attendance | Own id (or ADMIN) |
| `GET /api/agent/leads/{agentId}`, `/lead-assignments/agent/{id}` | Any agent's data | Own id, or ADMIN/MANAGER |
| `GET /api/leads/campaign/{id}` | All campaign leads to agents | Agents: only their assigned leads |
| `GET /api/users[/{id}]` as AGENT | Full records incl. email/phone | `{id, fullName, role, status}` |
| `GET /api/teams/{id}/members` | All roles | ADMIN/MANAGER (exposes emails/phones) |
| Deactivated users | Valid tokens kept working until expiry | Rejected within 30 s (401) |
| Missing/invalid token | 403 | 401 `{"error": ...}`; role denial stays 403 |
| Ownership failures ("You are not allowed…") | 400 | 403, same message |
| `ResponseStatusException` (lead views, attendance delete) | Flattened to 400 with `"404 NOT_FOUND …"` text | Proper 403/404 with a clean message |
| Unexpected/DB errors | 400 with raw exception text (SQL details) | Generic message; constraint violations mapped to clear 400s |
| CORS | `*` | Closed unless `CORS_ORIGINS` is set (production is same-origin) |
| Login | No throttling | 20 failed attempts / 15 min per IP |
| `/follow-ups/today|overdue|upcoming`, lead-view date | JVM zone (UTC on EC2), up to 5.5 h off | Asia/Kolkata |
| Create responses | `createdAt`/`updatedAt` null (not re-read) | Actual DB values |
| `POST /api/leads` with an `id` | Merged into (overwrote) that lead | `id` ignored |
| Bulk assign with repeated ids | Duplicate active assignments | De-duplicated |
| PUT with `status`/`role` null (users, teams, courses, campaigns, leads, follow-ups) | Wrote null | Keeps current value |
| `DELETE /api/users/{self}` | Allowed | Rejected |
| Admin attendance list | All history, N+1 queries | Same default, one query; optional `?from=&to=` |
| List ordering | Unspecified (heap order) | Ordered by id |

Not changed (flagged for a product decision): `PUT /api/leads/{id}` and agent `PUT …/details` can set a
closing status **without** deactivating the assignment (same as Spring). Only the status endpoints and
call outcomes deactivate it.

## Environment variables (names only)

`DB_URL`, `DB_USERNAME`, `DB_PASSWORD`, `JWT_SECRET` (shared with Spring, in `crm.env`);
`HOST`, `PORT`, `DB_POOL_MAX`, `SCHEDULER_ENABLED`, `CORS_ORIGINS`, `LOG_LEVEL`, optional
`USER_CACHE_TTL_MS`, `LOGIN_RATE_LIMIT_PER_15MIN`, `BCRYPT_COST`, `DB_STATEMENT_TIMEOUT_MS`,
`DB_SSL`, `JWT_EXPIRATION_MS` (in `crm-node.env`). See `.env.example`.

## Deployment (manual; requires approval)

### 1. Install alongside Spring (no traffic change)
```bash
# on EC2 (Node 22 is already installed: /usr/bin/node v22.23.2)
cd ~/apps && git clone <node-backend-repo-url> CRM-backend-node   # first time; later: git pull
cd ~/apps/CRM-backend-node && npm ci && npm run build && npm prune --omit=dev
install -m 600 /dev/null ~/.config/derivion/crm-node.env
printf 'HOST=127.0.0.1\nPORT=8081\nDB_POOL_MAX=6\nSCHEDULER_ENABLED=false\nLOG_LEVEL=info\n' > ~/.config/derivion/crm-node.env
sudo cp deploy/derivion-crm-node.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now derivion-crm-node
curl -s http://127.0.0.1:8081/api/health          # {"status":"UP"}
journalctl -u derivion-crm-node -n 50 --no-pager
```

### 2. Cutover (only after approval)
```bash
sudo cp /etc/nginx/conf.d/derivion-crm.conf /etc/nginx/conf.d/derivion-crm.conf.spring.bak
sudo sed -i 's#proxy_pass http://127.0.0.1:8080;#proxy_pass http://127.0.0.1:8081;#' /etc/nginx/conf.d/derivion-crm.conf
sudo nginx -t && sudo systemctl reload nginx     # zero-downtime; existing logins keep working
# Move the scheduler: stop Spring's first, then enable Node's.
sudo systemctl stop derivion-crm
sed -i 's/^SCHEDULER_ENABLED=.*/SCHEDULER_ENABLED=true/' ~/.config/derivion/crm-node.env
sudo systemctl restart derivion-crm-node
```
Keep `derivion-crm` installed (stopped, not disabled) until the new backend has run cleanly for an
agreed period. Keep the Render deployment available until AWS sign-off.

### Subsequent releases
```bash
cd ~/apps/CRM-backend-node && git pull && npm ci && npm run build && npm prune --omit=dev && sudo systemctl restart derivion-crm-node
```

## Rollback to Spring (any time, ~1 minute, no data migration)
```bash
sed -i 's/^SCHEDULER_ENABLED=.*/SCHEDULER_ENABLED=false/' ~/.config/derivion/crm-node.env
sudo systemctl restart derivion-crm-node          # or: sudo systemctl stop derivion-crm-node
sudo systemctl start derivion-crm                 # ~20 s startup (measured 17.6 s)
sudo cp /etc/nginx/conf.d/derivion-crm.conf.spring.bak /etc/nginx/conf.d/derivion-crm.conf
sudo nginx -t && sudo systemctl reload nginx
```
Both backends read and write the same tables in the same formats, and tokens are interchangeable, so
users stay logged in across a rollback.
