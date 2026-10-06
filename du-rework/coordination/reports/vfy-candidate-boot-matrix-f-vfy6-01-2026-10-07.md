# Independent Verification — Candidate Boot Matrix r4.1 (F-VFY6-01 §4.3)

- **Date:** 2026-10-07
- **Verifier:** DeepSeek (dsh) — independent verifier (disjoint scope; never a second dispatcher)
- **Repo scope:** `du-rework` ONLY; live Docker verification on the candidate image; no git mutation
- **Reference:** `coordination/reports/spec-f-vfy6-01-boot-policy-2026-10-06.md` §4.3 (Candidate-level matrix), gates listed in `claude-audit-review-r4-2026-10-06.md` §13.3 / §13.10
- **Target image:** `du-orchestrator:candidate-portal-swagger-20261006-r4.1`
- **Image identity:** `Id=sha256:ce35749edf35559095504f749ea9cfc63731e55e8c638a9e467c365a0a4f35c6` · `Created=2026-10-06T13:27:39.312Z` · `WorkingDir=/app` · `Cmd=["node","dist/main.js"]` (`entrypoint.sh` exec wrapper)
- **Code freeze:** NO git commit, NO push, NO stage. Writes limited to this report + raw evidence files.

## Environment

| Item | Value |
|---|---|
| Docker | 28.5.1 (Windows host daemon) |
| Host services via `host.docker.internal` | PostgreSQL `127.0.0.1:5433`, Redis `127.0.0.1:6380` (reachable from container, verified) |
| Scratch DB | `du_bootmatrix_vfy` — created + migrated (36 rows) with the image's own `node dist/migrate-cli.js migrate` (exit 0), **dropped after** the matrix |
| Env-file seam | valid `DU_VAULT_TRANSIT_OPTIONS` (https vault, `allowedKeyRefs` incl. `metadataKeyRef`/`publicUploadKeyRef`) + dummy ENC/DEC tokens — content-free, never a real Vault path/token |

## Summary verdict

| # | Scenario | Expected | VERIFIED |
|---|---|---|---|
| 1 | keyless dev boot | boots; 1 warn-once; serving | **PASS** |
| 2 | keyless real-mode refusal | process refuses, exit ≠ 0, content-safe `ENCRYPTION_KEY (or NEXTAUTH_SECRET) is required when artifact encryption is enabled in real-data mode` | **FAIL — gate stays open (code absent from image)** |
| 3 | tampered-key typed denial | typed 500 `AUTH_DECRYPT_FAILED`, no plaintext | **PASS** |
| 4 | healthy path | boot + decrypt success | **PASS** |

3 of 4 scenarios PASS; **Scenario 2 FAILS because the baked r4.1 image does not contain the F-VFY6-01 boot-policy code** (see §3). This is the honest, receipt-terminating verdict — per contract, a red gate is not closed by offline green.

---

## 1. Scenario 1 — keyless dev boot: PASS

- **Command (cwd `du-rework`):** `docker run -d --name vfy-boot-dev --env-file <tmp> -e NODE_ENV=development -e DU_METADATA_PLAINTEXT_READ_MODE=forbid -e ORCHESTRATOR_INTERNAL_BASE_URL=http://127.0.0.1:3002 -e DATABASE_URL=<redacted host> -e REDIS_URL=redis://host.docker.internal:6380 -e ORCHESTRATOR_PORT=13081 -p 127.0.0.1:13081:13081 du-orchestrator:candidate-portal-swagger-20261006-r4.1`
- **Env discipline:** NO `ENCRYPTION_KEY`, NO `NEXTAUTH_SECRET`; artifact seam on (SEC-ENC-05 real-mode forced + valid transit options).
- **Result:** `Running=true ExitCode=0`; logs show `artifact encryption enabled`, **exactly 1 warn** (subsystem=main, immediately before listen; the profile-cipher warn-once — message field `[REDACTED]` by the observability layer; the compiled source pins it as `profile cipher key absent — configured-cipher acquisition will deny with AUTH_DECRYPT_FAILED; set ENCRYPTION_KEY or NEXTAUTH_SECRET`), then `orchestrator listening` on 13081.
- **Traffic:** `GET /health` → **HTTP 200** `{"status":"ok","db":true,"redis":true,"activeLeases":0,...,"encryption":{"dataMode":"real","metadataEncryption":true,"publicUploadEncryption":true,"metadataPlaintextReadMode":"forbid","secretResolver":false}}`
- **Evidence:** `raw/vfy-boot-matrix-f-vfy6-01-2026-10-07/s1-keyless-dev-boot.log`, `s1-health.json` (SHA256 in `SHA256SUMS.txt`).

