# COMP-01 Slice F — Legacy encryption touchpoints inventory (READ-ONLY)

**TaskRef:** task_7580f1aad3b8
**Spec:** `du-rework/coordination/dispatch-specs/2026-10-02-0205-COMP01-slice-f.md`
**Status:** characterization only. No source, test, task-row, gate, or docs edit; no commit; no tests run (spec says not needed). Banned paths untouched: `services/orchestrator/src/server.ts`, `packages/contracts`, `tasks/*.md`, `AGENTS.md`, execution overlay, `businesses/document-core/**`, and `services/orchestrator/src/modules/encryption/**` (rework encryption module — **not read**, not mapped). **No secret, key, or token value was read**: only field names, env var NAMES (from `.env.example` placeholders), and algorithm shapes. Where a fixture literal exists in source (e.g. seed placeholders) it is described by name, not quoted.
**Legacy tree is outside `du-rework/`** — everything below lives at `D:/Git/dugate/{lib,app,components,middleware.ts}` (`app/` and `middleware.ts` are not part of the rework monorepo).

## 1. Touchpoint table

| # | Data | Primitive | Key source | Rotation surface | Class | file:line |
|---|---|---|---|---|---|---|
| 1 | `AppSetting` — 5 allowlisted keys: `ai_api_key`, `openai_api_key`, `api_secret_key`, `s3_access_key`, `s3_secret_key` | AES-256-GCM, random 12-byte IV, 16-byte tag; key = `SHA-256(secret)` | `ENCRYPTION_KEY` **falling back to** `NEXTAUTH_SECRET` | none (§4) | **at-rest encrypted** | `lib/crypto.ts:22-46`; allowlist `lib/settings.ts:111`; write `lib/settings.ts:150`; read `lib/settings.ts:119-124`, `:134-138` |
| 2 | `ProfileEndpoint.fileUrlAuthConfig` (bearer token / header / query credential for `file_urls`) | same AES-256-GCM | same | none (§4) | **at-rest encrypted, with a plaintext read fallback** (§6) | write `app/api/internal/profile-endpoints/route.ts:155`; read `:47-56`; second read path `lib/endpoints/profile-resolver.ts:100-111` |
| 3 | `ExternalApiConnection.authSecret` | **none — stored verbatim** | n/a | n/a | **PLAINTEXT at rest**, then placed in an outbound header | column `lib/db/schema.ts:81`; write `app/api/internal/ext-connections/route.ts:101`; readers `lib/pipelines/processors/external-api.ts:123,125`, `app/api/chat/route.ts:59,61`, `app/api/internal/prompt-wizard/route.ts:98,100`, `app/api/internal/ext-connections/[id]/test/route.ts:33,35` |
| 4 | `ExternalApiConnection.extraHeaders`, `.staticFormFields` (free-form JSON text, operator-supplied; may embed credentials) | none | n/a | n/a | **plaintext at rest** | `lib/db/schema.ts:86-87`; written verbatim `app/api/internal/ext-connections/route.ts:104-105` |
| 5 | `ApiKey` raw secret | `SHA-256(raw)` hex, no salt/pepper, no version prefix | generated `dg_` + `randomBytes(32).toString("base64url")` | **exists**: issue + rotate (§4) | **one-way hash at rest** | column `lib/db/schema.ts:56-57`; generate+hash `app/api/internal/apikeys/route.ts:51,83`; verify `app/api/internal/auth-key/route.ts:34`, `lib/endpoints/runner.ts:98-99` |
| 6 | first 16 chars of the **raw** API key | n/a | same raw key | n/a | **secret material in a second store (Redis key)** | `app/api/internal/auth-key/route.ts:17` — rate-limit key `ratelimit:apikey:` + `passedKey.slice(0,16)` |
| 7 | `User.password` | bcrypt, cost 10, one-way | user-supplied | via users routes | **one-way hash at rest** | column `lib/db/schema.ts:173`; hash `lib/db/seed.ts:408-412`, `app/api/users/route.ts:65-68`, `app/api/users/[id]/route.ts:47`; verify `lib/auth.ts:34` |
| 8 | NextAuth session cookie | JWT **signed** (HMAC via `NEXTAUTH_SECRET`), `strategy: "jwt"` — **not encrypted** | `NEXTAUTH_SECRET` | n/a | **in-transit cookie; claims are base64-readable client-side, integrity-only** | `lib/auth.ts:188-191`; consumed `middleware.ts:39-45`, `:56-59` |
| 9 | uploaded/output documents (`FileCache` row + stored object) | **no encryption**; MD5 only, for dedup/ETag | n/a | n/a | **plaintext at rest** (S3 bucket or local disk) | `lib/storage/s3-backend.ts:49,81`; `lib/storage/local-backend.ts:27,51`; columns `lib/db/schema.ts:152-155` |
| 10 | S3 credentials **in process memory** | decrypted at use, then held by a process-singleton client | `ENCRYPTION_KEY` chain (row 1) | invalidated by `resetStorageBackend()` when S3 settings change | in-memory for the process lifetime | `lib/storage/index.ts:19-49`; hook `app/api/settings/route.ts` (s3Keys branch) |
| 11 | `file_urls` credential on download (`bearer` / `header` / `query`) | none — carried in header **or URL query** | from row 2 | none | **in-transit; the `query` type puts the credential in the URL** | `lib/file-url-downloader.ts:75-84` (headers), `:85-94` (`applyQueryAuth`) |
| 12 | all outbound HTTP to external APIs / `file_urls` | TLS is **opportunistic** — `http:` and `https:` both permitted | n/a | n/a | **in-transit, app does not enforce TLS** | `lib/pipelines/processors/http-client.ts:90-91` |

