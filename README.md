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

### Approved business-rule changes (2026-10-21)

These are product decisions, not compatibility differences. Spring keeps the old rules, so after a
rollback to Spring they revert to the old behaviour. The data stays compatible either way.

| # | Rule | Spring (old) | Node (new) | Endpoints |
|---|---|---|---|---|
| 1 | Closing a lead via an edit form | Assignment stayed ACTIVE | ENROLLED / NOT_INTERESTED / LOST / WRONG_NUMBER releases the active assignment, as the status endpoints already did | `PUT /api/leads/{id}`, `PUT /api/agent/leads/{id}/details` |
| 2 | Admin edit without `campaignId` | Campaign link cleared | Omitted = keep; explicit `null`/`""` = clear | `PUT /api/leads/{id}` |
| 3 | Overdue follow-ups | MISSED one minute after the due time | Overdue notification at the due time but still PENDING (listed by `/follow-ups/overdue`); MISSED once the due **date** ends in Asia/Kolkata (00:00 IST next day) | scheduler, `/api/follow-ups/overdue` |
| 4 | Logout during a break | Break left open, counted until midnight | Break ends at logout time; stale sessions closed at next login also end their break at that midnight; reports cap open breaks of logged-out sessions at logout (corrects existing data) | `POST /api/auth/logout/{id}`, `POST /api/attendance/logout`, `POST /api/auth/login`, admin attendance, break summary |
| 5 | Lead created by an agent | Unassigned (agent couldn't see it) | Assigned to the creating agent (ACTIVE, no team); admin/manager creations stay unassigned | `POST /api/leads` |
| 6 | `updated_at` | Never changed | Set (UTC) whenever a lead/course/campaign/follow-up row's values change; identical re-saves keep it, so a closed lead's `updatedAt` stays its closure time | all writes to those tables |

Limitation (rule 6): `updatedAt` is the last real modification. A closed lead that is edited later moves
its closure date in the closed-leads report. An exact, immutable closure time would need a `closed_at`
column (schema change, not done). Leads closed before this release keep their creation date as `updated_at`.


## Environment variables (names only)

`DB_URL`, `DB_USERNAME`, `DB_PASSWORD`, `JWT_SECRET` (shared with Spring, in `crm.env`);
`HOST`, `PORT`, `DB_POOL_MAX`, `SCHEDULER_ENABLED`, `CORS_ORIGINS`, `LOG_LEVEL`, optional
`USER_CACHE_TTL_MS`, `LOGIN_RATE_LIMIT_PER_15MIN`, `BCRYPT_COST`, `DB_STATEMENT_TIMEOUT_MS`,
`DB_SSL`, `JWT_EXPIRATION_MS` (in `crm-node.env`). See `.env.example`.

## Deployment (manual; requires explicit approval)

Prerequisites:
- This repository is pushed to a remote EC2 can clone (not yet done; awaiting approval).
- Node 22 on EC2 (`/usr/bin/node` v22.23.2, already installed).
- `~/.config/derivion/crm.env` (existing; shared with Spring).

### 1. Install alongside Spring (no traffic change)
```bash
cd ~/apps && git clone <node-backend-repo-url> CRM-backend-node      # first time; later: git pull
cd ~/apps/CRM-backend-node
npm ci --ignore-scripts            # dev tools' install scripts (esbuild, embedded-postgres) are not needed to build
npm run build && npm prune --omit=dev
install -m 600 /dev/null ~/.config/derivion/crm-node.env
# DB_POOL_MAX=5 is REQUIRED while Spring runs: Supabase's session pooler allows 15 connections per
# role and Spring's Hikari pool uses up to 10.
printf 'HOST=127.0.0.1\nPORT=8081\nDB_POOL_MAX=5\nSCHEDULER_ENABLED=false\nLOG_LEVEL=info\n' > ~/.config/derivion/crm-node.env
sudo cp deploy/derivion-crm-node.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now derivion-crm-node
```

### 2. Verify before switching traffic
```bash
systemctl is-active derivion-crm-node derivion-crm nginx              # all "active"
curl -s http://127.0.0.1:8081/api/health                             # {"status":"UP"}
journalctl -u derivion-crm-node -n 30 --no-pager | grep -E '"msg":"(database reachable|listening)"'
#   expect: database reachable ... "timeZone":"UTC","readOnly":false,"poolMax":5
ss -ltnp | grep 8081                                                 # 127.0.0.1:8081 only
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8081/api/leads   # 401 (auth enforced)
```
Read-only side-by-side check (GET only, existing users, no writes):
`cd ~/crm-migration/tools && ( set -a; . ~/.config/derivion/crm.env; set +a; node compare-and-bench.mjs http://127.0.0.1:8080 http://127.0.0.1:8081 )`
The expected differences are listed in `migration/FINAL_REVIEW.md` §3.

### 3. Cutover (only after approval)
```bash
sudo cp /etc/nginx/conf.d/derivion-crm.conf /etc/nginx/conf.d/derivion-crm.conf.spring.bak
sudo sed -i 's#proxy_pass http://127.0.0.1:8080;#proxy_pass http://127.0.0.1:8081;#' /etc/nginx/conf.d/derivion-crm.conf
sudo nginx -t && sudo systemctl reload nginx        # no downtime; logged-in users stay logged in
# Move the follow-up scheduler: stop Spring first, then enable Node's.
sudo systemctl stop derivion-crm
sudo systemctl disable derivion-crm                 # prevents Spring returning after a reboot (reversible)
sed -i 's/^SCHEDULER_ENABLED=.*/SCHEDULER_ENABLED=true/' ~/.config/derivion/crm-node.env
sudo systemctl restart derivion-crm-node
```

### 4. Smoke test (immediately after cutover, in a browser via the public URL)
1. Admin: log in; the dashboard numbers match what was shown before cutover.
2. Admin: Leads list, a lead's details, Users, Teams, Lead Assignments, Attendance pages load.
3. Admin: create a test lead → assign it to a test agent → reassign → delete it.
4. Agent (test account): log in (an attendance row appears for today); the lead list shows only own leads.
5. Agent: open a lead → add a call log, a follow-up (a "New Follow-up Assigned" notification appears) and a note.
6. Agent: start a Tea break → summary shows it → end break; log out.
7. Expired session: a token older than 8 h is rejected (401) and the UI shows a failure, the same as today.
8. Server: `journalctl -u derivion-crm-node --since "-15 min" | grep -c '"level":50'` → 0 server errors;
   `journalctl -u derivion-crm-node | grep "follow-up reminders processed"` appears when follow-ups are due.

If any step fails, roll back (below) and keep the logs:
`journalctl -u derivion-crm-node --since "-30 min" > ~/node-cutover.log`.

### Subsequent releases
```bash
cd ~/apps/CRM-backend-node && git pull && npm ci --ignore-scripts && npm run build && npm prune --omit=dev && sudo systemctl restart derivion-crm-node
```

## Rollback to Spring (any time, ~1 minute, no data migration)
```bash
sudo systemctl enable --now derivion-crm                       # Spring needs ~18 s to start
until curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/api/teams | grep -qE '401|403'; do sleep 2; done
sudo cp /etc/nginx/conf.d/derivion-crm.conf.spring.bak /etc/nginx/conf.d/derivion-crm.conf
sudo nginx -t && sudo systemctl reload nginx
sed -i 's/^SCHEDULER_ENABLED=.*/SCHEDULER_ENABLED=false/' ~/.config/derivion/crm-node.env
sudo systemctl stop derivion-crm-node                          # or restart it to keep it as a shadow
```
Both backends read and write the same tables in the same formats, and tokens and password hashes are
interchangeable. Nothing in the database has to be reverted and users stay logged in. Node never
changes the schema. Data written by Node while it was live is fully readable by Spring (verified:
13/13 tables identical after the same writes).

## Frontend deployment notes
- EC2's frontend checkout is at `93ce41d`, 3 commits behind `origin/main` (`6a9a512`). A `git pull`
  also deploys those 3 commits ("lead detail page changed", "whatsapp intigrated", …); review them first.
- EC2 has an uncommitted local edit in `src/lib/config.ts` (`API_BASE_URL = NEXT_PUBLIC_API_BASE_URL ?? ""`,
  i.e. same-origin `/api` through Nginx). Keep it, or commit it, so a pull does not revert to the Render URL.
- The frontend works unchanged with either backend. Its optional changes are listed in
  `migration/FINAL_REVIEW.md` §7.
