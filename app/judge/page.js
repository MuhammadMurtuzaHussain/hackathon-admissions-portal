import { requireJudge } from '@/lib/auth';
import { projectsForJudge, getEvent, CRITERIA, TRACKS } from '@/lib/admissions';
import { Flash, fmt } from '../flash';
import { SubmitButton } from '../ui';
import { scoreAction } from '../actions';

export const dynamic = 'force-dynamic';

export default async function Judge({ searchParams }) {
  const sp = await searchParams;
  const judge = await requireJudge();
  const [projects, ev] = await Promise.all([projectsForJudge(judge), getEvent()]);
  const done = projects.filter((p) => p.scored_at).length;
  const mine = projects.filter((p) => !p.conflicted);
  return (
    <div className="narrow" style={{ maxWidth: 820 }}>
      <p className="eyebrow">Judging</p>
      <h1 className="page">Score the projects</h1>
      <p className="soft">
        Five criteria, 1 to 10 each. You have scored <b>{done} of {mine.length}</b>.{' '}
        {ev.judging_open ? 'You can change a score until organisers close judging.' : <b>Judging is closed; scores are frozen.</b>}
      </p>
      <Flash sp={sp} />
      {projects.length === 0 && <div className="panel dim">No projects have been submitted yet.</div>}
      {TRACKS.map((track) => {
        const rows = projects.filter((p) => p.track === track);
        if (!rows.length) return null;
        return (
          <section key={track}>
            <h2>{track} track</h2>
            <div className="panel">
              {rows.map((p) => (
                <div key={p.id} className="project">
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <b style={{ fontSize: 18 }}>{p.project_name}</b>
                    {p.conflicted ? <span className="pill flag">your own project</span> : p.scored_at ? <span className="pill confirmed">scored {fmt(p.scored_at)}</span> : <span className="pill offered">to score</span>}
                  </div>
                  <div className="soft">{p.tagline}</div>
                  <div className="sub dim" style={{ fontSize: 13, margin: '4px 0 8px' }}>
                    {p.team_name} · <a href={p.repo_url} target="_blank" rel="noreferrer">Repo</a>
                    {p.deck_url && <> · <a href={p.deck_url} target="_blank" rel="noreferrer">Deck</a></>}
                    {p.demo_url && <> · <a href={p.demo_url} target="_blank" rel="noreferrer">Demo</a></>}
                  </div>
                  <details><summary>What they built</summary><p className="soft">{p.description}</p></details>
                  {!p.conflicted && (
                    <form action={scoreAction} className="stack" style={{ marginTop: 12 }}>
                      <input type="hidden" name="submission_id" value={p.id} />
                      <fieldset disabled={!ev.judging_open} style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 12 }}>
                        <div className="scores">
                          {CRITERIA.map(([key, label]) => (
                            <label key={key}>{label}<input type="number" name={key} min="1" max="10" required defaultValue={p[key] ?? ''} /></label>
                          ))}
                        </div>
                        <label>Note for organisers <small>Optional</small><input type="text" name="note" maxLength={1000} defaultValue={p.note || ''} /></label>
                        {ev.judging_open && <div><SubmitButton className="btn btn-ghost btn-sm" pendingLabel="Saving…">{p.scored_at ? 'Update score' : 'Save score'}</SubmitButton></div>}
                      </fieldset>
                    </form>
                  )}
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