## 2. What the single crypto primitive actually is

`lib/crypto.ts` is the **only** encryption implementation in legacy (`lib/crypto.ts:1-46`):

- `ALGORITHM = "aes-256-gcm"`, `IV_LENGTH = 12`, `TAG_LENGTH = 16` (`:7-9`).
- Key derivation is `crypto.createHash("sha256").update(secret).digest()` (`:22`) — a bare digest, **not** a
  KDF with salt/iteration count, and the derived key is **not** cached, so it is recomputed per call.
- Wire format is `"<iv hex>:<tag hex>:<ciphertext hex>"` (`:38`). There is **no algorithm field, no version
  field, and no key id** — the parser only checks that there are three colon-separated parts (`:41`).
- `decrypt` sets the auth tag and calls `final()`, so tampering is rejected — authentication is present
  (`:47-58`), but it is **unauthenticated about which key** and **which algorithm** produced the bytes.
- `maskApiKey` (`:61-64`) keeps the first 4 and last 4 characters for display.

Consequences that follow mechanically from that shape (not proposals): the format cannot distinguish
"encrypted with an old key" from "corrupt", so **rotation is undetectable**, and there is no way to migrate
one row at a time.

## 3. Key sources (names only — no value read)

| Env var | Used for | Declared at |
|---|---|---|
| `ENCRYPTION_KEY` | AES key for rows 1-2, **only if set** | `.env.example:9` |
| `NEXTAUTH_SECRET` | NextAuth JWT signing (row 8) **and, when `ENCRYPTION_KEY` is absent, the AES key for rows 1-2** (`lib/crypto.ts:14`) | `.env.example:5` |
| `SEED_ADMIN_KEY` | seed-time admin `ApiKey` hash (`lib/db/seed.ts:353-356`) | `.env.example:31` |
| `SEED_ADMIN_PASSWORD` | seed-time bcrypt hash (`lib/db/seed.ts:408`) | `.env.example:32` |
| `ALLOWED_PRIVATE_HOSTS` | SSRF allowlist, comma-separated hosts (`lib/pipelines/processors/http-client.ts:103`) | — |
| `FILE_URL_DOWNLOAD_TIMEOUT_MS`, `FILE_URL_READ_STALL_TIMEOUT_MS` | download timeouts (not secrets) | `lib/file-url-downloader.ts:12,14` |

Two facts worth recording as-is: the AES key and the **session-signing** key are the **same secret** when
`ENCRYPTION_KEY` is unset, and nothing in code prevents an operator from setting them equal.

## 4. Rotation / revocation surfaces that actually exist

