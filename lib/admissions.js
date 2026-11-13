// The admissions state machine. Every seat that is ever handed out goes through
// claimSeats(), and every seat that comes back goes through releaseSeat(), so
// there is exactly one place where capacity can be got wrong.
//
//   submitted --offer--> offered --confirm--> confirmed --check in--> checked_in
//       |  \                |  \                  |
//       |   waitlist        |   expire/decline    withdraw
//       v                   v                     v
//    rejected           (seat freed -> next person on the waitlist is offered)
import { q, tx } from './db';
import { scoreApplication } from './score';

// Last year's three tracks, as listed on the HackBelfast Devpost page.
export const TRACKS = ['Builder', 'Non-Builder', 'Quant'];
export const TEAM_MIN = 3;
export const TEAM_MAX = 5;
export const ROLES = ['Student', 'Professional', 'Other'];
export const EXPERIENCE = ['First hackathon', 'Been to a few', 'Veteran'];
export const TEAM_PREFS = ['I have a team', 'Looking for a team', 'Going solo'];

const log = (t, appId, actor, action, detail = '') =>
  t.q(`INSERT INTO audit_log (application_id, actor, action, detail) VALUES ($1, $2, $3, $4)`, [appId, actor, action, detail]);

async function mail(t, appId, subject, body) {
  await t.q(
    `INSERT INTO outbox (to_email, subject, body)
     SELECT u.email_raw, $2, $3 FROM applications a JOIN users u ON u.id = a.user_id WHERE a.id = $1`,
    [appId, subject, body]
  );
}

/**
 * Every transaction that can move a seat takes the event row first. That gives
 * all of them the same lock order (event, then applications), which rules out
 * deadlocks, and it queues seat changes one behind another. At 200 seats that
 * queue is never a bottleneck.
 */
const lockEvent = (t) => t.q(`SELECT 1 FROM events WHERE id = 1 FOR UPDATE`);

// A "unit" is whoever is admitted together: one solo applicant, or a whole team.
const IN_IDS = `IN (SELECT unnest(string_to_array($1, ','))::uuid)`;
const root = { q };

/**
 * Take seats for a whole unit, all or nothing, or report why not.
 *
 * The capacity check and the increment are ONE statement. Under concurrency
 * Postgres row-locks the event row: a second caller waits, then re-evaluates
 * `seats_taken + n <= capacity` against the committed value and matches zero
 * rows. There is no read-then-write gap for two requests to both slip
 * through, and the CHECK constraint on `events` backs it up.
 */
async function claimSeats(t, ids, actor) {
  if (!ids.length) return 'ineligible';
  const [ev] = await t.q(
    `UPDATE events SET seats_taken = seats_taken + $1
      WHERE id = 1 AND seats_taken + $1 <= capacity
      RETURNING offer_ttl_hours`,
    [ids.length]
  );
  if (!ev) return 'full';
  const got = await t.q(
    `UPDATE applications
        SET status = 'offered', holds_seat = true, decided_at = now(), updated_at = now(),
            offer_expires_at = now() + ($2::int * interval '1 hour')
      WHERE id ${IN_IDS} AND holds_seat = false AND status IN ('submitted', 'waitlisted')
      RETURNING id`,
    [ids.join(','), ev.offer_ttl_hours]
  );
  // Someone was decided in the meantime (another organiser, a withdrawal): hand back what was not used.
  if (got.length < ids.length) await t.q(`UPDATE events SET seats_taken = seats_taken - $1 WHERE id = 1`, [ids.length - got.length]);
  if (!got.length) return 'ineligible';
  for (const { id } of got) {
    await log(t, id, actor, 'offered', `expires in ${ev.offer_ttl_hours}h`);
    await mail(t, id, 'You have a place at HackBelfast 2027', `Confirm your place within ${ev.offer_ttl_hours} hours or it goes to the next person on the waitlist.`);
  }
  return 'offered';
}

/** The applicant plus any teammates who are still awaiting a decision. */
async function unitOf(t, appId) {
  const rows = await t.q(
    `SELECT m.id FROM applications a
       JOIN applications m ON m.id = a.id OR (a.team_id IS NOT NULL AND m.team_id = a.team_id)
      WHERE a.id = $1 AND a.status IN ('submitted', 'waitlisted') AND m.status IN ('submitted', 'waitlisted')
      FOR UPDATE OF m`,
    [appId]
  );
  return rows.map((r) => r.id);
}

