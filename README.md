# HackBelfast Portal (prototype)

A registration, admissions and judging platform for a 200-place hackathon, built as a prototype for
[HackBelfast](https://www.hackbelfast.org/). **This is not an official HackBelfast site.**

Live demo: https://admissions-demo-k7x2.vercel.app (demo mode, fake data only). To look around as an
organiser, sign in as `admin@hackbelfast.dev` and open the link shown on screen.

Built by [Muhammad Murtuza Hussain](https://github.com/MuhammadMurtuzaHussain).

## What it does

- **Applications** with emailed one-time sign-in links (no passwords) and one application per person.
  Double clicks, retries and Gmail dot/plus spellings collapse into the same application.
- **A hard capacity limit.** The seat check and the seat increment are a single SQL statement, backed
  by a database constraint, so the room can never go over capacity.
- **Waitlist** that refills automatically when someone withdraws or lets an offer lapse.
- **Teams of 3 to 5** that join with a shared code and are accepted or waitlisted together.
- **Track targets** (Builder, Non-Builder, Quant) so offers keep the room balanced.
- **Reviewer score** with a visible breakdown and duplicate flags. It sorts the pile; people decide.
- **Project submission** and **judging** on five criteria, with a leaderboard per track.
- **Audit log** of every admissions decision, and a transactional email outbox.

## Stack

Next.js (App Router, server actions) · Postgres (Neon in production) · Resend for email · Vercel.

Without a `DATABASE_URL` the app falls back to PGlite, an in-process Postgres, so it runs locally
with no setup.

## Run it locally

```bash
npm install
npm run dev
```

Open http://localhost:3210. Sign-in links are shown on screen in development.

## Stress test

With the dev server running:

```bash
npm run test:race
```

This fires simultaneous requests (50 people for the last 2 seats, two teams for one gap, 12 duplicate
submits, 8 joins on one team code) and checks the invariants. It wipes the local database first.

## Environment variables

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string. Omit to use PGlite locally. |
| `RESEND_API_KEY`, `EMAIL_FROM` | Email delivery. Without a key, emails are recorded but not sent. |
| `ADMIN_EMAILS` | Comma-separated organiser addresses. |
| `DEMO_MODE` | `1` shows sign-in links on screen and enables demo-data controls. Never use with real applicants. |
| `CRON_SECRET` | Protects `/api/cron`, which releases lapsed offers and retries email. |

## Where the important logic lives

- `lib/admissions.js` — the admissions state machine: seats, waitlist, teams, tracks, judging.
- `lib/db.js` — schema and database access.
- `lib/auth.js` — sign-in links and sessions.
- `scripts/race.mjs` — the stress test.

## Licence

MIT