| Surface | Behaviour | file:line |
|---|---|---|
| `ApiKey` issue | new `dg_`+256-bit random key, `SHA-256` stored, **raw returned once in the response body** | `app/api/internal/apikeys/route.ts:70-97` |
| `ApiKey` rotate | `PUT` with `{action:"rotate"}` **overwrites `keyHash` in place** — the previous key dies immediately, no overlap/grace window, no revocation list | `app/api/internal/apikeys/route.ts:44-57`; UI caller `app/profiles/page.tsx:114-134` |
| `ApiKey` deactivate | status flag checked at auth time (`active` vs suspended) | write `app/api/internal/apikeys/route.ts:113-120`; check `app/api/internal/auth-key/route.ts:40-42` |
| seed re-run | **overwrites the admin `keyHash` from `SEED_ADMIN_KEY` every time** — the log line itself says "keyHash updated (SEED_ADMIN_KEY rotated)" | `lib/db/seed.ts:372-375` |
| `AppSetting` secrets / `fileUrlAuthConfig` | **no rotation surface exists.** The only way to change the AES key is to change the env var, after which every existing row is undecryptable (§5, §6) | — |

Observation recorded without judgement: the rotate response selects only `id/name/status/note`
(`app/api/internal/apikeys/route.ts:53-56`) while the UI reads `data.apiKey.keyHash`
(`app/profiles/page.tsx:128`), so the client-side key display is fed a field the response does not carry.

## 5. At-rest vs in-transit, summarized

**Encrypted at rest (2 data classes, both via one env-derived key):** the 5 `AppSetting` secrets, and
`ProfileEndpoint.fileUrlAuthConfig`.

**Plaintext at rest (by design or by omission — both listed because the inventory should not guess intent):**
- `ExternalApiConnection.authSecret` — the only **credential** in the plaintext group; it is the shared secret
  for every outbound call made on that connection.
- `extraHeaders` / `staticFormFields` — operator JSON, may or may not carry credentials.
- All document bytes (input and output) in S3 or on local disk; MD5 exists only for dedup/ETag.
- `operations.webhookUrl` and every non-secret setting column (models, prompts, TTL, region).

**Hashed one-way (not encryption, correctly so):** `ApiKey.keyHash`, `User.password`.

**In-transit:** credentials travel as `x-api-key`-style headers or `Authorization: Bearer`
(`lib/pipelines/processors/external-api.ts:123,125` and the three sibling call sites). The app **does not
require TLS** (`http-client.ts:90-91`); SSRF protection is present and is a positive control — private hostname
check plus DNS-resolution check to defeat rebinding (`http-client.ts:107-123`), redirects re-validated per hop
with a 5-hop cap (`lib/file-url-downloader.ts:106-124`).

**No request signing anywhere:** grep for `createHmac` / `timingSafeEqual` over `lib/**` returns only prompt
text and a `webhookUrl` column — there is no HMAC signature on any legacy webhook or callback (consistent with
Slice E).

## 6. MUST-NOT-REPLICATE (recorded as touchpoints, not as reproduced exploits)

1. **Plaintext credential at rest** — `authSecret` written verbatim (`ext-connections/route.ts:101`) and read
   back verbatim into outbound headers. Masked only on list endpoints (`ext-connections/route.ts:24-27`,
   `app/api/internal/workflow-schemas/pipeline-mappings/route.ts:46`).
2. **Plaintext fallback on the decrypt path** — `fileUrlAuthConfig` is decrypted, and on **any** failure the
   code re-parses the raw column as plain JSON (`profile-endpoints/route.ts:47-56`;
   `lib/endpoints/profile-resolver.ts:104-111`). Two consequences: legacy plaintext rows keep working with no
   way to tell them apart, and after a key change an encrypted row **silently resolves to `undefined`** instead
   of surfacing an error.
3. **Silent decrypt failure on the settings path** — `lib/settings.ts:119-124` and `:134-138` catch and return
   `""` with **no log line**. A wrong key is indistinguishable from "not configured".
4. **Secret material used as a Redis key** — the first 16 characters of a raw API key become a Redis key
   (`auth-key/route.ts:17`), so key prefixes persist in Redis outside the database.
