const { execSync } = require('child_process');

const roster = {
  codex_tester_offline: 'term_b2d08e87-4435-4323-8e14-b58fa1a6729b',
  codex_worker_1: 'term_2b05b203-549f-4428-b908-c303a2b187ec',
  codex_worker_2: 'term_949d489b-0ce8-4242-a8c2-988362192922',
  qwen_1: 'term_4568d175-fdf8-4ff6-8916-9e787e232a58',
  qwen_2: 'term_27eb3380-f9c3-466a-8b4e-0b7fa0ad23fc',
  qwen_3: 'term_742c2474-7ff2-427d-8db4-f4bd40d16129',
  codex_technical_lead: 'term_31d9ed40-6acd-443e-9152-05ce5fd938ab',
  reviewer: 'term_b103836b-98e7-4fa2-900d-98db145d3d01',
  codex_tester_live: 'term_c4486089-8f52-4c6f-add2-3d8d9d2e97fe'
};

for (const [name, handle] of Object.entries(roster)) {
  console.log(`\n==================== ${name} (${handle}) ====================`);
  try {
    const raw = execSync(`orca terminal read --terminal ${handle} --limit 35 --json`, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    const parsed = JSON.parse(raw);
    const result = parsed.result?.terminal || parsed;
    console.log(`Cursor: ${result.cursor ?? result.offset}`);
    const lines = result.lines || result.tail || [];
    console.log(`Lines count: ${lines.length}`);
    if (lines.length > 0) {
      console.log('--- Tail (last 15 lines) ---');
      console.log(lines.slice(-15).join('\n'));
    }
  } catch (err) {
    console.error(`Error reading ${name}: ${err.message}`);
  }
}