/**
 * Who is next? Units (solo or team) in the given status that fit in `maxSize`
 * seats, ordered by: tracks still under their target first, then score
 * (team average), then who has waited longest.
 */
async function nextUnit(t, status, maxSize) {
  const [u] = await t.q(
    `WITH held AS (SELECT track, count(*)::int AS n FROM applications WHERE holds_seat GROUP BY track),
          units AS (
            SELECT COALESCE(team_id, id) AS unit, count(*)::int AS size, avg(score) AS score,
                   min(COALESCE(waitlisted_at, applied_at)) AS since, min(track) AS track,
                   string_agg(id::text, ',') AS ids
              FROM applications WHERE status = $1 GROUP BY 1)
     SELECT u.ids, u.size, u.track
       FROM units u
       LEFT JOIN track_targets tt ON tt.track = u.track
       LEFT JOIN held h ON h.track = u.track
      WHERE u.size <= $2
      ORDER BY (COALESCE(h.n, 0) < COALESCE(tt.target, 0)) DESC, u.score DESC, u.since ASC
      LIMIT 1`,
    [status, maxSize]
  );
  return u ? { ids: u.ids.split(','), size: u.size, track: u.track } : null;
}

/** Give a seat back and immediately pass it down the waitlist. */
async function releaseSeat(t, appId, newStatus, actor) {
  const [app] = await t.q(
    `UPDATE applications SET status = $2, holds_seat = false, offer_expires_at = NULL, updated_at = now()
      WHERE id = $1 AND holds_seat = true RETURNING id`,
    [appId, newStatus]
  );
  if (!app) return false;
  await t.q(`UPDATE events SET seats_taken = seats_taken - 1 WHERE id = 1`);
  await log(t, appId, actor, newStatus, 'seat released');
  await promoteFromWaitlist(t);
  return true;
}

/**
 * Fill free seats from the waitlist. A team only moves when enough seats are
 * free for all of it; until then smaller units that do fit go ahead, so a
 * seat never sits empty waiting for a team-sized gap.
 */
async function promoteFromWaitlist(t) {
  let promoted = 0;
  for (;;) {
    const [{ free }] = await t.q(`SELECT capacity - seats_taken AS free FROM events WHERE id = 1`);
    if (free <= 0) break;
    const unit = await nextUnit(t, 'waitlisted', free);
    if (!unit) break;
    if ((await claimSeats(t, unit.ids, 'system:waitlist')) !== 'offered') break;
    promoted += unit.size;
  }
  return promoted;
}

// ---------------------------------------------------------------- applicants

