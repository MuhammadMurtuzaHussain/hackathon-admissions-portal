// Scheduled job (see vercel.json): release lapsed offers down the waitlist and
// retry any email that did not go out. Vercel sends CRON_SECRET as a bearer token.
import { expireOffers } from '@/lib/admissions';
import { deliverOutbox } from '@/lib/mail';

export const dynamic = 'force-dynamic';

export async function GET(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) return new Response('Unauthorized', { status: 401 });
  const released = await expireOffers();
  const mail = await deliverOutbox(100);
  return Response.json({ released, ...mail });
}
