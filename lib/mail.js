// Email delivery. State changes write rows to the `outbox` table inside their
// own transaction; this drains that table through Resend afterwards. It runs
// right after each action and again from the scheduled job, so a failed send
// is retried (up to 5 attempts) instead of being lost.
import { Resend } from 'resend';
import { q } from './db';

/** Local development and DEMO_MODE show sign-in links on screen. Never enable DEMO_MODE with real applicants. */
export const SHOW_LINKS = process.env.NODE_ENV !== 'production' || process.env.DEMO_MODE === '1';

const FROM = process.env.EMAIL_FROM || 'HackBelfast <onboarding@resend.dev>';
// Addresses that belong to seeded demo people. Nothing is ever sent to them.
const FAKE = `to_email ILIKE '%@example.com' OR to_email ILIKE '%@hackbelfast.dev'`;

export async function deliverOutbox(limit = 25) {
  await q(`UPDATE outbox SET sent_at = now(), result = 'skipped: demo address' WHERE sent_at IS NULL AND (${FAKE})`);
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    await q(`UPDATE outbox SET sent_at = now(), result = 'not sent: no email provider configured' WHERE sent_at IS NULL`);
    return { sent: 0, failed: 0 };
  }
  // Claim a batch so two overlapping runs never send the same email twice.
  const batch = await q(
    `UPDATE outbox SET claimed_at = now(), attempts = attempts + 1
      WHERE id IN (SELECT id FROM outbox
                    WHERE sent_at IS NULL AND attempts < 5
                      AND (claimed_at IS NULL OR claimed_at < now() - interval '2 minutes')
                    ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING id, to_email, subject, body`,
    [limit]
  );
  const resend = new Resend(key);
  let sent = 0, failed = 0;
  for (const m of batch) {
    let problem = '';
    try {
      const { error } = await resend.emails.send({ from: FROM, to: [m.to_email], subject: m.subject, text: m.body });
      if (error) problem = error.message || 'rejected by provider';
    } catch (e) {
      problem = e.message || 'network error';
    }
    if (problem) {
      failed++;
      await q(`UPDATE outbox SET result = $2 WHERE id = $1`, [m.id, `failed: ${problem}`.slice(0, 300)]);
    } else {
      sent++;
      await q(`UPDATE outbox SET sent_at = now(), result = 'sent' WHERE id = $1`, [m.id]);
    }
  }
  return { sent, failed };
}
