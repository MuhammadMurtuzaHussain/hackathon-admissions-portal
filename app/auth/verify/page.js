import { SubmitButton } from '../../ui';
import { verifyAction } from '../../actions';

// The link lands on a page with a button instead of signing in on GET.
// Mail scanners (Outlook Safe Links, Gmail previews) open every link in an
// email; if GET consumed the token, the real person would find it already used.
export default async function Verify({ searchParams }) {
  const sp = await searchParams;
  return (
    <div className="narrow">
      <p className="eyebrow">Sign in</p>
      <h1 className="page">One more click</h1>
      <form action={verifyAction} className="stack">
        <input type="hidden" name="token" value={sp.token || ''} />
        <input type="hidden" name="next" value={sp.next || '/status'} />
        <div><SubmitButton pendingLabel="Signing in…">Continue to HackBelfast</SubmitButton></div>
      </form>
    </div>
  );
}
