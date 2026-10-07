import { Worker } from 'node:worker_threads';
import { RequestRedactionRuleSchema, type RequestRedactionRule } from '@du/contracts';
import { redactRequestValues } from './request-redaction-worker';

// Only this trusted function's JS is evaluated; rules/input are workerData.
// This also supports tsx/ts-jest without requiring a stale compiled worker file.
const WORKER_SOURCE = `const { parentPort, workerData } = require('node:worker_threads');
  const run = ${redactRequestValues.toString()};
  try {
    const data = run(workerData.data, workerData.rules);
    if (Buffer.byteLength(JSON.stringify(data)) > 256 * 1024) throw new Error('DISPLAY_LIMIT');
    parentPort.postMessage({ ok: true, data });
  } catch { parentPort.postMessage({ ok: false }); }`;

export interface RequestInputView {
  data: unknown;
  status: 'REDACTED' | 'NO_RULES' | 'HIDDEN';
  ruleCount: number;
}
export const hiddenRequestInput = (): RequestInputView => ({ data: '[REDACTED]', status: 'HIDDEN', ruleCount: 0 });
let running = 0;

/** CPU budget applies off-thread; every failure returns a fully hidden view. */
export async function redactRequestInput(data: unknown, rules: RequestRedactionRule[], timeoutMs = 200): Promise<RequestInputView> {
  const checked = RequestRedactionRuleSchema.array().max(40).safeParse(rules);
  if (!checked.success) return hiddenRequestInput();
  let json: string;
  try { json = JSON.stringify(data); }
  catch { return hiddenRequestInput(); }
  if (!json || Buffer.byteLength(json) > 256 * 1024) return hiddenRequestInput();
  if (rules.length === 0) {
    try { return { data: redactRequestValues(JSON.parse(json) as unknown, []), status: 'NO_RULES', ruleCount: 0 }; }
    catch { return hiddenRequestInput(); }
  }
  if (running >= 4) return hiddenRequestInput();
  running++;
  return new Promise(resolve => {
    let worker: Worker;
    try {
      worker = new Worker(WORKER_SOURCE, {
        eval: true,
        workerData: { data: JSON.parse(json) as unknown, rules: checked.data },
        execArgv: [], env: {}, stdout: true, stderr: true,
        resourceLimits: { maxOldGenerationSizeMb: 16, maxYoungGenerationSizeMb: 4 },
      });
    } catch { running--; resolve(hiddenRequestInput()); return; }
    let finished = false;
    const finish = (result: RequestInputView): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      void worker.terminate().then(
        () => { running--; resolve(result); },
        () => { running--; resolve(hiddenRequestInput()); },
      );
    };
    const timer = setTimeout(() => finish(hiddenRequestInput()), timeoutMs);
    worker.once('error', () => finish(hiddenRequestInput()));
    worker.once('exit', () => finish(hiddenRequestInput()));
    worker.once('message', (message: unknown) => {
      if (typeof message !== 'object' || message === null || !('ok' in message) || message.ok !== true || !('data' in message)) {
        finish(hiddenRequestInput()); return;
      }
      finish({ data: message.data, status: 'REDACTED', ruleCount: rules.length });
    });
  });
}
