import Link from 'next/link';
import { requireUser } from '@/lib/auth';
import { getApplication, getSubmission, getEvent, TRACKS } from '@/lib/admissions';
import { Flash, fmt } from '../flash';
import { SubmitButton } from '../ui';
import { submitProjectAction } from '../actions';

export const dynamic = 'force-dynamic';

export default async function Submit({ searchParams }) {
  const sp = await searchParams;
  const user = await requireUser('/submit');
  const [app, sub, ev] = await Promise.all([getApplication(user.id), getSubmission(user.id), getEvent()]);
  const allowed = app && ['confirmed', 'checked_in'].includes(app.status);
  const open = new Date(ev.submissions_deadline) > new Date();
  const v = sub || {};
  return (
    <div className="narrow">
      <p className="eyebrow">Project submission</p>
      <h1 className="page">{sub ? 'Your project' : 'Submit your project'}</h1>
      <Flash sp={sp} />
      {!allowed ? (
        <div className="panel">
          <p className="soft">Project submission opens to confirmed attendees. One person submits for the whole team.</p>
          <Link href="/status" className="btn btn-ghost btn-sm">Check my status</Link>
        </div>
      ) : (
        <>
          <p className="soft">
            One submission per team: whoever submits lists the teammates. {open ? <>Editable until <b>{fmt(ev.submissions_deadline)}</b>.</> : <b>The deadline has passed; this is now read-only.</b>}
            {sub && <> Last saved {fmt(sub.updated_at)}.</>}
          </p>
          <form action={submitProjectAction} className="stack panel">
            <fieldset disabled={!open} style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 18 }}>
              <div className="grid2">
                <label>Team name<input type="text" name="team_name" required defaultValue={v.team_name} /></label>
                <label>Project name<input type="text" name="project_name" required defaultValue={v.project_name} /></label>
              </div>
              <label>One-line pitch<input type="text" name="tagline" required maxLength={140} defaultValue={v.tagline} /></label>
              <label>Track
                <select name="track" required defaultValue={v.track || app.track}>{TRACKS.map((t) => <option key={t}>{t}</option>)}</select>
              </label>
              <label>What did you build?<textarea name="description" required minLength={30} defaultValue={v.description} /></label>
              <label>Code repository <small>GitHub or similar. No-code teams: link your project.</small>
                <input type="url" name="repo_url" required placeholder="https://github.com/…" defaultValue={v.repo_url} />
              </label>
              <div className="grid2">
                <label>Pitch deck <small>Optional</small><input type="url" name="deck_url" placeholder="https://" defaultValue={v.deck_url} /></label>
                <label>Live demo or website <small>Optional</small><input type="url" name="demo_url" placeholder="https://" defaultValue={v.demo_url} /></label>
              </div>
              <label>Teammates' emails <small>Comma separated, the ones they applied with</small>
                <input type="text" name="members" defaultValue={v.members} />
              </label>
              {open && <div><SubmitButton pendingLabel="Saving…">{sub ? 'Save changes' : 'Submit project'}</SubmitButton></div>}
            </fieldset>
          </form>
        </>
      )}
    </div>
  );
}
