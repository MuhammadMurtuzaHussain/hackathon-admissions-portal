'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { after } from 'next/server';
import { deliverOutbox, SHOW_LINKS } from '@/lib/mail';
import * as demo from '@/lib/demo';
import * as auth from '@/lib/auth';
import * as adm from '@/lib/admissions';

const enc = encodeURIComponent;
// Send whatever this action queued, after the response has gone out.
const flush = () => after(() => deliverOutbox().catch((e) => console.error('outbox', e)));
const safeNext = (n) => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') ? n : '/status');

// ------------------------------------------------------------------- auth

export async function loginAction(formData) {
  const email = String(formData.get('email') || '');
  const next = safeNext(formData.get('next'));
  if (!auth.isValidEmail(email)) redirect(`/login?error=${enc('Enter a valid email address.')}&next=${enc(next)}`);
  const h = await headers();
  const origin = `${h.get('x-forwarded-proto') || 'http'}://${h.get('host')}`;
  const link = await auth.requestLogin(email, origin);
  if (!link) redirect(`/login?error=${enc('Too many sign-in links requested for that address. Try again in 15 minutes.')}&next=${enc(next)}`);
  flush();
  // Local development and demo mode show the link on screen instead of relying on email.
  const dev = SHOW_LINKS ? `&dev=${enc(link + '&next=' + enc(next))}` : '';
  redirect(`/login?sent=${enc(email.trim())}${dev}`);
}

export async function verifyAction(formData) {
  const sid = await auth.consumeToken(formData.get('token'));
  if (!sid) redirect(`/login?error=${enc('That link has expired or was already used. Request a new one.')}`);
  await auth.setSessionCookie(sid);
  redirect(safeNext(formData.get('next')));
}

export async function logoutAction() {
  await auth.clearSession();
  redirect('/');
}

// -------------------------------------------------------------- applicants

export async function applyAction(formData) {
  const user = await auth.requireUser('/apply');
  const input = Object.fromEntries(formData);
  const { a, errors } = adm.validateApplication({ ...input, requireConsent: true });
  if (errors.length) redirect(`/apply?error=${enc(errors.join(' '))}`);
  const res = await adm.submitApplication(user, a);
  flush();
  if (!res.ok) redirect(`/status?error=${enc(res.error)}`);
  revalidatePath('/', 'layout');
  redirect(`/status?notice=${enc(res.created ? 'Application received.' : 'Application updated.')}`);
}

async function applicantStep(fn, okMsg, failMsg) {
  const user = await auth.requireUser();
  const ok = await fn(user);
  flush();
  revalidatePath('/', 'layout');
  redirect(`/status?${ok ? 'notice' : 'error'}=${enc(ok ? okMsg : failMsg)}`);
}

export const confirmAction = async () =>
  applicantStep(adm.confirmSeat, 'Your place is confirmed.', 'That offer is no longer available.');
export const withdrawAction = async () =>
  applicantStep(adm.withdraw, 'You have withdrawn. Thanks for letting us know.', 'Nothing to withdraw.');
export const rejoinAction = async () =>
  applicantStep(adm.rejoin, 'You are back in the queue.', 'You cannot rejoin from here.');

export async function submitProjectAction(formData) {
  const user = await auth.requireUser('/submit');
  const { p, errors } = adm.validateSubmission(Object.fromEntries(formData));
  if (errors.length) redirect(`/submit?error=${enc(errors.join(' '))}`);
  const res = await adm.saveSubmission(user, p);
  redirect(`/submit?${res.ok ? 'notice' : 'error'}=${enc(res.ok ? 'Project saved. You can keep editing until the deadline.' : res.error)}`);
}

// --------------------------------------------------------------- organisers

async function adminStep(formData, fn) {
  const user = await auth.requireAdmin();
  const msg = await fn(user.email);
  flush();
  revalidatePath('/', 'layout');
  const back = String(formData.get('back') || '/admin');
  redirect(`${back.startsWith('/admin') ? back : '/admin'}${back.includes('?') ? '&' : '?'}notice=${enc(msg)}`);
}

const LABEL = { offered: 'Offer sent.', waitlisted: 'Room is full, so they were added to the waitlist.', ineligible: 'No change: that application was already decided.' };

export const offerAction = async (fd) =>
  adminStep(fd, async (who) => {
    const { result, size } = await adm.offer(fd.get('id'), who);
    if (size > 1 && result === 'offered') return `Offers sent to the whole team (${size} people).`;
    if (size > 1 && result === 'waitlisted') return `Not enough room for all ${size}, so the team was waitlisted together.`;
    return LABEL[result];
  });
