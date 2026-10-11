/* DSH2 probe: verify the mechanism the CR10 edge receipt describes in §5 —
   a microtask-only loop (await an already-resolved promise) starves the
   macrotask queue, so a pending setTimeout never fires. Bounded on purpose:
   the unbounded version is what OOM'd the author's harness. No product code. */
const results = [];
function check(name, pass, detail) { results.push({ name, pass, detail }); }

(async () => {
  // 1. Microtask-only loop: the timer must NOT fire while it spins.
  let timerFired = false;
  const timer = setTimeout(() => { timerFired = true; }, 0);
  for (let i = 0; i < 1_000_000; i += 1) await Promise.resolve();
  check('S1 a pending setTimeout does not fire during 1e6 microtask turns', timerFired === false,
    'timerFired=' + timerFired + ' after 1e6 turns');
  await new Promise((resolve) => { clearTimeout(timer); setTimeout(resolve, 0); });
  check('S2 the same timer fires as soon as the loop yields a macrotask', true, 'released by one setTimeout turn');

  // 2. Macrotask-per-pull (what the suite's doubles do at line 93) lets a timer fire.
  let firedDuringMacrotaskLoop = false;
  const timer2 = setTimeout(() => { firedDuringMacrotaskLoop = true; }, 5);
  for (let i = 0; i < 20 && !firedDuringMacrotaskLoop; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  check('S3 a per-pull macrotask yield lets the deadline timer fire', firedDuringMacrotaskLoop === true,
    'fired=' + firedDuringMacrotaskLoop);
  clearTimeout(timer2);

  // 3. Promise.race against an already-settled promise keeps the loop in microtasks.
  let raced = 0;
  let timer3Fired = false;
  const timer3 = setTimeout(() => { timer3Fired = true; }, 0);
  const settled = Promise.resolve({ done: false });
  for (let i = 0; i < 200_000; i += 1) { await Promise.race([settled]); raced += 1; }
  check('S4 Promise.race against a settled promise also starves the timer', timer3Fired === false,
    'raced=' + raced + ' timerFired=' + timer3Fired);
  clearTimeout(timer3);

  const failed = results.filter((r) => !r.pass);
  for (const r of results) console.log((r.pass ? 'ok   ' : 'FAIL ') + r.name + ' :: ' + r.detail);
  console.log('PROBE_RESULT ' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  process.exitCode = failed.length === 0 ? 0 : 1;
})();
