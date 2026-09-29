/**
 * Child Worker Process Runner for Crash / Lease Recovery Testing (Wave 14, W14-A)
 *
 * Runs as an independent OS process with its own PID.
 * Terminated abruptly via SIGKILL / TerminateProcess to simulate hard worker crashes.
 */
const { startDocumentCoreWorker } = require('../../dist/worker');

const runtimeUrl = process.env.RUNTIME_URL;
const runtimeToken = process.env.RUNTIME_TOKEN;
const redisUrl = process.env.REDIS_URL;
const connectorUrl = process.env.CONNECTOR_URL;
const connectorServiceToken = process.env.CONNECTOR_SERVICE_TOKEN;
const workerInstanceId = process.env.WORKER_INSTANCE_ID || `child-worker-${process.pid}`;
const holdStep = process.env.HOLD_STEP;

if (!runtimeUrl || !runtimeToken || !redisUrl || !connectorUrl || !connectorServiceToken) {
  console.error('[ChildWorkerRunner] Missing required environment variables');
  process.exit(1);
}

const customFetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

  const res = await fetch(input, init);

  if (
    holdStep &&
    init?.method === 'PUT' &&
    url.includes('/steps/') &&
    (url.includes(holdStep) || url.includes(encodeURIComponent(holdStep))) &&
    (res.status === 200 || res.status === 201)
  ) {
    if (process.send) {
      process.send({
        type: 'step_held',
        step: holdStep,
        pid: process.pid,
        workerInstanceId,
      });
    }
    // Hold process execution at this barrier until killed by parent test
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  }

  return res;
};

startDocumentCoreWorker({
  runtimeUrl,
  runtimeToken,
  redis: { url: redisUrl },
  connectorUrl,
  connectorServiceToken,
  workerInstanceId,
  concurrency: 1,
  heartbeatIntervalMs: 1000,
  fetchImpl: customFetch,
})
  .then((handle) => {
    if (process.send) {
      process.send({
        type: 'ready',
        pid: process.pid,
        workerInstanceId: handle.workerInstanceId,
      });
    }
  })
  .catch((err) => {
    console.error('[ChildWorkerRunner Fatal Error]:', err);
    process.exit(1);
  });
