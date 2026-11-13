// Fires real concurrent HTTP requests at the running dev server and checks the
// invariants that matter: never more seats than capacity, one application per
// person, and every freed seat goes to the waitlist.   Run: npm run test:race
const BASE = process.env.BASE || 'http://localhost:3210';
const post = async (path) => {
  const res = await fetch(`${BASE}/api/dev/${path}`, { method: 'POST' });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  return res.json();
};
let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${detail})`);
  if (!ok) failed++;
};

await post('reset');
await post('seed?n=400');
await post('bulk?n=195');
let s = await post('state');
check('195 offers handed out, teams kept whole', s.seats_taken === 195 && s.holders === 195 && s.split === 0, `split teams ${s.split}, counter ${s.seats_taken}, holders ${s.holders}`);

// 1. Two whole teams go for the last five seats at the same moment: only one can fit.
const squads = (await post('ids?status=submitted&team=3&n=40')).filter((t) => t.size === 3).slice(0, 2);
const squadResults = await Promise.all(squads.map((t) => post(`claim?id=${t.id}`)));
s = await post('state');
const squadsIn = squadResults.filter((r) => r.result === 'offered').length;
check('2 teams of 3 race for 5 seats: one team gets in whole, the other gets nothing', squads.length === 2 && squadsIn === 1 && s.seats_taken === 198 && s.split === 0, `${squadsIn} team in, seats ${s.seats_taken}, split teams ${s.split}`);

// 2. Fifty solo applicants go for the last two seats at the same moment.
const rivals = await post('ids?status=submitted&solo=1&n=50');
const results = await Promise.all(rivals.map((r) => post(`claim?id=${r.id}`)));
const won = results.filter((r) => r.result === 'offered').length;
s = await post('state');
check('50 simultaneous claims on the last 2 seats: exactly 2 win', won === 2, `${won} won, ${results.length - won} told "full"`);
check('room is exactly full, never 201', s.seats_taken === 200 && s.holders === 200, `counter ${s.seats_taken}, holders ${s.holders}, capacity ${s.capacity}`);
check('no team was ever split by an offer', s.split === 0, `${s.split} split teams`);

// 3. The same seat offered twice at once (two organisers clicking the same row).
const [one] = await post('ids?status=offered&n=1');
const twice = await Promise.all([post(`claim?id=${one.id}`), post(`claim?id=${one.id}`)]);
s = await post('state');
check('re-offering someone who already holds a seat changes nothing', twice.every((r) => r.result !== 'offered') && s.seats_taken === 200, twice.map((r) => r.result).join(', '));

// 4. Double click / retry / second tab, plus Gmail spelling tricks for one inbox.
const before = s.apps;
const spellings = ['dupe.person@gmail.com', 'dupeperson@gmail.com', 'DupePerson+hack@googlemail.com', 'd.u.p.e.person@gmail.com'];
await Promise.all(Array.from({ length: 12 }, (_, i) => post(`apply?email=${encodeURIComponent(spellings[i % spellings.length])}`)));
s = await post('state');
check('12 simultaneous submits from 4 spellings of one inbox: one application', s.apps === before + 1, `${s.apps - before} new application(s)`);

// 5. Withdrawals and lapsed offers refill from the waitlist.
await post('waitlist-rest');
const waitBefore = (await post('state')).by.waitlisted;
await post('confirm-all');
const leavers = await post('ids?status=confirmed&n=4');
await Promise.all(leavers.map((l) => post(`withdraw?id=${l.id}`)));
s = await post('state');
check('4 simultaneous withdrawals: 4 waitlisted people get offers, room stays full', s.seats_taken === 200 && s.holders === 200 && s.by.waitlisted === waitBefore - 4, `seats ${s.seats_taken}, new offers ${s.by.offered}, waitlist ${waitBefore} -> ${s.by.waitlisted}`);

const lapse = await post('lapse?n=3');
s = await post('state');
check('3 offers lapse unanswered: released and re-offered down the waitlist', lapse.released === 3 && s.seats_taken === 200 && s.by.expired === 3, `expired ${s.by.expired}, seats ${s.seats_taken}, waitlist ${s.by.waitlisted}`);

// 6. Eight people enter the same team code at once: the team stops at five.
const rush = await post('team-rush?n=8');
check('8 simultaneous joins on one team code: team stops at 5', rush.joined === 4 && rush.size === 5, `${rush.joined} joined, team size ${rush.size}`);

// 7. Track balance: with only one track under target, the next free seat goes to that track.
for (const track of ['Quant', 'Non-Builder']) {
  await post(`targets?only=${encodeURIComponent(track)}`);
  await post('lapse?n=1');
  const last = await post('last-offer');
  check(`only ${track} is under target: the freed seat goes to a ${track} applicant`, last.track === track, `went to ${last.track}`);
}
s = await post('state');
check('room still exactly full at the end', s.seats_taken === 200 && s.holders === 200, `counter ${s.seats_taken}, holders ${s.holders}`);

console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
