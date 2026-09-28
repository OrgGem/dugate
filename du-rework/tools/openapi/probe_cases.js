const c = require(require("path").resolve("du-rework/packages/contracts/dist/index.js"));
const U = (n) => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
const cases = [
  ["SubmissionSchema", { input: { type: "invoice" } }],
  ["ListOperationsQuerySchema", { limit: 20 }],
  ["SubmitAckSchema", { operationId: U(1), state: "RUNNING", stateVersion: 1, replayed: false, correlationId: "abc12345", links: { self: "/a", result: "/b" } }],
  ["OperationViewSchema", { id: U(1), tenantId: "t", businessId: "document-core", businessVersion: "1.0.0", action: "extract", state: "RUNNING", stateVersion: 1, createdAt: "2026-09-23T00:00:00.000Z", updatedAt: "2026-09-23T00:00:00.000Z", deadlineAt: null, progress: { percent: 0 }, links: { self: "/a", result: "/b" } }],
  ["ResultEnvelopeSchema", { schemaVersion: "1", data: {}, artifacts: [], usage: { inputTokens: 1, outputTokens: 2, costMicrousd: 3, measurement: "measured" }, warnings: [] }],
  ["ArtifactUploadGrantRequestSchema", { leaseEpoch: 1, taskId: U(2), purpose: "output", mimeType: "application/json", sizeBytes: 10 }],
  ["ArtifactFinalizeRequestSchema", { leaseEpoch: 1, taskId: "00000000-0000-0000-0000-000000000001", sizeBytes: 10, sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" }],
  ["ArtifactAccessRequestSchema", { taskId: U(2), leaseEpoch: 1, mode: "read" }],
  ["InvocationGrantRequestSchema", { leaseEpoch: 1, taskId: U(2), stepKey: "s", bindingSlot: "reasoning", inputHash: "sha256:x" }],
  ["InvocationGrantSchema", { grant: "g", invocationId: "i", connectorId: "c", connectorRevision: 1, expiresAt: "2026-09-23T00:00:00.000Z", allowedOptions: {} }],
  ["UsageEventSchema", { eventId: "e1", invocationId: "i1", operationId: U(1), taskId: U(2), units: { inputTokens: 1, outputTokens: 2 }, costMicrousd: 3, measurement: "measured", occurredAt: "2026-09-23T00:00:00.000Z" }],
  ["UsageIngestBatchSchema", { events: [{ eventId: "e1", invocationId: "i1", operationId: U(1), taskId: U(2), units: { inputTokens: 1, outputTokens: 2 }, costMicrousd: 3, measurement: "measured", occurredAt: "2026-09-23T00:00:00.000Z" }] }],
  ["ClaimTaskRequestSchema", { deliveryId: "d1", workerInstanceId: "w1", businessId: "document-core" }],
  ["TaskHeartbeatRequestSchema", { leaseEpoch: 1, taskId: U(2) }],
  ["SaveStepRequestSchema", { leaseEpoch: 1, taskId: U(2), inputHash: "sha256:x", outputRef: "r", status: "SUCCEEDED" }],
  ["SpawnChildrenRequestSchema", { leaseEpoch: 1, taskId: U(2), children: [{ taskKey: "k1", kind: "review-item", payloadRef: {}, payloadHash: "sha256:x" }], joinPolicy: "all-success", continuationRef: "c1" }],
  ["WaitInputRequestSchema", { leaseEpoch: 1, taskId: U(2), waitKey: "w", inputSchema: { verdict: { type: "string" } } }],
  ["CompleteTaskRequestSchema", { leaseEpoch: 1, taskId: U(2), resultRef: "r", resultHash: "sha256:x" }],
  ["FailTaskRequestSchema", { leaseEpoch: 1, taskId: U(2), errorCode: "E", retryable: false }],
  ["InvocationRequestSchema", { contractVersion: "1", invocationId: "i", grant: "g", operationId: U(3), taskId: U(4), stepKey: "s", bindingSlot: "reasoning", input: { prompt: "p" }, deadlineAt: "2026-09-23T00:00:00.000Z" }],
  ["InvocationResponseSchema", { invocationId: "i", state: "SUCCEEDED", result: { data: {} }, usage: { inputTokens: 1, outputTokens: 2, costMicrousd: 0, measurement: "measured" } }],
  ["OperationDetailSchema", { id: U(5), tenantId: "t", businessId: "document-core", businessVersion: "1.0.0", action: "extract", state: "RUNNING", stateVersion: 1, createdAt: "2026-09-23T00:00:00.000Z", updatedAt: "2026-09-23T00:00:00.000Z", deadlineAt: null, progress: { percent: 10 }, links: { self: "/a", result: "/b" } }],
  ["HumanWaitViewSchema", { waitId: "w1", inputSchema: { verdict: { type: "string" } }, expiresAt: "2026-09-23T00:00:00.000Z" }],
];
let fail = 0;
for (const [n, v] of cases) {
  const s = c[n];
  if (!s) { console.log("MISSING " + n); fail++; continue; }
  const r = s.safeParse(v);
  console.log((r.success ? "PASS " : "FAIL ") + n);
  if (!r.success) { fail++; console.log(JSON.stringify(r.error.issues).slice(0, 300)); }
}
process.exit(fail ? 1 : 0);
