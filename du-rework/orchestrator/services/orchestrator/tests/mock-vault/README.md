# DU_VAULT_MOCK - in-process HashiCorp Vault mockup

Local dev + offline tests only. It serves the slice of the Vault HTTP API the
Orchestrator actually calls (KV v2 data/metadata, Transit encrypt/decrypt/rewrap,
token create + lease renew/revoke), seeded entirely from `mock-vault.json`.

## Activation

Set `DU_VAULT_MOCK=true`:

- **jest** (`@du/orchestrator`): the `globalSetup` hook boots the mock on
  loopback and injects `DU_VAULT_KV_OPTIONS`, `DU_VAULT_KV_TOKEN`,
  `DU_VAULT_TRANSIT_OPTIONS`, `DU_VAULT_TRANSIT_ENC_TOKEN` and
  `DU_VAULT_TRANSIT_DEC_TOKEN` (plus `DU_METADATA_PLAINTEXT_READ_MODE=forbid`
  when unset), so every suite that boots from env talks to the mock instead of
  a live Vault. Unset or `false` is a no-op - production code is never touched.
- **local dev** (`node scripts/dev.cjs`): the same injection runs before the
  runtime validation, so the whole stack starts without a live Vault. `--check`
  stops the mock again; a normal exit does too.

`DU_VAULT_MOCK_FIXTURE=<path>` overrides the seed file. The flag is strict:
only `true`/`false`, a typo or a malformed fixture fails the boot.

## Files

- `mock-vault.json` - the mockup data: KV seeds, Transit keys, identities.
- `mock-vault-fixture.cjs` - fail-closed fixture parser.
- `mock-vault-service.cjs` - the loopback HTTP server.
- `bootstrap.cjs` - the env gate shared by jest and `scripts/dev.cjs`.
- `jest-global-setup.cjs` / `jest-global-teardown.cjs` - jest hooks.
- `mock-vault-service.offline.test.ts` - 22 offline assertions, including the
  real `VaultTransitProvider`, the real KV writer and the real credential
  workflow driven over the mock wire.

## Deliberate choices

- Three identities (kv / encrypt / decrypt) mirror the least-privilege split the
  production boot enforces, so a wrong-token call is a real 403 on the wire.
- `GET /v1/sys/health` answers 503 on purpose: a live-gated suite must never
  false-green against the mock.
- The connector service keeps its own `VAULT_ADDR` seam; this mockup does not
  touch it.
- Every value in the fixture is fake. This is not a security boundary.