## 2. Scenario 2 — keyless real-mode refusal: **FAIL (gate remains OPEN)**

- **Command:** same as S1 but `NODE_ENV=production` (env-file seam + `DU_METADATA_PLAINTEXT_READ_MODE=forbid` + `ORCHESTRATOR_INTERNAL_BASE_URL` + migrated DB), **no `ENCRYPTION_KEY`/`NEXTAUTH_SECRET`**.
- **Expected:** process refuses, exit ≠ 0, content-safe log with `ENCRYPTION_KEY (or NEXTAUTH_SECRET) is required when artifact encryption is enabled in real-data mode`.

### Actual (decisive run)
`Running=true ExitCode=0` — log: `artifact encryption enabled` → 1 warn (`[REDACTED]`, the **old warn-only**) → `orchestrator listening` on 13082; `GET /health` → **HTTP 200** with `"environment":"prod"` in logs and `"encryption":{"dataMode":"real","metadataEncryption":true,"publicUploadEncryption":true,...}` in /health.

**The keyless production-real-seam boot was NOT refused.** It started and served traffic — this is the pre-fix warn-only behavior, i.e. the exact hole F-VFY6-01 exists to close.

### Root cause — F-VFY6-01 code absent from the baked image
- Image `dist/modules/encryption/boot-options.js` exports only: `resolveDataMode, encryptionIsRequired, parseEncryptionBootConfig, buildMetadataReadPolicy, buildEncryptionBootOptions, summarizeEncryptionPolicy, EncryptionBootConfigError` — **no `assertProfileCipherBootPolicy`, no `profileCipherKeyPresent`**, and no `ENCRYPTION_KEY (or NEXTAUTH_SECRET) is required when artifact encryption is enabled in real-data mode` message.
- Image `dist/main.js` (compiled :264-267) has only the old warn block (`if (!env.ENCRYPTION_KEY && !env.NEXTAUTH_SECRET) logger.warn('profile cipher key absent …')`) — **no policy call** before `createApp`.
- Working tree at HEAD `4308cc5` **does** contain the implementation (`src/modules/encryption/boot-options.ts:511` `assertProfileCipherBootPolicy`; `src/main.ts:274` call; `profileCipherKeyPresent` `:467/:489`). Source mtime `2026-10-06 21:51 local (+07)` = `14:51Z`; image Created `13:27:39Z` → **the image bake predates the F-VFY6-01 commit by ~1h24m**.
- Diagnostics hazard recorded: without `ORCHESTRATOR_INTERNAL_BASE_URL`, the same keyless prod boot exits 1 with the unrelated pre-existing `ORCHESTRATOR_INTERNAL_BASE_URL is required for production PostgreSQL Runtime artifact grants` — without isolating vars a false "refusal" could be mistaken for F-VFY6-01. This run isolated that var so the negative is unambiguous.
- **Evidence:** `s2-keyless-real-mode-boot.state.txt` (`Running=true ExitCode=0`), `s2-keyless-real-mode-boot.log`, `s2-health.json`, `s2-code-gap.txt` + this report's compiled-source mapping.

