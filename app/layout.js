import './globals.css';
import Link from 'next/link';
import { currentUser } from '@/lib/auth';
import { logoutAction } from './actions';

export const metadata = {
  title: 'HackBelfast 2027 · Applications',
  description: 'Apply, track your place and submit your project.',
  // This is a private demo: keep it out of search engines.
  robots: { index: false, follow: false, nocache: true },
};

export default async function RootLayout({ children }) {
  const user = await currentUser();
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@600;700&family=Space+Grotesk:wght@400;500;600&family=Space+Mono&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <header className="nav">
          <Link href="/" className="brand">
            <span className="mark" aria-hidden="true" />
            HackBelfast
          </Link>
          <nav>
            <Link href="/apply">Apply</Link>
            <Link href="/status">My status</Link>
            <Link href="/submit">Submit project</Link>
            {user?.is_judge && <Link href="/judge">Judging</Link>}
            {user?.is_admin && <Link href="/admin">Organisers</Link>}
          </nav>
          <div className="who">
            {user ? (
              <form action={logoutAction}>
                <span className="mono dim">{user.email_raw}</span>
                <button className="link">Sign out</button>
              </form>
            ) : (
              <Link href="/login" className="btn btn-ghost btn-sm">Sign in</Link>
            )}
          </div>
        </header>
        <main>{children}</main>
        <footer className="foot mono">
          <span>X: 5.9301° · Y: 54.5973°</span>
          <span>
            Prototype, not the official HackBelfast site · Built by{' '}
            <a href="https://github.com/MuhammadMurtuzaHussain" target="_blank" rel="noreferrer">Muhammad Murtuza Hussain</a> ·{' '}
            <a href="https://github.com/MuhammadMurtuzaHussain/hackathon-admissions-portal" target="_blank" rel="noreferrer">Source</a>
          </span>
        </footer>
      </body>
    </html>
  );
}
