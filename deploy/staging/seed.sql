-- SYNTHETIC staging data (no production data). All accounts use STAGING_USER_PASSWORD
-- (the :'pw_hash' placeholder is replaced with its bcrypt hash by staging-db.mjs init).
-- Emails use the reserved .test domain.
insert into users (full_name, email, phone, password, role, status) values
  ('Staging Admin',   'admin@staging.test',   '9000001000', :'pw_hash', 'ADMIN',   'ACTIVE'),
  ('Staging Manager', 'manager@staging.test', '9000001001', :'pw_hash', 'MANAGER', 'ACTIVE'),
  ('Staging Agent 1', 'agent1@staging.test',  '9000001002', :'pw_hash', 'AGENT',   'ACTIVE'),
  ('Staging Agent 2', 'agent2@staging.test',  '9000001003', :'pw_hash', 'AGENT',   'ACTIVE'),
  ('Staging Inactive','inactive@staging.test','9000001004', :'pw_hash', 'AGENT',   'INACTIVE');

insert into teams (team_name, description, status) values ('North', 'Staging team', 'ACTIVE'), ('Legacy', 'Inactive team', 'INACTIVE');
insert into courses (course_name, description, duration_months, status) values ('Stock Market Basics', 'Staging course', 3, 'ACTIVE');
insert into campaigns (campaign_name, source, course_id, start_date, end_date, status)
  select 'Staging Campaign', 'Meta', id, current_date - 30, current_date + 30, 'ACTIVE' from courses limit 1;

-- 40 synthetic leads: 10-digit phones (WhatsApp OK) plus two +91 and one 11-digit number.
insert into leads (full_name, phone, email, lead_source, status, priority, city, campaign_id)
select 'Staging Lead ' || g,
       case when g = 38 then '+919800000038' when g = 39 then '+919800000039' when g = 40 then '98000000400'
            else '98000000' || lpad(g::text, 2, '0') end,
       'lead' || g || '@staging.test',
       (array['Website', 'Meta', 'Referral', null])[1 + g % 4],
       case when g between 31 and 33 then 'ENROLLED' when g between 34 and 35 then 'NOT_INTERESTED' else 'NEW' end,
       (array['LOW', 'MEDIUM', 'HIGH'])[1 + g % 3],
       (array['Delhi', 'Pune', 'Jaipur'])[1 + g % 3],
       case when g % 2 = 0 then (select id from campaigns limit 1) end
from generate_series(1, 40) g;

-- Leads 1–12 to agent 1, 13–24 to agent 2 (team North); 25–30 unassigned; closed leads unassigned.
insert into lead_assignments (lead_id, agent_id, team_id, status)
select l.id, case when l.id <= 12 then (select id from users where email = 'agent1@staging.test')
                  else (select id from users where email = 'agent2@staging.test') end,
       (select id from teams where team_name = 'North'), 'ACTIVE'
from leads l where l.id <= 24;

-- Follow-ups around "today" in IST to exercise reminders, overdue and the end-of-day MISSED rule.
insert into follow_ups (lead_id, agent_id, follow_up_date, purpose, status)
select 1, (select id from users where email = 'agent1@staging.test'), ((now() at time zone 'Asia/Kolkata') + interval '10 minutes')::timestamp(0), 'Demo call', 'PENDING'
union all select 2, (select id from users where email = 'agent1@staging.test'), ((now() at time zone 'Asia/Kolkata') - interval '1 hour')::timestamp(0), 'Callback', 'PENDING'
union all select 3, (select id from users where email = 'agent1@staging.test'), ((now() at time zone 'Asia/Kolkata') - interval '2 days')::timestamp(0), 'Old callback', 'PENDING'
union all select 13, (select id from users where email = 'agent2@staging.test'), ((now() at time zone 'Asia/Kolkata') + interval '1 day')::timestamp(0), 'Counselling', 'PENDING';

insert into notes (lead_id, user_id, note)
select 1, (select id from users where email = 'agent1@staging.test'), 'Staging note: interested in weekend batch';