### Required action
Coordinator/owner: **re-bake** the `du-orchestrator` candidate from a tree that includes `assertProfileCipherBootPolicy` (HEAD `4308cc5` qualifies) → new digest → re-run S2 (and confirm S1's warn remains the single warn). Independent reviewer re-checks before any ACCEPTED/F-VFY6-01 closure.

## 3. Scenario 3 — tampered-key typed denial: PASS

- **Command (probe piped as stdin into the image):** `Get-Content probe-s3.js -Raw | docker run -i --rm --entrypoint node du-orchestrator:candidate-portal-swagger-20261006-r4.1 -`
  Probe used the image's own compiled `file-url-auth.js` (`encrypt/decryptFileUrlAuthConfig`) + `acquisition-ref-resolver.js` (`createAcquisitionRefResolver`), fake DB returning a snapshot + stored cipher row.
- **Result:** `STORED_IS_CIPHER=true`; `DIRECT_DECRYPT_WRONG_KEY_IS_NULL=true` (**no plaintext fallback**); `DIRECT_DECRYPT_CORRECT_KEY_OK=true` (control round-trip); resolver with wrong key → `DENIAL_NAME=SourceAuthDeniedError`, `DENIAL_STATUS=500`, `DENIAL_CODE=AUTH_DECRYPT_FAILED`, `DENIAL_MSG=stored auth cipher could not be decrypted with this deployment key`, `DENIAL_IS_TYPED_500=true`; `PROBE_EXIT=0`. No value was ever resolved (nothing to serve).
- **Evidence:** `s3-tampered-key-typed-denial.log`. Note: this boundary (`file-url-auth.ts:91-123`, `acquisition-ref-resolver.ts:199-211`) is present in the image — scenario 3 is **not** affected by the F-VFY6-01 bake gap.

## 4. Scenario 4 — healthy path: PASS

- **Command:** same as S2 but **`ENCRYPTION_KEY=vfy-healthy-deployment-key-0123456789abcde`** (+ `NODE_ENV=production`, seam on, migrated DB).
- **Result:** `Running=true ExitCode=0`; logs `artifact encryption enabled` → `orchestrator listening` on 13083 (**no warn** — the profile-cipher warn is key-gated); `GET /health` → **HTTP 200** db/redis true.
- **Decrypt success:** in-image round-trip with the deployment key → `HEALTHY_ROUNDTRIP=true` (exit 0).
- **Evidence:** `s4-healthy-boot.log`, `s4-health.json`.

## 5. Integrity & cleanup

- **Evidence hashes:** all raw files hashed into `raw/vfy-boot-matrix-f-vfy6-01-2026-10-07/SHA256SUMS.txt` (e.g. `s2-keyless-real-mode-boot.state.txt = A3675200B26D6540EEB10A84A6034FD958A67B3FD765683B6AFD3EF24D54A20B`; `s3-tampered-key-typed-denial.log = 1E26B6AD67285FA15CEEB7A552805449E8BB85C3A704AFDE777D3D4B9D5006A9`).
- **No secrets in evidence:** `DATABASE_URL` never printed; transit tokens are dummy content-free values; the warn message is `[REDACTED]` in structured logs by the observability layer.
- **Cleanup:** all three test containers removed (`docker rm -f`), scratch DB `du_bootmatrix_vfy` **dropped** (verified `REMAINING=dropped`), temporary env-file deleted. Host PG/Redis untouched (no schema change to existing DBs).
- **Mutations made by this verification:** none to source/tests/configs. Only report + raw evidence directory created under `du-rework/coordination/`.

## 6. Findings & limits

1. **[HIGH] F-VFY6-01 boot policy not present in r4.1 image** → keyless real-mode boot does not refuse; Scenario 2 fails. Blocking for F-VFY6-01 / VFY-06 closure. Next: re-bake from HEAD `4308cc5` (or later) and re-run the matrix on the new digest.
2. **[LOW] Warn message is `[REDACTED]` in structured logs** — the profile-cipher warn-once text names `ENCRYPTION_KEY`/`NEXTAUTH_SECRET` and the redaction layer blanks the whole message, so operators cannot read the actionable failure. Consider a redaction-safe wording in the implementation.
3. **Limits:** Scenario 2 was verified on the image as delivered; it does **not** prove the refusal works on a re-baked image. DB/resilience beyond boot (Vault encrypt/decrypt calls, exact `AUTH_DECRYPT_FAILED` over the real HTTP route) were out of scope for this offline container matrix (§4.3's "test probe" alternative was used for S3; the live-route variant remains a VFY follow-up). No committed/pushed state; working tree dirty state (316 entries) untouched.