import { notFound } from 'next/navigation';
import { q } from '@/lib/db';
import { SHOW_LINKS } from '@/lib/mail';
import { fmt } from '../../flash';

export const dynamic = 'force-dynamic';

export default async function Mailbox() {
  if (!SHOW_LINKS) notFound();
  const mails = await q(`SELECT * FROM outbox ORDER BY id DESC LIMIT 60`);
  const linkify = (text) =>
    text.split(/(https?:\/\/\S+)/).map((part, i) => (part.startsWith('http') ? <a key={i} href={part}>{part}</a> : part));
  return (
    <>
      <p className="eyebrow">Demo only</p>
      <h1 className="page">Outbox</h1>
      <p className="soft">Every email the app would send. In production a worker drains this table through a mail provider.</p>
      <div className="table-wrap">
        <table>
          <thead><tr><th>When</th><th>To</th><th>Subject</th><th>Body</th><th>Delivery</th></tr></thead>
          <tbody>
            {mails.map((m) => (
              <tr key={m.id}>
                <td className="num">{fmt(m.at)}</td><td>{m.to_email}</td><td>{m.subject}</td>
                <td style={{ wordBreak: 'break-all' }}>{linkify(m.body)}</td>
                <td className="sub">{m.sent_at ? m.result : 'queued'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