export const waitlistAction = async (fd) => adminStep(fd, async (who) => ((await adm.waitlist(fd.get('id'), who)) ? 'Added to waitlist.' : LABEL.ineligible));
export const rejectAction = async (fd) => adminStep(fd, async (who) => ((await adm.reject(fd.get('id'), who)) ? 'Rejected.' : LABEL.ineligible));
export const revokeAction = async (fd) => adminStep(fd, async (who) => ((await adm.revoke(fd.get('id'), who)) ? 'Seat released and passed to the waitlist.' : LABEL.ineligible));
export const checkInAction = async (fd) => adminStep(fd, async (who) => ((await adm.checkIn(fd.get('id'), who)) ? 'Checked in.' : 'Only confirmed attendees can be checked in.'));

export const bulkOfferAction = async (fd) =>
  adminStep(fd, async (who) => {
    const n = Math.max(1, Math.min(500, parseInt(fd.get('n'), 10) || 0));
    const t = await adm.bulkOffer(n, who);
    return `${t.offered} offered, ${t.waitlisted} waitlisted.`;
  });

export const waitlistRemainingAction = async (fd) =>
  adminStep(fd, async (who) => `${await adm.waitlistRemaining(who)} moved to the waitlist.`);

export const expireAction = async (fd) =>
  adminStep(fd, async () => `${await adm.expireOffers()} lapsed offers released.`);

export const capacityAction = async (fd) =>
  adminStep(fd, async (who) => {
    const n = parseInt(fd.get('capacity'), 10);
    if (!(n > 0)) return 'Enter a capacity above zero.';
    return (await adm.setCapacity(n, who)) ? `Capacity is now ${n}.` : 'Capacity cannot go below the seats already handed out.';
  });

export const targetsAction = async (fd) =>
  adminStep(fd, async (who) => {
    await adm.setTargets(Object.fromEntries(fd), who);
    return 'Track targets saved.';
  });

// ------------------------------------------------------------------- teams

async function teamStep(fn) {
  const user = await auth.requireUser();
  const res = await fn(user);
  flush();
  revalidatePath('/', 'layout');
  redirect(`/status?${res.ok ? 'notice' : 'error'}=${enc(res.ok ? res.msg : res.error)}`);
}

export const createTeamAction = async (fd) =>
  teamStep(async (u) => {
    const r = await adm.createTeam(u, fd.get('name'));
    return r.ok ? { ok: true, msg: `Team created. Share the code ${r.code} with your teammates.` } : r;
  });
export const joinTeamAction = async (fd) =>
  teamStep(async (u) => {
    const r = await adm.joinTeam(u, fd.get('code'));
    return r.ok ? { ok: true, msg: `You joined ${r.name}.` } : r;
  });
export const leaveTeamAction = async () =>
  teamStep(async (u) => ((await adm.leaveTeam(u)) ? { ok: true, msg: 'You left the team.' } : { ok: false, error: 'You can only leave a team before it is reviewed.' }));

// ----------------------------------------------------------------- judging

export const addJudgeAction = async (fd) =>
  adminStep(fd, async (who) => {
    const email = String(fd.get('email') || '');
    if (!auth.isValidEmail(email)) return 'Enter a valid email address.';
    await adm.addJudge(email, auth.normalizeEmail(email), who);
    return `${email.trim()} can now judge. They sign in with that email.`;
  });
export const removeJudgeAction = async (fd) =>
  adminStep(fd, async () => {
    await adm.removeJudge(fd.get('id'));
    return 'Judge removed. Their existing scores are kept.';
  });
export const judgingToggleAction = async (fd) =>
  adminStep(fd, async () => {
    const open = fd.get('open') === '1';
    await adm.setJudgingOpen(open);
    return open ? 'Judging is open.' : 'Judging is closed. Scores are frozen.';
  });

export async function scoreAction(formData) {
  const judge = await auth.requireJudge();
  const res = await adm.saveScore(judge, formData.get('submission_id'), Object.fromEntries(formData));
  revalidatePath('/', 'layout');
  redirect(`/judge?${res.ok ? 'notice' : 'error'}=${enc(res.ok ? 'Score saved.' : res.error)}`);
}

// --------------------------------------------------------------- demo data

export const demoLoadAction = async (fd) =>
  adminStep(fd, async () => {
    if (!demo.DEMO_MODE) return 'Demo data is switched off on this site.';
    const r = await demo.loadDemo();
    return `Demo data loaded: ${r.applicants} applicants in ${r.teams} teams, ${r.projects} projects.`;
  });
export const demoWipeAction = async (fd) =>
  adminStep(fd, async () => {
    if (!demo.DEMO_MODE) return 'Demo data is switched off on this site.';
    await demo.resetAll();
    return 'Everything wiped. Organiser accounts were kept.';
  });
