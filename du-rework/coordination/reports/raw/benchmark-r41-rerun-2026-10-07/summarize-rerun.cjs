'use strict';
// Benchmark re-run summary (evidence tooling, not product code).
// Reads workload.json produced by benchmark-driver.cjs and writes
// measurement-summary-rerun.json with per-action metrics + resource peaks.
const fs = require('node:fs');
const path = require('node:path');

const raw = __dirname;
const workload = JSON.parse(fs.readFileSync(path.join(raw, 'workload.json'), 'utf8'));

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return sorted[rank];
}

const metrics = [];
for (const action of ['ingest', 'extract']) {
  const measured = workload.rows.filter((row) => row.action === action && row.warmup === false);
  const succeeded = measured.filter((row) => row.state === 'SUCCEEDED' && row.resultHttp === 200);
  const batch = workload.batches.find((entry) => entry.action === action);
  const durationSec = batch ? batch.durationMs / 1000 : null;
  const e2e = measured.map((row) => row.e2eMs);
  const admission = measured.map((row) => row.admissionMs);
  metrics.push({
    action,
    samples: measured.length,
    success: succeeded.length,
    failed: measured.length - succeeded.length,
    durationSec,
    successfulReqPerSec: durationSec ? Number((succeeded.length / durationSec).toFixed(3)) : null,
    latencyKind: 'successful e2e (admission through result fetch)',
    p50Ms: percentile(e2e, 0.5),
    p95Ms: percentile(e2e, 0.95),
    p99Ms: percentile(e2e, 0.99),
    admissionP50Ms: percentile(admission, 0.5),
    admissionP95Ms: percentile(admission, 0.95),
  });
}

const peaks = {};
for (const sample of workload.observations) {
  for (const row of sample.rows) {
    const name = String(row.Name || row.Container || '');
    const service = name.replace(/^du-benchmark-r41-v2-/, '').replace(/-1$/, '');
    const memoryPercent = parseFloat(String(row.MemPerc || '0').replace('%', ''));
    const cpuPercent = parseFloat(String(row.CPUPerc || '0').replace('%', ''));
    const current = peaks[service] || { memoryPercent: 0, cpuPercent: 0, memUsage: null };
    if (Number.isFinite(memoryPercent) && memoryPercent > current.memoryPercent) current.memoryPercent = memoryPercent;
    if (Number.isFinite(cpuPercent) && cpuPercent > current.cpuPercent) current.cpuPercent = cpuPercent;
    if (row.MemUsage) current.memUsage = row.MemUsage;
    peaks[service] = current;
  }
}

fs.writeFileSync(path.join(raw, 'measurement-summary-rerun.json'), JSON.stringify({
  verdict: metrics.every((metric) => metric.failed === 0) ? 'PASS_INGEST_AND_EXTRACT' : 'PARTIAL',
  metrics,
  resources: peaks,
  dockerStatsSnapshots: workload.observations.length,
  providerCalls: workload.provider?.calls ?? null,
  note: 'Short synthetic sample (12 measured + warmup per action, concurrency 2); not a sustained SLA test.',
}, null, 2));
console.log(JSON.stringify({ metrics: metrics.map((m) => ({ action: m.action, success: `${m.success}/${m.samples}`, reqPerSec: m.successfulReqPerSec, p50Ms: Math.round(m.p50Ms), p95Ms: Math.round(m.p95Ms) })), providerCalls: workload.provider?.calls, snapshots: workload.observations.length }));