export function validateApplication(input) {
  const s = (k, max = 300) => String(input[k] ?? '').trim().slice(0, max);
  const a = {
    full_name: s('full_name', 120),
    affiliation: s('affiliation', 160),
    role_type: s('role_type'),
    track: s('track'),
    experience: s('experience'),
    team_pref: s('team_pref'),
    // Accept "octocat", "@octocat" or a full URL; store just the handle so duplicates are comparable.
    github: s('github').replace(/^https?:\/\/(www\.)?github\.com\//i, '').replace(/^@/, '').replace(/\/.*$/, '').toLowerCase(),
    linkedin: s('linkedin').replace(/^https?:\/\/([a-z]+\.)?linkedin\.com\/in\//i, '').replace(/\/.*$/, '').toLowerCase(),
    portfolio: s('portfolio'),
    motivation: s('motivation', 2000),
  };
  const errors = [];
  if (a.full_name.length < 2) errors.push('Tell us your name.');
  if (a.affiliation.length < 2) errors.push('Tell us your university or company.');
  if (!ROLES.includes(a.role_type)) errors.push('Pick what describes you.');
  if (!TRACKS.includes(a.track)) errors.push('Pick a track.');
  if (!EXPERIENCE.includes(a.experience)) errors.push('Pick your hackathon experience.');
  if (!TEAM_PREFS.includes(a.team_pref)) errors.push('Tell us about your team plans.');
  if (a.motivation.length < 20) errors.push('Write a sentence or two about what you want to build.');
  if (a.portfolio && !/^https?:\/\/\S+\.\S+/.test(a.portfolio)) errors.push('Portfolio must be a full link starting with https://');
  if (input.requireConsent && !input.consent) errors.push('You need to accept the code of conduct to apply.');
  return { a, errors };
}

/**
 * Create or edit the caller's application. Safe to call any number of times:
 * the unique (event, user) constraint turns a double click, a retry or a
 * second tab into an update of the same row, and edits stop once reviewed.
 */
export async function submitApplication(user, a) {
  const { score, detail } = scoreApplication(a, user.email);
  return tx(async (t) => {
    const [ev] = await t.q(`SELECT applications_open FROM events WHERE id = 1`);
    const [existing] = await t.q(`SELECT id, status FROM applications WHERE event_id = 1 AND user_id = $1`, [user.id]);
    if (!existing && !ev.applications_open) return { ok: false, error: 'Applications are closed.' };
    if (existing && existing.status !== 'submitted') return { ok: false, error: 'Your application has already been reviewed and can no longer be edited.' };
    const [row] = await t.q(
      `INSERT INTO applications (event_id, user_id, full_name, affiliation, role_type, track, experience,
                                 team_pref, github, linkedin, portfolio, motivation, score, score_detail)
       VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (event_id, user_id) DO UPDATE SET
         full_name = EXCLUDED.full_name, affiliation = EXCLUDED.affiliation, role_type = EXCLUDED.role_type,
         track = COALESCE((SELECT tm.track FROM teams tm WHERE tm.id = applications.team_id), EXCLUDED.track), experience = EXCLUDED.experience, team_pref = EXCLUDED.team_pref,
         github = EXCLUDED.github, linkedin = EXCLUDED.linkedin, portfolio = EXCLUDED.portfolio,
         motivation = EXCLUDED.motivation, score = EXCLUDED.score, score_detail = EXCLUDED.score_detail,
         updated_at = now()
       WHERE applications.status = 'submitted'
       RETURNING id, (xmax = 0) AS created`,
      [user.id, a.full_name, a.affiliation, a.role_type, a.track, a.experience, a.team_pref, a.github, a.linkedin, a.portfolio, a.motivation, score, JSON.stringify(detail)]
    );
    if (row.created) {
      await log(t, row.id, user.email, 'applied');
      await mail(t, row.id, 'We have your HackBelfast application', 'Thanks for applying. We review in batches and will email you either way.');
    } else {
      await log(t, row.id, user.email, 'edited application');
    }
    return { ok: true, id: row.id, created: row.created };
  });
}

export async function getApplication(userId) {
  const [app] = await q(`SELECT * FROM applications WHERE event_id = 1 AND user_id = $1`, [userId]);
  if (!app) return null;
  if (app.status === 'waitlisted') {
    // Position among units queueing for the same track.
    const queue = await q(
      `SELECT COALESCE(team_id, id) AS unit FROM applications WHERE status = 'waitlisted' AND track = $1
        GROUP BY 1 ORDER BY avg(score) DESC, min(waitlisted_at) ASC`,
      [app.track]
    );
    app.waitlist_position = queue.findIndex((u) => u.unit === (app.team_id || app.id)) + 1;
  }
  if (app.team_id) {
    const [team] = await q(`SELECT * FROM teams WHERE id = $1`, [app.team_id]);
    team.members = await q(`SELECT full_name, status, user_id FROM applications WHERE team_id = $1 ORDER BY applied_at`, [app.team_id]);
    app.team = team;
  }
  return app;
}

export async function confirmSeat(user) {
  return tx(async (t) => {
    const [app] = await t.q(
      `UPDATE applications SET status = 'confirmed', offer_expires_at = NULL, updated_at = now()
        WHERE event_id = 1 AND user_id = $1 AND status = 'offered' AND offer_expires_at > now()
        RETURNING id`,
      [user.id]
    );
    if (!app) return false;
    await log(t, app.id, user.email, 'confirmed');
    await mail(t, app.id, 'You are in. See you at HackBelfast', 'Your place is confirmed. If your plans change, withdraw from your status page so someone else can come.');
    return true;
  });
}

/** Applicant gives up: frees the seat if they held one. */
export async function withdraw(user) {
  return tx(async (t) => {
    await lockEvent(t);
    const [app] = await t.q(`SELECT id, holds_seat, status FROM applications WHERE event_id = 1 AND user_id = $1 FOR UPDATE`, [user.id]);
    if (!app || ['withdrawn', 'rejected', 'checked_in'].includes(app.status)) return false;
    if (app.holds_seat) return releaseSeat(t, app.id, 'withdrawn', user.email);
    await t.q(`UPDATE applications SET status = 'withdrawn', updated_at = now() WHERE id = $1`, [app.id]);
    await log(t, app.id, user.email, 'withdrawn');
    return true;
  });
}

/** Changed their mind after withdrawing or missing the deadline: back of the queue. */
export async function rejoin(user) {
  return tx(async (t) => {
    await lockEvent(t);
    const [app] = await t.q(
      `UPDATE applications
          SET status = CASE WHEN decided_at IS NULL THEN 'submitted' ELSE 'waitlisted' END,
              waitlisted_at = CASE WHEN decided_at IS NULL THEN NULL ELSE now() END, updated_at = now()
        WHERE event_id = 1 AND user_id = $1 AND status IN ('withdrawn', 'expired')
        RETURNING id, status`,
      [user.id]
    );
    if (!app) return false;
    await log(t, app.id, user.email, 'rejoined', `as ${app.status}`);
    if (app.status === 'waitlisted') await promoteFromWaitlist(t);
    return true;
  });
}

// ---------------------------------------------------------------- organisers

/**
 * Offer a place to an applicant and, if they applied as a team, to the whole
 * team at once. If there is not room for all of them, all of them go on the
 * waitlist together: a team is never split by an offer.
 */
export async function offer(appId, actor) {
  return tx(async (t) => {
    await lockEvent(t);
    const ids = await unitOf(t, appId);
    const result = await claimSeats(t, ids, actor);
    if (result === 'full') return { result: (await moveToWaitlist(t, ids, actor)) ? 'waitlisted' : 'ineligible', size: ids.length };
    return { result, size: ids.length };
  });
}

/** Strict version used by the stress test: seats for the whole unit, or nothing. */
export async function tryClaim(appId, actor) {
  return tx(async (t) => {
    await lockEvent(t);
    return claimSeats(t, await unitOf(t, appId), actor);
  });
}

async function moveToWaitlist(t, ids, actor) {
  if (!ids.length) return 0;
  const moved = await t.q(
    `UPDATE applications SET status = 'waitlisted', waitlisted_at = now(), decided_at = now(), updated_at = now()
      WHERE id ${IN_IDS} AND status = 'submitted' RETURNING id`,
    [ids.join(',')]
  );
  for (const { id } of moved) {
    await log(t, id, actor, 'waitlisted');
    await mail(t, id, 'You are on the HackBelfast waitlist', 'We are full right now. Places open up as people drop out, and we will email you the moment one is yours.');
  }
  return moved.length;
}

export const waitlist = (appId, actor) => tx(async (t) => moveToWaitlist(t, await unitOf(t, appId), actor));

export async function reject(appId, actor) {
  return tx(async (t) => {
    const [app] = await t.q(
      `UPDATE applications SET status = 'rejected', decided_at = now(), updated_at = now()
        WHERE id = $1 AND status IN ('submitted', 'waitlisted') RETURNING id`,
      [appId]
    );
    if (!app) return false;
    await log(t, appId, actor, 'rejected');
    await mail(t, appId, 'Your HackBelfast application', 'We could not offer you a place this year. Thank you for applying.');
    return true;
  });
}

/** Organiser removes someone who holds a seat (no-show notice, conduct, duplicate). */
export const revoke = (appId, actor) =>
  tx(async (t) => {
    await lockEvent(t);
    return releaseSeat(t, appId, 'withdrawn', actor);
  });

export async function checkIn(appId, actor) {
  return tx(async (t) => {
    const [app] = await t.q(`UPDATE applications SET status = 'checked_in', updated_at = now() WHERE id = $1 AND status = 'confirmed' RETURNING id`, [appId]);
    if (app) await log(t, appId, actor, 'checked in');
    return !!app;
  });
}

/**
 * Hand out up to `n` places to unreviewed applicants, whole units at a time,
 * under-target tracks first. Anything that no longer fits in the room is waitlisted.
 */
export async function bulkOffer(n, actor) {
  const tally = { offered: 0, waitlisted: 0, ineligible: 0 };
  let left = n;
  while (left > 0) {
    const unit = await nextUnit(root, 'submitted', left);
    if (!unit) break;
    const { result, size } = await offer(unit.ids[0], actor);
    if (result === 'ineligible') break;
    tally[result] += size;
    left -= size;
  }
  return tally;
}

/** Everyone still unreviewed goes onto the waitlist in one go. */
export async function waitlistRemaining(actor) {
  return tx(async (t) => {
    const ids = (await t.q(`SELECT id FROM applications WHERE status = 'submitted'`)).map((r) => r.id);
    return moveToWaitlist(t, ids, actor);
  });
}

/** Cron job (every few minutes in production): lapse unanswered offers, refill from the waitlist. */
export async function expireOffers() {
  return tx(async (t) => {
    await lockEvent(t);
    const stale = await t.q(`SELECT id FROM applications WHERE status = 'offered' AND offer_expires_at < now() FOR UPDATE SKIP LOCKED`);
    for (const { id } of stale) {
      await releaseSeat(t, id, 'expired', 'system:expiry');
      await mail(t, id, 'Your HackBelfast offer has lapsed', 'We did not hear back in time, so your place went to the next person. You can rejoin the waitlist from your status page.');
    }
    return stale.length;
  });
}

/** Capacity can go up freely; it can never drop below seats already handed out. */
export async function setCapacity(n, actor) {
  return tx(async (t) => {
    await lockEvent(t);
    const [ev] = await t.q(`UPDATE events SET capacity = $1 WHERE id = 1 AND seats_taken <= $1 RETURNING capacity`, [n]);
    if (!ev) return false;
    await log(t, null, actor, 'capacity changed', `to ${n}`);
    await promoteFromWaitlist(t);
    return true;
  });
}

export async function getEvent() {
  const [ev] = await q(`SELECT *, capacity - seats_taken AS seats_left FROM events WHERE id = 1`);
  return ev;
}

export async function getStats() {
  const rows = await q(`SELECT status, count(*)::int AS n FROM applications GROUP BY status`);
  const by = Object.fromEntries(rows.map((r) => [r.status, r.n]));
  const total = rows.reduce((s, r) => s + r.n, 0);
  return { by, total };
}

// --------------------------------------------------------------- submissions

export function validateSubmission(input) {
  const s = (k, max = 300) => String(input[k] ?? '').trim().slice(0, max);
  const p = {
    team_name: s('team_name', 80), project_name: s('project_name', 80), tagline: s('tagline', 140),
    description: s('description', 3000), track: s('track'), repo_url: s('repo_url'), deck_url: s('deck_url'),
    demo_url: s('demo_url'), members: s('members', 500),
  };
  const url = (v) => /^https?:\/\/\S+\.\S+/.test(v);
  const errors = [];
  if (!p.team_name) errors.push('Team name is required.');
  if (!p.project_name) errors.push('Project name is required.');
  if (!p.tagline) errors.push('Add a one-line pitch.');
  if (p.description.length < 30) errors.push('Describe what you built (a few sentences).');
  if (!TRACKS.includes(p.track)) errors.push('Pick a track.');
  if (!url(p.repo_url)) errors.push('Repository link must start with https://');
  if (p.deck_url && !url(p.deck_url)) errors.push('Deck link must start with https://');
  if (p.demo_url && !url(p.demo_url)) errors.push('Demo link must start with https://');
  return { p, errors };
}

/** One submission per team lead, editable until the deadline, which the server enforces. */
export async function saveSubmission(user, p) {
  return tx(async (t) => {
    const [app] = await t.q(`SELECT id, status FROM applications WHERE event_id = 1 AND user_id = $1`, [user.id]);
    if (!app || !['confirmed', 'checked_in'].includes(app.status)) return { ok: false, error: 'Only confirmed attendees can submit a project.' };
    const [ev] = await t.q(`SELECT now() < submissions_deadline AS open FROM events WHERE id = 1`);
    if (!ev.open) return { ok: false, error: 'The submission deadline has passed.' };
    await t.q(
      `INSERT INTO submissions (owner_app_id, team_name, project_name, tagline, description, track, repo_url, deck_url, demo_url, members)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (owner_app_id) DO UPDATE SET
         team_name = EXCLUDED.team_name, project_name = EXCLUDED.project_name, tagline = EXCLUDED.tagline,
         description = EXCLUDED.description, track = EXCLUDED.track, repo_url = EXCLUDED.repo_url,
         deck_url = EXCLUDED.deck_url, demo_url = EXCLUDED.demo_url, members = EXCLUDED.members, updated_at = now()`,
      [app.id, p.team_name, p.project_name, p.tagline, p.description, p.track, p.repo_url, p.deck_url, p.demo_url, p.members]
    );
    await log(t, app.id, user.email, 'project saved', p.project_name);
    return { ok: true };
  });
}

export async function getSubmission(userId) {
  const [s] = await q(
    `SELECT s.* FROM submissions s JOIN applications a ON a.id = s.owner_app_id WHERE a.user_id = $1`,
    [userId]
  );
  return s || null;
}

// --------------------------------------------------------------------- teams

const teamCode = () => Array.from({ length: 6 }, () => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 31)]).join('');

