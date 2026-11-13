import Link from 'next/link';
import { requireUser } from '@/lib/auth';
import { expireOffers, getApplication, TEAM_MIN, TEAM_MAX } from '@/lib/admissions';
import { Flash, fmt } from '../flash';
import { SubmitButton } from '../ui';
import { confirmAction, withdrawAction, rejoinAction, createTeamAction, joinTeamAction, leaveTeamAction } from '../actions';

export const dynamic = 'force-dynamic';

const Withdraw = ({ label = 'Withdraw my application' }) => (
  <form action={withdrawAction}><SubmitButton className="btn btn-danger btn-sm">{label}</SubmitButton></form>
);

export default async function Status({ searchParams }) {
  const sp = await searchParams;
  const user = await requireUser('/status');
  await expireOffers();
  const app = await getApplication(user.id);
  const lapsed = app?.status === 'offered' && new Date(app.offer_expires_at) < new Date();

  let body;
  if (!app) {
    body = (
      <>
        <p className="big-status">You have not applied yet.</p>
        <Link href="/apply" className="btn btn-primary">Start my application →</Link>
      </>
    );
  } else if (app.status === 'submitted') {
    body = (
      <>
        <p className="big-status">Application received. We are reviewing it.</p>
        <p className="soft">We review in batches and email you either way. You can still edit your answers.</p>
        <div className="row"><Link href="/apply" className="btn btn-ghost btn-sm">Edit application</Link><Withdraw /></div>
      </>
    );
  } else if (app.status === 'offered' && !lapsed) {
    body = (
      <>
        <p className="big-status"><span className="grad-text">You have a place.</span> Confirm it to keep it.</p>
        <p className="soft">Confirm by <b>{fmt(app.offer_expires_at)}</b>. After that it goes to the next person on the waitlist.</p>
        <div className="row">
          <form action={confirmAction}><SubmitButton pendingLabel="Confirming…">Confirm my place</SubmitButton></form>
          <Withdraw label="I can't make it" />
        </div>
      </>
    );
  } else if (app.status === 'offered') {
    body = <p className="big-status">Your offer has run out. It will be released shortly.</p>;
  } else if (app.status === 'confirmed' || app.status === 'checked_in') {
    body = (
      <>
        <p className="big-status"><span className="grad-text">{app.status === 'checked_in' ? 'You are checked in.' : 'You are in.'}</span></p>
        <p className="soft">Show this code at the door.</p>
        <p className="ticket">{app.id.slice(0, 8).toUpperCase()}</p>
        <div className="row" style={{ marginTop: 20 }}>
          <Link href="/submit" className="btn btn-ghost btn-sm">Submit your project</Link>
          {app.status === 'confirmed' && <Withdraw label="I can no longer attend" />}
        </div>
      </>
    );
  } else if (app.status === 'waitlisted') {
    body = (
      <>
        <p className="big-status">You are on the waitlist. <span className="grad-text">#{app.waitlist_position}</span> in the {app.track} queue</p>
        <p className="soft">
          Places open as people drop out. The moment one is yours we email you and you get a fixed window to confirm.
          {app.team && <> Your team moves together, so it needs {app.team.members.filter((m) => m.status === 'waitlisted').length} places to open at once.</>}
        </p>
        <Withdraw label="Leave the waitlist" />
      </>
    );
  } else if (app.status === 'rejected') {
    body = <p className="big-status">We could not offer you a place this year.</p>;
  } else {
    body = (
      <>
        <p className="big-status">{app.status === 'expired' ? 'Your offer lapsed.' : 'You withdrew your application.'}</p>
        <p className="soft">Changed your mind? You can rejoin at the back of the queue.</p>
        <form action={rejoinAction}><SubmitButton className="btn btn-ghost btn-sm">Rejoin the queue</SubmitButton></form>
      </>
    );
  }

  return (
    <div className="narrow">
      <p className="eyebrow">My status {app && <span className={`pill ${app.status}`} style={{ marginLeft: 8 }}>{app.status.replace('_', ' ')}</span>}</p>
      <Flash sp={sp} />
      <div className="panel">{body}</div>
      {app?.team && (
        <div className="panel" style={{ marginTop: 16 }}>
          <p className="eyebrow">Your team · {app.team.track} track</p>
          <h2 style={{ margin: '6px 0 10px' }}>{app.team.name}</h2>
          <ul style={{ margin: '0 0 14px', paddingLeft: 18 }} className="soft">
            {app.team.members.map((m) => (
              <li key={m.user_id}>{m.full_name}{m.user_id === user.id && ' (you)'} <span className={`pill ${m.status}`}>{m.status.replace('_', ' ')}</span></li>
            ))}
          </ul>
          {app.status === 'submitted' && (
            <>
              <p className="soft">Teammates apply with their own email, then enter this code on their status page:</p>
              <p className="ticket">{app.team.join_code}</p>
              <p className="dim" style={{ fontSize: 14 }}>
                {app.team.members.length} of {TEAM_MAX} places used. Teams need at least {TEAM_MIN} people; we accept or waitlist the whole team together.
              </p>
              <form action={leaveTeamAction}><SubmitButton className="btn btn-danger btn-sm">Leave team</SubmitButton></form>
            </>
          )}
        </div>
      )}
      {app && !app.team && app.status === 'submitted' && (
        <div className="panel" style={{ marginTop: 16 }}>
          <p className="eyebrow">Applying as a team?</p>
          <p className="soft">Teams of {TEAM_MIN} to {TEAM_MAX} are reviewed together and get in together. Everyone applies with their own email first.</p>
          <div className="grid2">
            <form action={createTeamAction} className="stack">
              <label>Start a team<input type="text" name="name" required maxLength={60} placeholder="Team name" /></label>
              <div><SubmitButton className="btn btn-ghost btn-sm">Create team</SubmitButton></div>
            </form>
            <form action={joinTeamAction} className="stack">
              <label>Join with a code<input type="text" name="code" required maxLength={6} placeholder="6-character code" style={{ textTransform: 'uppercase' }} /></label>
              <div><SubmitButton className="btn btn-ghost btn-sm">Join team</SubmitButton></div>
            </form>
          </div>
        </div>
      )}
      {app && <p className="mono dim" style={{ marginTop: 14 }}>Applied {fmt(app.applied_at)} · {app.track} track · {user.email_raw}</p>}
    </div>
  );
}