5. **Credential in a URL** — the `query` auth type writes the credential into `url.searchParams`
   (`lib/file-url-downloader.ts:85-94`), where it can be logged by any intermediary.
6. **Unauthenticated route that spends a stored credential** — `app/api/chat/route.ts` `POST` has no
   `requireAuth`/`getServerSession` (the file exports only `POST` at `:8`) and `/api/chat` is in the middleware
   bypass list (`middleware.ts:8-15`), yet it places `connection.authSecret` in an outbound header (`:59-61`).
7. **Mask handling enforced only client-side** — the settings UI drops any value containing `****` before PUT
   (`components/SettingsForm.tsx:132-134`), but the server accepts any string for those 5 keys
   (`app/api/settings/route.ts:60-73`) and would encrypt-and-store a masked literal.
8. **Same secret for two purposes** — `NEXTAUTH_SECRET` doubles as the AES key when `ENCRYPTION_KEY` is unset
   (`lib/crypto.ts:14`); there is no separation and no check.
9. **No TLS enforcement** on credential-bearing outbound calls (`http-client.ts:90-91`).

Positive controls worth carrying forward (so the inventory is not one-sided): auth tag verification on decrypt
(`lib/crypto.ts:52-56`); SSRF defence in depth (`http-client.ts:107-123`); per-hop redirect re-validation
(`file-url-downloader.ts:106-124`); API keys stored only as hashes; internal routes carry their own guards
(`ext-connections/route.ts:18-19` `requireAuth`, `:39-40` `requireAdmin`;
`app/api/internal/apikeys/route.ts:10-11`, `:36-37`, `:71-72`), which is what makes the `/api/internal`
middleware bypass (`middleware.ts:12`) survivable.

## 7. MISMATCH ledger — docs/comment claim vs code

| # | Claim (where) | Code (where) | Verdict |
|---|---|---|---|
| MM-1 | `ENCRYPTION_KEY` must be "a random 32-char string" (`.env.example:9`, echoed by the thrown error at `lib/crypto.ts:17-19`) | any non-empty string is accepted and hashed (`:14-22`); length is never checked | **MISMATCH** — a doc/eror promise with no enforcement behind it |
| MM-2 | `lib/crypto.ts:2` — *"AES-256-GCM encrypt/decrypt cho ai_api_key"* | the same primitive protects 5 `AppSetting` keys **and** `ProfileEndpoint.fileUrlAuthConfig` (`lib/settings.ts:111`, `profile-endpoints/route.ts:155`) | **MISMATCH (understated scope)** — auditing from this comment alone misses a whole data class |
| MM-3 | `middleware.ts:2` — describes auth behaviour for `/api/v1/docs/*` only | the bypass list also exempts `/api/internal` and `/api/chat` (`:8-15`) | **MISMATCH (understated surface)** |
| MM-4 | `AGENTS.md` security section — "use `lib/logger.ts` for structured logging" | `lib/logger.ts` has **no redaction helper**: grep for `redact|sanitiz|mask|secret|token|password` in that file matches only the `apiKeyId` context field (`:12`) | **GAP** — documented logging rule has no secret-scrubbing counterpart in the logger |
| MM-5 | Rework docs present Vault-managed envelopes as available: `docs/09-system-architecture.md:116` ("Có"), `docs/02-architecture.md:99` ("Đã có schema"), `docs/04-data-state.md:91` | true **for the rework target**; legacy has no Vault, no key registry, no key version, no rotation | **SCOPE NOTE for COMP-00 #5** — legacy secrets must not be assumed Vault-managed at cutover |
| MM-6 | No document under `du-rework/docs/**` describes legacy encryption behaviour at all (grep for `authSecret|ENCRYPTION_KEY|AES-256|NEXTAUTH_SECRET` over that tree returns rework-design docs only) | the legacy facts in §1-§4 exist only in code comments | **UNCLAIMED** — legacy crypto behaviour is undocumented, so any plan that trusts docs for it will find nothing |

## 8. Open questions — for ENC/ADR-18 and COMP-00 #5 (decisions, deliberately not taken here)