/** Start a team. The team takes its creator's track; teammates join with the code. */
export async function createTeam(user, rawName) {
  const name = String(rawName || '').trim().slice(0, 60);
  if (name.length < 2) return { ok: false, error: 'Give your team a name.' };
  return tx(async (t) => {
    const [app] = await t.q(`SELECT id, track FROM applications WHERE event_id = 1 AND user_id = $1 AND status = 'submitted' AND team_id IS NULL FOR UPDATE`, [user.id]);
    if (!app) return { ok: false, error: 'You can only start a team while your application is under review and you are not already in one.' };
    const [team] = await t.q(`INSERT INTO teams (name, join_code, track) VALUES ($1, $2, $3) RETURNING id, join_code`, [name, teamCode(), app.track]);
    await t.q(`UPDATE applications SET team_id = $1, updated_at = now() WHERE id = $2`, [team.id, app.id]);
    await log(t, app.id, user.email, 'created team', name);
    return { ok: true, code: team.join_code };
  });
}

/**
 * Join a team by code. The team row is locked first, so two people taking the
 * last spot at once cannot both get in. Teams close once reviewing has started.
 */
export async function joinTeam(user, rawCode) {
  const code = String(rawCode || '').trim().toUpperCase();
  return tx(async (t) => {
    const [team] = await t.q(`SELECT id, name, track FROM teams WHERE join_code = $1 FOR UPDATE`, [code]);
    if (!team) return { ok: false, error: 'No team has that code.' };
    const members = await t.q(`SELECT status FROM applications WHERE team_id = $1`, [team.id]);
    if (members.length >= TEAM_MAX) return { ok: false, error: `That team is full (${TEAM_MAX} people).` };
    if (members.some((m) => m.status !== 'submitted')) return { ok: false, error: 'That team has already been reviewed, so it is closed to new members.' };
    const [app] = await t.q(
      `UPDATE applications SET team_id = $1, track = $2, updated_at = now()
        WHERE event_id = 1 AND user_id = $3 AND status = 'submitted' AND team_id IS NULL RETURNING id`,
      [team.id, team.track, user.id]
    );
    if (!app) return { ok: false, error: 'You can only join a team while your own application is under review and you are not already in one.' };
    await log(t, app.id, user.email, 'joined team', team.name);
    return { ok: true, name: team.name };
  });
}

