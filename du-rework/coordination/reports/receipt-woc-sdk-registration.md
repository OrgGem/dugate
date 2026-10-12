# WOC09 SDK startup-registration receipt

Date: 2026-10-12 15:37 ICT  
Owner: `/root/woc_sdk`  
Workspace: `D:\Git\dugate\du-rework`  
SDK command cwd: `D:\Git\dugate\du-rework\orchestrator`

## Delivered

- `startWorker` validates and idempotently registers the local manifest through the existing `PUT /businesses/{businessId}/versions/{version}` route before starting a workspace sweep, sending a heartbeat, or consuming queue messages. Registration uses the configured `runtimeToken`; there is no new credential or identity setting.
- `RuntimeClient.registerBusinessVersion` validates the manifest, sends its canonical DTO at the exact business/version URL, parses the existing result shape, and rejects a server response whose business, version, digest, or business/version queue differs from the validated manifest.
- The returned registration digest is sent in the first and subsequent worker heartbeats. Existing queue naming remains business plus exact version.
- Transient and ambiguous registration errors receive at most three bounded, jittered startup attempts. Conflicts and incompatible response pins fail startup. An optional `startupSignal` cancels registration or the initial heartbeat; cancellation and registration failure occur before consumer start. Startup cleanup also stops a consumer if the initial heartbeat or consumer start fails.
- Tests cover registration body/path/auth and ordering, exact queue and heartbeat digest, digest mismatch refusal, a transient response followed by success, startup abort during registration, and durable deferral for `BUSINESS_DISABLED`. Existing missing-`backupEffectFence` legacy compatibility refusal remains covered.

## Files changed

- `packages/worker-sdk/src/worker.ts`
- `packages/worker-sdk/src/runtime-client.ts`
- `packages/worker-sdk/src/types.ts`
- `packages/worker-sdk/tests/woc-sdk-registration.test.ts` (new)
- `packages/worker-sdk/tests/woc-sdk-worker.test.ts`
- `packages/worker-sdk/tests/worker.test.ts`
- `packages/worker-sdk/tests/connector-session.test.ts`
- `packages/worker-sdk/tests/p730-sdk-consume-pin-passthrough.test.ts`
- `packages/worker-sdk/tests/p745-carrier-sdk-forward.test.ts`
- `packages/worker-sdk/tests/temp-sweep.test.ts`

The listed fixtures derive digest and queue expectations from each validated local manifest. No contracts, backend, templates, auth configuration, shared docs, or distribution artifacts were edited by this packet.

## Verification

Passed:

- `pnpm --filter @du/worker-sdk lint` from orchestrator cwd — `tsc --noEmit -p tsconfig.json`, exit 0. Raw log: `du-rework/coordination/reports/raw/woc-sdk-registration-typecheck-2026-10-12.txt`.
- `pnpm exec jest --runInBand --runTestsByPath tests/woc-sdk-registration.test.ts tests/woc-sdk-worker.test.ts tests/worker.test.ts tests/connector-session.test.ts tests/p730-sdk-consume-pin-passthrough.test.ts tests/p745-carrier-sdk-forward.test.ts tests/temp-sweep.test.ts` from `orchestrator/packages/worker-sdk` — 7 suites passed, 140 tests passed, 0 failed. Raw log: `du-rework/coordination/reports/raw/woc-sdk-registration-jest-2026-10-12.txt`.

The full package command `pnpm --filter @du/worker-sdk test` was bounded at about 60 seconds and interrupted to release the SDK lease. It did not emit final Jest counts. The partial raw log is `du-rework/coordination/reports/raw/woc-sdk-registration-full-jest-2026-10-12.txt`. Before interruption, failures were observed in `artifact-direct-band.test.ts`, `connector-invoker.test.ts`, `artifact-read-metadata.test.ts`, `artifact-stat.test.ts`, `crypto-seam.test.ts`, and `p730-pinned-policy.test.ts`. The latter includes two malformed-claim expectations receiving `RuntimeError` instead of `ZodError`; connector/metadata failures concern error and retryability assertions, while the crypto test reports source-parity drift. The RSS test also failed. No total pass/fail count is claimed, and these failures remain unresolved for the next verification packet.

No production build, live Runtime API, Redis/PostgreSQL E2E, deployment, commit, or push was performed.

## SHA-256 hashes

```text
31C0036150EA557CCD22584DBE226116760F28A999EC2F36058FA228C17D5272  packages/worker-sdk/src/worker.ts
6B705B4CCCE271AE944EC873D144AE635873FD1BFAD146C8429693362E264E67  packages/worker-sdk/src/runtime-client.ts
09B45C814BEBD7D5DCF977ACC26FC1118492ED5B14CC974BE84E0EB14A632E0E  packages/worker-sdk/src/types.ts
03DE44F99F0ECC3ABFFCF4A19E0BA3787D8BDCA5DEA006141328017F17754735  packages/worker-sdk/tests/woc-sdk-registration.test.ts
640548F69A97BADF5CE0E53400055F5D0B3F538DDAED2DF30C8B25ACE8CD45DC  packages/worker-sdk/tests/woc-sdk-worker.test.ts
907960644A0A20657D4157C93FD9C574785C052C2C5318740C966CD142C22549  packages/worker-sdk/tests/worker.test.ts
674007229DF01245830A93E35D106A97997A82A583EF60ED297603B02B5ACC20  packages/worker-sdk/tests/connector-session.test.ts
2E23E4822D067515DFB5B33727B45FAC1D0C58CAD97F82203E6F7DA1F602D150  packages/worker-sdk/tests/p730-sdk-consume-pin-passthrough.test.ts
E9A798D480C8DEB641DC559025204B6D5344CA29D7F9F3FCB8F705EB6FADC061  packages/worker-sdk/tests/p745-carrier-sdk-forward.test.ts
288AAFE14DABBC7FAD9349882D3841479A07062A3F0C0CDA53A137E3E7810D43  packages/worker-sdk/tests/temp-sweep.test.ts
```
