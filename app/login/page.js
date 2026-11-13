import { Flash } from '../flash';
import { SubmitButton } from '../ui';
import { loginAction } from '../actions';
import { SHOW_LINKS } from '@/lib/mail';

export default async function Login({ searchParams }) {
  const sp = await searchParams;
  if (sp.sent) {
    return (
      <div className="narrow">
        <p className="eyebrow">Sign in</p>
        <h1 className="page">Check your inbox</h1>
        <p className="lede">We sent a sign-in link to {sp.sent}. It works once and expires in 15 minutes.</p>
        {sp.dev && (
          <p className="devbox">
            <span className="mono">DEMO MODE · sign-in links are shown on screen so anyone can try any role</span>
            <br />
            <a href={sp.dev}>Open the sign-in link</a> or see every queued email in the <a href="/dev/mailbox">dev mailbox</a>.
          </p>
        )}
      </div>
    );
  }
  return (
    <div className="narrow">
      <p className="eyebrow">Sign in</p>
      <h1 className="page">No password needed</h1>
      <p className="soft">Enter your email and we will send you a one-time link. New here? This creates your account too.</p>
      <Flash sp={sp} />
      <form action={loginAction} className="stack panel">
        <input type="hidden" name="next" value={sp.next || '/status'} />
        <label>
          Email address
          <input type="email" name="email" required autoComplete="email" placeholder="you@university.ac.uk" />
        </label>
        <div><SubmitButton pendingLabel="Sending…">Email me a link</SubmitButton></div>
      </form>
      {SHOW_LINKS && <p className="mono dim" style={{ marginTop: 16 }}>Demo organiser account: admin@hackbelfast.dev</p>}
    </div>
  );
}