export async function leaveTeam(user) {
  return tx(async (t) => {
    const [app] = await t.q(
      `UPDATE applications SET team_id = NULL, updated_at = now()
        WHERE event_id = 1 AND user_id = $1 AND status = 'submitted' AND team_id IS NOT NULL RETURNING id`,
      [user.id]
    );
    if (app) await log(t, app.id, user.email, 'left team');
    return !!app;
  });
}

// -------------------------------------------------------------------- tracks

export async function getTracks() {
  return q(
    `SELECT tt.track, tt.target,
            count(a.id) FILTER (WHERE a.holds_seat)::int AS held,
            count(a.id) FILTER (WHERE a.status = 'submitted')::int AS unreviewed,
            count(a.id) FILTER (WHERE a.status = 'waitlisted')::int AS waiting
       FROM track_targets tt LEFT JOIN applications a ON a.track = tt.track
      GROUP BY tt.track, tt.target ORDER BY tt.target DESC, tt.track`
  );
}

export async function setTargets(targets, actor) {
  return tx(async (t) => {
    for (const track of TRACKS) {
      const n = parseInt(targets[track], 10);
      if (n >= 0) await t.q(`UPDATE track_targets SET target = $2 WHERE track = $1`, [track, n]);
    }
    await log(t, null, actor, 'track targets changed', TRACKS.map((k) => `${k} ${targets[k]}`).join(', '));
    return true;
  });
}