1. **Which legacy secrets must survive cutover?** The 2 encrypted classes (`AppSetting` 5 keys,
   `fileUrlAuthConfig`) and the 1 plaintext credential class (`authSecret`) have different risk profiles.
   Which of them need a Vault-managed key at parity, and which may remain env-derived during a phase?
2. **Migration marker for keyless ciphertext.** The legacy wire format carries no algorithm/version/key id
   (`lib/crypto.ts:38-42`), so per-row migration is impossible without an out-of-band marker. Which marker
   field is acceptable, and who owns writing it?
3. **`authSecret` re-provisioning.** Encrypting an existing plaintext secret server-side is mechanical;
   *rotating* it is a product question — the external provider may not accept two active secrets, so cutover
   may have to be encrypt-in-place without rotation. Is that acceptable?
4. **Legacy-plaintext `fileUrlAuthConfig` rows.** Because the read path falls back to plain JSON
   (`profile-endpoints/route.ts:47-56`), a migration cannot distinguish "legacy plaintext" from "corrupt
   ciphertext" at read time. Which policy resolves that — and does the fallback survive cutover at all?
5. **Key-change failure signalling.** Today a key change degrades silently to `""` (`lib/settings.ts:119-124`)
   and `undefined` (`profile-resolver.ts:108-111`). Should COMP-00 require an explicit failure signal during
   migration, or is silent degradation acceptable?
6. **ApiKey handling at parity.** Legacy keeps `SHA-256(raw)` with no salt and uses `raw.slice(0,16)` as a
   Redis rate-limit key (`auth-key/route.ts:17`). Does the rework keep that indexing, or change it — and does
   that change fall inside COMP-00 or a later slice?
7. **Seed overwriting the admin key.** `npm run seed` rewrites the admin `keyHash` from `SEED_ADMIN_KEY` every
   run (`lib/db/seed.ts:372-375`). Acceptable at cutover?
8. **TLS enforcement.** `http:` remains permitted (`http-client.ts:90-91`). Is https-only a COMP-00
   requirement (a behaviour change for existing http endpoints) or out of scope?

## 9. Acceptance mapping

| Required | Where |
|---|---|
| 1. Touchpoint table: data → algorithm → key source → rotation surface → at-rest/in-transit/plaintext, with file:line | §1 (12 rows), §2, §3, §4, §5 |
| 2. Open questions for ENC/ADR-18 + COMP-00 #5, not self-decided | §8 (8 questions) |
| 3. MISMATCH ledger: docs claim vs code | §7 (MM-1..MM-6) |
| 4. No tests required; read commands recorded | §10 |

## 10. Read commands run (literals)

All read-only; no test, build, or lint command was run (spec: not needed).

- `glob {lib/crypto*,prisma/schema.prisma,middleware.ts,lib/file-url-downloader.ts}` → 3 files (no `prisma/`
  tree; legacy uses Drizzle, `lib/db/schema.ts`).
- `grep "from '.*crypto'|require\(.*crypto\)"` (repo-wide, ts/tsx/js) → 225 matches; the `@/lib/crypto`
  importers are exactly 4 files: `app/api/settings/route.ts:7`, `app/api/internal/profile-endpoints/route.ts:10`,
  `lib/settings.ts:7`, `lib/endpoints/profile-resolver.ts:10`. Every other hit is Node `crypto` (randomUUID,
  sha256 key hashing, md5 dedup) or lives under `du-rework/`.
- `grep "authSecret"` → 54 matches; `grep "keyHash"` → 58; `grep "users\.password|bcrypt|argon2|scrypt|pbkdf2"`
  → bcrypt only; `grep "createHmac|timingSafeEqual|signature"` over `lib/**` → no HMAC anywhere.
- `grep "^[A-Z_]+=" .env.example` → 10 env NAMES (values are placeholders; no value was opened).
- Read-only verification only: `git status` / `git check-ignore` were used solely to prove this slice
  changed nothing in `lib/`, `app/`, `components/` or `middleware.ts`. **The only file written by this slice is this receipt.**

**Boundary respected:** the rework encryption module (`services/orchestrator/src/modules/encryption/**`) was
**not read**; ADR-18 wire-profile decisions (HPKE/RSA, DEK, AAD, nonce, tag, vectors) are untouched here by
instruction.
