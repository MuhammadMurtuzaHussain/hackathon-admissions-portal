// Dev-only helpers used by scripts/race.mjs. They do not exist in production builds.
import { q } from '@/lib/db';
import * as adm from '@/lib/admissions';
import { userFor, fakeApplication, resetAll, seedApplicants, seedProjects, confirmAllOffers } from '@/lib/demo';

export async function POST(req, { params }) {
  if (process.env.NODE_ENV === 'production') return new Response('Not found', { status: 404 });
  const { action } = await params;
  const sp = new URL(req.url).searchParams;
  const n = parseInt(sp.get('n') || '0', 10);
  const json = (data) => Response.json(data);

  switch (action) {
    case 'reset':
      await resetAll();
      return json({ ok: true });
    case 'seed':
      return json(await seedApplicants(n));
    case 'seed-projects':
      return json(await seedProjects(n));
    case 'apply': {
      const user = await userFor(sp.get('email'));
      return json(await adm.submitApplication(user, fakeApplication(0)));
    }
    case 'ids': {
      // solo=1: only people without a team. team=k: one member from each fully-unreviewed team of at least k.
      if (sp.get('team'))
        return json(await q(
          `SELECT min(id::text) AS id, count(*)::int AS size FROM applications WHERE team_id IS NOT NULL
            GROUP BY team_id HAVING count(*) >= $1 AND bool_and(status = $2) LIMIT $3`,
          [parseInt(sp.get('team'), 10), sp.get('status'), n]));
      return json(await q(
        `SELECT id FROM applications WHERE status = $1 AND ($3 = '' OR team_id IS NULL) ORDER BY score DESC LIMIT $2`,
        [sp.get('status'), n, sp.get('solo') || '']));
    }
    case 'team-rush': {
      // One captain starts a team, then n people enter the code at the same moment.
      const stamp = Date.now().toString(36);
      const mk = async (i) => {
        const user = await userFor(`rush${i}.${stamp}@example.com`);
        await adm.submitApplication(user, fakeApplication(i));
        return user;
      };
      const captain = await mk(0);
      const { code } = await adm.createTeam(captain, 'Rush Team');
      const joiners = await Promise.all(Array.from({ length: n }, (_, i) => mk(i + 1)));
      const results = await Promise.all(joiners.map((u) => adm.joinTeam(u, code)));
      const [{ size }] = await q(`SELECT count(*)::int AS size FROM applications a JOIN teams t ON t.id = a.team_id WHERE t.join_code = $1`, [code]);
      return json({ joined: results.filter((r) => r.ok).length, size });
    }
    case 'targets': {
      const only = sp.get('only');
      await q(`UPDATE track_targets SET target = CASE WHEN track = $1 THEN 1000 ELSE 0 END`, [only]);
      return json({ ok: true });
    }
    case 'last-offer':
      return json((await q(`SELECT a.track FROM audit_log l JOIN applications a ON a.id = l.application_id WHERE l.action = 'offered' ORDER BY l.id DESC LIMIT 1`))[0]);
    case 'bulk':
      return json(await adm.bulkOffer(n, 'dev'));
    case 'waitlist-rest':
      return json({ moved: await adm.waitlistRemaining('dev') });
    case 'claim':
      return json({ result: await adm.tryClaim(sp.get('id'), 'dev') });
    case 'confirm-all':
      return json(await confirmAllOffers());
    case 'withdraw': {
      const [u] = await q(`SELECT u.id, u.email FROM users u JOIN applications a ON a.user_id = u.id WHERE a.id = $1`, [sp.get('id')]);
      return json({ ok: await adm.withdraw(u) });
    }
    case 'lapse':
      await q(
        `UPDATE applications SET offer_expires_at = now() - interval '1 minute'
          WHERE id IN (SELECT id FROM applications WHERE status = 'offered' LIMIT $1)`,
        [n]
      );
      return json({ released: await adm.expireOffers() });
    case 'state': {
      const [ev] = await q(`SELECT capacity, seats_taken FROM events WHERE id = 1`);
      const [{ holders }] = await q(`SELECT count(*)::int AS holders FROM applications WHERE holds_seat`);
      const [{ apps }] = await q(`SELECT count(*)::int AS apps FROM applications`);
      const [{ users }] = await q(`SELECT count(*)::int AS users FROM users WHERE NOT is_admin`);
      const by = (await adm.getStats()).by;
      // Teams where an offer reached some members but left others unreviewed or waitlisted.
      const [{ split }] = await q(
        `SELECT count(*)::int AS split FROM (
           SELECT team_id FROM applications WHERE team_id IS NOT NULL GROUP BY team_id
           HAVING bool_or(status = 'offered') AND bool_or(status IN ('submitted', 'waitlisted'))) x`);
      return json({ ...ev, holders, apps, users, by, split });
    }
    default:
      return new Response('Unknown action', { status: 400 });
  }
}