// ------------------------------------------------------------------- judging

// Last year's five criteria. Each is scored 1 to 10, so a sheet is out of 50.
export const CRITERIA = [
  ['technical', 'Technical execution'],
  ['innovation', 'Innovation and problem fit'],
  ['product', 'Product and UX'],
  ['potential', 'Real-world potential'],
  ['pitch', 'Pitch and communication'],
];

export async function addJudge(rawEmail, normalized, actor) {
  await tx(async (t) => {
    await t.q(
      `INSERT INTO users (email, email_raw, is_judge) VALUES ($1, $2, true)
       ON CONFLICT (email) DO UPDATE SET is_judge = true`,
      [normalized, String(rawEmail).trim()]
    );
    await log(t, null, actor, 'judge added', normalized);
  });
}

export const removeJudge = (id) => q(`UPDATE users SET is_judge = false WHERE id = $1`, [id]);
export const setJudgingOpen = (open) => q(`UPDATE events SET judging_open = $1 WHERE id = 1`, [open]);

export async function getJudges() {
  return q(
    `SELECT u.id, u.email_raw, count(s.submission_id)::int AS scored
       FROM users u LEFT JOIN scores s ON s.judge_id = u.id WHERE u.is_judge GROUP BY u.id, u.email_raw ORDER BY u.email_raw`
  );
}

