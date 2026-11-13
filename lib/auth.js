// Passwordless auth: emailed one-time link -> server-side session cookie.
// No passwords to store, leak or reset, and the email address is verified
// as a side effect, which is what makes "one application per person" hold.
import crypto from 'node:crypto';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { q, tx } from './db';

const COOKIE = 'hb_session';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
// Organisers are named in ADMIN_EMAILS. The shared demo organiser account only exists
// in local development and DEMO_MODE, where sign-in links are shown on screen.
const DEMO = process.env.NODE_ENV !== 'production' || process.env.DEMO_MODE === '1';
const ADMINS = [process.env.ADMIN_EMAILS, DEMO ? 'admin@hackbelfast.dev' : ''].filter(Boolean).join(',')
  .split(',')
  .map((e) => normalizeEmail(e))
  .filter(Boolean);

/** Collapse the common "same inbox, different spelling" tricks into one key. */
export function normalizeEmail(raw) {
  const email = String(raw || '').trim().toLowerCase();
  const at = email.lastIndexOf('@');
  if (at < 1) return email;
  let local = email.slice(0, at).split('+')[0];
  let domain = email.slice(at + 1);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replaceAll('.', '');
  return `${local}@${domain}`;
}

export function isValidEmail(raw) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(raw || '').trim());
}

/** Create a single-use, 15-minute login link and queue the email. */
export async function requestLogin(rawEmail, origin) {
  const email = normalizeEmail(rawEmail);
  const token = crypto.randomBytes(32).toString('base64url');
  const link = `${origin}/auth/verify?token=${token}`;
  // At most 5 links per address per 15 minutes, so the form cannot be used to flood someone's inbox.
  const [{ recent }] = await q(`SELECT count(*)::int AS recent FROM login_tokens WHERE email = $1 AND created_at > now() - interval '15 minutes'`, [email]);
  if (recent >= 5) return null;
  await tx(async (t) => {
    await t.q(
      `INSERT INTO login_tokens (token_hash, email, email_raw, expires_at)
       VALUES ($1, $2, $3, now() + interval '15 minutes')`,
      [sha(token), email, String(rawEmail).trim()]
    );
    await t.q(`INSERT INTO outbox (to_email, subject, body) VALUES ($1, $2, $3)`, [
      String(rawEmail).trim(),
      'Your HackBelfast sign-in link',
      `Sign in to HackBelfast (valid for 15 minutes, works once):\n${link}`,
    ]);
  });
  return link;
}

/** Burn the token, upsert the user, open a session. Returns the session id or null. */
export async function consumeToken(token) {
  return tx(async (t) => {
    const [tok] = await t.q(
      `UPDATE login_tokens SET used_at = now()
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
        RETURNING email, email_raw`,
      [sha(String(token || ''))]
    );
    if (!tok) return null;
    const [user] = await t.q(
      `INSERT INTO users (email, email_raw, is_admin) VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE SET is_admin = users.is_admin OR EXCLUDED.is_admin
       RETURNING id`,
      [tok.email, tok.email_raw, ADMINS.includes(tok.email)]
    );
    const sid = crypto.randomBytes(32).toString('base64url');
    await t.q(`INSERT INTO sessions (id_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '30 days')`, [
      sha(sid),
      user.id,
    ]);
    return sid;
  });
}

export async function setSessionCookie(sid) {
  (await cookies()).set(COOKIE, sid, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  });
}

export async function clearSession() {
  const jar = await cookies();
  const sid = jar.get(COOKIE)?.value;
  if (sid) await q(`DELETE FROM sessions WHERE id_hash = $1`, [sha(sid)]);
  jar.delete(COOKIE);
}

export async function currentUser() {
  const sid = (await cookies()).get(COOKIE)?.value;
  if (!sid) return null;
  const [user] = await q(
    `SELECT u.id, u.email, u.email_raw, u.is_admin, u.is_judge
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id_hash = $1 AND s.expires_at > now()`,
    [sha(sid)]
  );
  return user || null;
}

export async function requireUser(next = '/status') {
  const user = await currentUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(next)}`);
  return user;
}

export async function requireAdmin() {
  const user = await requireUser('/admin');
  if (!user.is_admin) redirect('/status?error=' + encodeURIComponent('That page is for organisers.'));
  return user;
}

export async function requireJudge() {
  const user = await requireUser('/judge');
  if (!user.is_judge) redirect('/status?error=' + encodeURIComponent('That page is for judges.'));
  return user;
}
