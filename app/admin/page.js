import Link from 'next/link';
import { requireAdmin } from '@/lib/auth';
import { q } from '@/lib/db';
import { DEMO_MODE } from '@/lib/demo';
import { expireOffers, getEvent, getStats, getTracks, getJudges, leaderboard, TRACKS, TEAM_MIN, CRITERIA } from '@/lib/admissions';
import { Flash, fmt } from '../flash';
import { SubmitButton } from '../ui';
import * as act from '../actions';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const TABS = ['submitted', 'offered', 'confirmed', 'waitlisted', 'checked_in', 'rejected', 'withdrawn', 'expired'];
const Btn = ({ action, children, danger }) => (
  <SubmitButton formAction={action} className={`btn btn-sm ${danger ? 'btn-danger' : 'btn-ghost'}`} pendingLabel="…">{children}</SubmitButton>
);

export default async function Admin({ searchParams }) {
  const sp = await searchParams;
  await requireAdmin();
  await expireOffers(); // lapsed offers are released whenever an organiser looks, as well as by the scheduled job
  const view = ['projects', 'log', 'judging'].includes(sp.view) ? sp.view : 'applications';
  const status = TABS.includes(sp.status) ? sp.status : 'submitted';
  const [ev, stats, tracks] = await Promise.all([getEvent(), getStats(), getTracks()]);
  const search = String(sp.q || '').trim().slice(0, 80);
  const back = search ? `/admin?q=${encodeURIComponent(search)}` : view === 'applications' ? `/admin?status=${status}` : `/admin?view=${view}`;
  const pct = Math.round((ev.seats_taken / ev.capacity) * 100);

  let apps = [], projects = [], logs = [], judges = [], board = [];
  if (view === 'judging') [judges, board] = await Promise.all([getJudges(), leaderboard()]);
  if (view === 'applications') {
    apps = await q(
      `SELECT * FROM (
         SELECT a.*, u.email_raw, tm.name AS team_name,
                CASE WHEN a.team_id IS NOT NULL THEN count(*) OVER (PARTITION BY a.team_id) ELSE 1 END AS team_size,
                CASE WHEN a.github <> '' THEN count(*) OVER (PARTITION BY a.github) ELSE 1 END AS gh_n,
                CASE WHEN a.linkedin <> '' THEN count(*) OVER (PARTITION BY a.linkedin) ELSE 1 END AS li_n,
                count(*) OVER (PARTITION BY lower(a.full_name), lower(a.affiliation)) AS name_n
           FROM applications a JOIN users u ON u.id = a.user_id LEFT JOIN teams tm ON tm.id = a.team_id) x
        WHERE CASE WHEN $2 = '' THEN status = $1
                   ELSE full_name ILIKE '%' || $2 || '%' OR email_raw ILIKE '%' || $2 || '%' OR affiliation ILIKE '%' || $2 || '%' END
        ORDER BY score DESC, COALESCE(waitlisted_at, applied_at) ASC LIMIT 100`,
      [status, search]
    );
  } else if (view === 'projects') {
    projects = await q(
      `SELECT s.*, a.full_name, u.email_raw FROM submissions s
         JOIN applications a ON a.id = s.owner_app_id JOIN users u ON u.id = a.user_id ORDER BY s.updated_at DESC`
    );
  } else if (view === 'log') {
    logs = await q(
      `SELECT l.*, a.full_name FROM audit_log l LEFT JOIN applications a ON a.id = l.application_id ORDER BY l.id DESC LIMIT 150`
    );
  }

  return (
    <>
      <p className="eyebrow">Organisers</p>
      <h1 className="page">Admissions</h1>
      <Flash sp={sp} />

      <div className="panel">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <b>{ev.seats_taken} of {ev.capacity} places handed out</b>
          <span className="mono dim">{ev.seats_left} free · offers last {ev.offer_ttl_hours}h</span>
        </div>
        <div className="bar" style={{ margin: '12px 0 18px' }} role="img" aria-label={`${pct}% of places handed out`}><i style={{ width: `${pct}%` }} /></div>
        <div className="tools">
          <form action={act.bulkOfferAction}>
            <input type="hidden" name="back" value={back} />
            <label>Offer to top N unreviewed<input type="number" name="n" min="1" max="500" defaultValue={Math.max(1, Math.min(ev.seats_left, stats.by.submitted || 1))} /></label>
            <SubmitButton className="btn btn-primary btn-sm" pendingLabel="Offering…">Send offers</SubmitButton>
          </form>
          <form action={act.waitlistRemainingAction}>
            <input type="hidden" name="back" value={back} />
            <SubmitButton className="btn btn-ghost btn-sm" pendingLabel="…">Waitlist all unreviewed</SubmitButton>
          </form>
          <form action={act.expireAction}>
            <input type="hidden" name="back" value={back} />
            <SubmitButton className="btn btn-ghost btn-sm" pendingLabel="…">Release lapsed offers</SubmitButton>
          </form>
          <form action={act.capacityAction}>
            <input type="hidden" name="back" value={back} />
            <label>Capacity<input type="number" name="capacity" min="1" defaultValue={ev.capacity} /></label>
            <SubmitButton className="btn btn-ghost btn-sm" pendingLabel="…">Set</SubmitButton>
          </form>
        </div>
      </div>

      <div className="panel" style={{ marginTop: 16 }}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <b>Track balance</b>
          <span className="mono dim">Tracks under target are offered first, then by score</span>
        </div>
        <form action={act.targetsAction} className="tracks">
          <input type="hidden" name="back" value={back} />
          {tracks.map((t) => (
            <div key={t.track}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span>{t.track}</span>
                <span className="mono dim">{t.held} of {t.target} · {t.unreviewed} to review · {t.waiting} waiting</span>
              </div>
              <div className="bar" style={{ margin: '6px 0 8px' }} role="img" aria-label={`${t.track}: ${t.held} of target ${t.target}`}>
                <i style={{ width: `${Math.min(100, t.target ? (t.held / t.target) * 100 : 100)}%` }} />
              </div>
              <label>Target<input type="number" name={t.track} min="0" defaultValue={t.target} /></label>
            </div>
          ))}
          <div style={{ alignSelf: 'end' }}><SubmitButton className="btn btn-ghost btn-sm" pendingLabel="…">Save targets</SubmitButton></div>
        </form>
      </div>

      <div className="stats">
        <div className="stat"><b>{stats.total}</b><span>Applications</span></div>
        <div className="stat"><b>{stats.by.submitted || 0}</b><span>To review</span></div>
        <div className="stat"><b>{stats.by.offered || 0}</b><span>Awaiting confirm</span></div>
        <div className="stat"><b>{(stats.by.confirmed || 0) + (stats.by.checked_in || 0)}</b><span>Confirmed</span></div>
        <div className="stat"><b>{stats.by.waitlisted || 0}</b><span>Waitlist</span></div>
      </div>

      {DEMO_MODE && (
        <div className="devbox row" style={{ justifyContent: 'space-between', wordBreak: 'normal' }}>
          <span><span className="mono">DEMO MODE</span> · fill the site with fake applicants, teams, projects and scores, or wipe it. <a href="/dev/mailbox">See queued emails</a></span>
          <form className="row">
            <input type="hidden" name="back" value={back} />
            <SubmitButton formAction={act.demoLoadAction} className="btn btn-ghost btn-sm" pendingLabel="Loading, about a minute…">Load demo data</SubmitButton>
            <SubmitButton formAction={act.demoWipeAction} className="btn btn-danger btn-sm" pendingLabel="Wiping…">Wipe everything</SubmitButton>
          </form>
        </div>
      )}

      <div className="tabs">
        {TABS.map((t) => (
          <Link key={t} href={`/admin?status=${t}`} className={view === 'applications' && !search && status === t ? 'on' : ''}>
            {t.replace('_', ' ')} · {stats.by[t] || 0}
          </Link>
        ))}
        <Link href="/admin?view=projects" className={view === 'projects' ? 'on' : ''}>Projects</Link>
        <Link href="/admin?view=judging" className={view === 'judging' ? 'on' : ''}>Judging</Link>
        <Link href="/admin?view=log" className={view === 'log' ? 'on' : ''}>Audit log</Link>
      </div>

      {view === 'applications' && (
        <form method="get" action="/admin" className="row" style={{ marginBottom: 14 }}>
          <label style={{ flex: 1, minWidth: 220 }}>
            Find an applicant
            <input type="text" name="q" defaultValue={search} placeholder="Name, email or university" />
          </label>
          <button className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-end' }}>Search</button>
          {search && <Link href="/admin" className="link" style={{ alignSelf: 'flex-end' }}>Clear</Link>}
        </form>
      )}
      {view === 'applications' && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Applicant</th><th>Track</th><th>Score</th><th>Links</th><th>Answer</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {apps.length === 0 && <tr><td colSpan="7" className="dim">Nobody here.</td></tr>}
              {apps.map((a) => {
                const flags = [...(a.score_detail.flags || [])];
                if (a.gh_n > 1) flags.push('same GitHub as another applicant');
                if (a.li_n > 1) flags.push('same LinkedIn as another applicant');
                if (a.name_n > 1) flags.push('same name and affiliation as another applicant');
                if (a.team_id && a.team_size < TEAM_MIN) flags.push(`team has only ${a.team_size}`);
                return (
                  <tr key={a.id}>
                    <td><b>{a.full_name}</b><div className="sub">{a.email_raw}</div><div className="sub">{a.affiliation} · {a.role_type}</div>{a.team_id && <div><span className="pill waitlisted">Team {a.team_name} · {a.team_size}</span></div>}</td>
                    <td>{a.track}<div className="sub">{a.experience}</div>{!a.team_id && <div className="sub">{a.team_pref}</div>}</td>
                    <td className="num">
                      {a.score}
                      <details><summary>why</summary>{(a.score_detail.parts || []).map((p) => <div key={p.label} className="sub">{p.label}: {p.pts}/{p.max}</div>)}</details>
                      {flags.map((f) => <div key={f}><span className="pill flag">{f}</span></div>)}
                    </td>
                    <td>
                      {a.github && <div><a href={`https://github.com/${a.github}`} target="_blank" rel="noreferrer">GitHub</a></div>}
                      {a.linkedin && <div><a href={`https://www.linkedin.com/in/${a.linkedin}`} target="_blank" rel="noreferrer">LinkedIn</a></div>}
                      {a.portfolio && <div><a href={a.portfolio} target="_blank" rel="noreferrer">Portfolio</a></div>}
                    </td>
                    <td style={{ maxWidth: 300 }}><details><summary>{a.motivation.slice(0, 60)}…</summary>{a.motivation}</details></td>
                    <td><span className={`pill ${a.status}`}>{a.status.replace('_', ' ')}</span><div className="sub">{a.status === 'offered' ? `until ${fmt(a.offer_expires_at)}` : `applied ${fmt(a.applied_at)}`}</div></td>
                    <td className="actions">
                      <form>
                        <input type="hidden" name="id" value={a.id} />
                        <input type="hidden" name="back" value={back} />
                        {['submitted', 'waitlisted'].includes(a.status) && <Btn action={act.offerAction}>{a.team_size > 1 ? `Offer team (${a.team_size})` : 'Offer'}</Btn>}
                        {a.status === 'submitted' && <Btn action={act.waitlistAction}>{a.team_size > 1 ? 'Waitlist team' : 'Waitlist'}</Btn>}
                        {['submitted', 'waitlisted'].includes(a.status) && <Btn action={act.rejectAction} danger>Reject</Btn>}
                        {a.status === 'confirmed' && <Btn action={act.checkInAction}>Check in</Btn>}
                        {['offered', 'confirmed'].includes(a.status) && <Btn action={act.revokeAction} danger>Release seat</Btn>}
                      </form>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {view === 'projects' && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Project</th><th>Team</th><th>Track</th><th>Links</th><th>Saved</th></tr></thead>
            <tbody>
              {projects.length === 0 && <tr><td colSpan="5" className="dim">No projects submitted yet.</td></tr>}
              {projects.map((p) => (
                <tr key={p.id}>
                  <td><b>{p.project_name}</b><div className="sub">{p.tagline}</div></td>
                  <td>{p.team_name}<div className="sub">{p.full_name} · {p.email_raw}</div><div className="sub">{p.members}</div></td>
                  <td>{p.track}</td>
                  <td>
                    <div><a href={p.repo_url} target="_blank" rel="noreferrer">Repo</a></div>
                    {p.deck_url && <div><a href={p.deck_url} target="_blank" rel="noreferrer">Deck</a></div>}
                    {p.demo_url && <div><a href={p.demo_url} target="_blank" rel="noreferrer">Demo</a></div>}
                  </td>
                  <td className="num">{fmt(p.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {view === 'judging' && (
        <>
          <div className="panel">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <b>Judging is {ev.judging_open ? 'open' : 'closed'}</b>
              <form action={act.judgingToggleAction}>
                <input type="hidden" name="back" value={back} />
                <input type="hidden" name="open" value={ev.judging_open ? '0' : '1'} />
                <SubmitButton className="btn btn-ghost btn-sm" pendingLabel="…">{ev.judging_open ? 'Close judging and freeze scores' : 'Reopen judging'}</SubmitButton>
              </form>
            </div>
            <div className="tools" style={{ marginTop: 14 }}>
              <form action={act.addJudgeAction}>
                <input type="hidden" name="back" value={back} />
                <label>Add a judge by email<input type="email" name="email" required placeholder="judge@company.com" style={{ padding: '7px 10px', fontSize: 14, width: 260 }} /></label>
                <SubmitButton className="btn btn-primary btn-sm" pendingLabel="…">Add judge</SubmitButton>
              </form>
            </div>
            {judges.length > 0 && (
              <ul style={{ listStyle: 'none', padding: 0, margin: '14px 0 0' }}>
                {judges.map((j) => (
                  <li key={j.id} className="row" style={{ padding: '6px 0', borderTop: '1px solid var(--line)' }}>
                    <span style={{ flex: 1 }}>{j.email_raw}</span>
                    <span className="mono dim">{j.scored} of {board.length} scored</span>
                    <form action={act.removeJudgeAction}>
                      <input type="hidden" name="back" value={back} /><input type="hidden" name="id" value={j.id} />
                      <SubmitButton className="btn btn-danger btn-sm" pendingLabel="…">Remove</SubmitButton>
                    </form>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {TRACKS.map((track) => {
            const rows = board.filter((b) => b.track === track);
            return (
              <div key={track}>
                <h2>{track} track</h2>
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>#</th><th>Project</th><th>Avg / 50</th><th>Judges</th>{CRITERIA.map(([k, label]) => <th key={k}>{label.split(' ')[0]}</th>)}</tr></thead>
                    <tbody>
                      {rows.length === 0 && <tr><td colSpan="9" className="dim">No projects in this track yet.</td></tr>}
                      {rows.map((b, i) => (
                        <tr key={b.id}>
                          <td className="num">{b.judges ? i + 1 : ''}</td>
                          <td><b>{b.project_name}</b><div className="sub">{b.team_name}</div></td>
                          <td className="num"><b>{b.total ?? 'not scored'}</b></td>
                          <td className="num">{b.judges}{b.judges > 0 && b.judges < 2 && <div><span className="pill flag">one judge only</span></div>}</td>
                          {CRITERIA.map(([k]) => <td key={k} className="num">{b[k] ?? ''}</td>)}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })}
        </>
      )}

      {view === 'log' && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>When</th><th>Who did it</th><th>Action</th><th>Applicant</th><th>Detail</th></tr></thead>
            <tbody>
              {logs.map((l) => (
                <tr key={l.id}><td className="num">{fmt(l.at)}</td><td>{l.actor}</td><td>{l.action}</td><td>{l.full_name}</td><td className="sub">{l.detail}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
