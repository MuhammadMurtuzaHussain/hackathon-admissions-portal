// Fake applicants, teams, projects and scores for demos and the stress test.
// Every fake person has an @example.com address, which the mailer never sends to.
import { q, tx } from './db';
import { normalizeEmail } from './auth';
import * as adm from './admissions';

export const DEMO_MODE = process.env.NODE_ENV !== 'production' || process.env.DEMO_MODE === '1';

const FIRST = ['Aoife', 'Conor', 'Niamh', 'Sean', 'Priya', 'Mohammed', 'Chloe', 'Liam', 'Zara', 'Oisin', 'Mei', 'Tariq', 'Erin', 'Callum', 'Fatima', 'Ryan', 'Sofia', 'Declan', 'Amara', 'Finn'];
const LAST = ['Murphy', 'Kelly', 'Patel', 'Hughes', 'Khan', 'Doherty', 'Wilson', 'Chen', 'Campbell', 'Okafor', 'McAllister', 'Singh', 'Quinn', 'Ahmed', 'Stewart', 'Byrne'];
const ORGS = ["Queen's University Belfast", 'Ulster University', 'Trinity College Dublin', 'University College Dublin', 'University of Edinburgh', 'University of Manchester', 'Kainos', 'Allstate NI', 'Independent'];
const WHY = 'I want to build a tool that helps students in Belfast find and share spare lab equipment between societies. '.split(' ');
const TEAM_A = ['Lagan', 'Titanic', 'Cavehill', 'Mourne', 'Causeway', 'Botanic', 'Harland', 'Divis'];
const TEAM_B = ['Labs', 'Collective', 'Crew', 'Works', 'Stack', 'Loop'];
const PROJ_A = ['Kit', 'Fare', 'Shift', 'Grid', 'Pulse', 'Harbour', 'Ledger', 'Clinic'];
const PROJ_B = ['Share', 'Wise', 'Flow', 'Mate', 'Scope', 'Path'];
export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

export async function userFor(rawEmail) {
  const [u] = await q(
    `INSERT INTO users (email, email_raw) VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET email_raw = users.email_raw RETURNING id, email, email_raw`,
    [normalizeEmail(rawEmail), rawEmail]
  );
  return u;
}

export function fakeApplication(i) {
  const name = `${pick(FIRST)} ${pick(LAST)}`;
  const handle = name.toLowerCase().replace(' ', '') + i;
  return {
    full_name: name, affiliation: pick(ORGS), role_type: pick(adm.ROLES), track: pick(adm.TRACKS),
    experience: pick(adm.EXPERIENCE), team_pref: pick(adm.TEAM_PREFS),
    github: Math.random() < 0.7 ? handle : '', linkedin: Math.random() < 0.6 ? handle : '',
    portfolio: Math.random() < 0.35 ? `https://${handle}.example.com` : '',
    motivation: Array.from({ length: 8 + Math.floor(Math.random() * 90) }, (_, k) => WHY[k % WHY.length]).join(' '),
  };
}

/** Wipe all event data. Organiser accounts survive. */
export async function resetAll() {
  await tx(async (t) => {
    await t.q(`DELETE FROM scores`);
    await t.q(`DELETE FROM submissions`);
    await t.q(`DELETE FROM applications`);
    await t.q(`DELETE FROM teams`);
    await t.q(`DELETE FROM audit_log`);
    await t.q(`DELETE FROM outbox`);
    await t.q(`DELETE FROM login_tokens WHERE used_at IS NOT NULL OR expires_at < now()`);
    await t.q(`DELETE FROM users WHERE NOT is_admin`);
    await t.q(`UPDATE users SET is_judge = false`);
    await t.q(`UPDATE track_targets SET target = CASE track WHEN 'Builder' THEN 90 WHEN 'Non-Builder' THEN 70 ELSE 40 END`);
    await t.q(`UPDATE events SET seats_taken = 0, capacity = 200, offer_ttl_hours = 72, judging_open = true WHERE id = 1`);
  });
}

/** n fake applicants; roughly a third of them arrive as teams of 3 to 5. */
export async function seedApplicants(n) {
  const stamp = Date.now().toString(36);
  const ids = [];
  for (let i = 0; i < n; i++) {
    const user = await userFor(`applicant${i}.${stamp}@example.com`);
    ids.push((await adm.submitApplication(user, fakeApplication(i))).id);
  }
  let teams = 0;
  for (let i = 0; i < ids.length; ) {
    const size = 3 + Math.floor(Math.random() * 3);
    if (Math.random() < 0.12 && i + size <= ids.length) {
      const track = pick(adm.TRACKS);
      const code = Math.random().toString(36).slice(2, 8).toUpperCase().padEnd(6, 'X');
      const [team] = await q(`INSERT INTO teams (name, join_code, track) VALUES ($1, $2, $3) RETURNING id`, [`${pick(TEAM_A)} ${pick(TEAM_B)} ${teams + 1}`, code, track]);
      await q(`UPDATE applications SET team_id = $1, track = $2 WHERE id IN (SELECT unnest(string_to_array($3, ','))::uuid)`, [team.id, track, ids.slice(i, i + size).join(',')]);
      teams++;
      i += size;
    } else i++;
  }
  return { seeded: n, teams };
}

/** Fake projects from confirmed attendees, each scored by three fake judges. */
export async function seedProjects(n) {
  const owners = await q(
    `SELECT a.id, a.track FROM applications a
      WHERE a.status = 'confirmed' AND NOT EXISTS (SELECT 1 FROM submissions s WHERE s.owner_app_id = a.id)
      ORDER BY random() LIMIT $1`,
    [n]
  );
  const judges = [];
  for (const name of ['judge.one', 'judge.two', 'judge.three']) {
    await adm.addJudge(`${name}@example.com`, `${name}@example.com`, 'demo');
    judges.push((await q(`SELECT id FROM users WHERE email = $1`, [`${name}@example.com`]))[0].id);
  }
  for (const [i, o] of owners.entries()) {
    const [sub] = await q(
      `INSERT INTO submissions (owner_app_id, team_name, project_name, tagline, description, track, repo_url, demo_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [o.id, `${pick(TEAM_A)} ${pick(TEAM_B)}`, `${pick(PROJ_A)}${pick(PROJ_B)}`, 'A demo project seeded for the judging leaderboard.', 'Seeded demo project. Built over the weekend by a team of four, with a working prototype and a short pitch.', o.track, `https://github.com/example/project-${i}`, `https://project-${i}.example.com`]
    );
    for (const j of judges) {
      const r = () => 4 + Math.floor(Math.random() * 7);
      await q(`INSERT INTO scores (submission_id, judge_id, technical, innovation, product, potential, pitch) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [sub.id, j, r(), r(), r(), r(), r()]);
    }
  }
  return { projects: owners.length, judges: judges.length };
}

export const confirmAllOffers = () => q(`UPDATE applications SET status = 'confirmed', offer_expires_at = NULL WHERE status = 'offered' RETURNING id`);

/** A believable mid-admissions snapshot: mostly full, some offers pending, a queue to review. */
export async function loadDemo() {
  await resetAll();
  const { teams } = await seedApplicants(300);
  await adm.bulkOffer(150, 'demo');
  await confirmAllOffers();
  await adm.bulkOffer(25, 'demo');
  const { projects } = await seedProjects(12);
  return { applicants: 300, teams, projects };
}
