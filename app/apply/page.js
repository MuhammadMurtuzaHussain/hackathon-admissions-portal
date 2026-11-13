import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth';
import { getApplication, getEvent, TRACKS, ROLES, EXPERIENCE, TEAM_PREFS } from '@/lib/admissions';
import { Flash } from '../flash';
import { SubmitButton } from '../ui';
import { applyAction } from '../actions';

export const dynamic = 'force-dynamic';

const Select = ({ name, label, options, value }) => (
  <label>
    {label}
    <select name={name} required defaultValue={value || ''}>
      <option value="" disabled>Choose…</option>
      {options.map((o) => <option key={o}>{o}</option>)}
    </select>
  </label>
);

export default async function Apply({ searchParams }) {
  const sp = await searchParams;
  const user = await requireUser('/apply');
  const [app, ev] = await Promise.all([getApplication(user.id), getEvent()]);
  if (app && app.status !== 'submitted') redirect('/status');
  if (!app && !ev.applications_open) redirect('/status?error=' + encodeURIComponent('Applications are closed.'));
  const v = app || {};
  return (
    <div className="narrow">
      <p className="eyebrow">{app ? 'Edit application' : 'Apply'}</p>
      <h1 className="page">{app ? 'Update your application' : 'Apply to HackBelfast'}</h1>
      <p className="soft">Applying as <b>{user.email_raw}</b>. One application per person; you can edit this until we review it.</p>
      <Flash sp={sp} />
      <form action={applyAction} className="stack panel">
        <div className="grid2">
          <label>Full name<input type="text" name="full_name" required defaultValue={v.full_name} autoComplete="name" /></label>
          <label>University or company<input type="text" name="affiliation" required defaultValue={v.affiliation} /></label>
          <Select name="role_type" label="I am a" options={ROLES} value={v.role_type} />
          <Select name="track" label={v.team_id ? 'Track (set by your team)' : 'Track I am most interested in'} options={TRACKS} value={v.track} />
          <Select name="experience" label="Hackathon experience" options={EXPERIENCE} value={v.experience} />
          <Select name="team_pref" label="Team plans" options={TEAM_PREFS} value={v.team_pref} />
          <label>GitHub <small>Username or link. Optional.</small><input type="text" name="github" defaultValue={v.github} placeholder="octocat" /></label>
          <label>LinkedIn <small>Username or link. Optional.</small><input type="text" name="linkedin" defaultValue={v.linkedin} /></label>
        </div>
        <label>Portfolio or something you have made <small>Full link. Optional.</small>
          <input type="url" name="portfolio" defaultValue={v.portfolio} placeholder="https://" />
        </label>
        <label>What do you want to build, and why HackBelfast?
          <small>A few sentences is plenty. No code experience needed.</small>
          <textarea name="motivation" required minLength={20} maxLength={2000} defaultValue={v.motivation} />
        </label>
        <label className="check">
          <input type="checkbox" name="consent" required defaultChecked={!!app} />
          <span>I am 18 or over, I agree to the code of conduct, and I agree to my details being used to review this application.</span>
        </label>
        <div><SubmitButton pendingLabel="Submitting…">{app ? 'Save changes' : 'Submit application'}</SubmitButton></div>
      </form>
    </div>
  );
}
