# Staging: Derivion CRM release 1.0.0-rc.1

A private staging stack on the EC2 host, **isolated from production**:

```
browser (your laptop) ──SSH tunnel──► 127.0.0.1:3002 Next.js (release frontend, staging build)
                                      127.0.0.1:8082 Node API (release backend)
                                      127.0.0.1:55433 PostgreSQL 17 (staging DB, synthetic data)
```

What it does **not** touch: production database, `~/.config/derivion/crm.env`, live Spring (8080),
live frontend (3000), Nginx, systemd, firewall, Render. Nothing listens publicly. Staging uses its own
JWT secret, so production tokens don't work here and vice versa.

Memory budget (measured): API ≈ 115 MB, Next.js ≈ 160 MB, PostgreSQL ≈ 50 MB. EC2 currently has
≈ 1 GB available.

## Artifacts (`migration/release/`, verify with `SHA256SUMS`)
| File | Content |
|---|---|
| `crm-backend-node-1.0.0-rc.1.bundle` | git bundle of the Node repo, branch `release/1.0.0`, tag `v1.0.0-rc.1` |
| `crm-frontend-release.bundle` | git bundle of the frontend, branch `release/node-backend-migration`, tag `node-migration-rc.1` |
| `crm-frontend-staging-<sha>.tgz` | prebuilt staging frontend (`NEXT_PUBLIC_API_BASE_URL=http://localhost:8082`); started with production deps only (verified) |

## 1. Install (one time)
```bash
# from your workstation
scp -i <key> migration/release/* ec2-user@<host>:/tmp/crm-release/
# on EC2
cd /tmp/crm-release && sha256sum -c SHA256SUMS
mkdir -p ~/staging && cd ~/staging
git clone -b release/1.0.0 /tmp/crm-release/crm-backend-node-1.0.0-rc.1.bundle backend
cd backend && npm ci --ignore-scripts && npm rebuild @embedded-postgres/linux-x64 && npm run build
mkdir -p ~/staging/frontend && tar -xzf /tmp/crm-release/crm-frontend-staging-*.tgz -C ~/staging/frontend
cd ~/staging/frontend && npm ci --omit=dev --ignore-scripts
chmod +x ~/staging/backend/deploy/staging/staging.sh
install -m 600 ~/staging/backend/deploy/staging/staging.env.example ~/.config/derivion/staging.env
# fill STAGING_PG_PASSWORD, DB_PASSWORD (same value), STAGING_USER_PASSWORD, JWT_SECRET (openssl rand -base64 36)
~/staging/backend/deploy/staging/staging.sh init     # schema + synthetic seed
```

## 2. Run and verify
```bash
~/staging/backend/deploy/staging/staging.sh start    # postgres, api, web (waits for health)
~/staging/backend/deploy/staging/staging.sh status   # all three listening on 127.0.0.1 only
( set -a; . ~/.config/derivion/staging.env; set +a; ~/staging/backend/deploy/staging/staging.sh smoke )   # 23 checks
```
Browser testing: `ssh -i <key> -L 3002:127.0.0.1:3002 -L 8082:127.0.0.1:8082 ec2-user@<host>`, then
open http://localhost:3002 and log in as `admin@staging.test`, `manager@staging.test`,
`agent1@staging.test` or `agent2@staging.test` with `STAGING_USER_PASSWORD`.

### Manual staging checklist
1. Login page; an expired session shows "Your session has expired. Please log in again." (test: log in, then in DevTools set `localStorage.jwtToken` to a token with a past `exp`, reload).
2. Admin: dashboard, Leads, lead edit (campaign kept), Users, Teams, Lead Assignments (bulk + reassign), Attendance.
3. Agent: only own leads; lead details: phone field read-only, **WhatsApp** button ("…from ISFT…") for 10-digit numbers, "unavailable" for leads 38–40; Save → next lead.
4. Agent: add a lead → it appears in own list. Close a lead via details → it leaves the list.
5. Agent: start a break, log out → admin attendance shows the break ended at logout.
6. Follow-ups: "Callback" (1 h ago) is overdue but PENDING; "Old callback" is MISSED; reminder notification appears for the +10 min one.

## 3. Stop / remove
```bash
~/staging/backend/deploy/staging/staging.sh stop      # stops web, api, postgres
~/staging/backend/deploy/staging/staging.sh destroy   # stop + delete staging DB data
rm -rf ~/staging ~/.config/derivion/staging.env /tmp/crm-release   # remove everything
```
Removal leaves production exactly as it was.
