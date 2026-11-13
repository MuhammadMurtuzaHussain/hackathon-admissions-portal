import Link from 'next/link';
import { getEvent, getStats } from '@/lib/admissions';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const [ev, stats] = await Promise.all([getEvent(), getStats()]);
  return (
    <>
      <p className="eyebrow">Applications · 2027</p>
      <h1>HackBelfast</h1>
      <p className="lede">
        {ev.capacity} places, 24 to 36 hours, three tracks. Apply solo or as a team of three to five, track your
        place, and submit your project from the same account.
      </p>
      <div className="row" style={{ marginTop: 28 }}>
        <Link href="/apply" className="btn btn-primary">Apply now →</Link>
        <Link href="/status" className="btn btn-ghost">Check my status</Link>
      </div>

      <div className="stats">
        <div className="stat"><b>{ev.capacity}</b><span>Places</span></div>
        <div className="stat"><b>{stats.total}</b><span>Applications</span></div>
        <div className="stat"><b>{ev.seats_left}</b><span>Places left</span></div>
        <div className="stat"><b>{stats.by.waitlisted || 0}</b><span>On the waitlist</span></div>
      </div>

      <h2>How getting a place works</h2>
      <ol className="steps">
        <li><b>Apply</b>Sign in with an emailed link and fill in one form. Start a team and share its code, or apply solo.</li>
        <li><b>Review</b>Organisers read every application. Teams are accepted or waitlisted together, never split.</li>
        <li><b>Confirm</b>If you get an offer you have {ev.offer_ttl_hours} hours to confirm. Unconfirmed places are released.</li>
        <li><b>Waitlist</b>When anyone drops out, the next person on the waitlist is offered that place automatically.</li>
      </ol>
    </>
  );
}