/** A judge may not score a project they submitted or are listed on. */
const OWN_PROJECT = `(a.user_id = $1 OR position(lower($2) in lower(s.members)) > 0)`;

export async function projectsForJudge(judge) {
  return q(
    `SELECT s.*, sc.technical, sc.innovation, sc.product, sc.potential, sc.pitch, sc.note, sc.updated_at AS scored_at,
            ${OWN_PROJECT} AS conflicted
       FROM submissions s
       JOIN applications a ON a.id = s.owner_app_id
       LEFT JOIN scores sc ON sc.submission_id = s.id AND sc.judge_id = $1
      ORDER BY s.track, (sc.judge_id IS NOT NULL), s.project_name`,
    [judge.id, judge.email_raw]
  );
}

/** Save or change this judge's sheet for one project. One sheet per judge per project. */
export async function saveScore(judge, submissionId, input) {
  const v = CRITERIA.map(([key]) => parseInt(input[key], 10));
  if (v.some((n) => !(n >= 1 && n <= 10))) return { ok: false, error: 'Score every criterion from 1 to 10.' };
  return tx(async (t) => {
    const [ev] = await t.q(`SELECT judging_open FROM events WHERE id = 1`);
    if (!ev.judging_open) return { ok: false, error: 'Judging is closed.' };
    const [sub] = await t.q(
      `SELECT s.id, ${OWN_PROJECT} AS conflicted FROM submissions s JOIN applications a ON a.id = s.owner_app_id WHERE s.id = $3`,
      [judge.id, judge.email_raw, submissionId]
    );
    if (!sub) return { ok: false, error: 'That project no longer exists.' };
    if (sub.conflicted) return { ok: false, error: 'You cannot score your own project.' };
    await t.q(
      `INSERT INTO scores (submission_id, judge_id, technical, innovation, product, potential, pitch, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (submission_id, judge_id) DO UPDATE SET
         technical = EXCLUDED.technical, innovation = EXCLUDED.innovation, product = EXCLUDED.product,
         potential = EXCLUDED.potential, pitch = EXCLUDED.pitch, note = EXCLUDED.note, updated_at = now()`,
      [submissionId, judge.id, ...v, String(input.note || '').trim().slice(0, 1000)]
    );
    return { ok: true };
  });
}

/** Ranking per track: mean sheet total across judges; ties go to technical execution. */
export async function leaderboard() {
  return q(
    `SELECT s.id, s.project_name, s.team_name, s.track, count(sc.judge_id)::int AS judges,
            round(avg(sc.technical + sc.innovation + sc.product + sc.potential + sc.pitch), 1)::float AS total,
            round(avg(sc.technical), 1)::float AS technical, round(avg(sc.innovation), 1)::float AS innovation,
            round(avg(sc.product), 1)::float AS product, round(avg(sc.potential), 1)::float AS potential,
            round(avg(sc.pitch), 1)::float AS pitch
       FROM submissions s LEFT JOIN scores sc ON sc.submission_id = s.id
      GROUP BY s.id ORDER BY s.track, total DESC NULLS LAST, technical DESC NULLS LAST, s.project_name`
  );
}
