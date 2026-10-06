# W1 REVIEW — Part 4 (W3 + W1c + PREFCONSUME verdicts) — 2026-10-04

**Packet:** W-REVIEW-PART4 (run `run_069ecd6957cd`). **Owner:** Claude Code — REVIEW-ONLY.
READ-ONLY: khong sua source/test, khong tick/commit.
**Evidence:** `p730-admin-mutate-2026-10-04.md` §8 + tester.md `VERIFY-W3` (:12633) + `p730-acquire-2026-10-04.md` + tester.md `VERIFY-W1C-PC` (:12715) + `p730-prefconsume-2026-10-04.md` + doc lap truc tiep code (`profile-actions.ts`, `publish.ts`, `prompt-overrides.ts:209-220`, `acquisition-ref-resolver.ts`, `prompt-precedence.ts`).

**Working tree:** HEAD van `b088eec` o ca hai verifier receipts — chua co commit nao land; tree dirty voi cac slice da review.

---

## VERDICT 1 — W3 ADMIN-MUTATE: APPROVED (offline)

Slice offline hoan chinh: Δ7(A) + Δ8 + Δ10 da implement; gate focused xanh 3× lien tiep o ca owner va verifier doc lap.

**Xac minh doc lap (VERIFY-W3, :12640-12670):**
- Contracts 2 suites / 39 tests exit 0 ×3; orchestrator 9 suites / 215 tests exit 0 ×3, raw logs co SHA-256 tung round.
- **Hash continuity owner→verifier (tu khop, case-insensitive):** `profile-actions.ts` `8bb9d69d…`, `rbac.ts` `55fe5ee4…`, `session-store.ts` `7b64f1ad…`, `audit.ts` `1076e2b3…`, `profile-commands.ts` `908b870b…`, `0028` `5289210a…` — verifier digest (SHA-256 full) mo dau dung bang owner sha16. Source chay test = source da review.
- Standing-reds: lifecycle suite default-env 1 failed/50 passed (:12688), production pair 2 failed (:12696) — dung 2 cells owner da A/B (`RESTORED_ALL_MATCH=True`); verifier corroborate ma khong lap lai source swap. **Pre-existing, khong phai regression W3.** (Default-env 1-failure la tap con env-gated cua cung 2 cells.)

**Doc lap tren code (spot-check truc tiep):**
- `runProfileUpsert`: resolve ACTIVE key (uniform 404) → `fence(key.tenant_id)` **truoc write dau tien** → `ensureProfileId` → CAS (`FOR UPDATE`) → `createRevision` tren cung client (nguyen tu voi audit qua `auditedMutation` theo comment `:26-29`).
- `assertUpsertCas`: profile moi chi chap nhan absent/0 (R-12); profile cu doi expectedRevision khop pointer — dung semantics CAS.
- `runProfilePublish`: resolve registry (missing → 404) → `publishRevision({profileId, expectedRevision})` — CAS **required** o type (`publish.ts:139`).
- `runProfileRollback`: catch `isUnknownRevisionError` (code `23503`, khong phai HttpError) → 404; throw lai moi thu khac.

**Danh gia 2 precision cua tester (:12673) — DONG Y ca hai la semantics dung:**
- (a) **23503→404 chi cho rollback target invalid.** Dung: publish target = `max(revision)` (`publish.ts:110-115`) — row do chac chan ton tai tren bang append-only, nen FK (`pinActiveRevision`) khong the fire o duong publish; chi rollback voi target tu client moi co the tro toi pair `(profile_id, target)` khong ton tai. Khong co publish-23503 translation nao bi thieu.
- (b) **Publish moves to latest revision duoi CAS.** Dung theo dinh nghia: publish = "activate newest" + `expectedRevision` REQUIRED chong hai operator ghi de nhau (`publish.ts:134-136` comment). Rollback = re-point ve revision cu (row khong bi sua — R-03), target cu the, CAS optional (xem LOW-1 duoi).

**Δ-DECOMP (registry `profile_names` thay vi cot tren `profile_bindings`) — DONG Y voi thiet ke:**
- Verifier xac nhan (:12678): unique key chi tren `profile_names(tenant_id, api_key_id, business_id, business_version, action, profile_name)`; `profile_bindings` giu PK `(profile_id, revision)`.
- Ly do owner dung: unique `(…, profile_name)` ap len bang append-only se **chan revision N+1 cua chinh profile do**; ghi cot doi lease `profiles.ts` (ngoai cap). Race guard = unique index + `ON CONFLICT DO NOTHING` + re-read winner (`:132-160`). Neu coordinator muon cot-on-bindings → can named lease `profiles.ts`, cho quyet (khong chan verdict nay).

**LOW-1 (question, khong chan):** rollback `expectedRevision` optional — rollback khong CAS se thang `FOR UPDATE` serialize nhung van last-writer-wins voi mot publish dong thoi (khac voi publish bat buoc CAS). Neu la chu y thi ghi lai; neu muon chat thi require CAS ca rollback o packet closure. Khong phai defect cua slice hien tai (behavior da pin bang test).

**Dieu kien con lai (live/closure, khong phai defect):**
1. Real PG: serialization `FOR UPDATE`, unique-race registry dong thoi that, FK 23503 that; idempotency marker race live (23505 → replay winner).
2. Closure T-API-01 detail read (Δ9: seam truoc, closure sau) — UI end-to-end (apiKey tu detail read) doi packet closure.
3. Principal fields hien chi gan cho 3 case `profile.*` (chu y additive); mo rong ra moi action cu = packet rieng.

---

## VERDICT 2 — W1c ACQUIRE: APPROVED (offline)

Resolver + consumer wiring hoan chinh offline; seam `transfer.fetcher` du, worker-sdk khong can sua.

**Xac minh doc lap (VERIFY-W1C-PC, :12727-12731):** W1c focused 2 suites / 26 tests exit 0; URL-ingestion regression 3 suites / 45 tests exit 0; PREFCONSUME set 4 suites / 45 tests exit 0 — **tong 9 suites / 116 passed / 0 failed** (26+45+45=116 khop). Hash khop receipt owner; verifier khong sua source/test.

**Doc lap tren code (`acquisition-ref-resolver.ts` doc truc tiep):**
- Doc snapshot theo `(operationId, tenantId)`; NULL snapshot (legacy) → `none`; `configured=false` → `none` khong cham bindings.
- Ref tenant ≠ op tenant → 403; binding doc theo **dung revision** trong pin (khong resolve latest); binding tenant ≠ ref tenant → 403; cipher NULL/empty → `AUTH_CONFIG_MISSING`; decrypt null (sai key/tag) → 500 `AUTH_DECRYPT_FAILED`; config khong secret mac du flag configured → `MISSING` (khong silent no-auth); `type:'query'` → 422 `QUERY_AUTH_FORBIDDEN`; bearer trim-empty → `MISSING`; message deny co dinh, secret-free.
- `withSourceAuth`: pin origin cua URL dau tien, bo credential o hop cheo origin (redaction chu dich, khong fallback); origin null (khong parse duoc) → khong gan credential (fail-closed).

**Danh gia honest-limit (packet + verifier :12737-12739) — DONG Y:**
Fetch-spy zero-call truc tiep chi chung minh cho query denial; cac denial class khac duoc pin bang typed resolver tests + thu tu pre-network thiet lap boi shared call path (consumer `await resolveSourceAuth` truoc khi dung fetch path). Du cho verdict offline; tang cuong tuy chon (khong bat buoc): them fetch-spy case cho moi denial class o packet sau.

**Δ dong y:** Δ2 query-deny thi hanh (khong nhanh "query hop le"); Δ-SDK = KHONG can (worker-sdk hash chung minh khong sua).

**Dieu kien con lai:**
1. Live: PG that (wrong-key/tag tren row that), MinIO fetch that quan sat header tai mock provider.
2. **Δ-composition (MO):** chua compose `createAcquisitionRefResolver` trong `create-app`/`main` — production giu hanh vi cu (unauthenticated), khong hoi quy; can coordinator cap lease file composition.

---

## VERDICT 3 — PREFCONSUME: APPROVED-WITH-CONDITIONS (core APPROVED offline; acceptance con lai BLOCKED-BOI-Δ-PC-1)

Boi canh dung nhu owner TL;DR: carrier cho prompt CONTENT la Δ-1 CHUA CHOT (sealed bucket vs snapshot extension; key-format flat vs composite; producer hardcode `promptRevisions: {}`) — phan kha thi offline (resolver precedence thuan + pin semantics) da xong; wiring substitution giu nguyen la **chu y dung** (khong dung carrier gia, khong de code chet).

**Xac minh:** focused 4 suites / 45 tests (17 moi + forwarding + execution-pin + manifest) exit 0 — owner 3× lien tiep, verifier lap 1× (:12731). `execution-pin.functional.test.ts` KHONG sua; SHA truoc/sau run y het (`4b721dca…`, :12750) — suite khong vacuous. `test:typecheck` do pre-existing ngoai lease (Δ-1 cua W1b) — owner khong sua la dung; verifier khong rerun.

**Doc lap tren code:**
- `resolveStepPrompt`: code (trim-empty=absent) > profile (exact → `_default`, cleared exact short-circuit `_default` roi roi xuong connector) > connector (label-only, `apply:false` — caller giu prompt cu byte-identical). `profilePolicy === null`/`undefined` skip profile level, khong coalesce `{}` (NULL semantics PROMPT-02/0026).
- `pickPinnedPromptOverride` (`:110-125`) la parity chinh xac cua `pickPromptOverride` (`prompt-overrides.ts:214-219`: `exact ?? _default`) — selection theo STEP ONLY, content do caller quyet.

**Danh gia Δ (theo yeu cau packet):**
- **Δ-PC-5 (cleared exact KHONG hoi sinh `_default`) — DONG Y la parity hop ly, khong phai defect.** Selection `exact ?? _default` thang bat ke content o ca hai ham; cleared-ness roi xuong connector level. Owner da flag ro la interpretation call va flip cost re (1 nhanh + 2 test) — coordinator co the chot nguoc ma khong vo slice.
- **Marker formula composite `connectionId::stepId` — anh huong producer/carrier, KHONG anh huong resolver.** Resolver nhan bucket rows `(connectionId, stepId, promptOverride)` nen bat ke key-format nao chot (flat `{stepId→rev}` hay composite), chi can producer map marker→rows la wiring duoc. Δ-PC-4 deferral (chua dung `promptRevisions` lam tin hieu chon step) la dung.
- **Δ-PC-1 (blocker wiring) — CONG NHAN MO:** carrier content + key-format cho coordinator chot, roi packet producer (submission/runtime — hot files) roi packet wiring document-core (6 site build-prompt, ~1 dong/site `resolveStepPrompt` + `apply ? prompt : defaultText`).
- **Δ-PC-2 — (a) substitution tai payload construction truoc `ctx.connector.invoke` la kha thi nhat (khong doi contracts);** xac nhan o packet wiring. Δ-PC-3 (bucket pre-scoped o producer; consumer ctx khong co `apiKeyId`/`endpointSlug`) la design assumption dung huong.

**Dieu kien dong acceptance day du (T-PROM-02):** (1) chot Δ-PC-1; (2) packet producer pin content; (3) packet wiring 6 sites; (4) independent verify observed provider request (key-4/step mapping/fallback tren wire) + live. Hien tai khong claim hon.

---

## Input cho commit plan (noi tiep Part 3 §NOTE)

Part 3 de xuat 1→2→3 (DTO freeze → producer → claim+P2) + tach rieng `config.ts`/`crypto-storage.ts` (lane khac — KHONG BAO GIO gop). Ba slice Part 4 map nhu sau:

4. **Commit 4 — W3 ADMIN-MUTATE** (1 don vi): `migrations/0028_profile_name.sql` + `0029_audit_actor_principal.sql` (moi, additive) + `profile-actions.ts` (moi) + `dispatcher.ts` + `rbac.ts` + `session-store.ts` + `audit.ts` (additive-only) + `bff/profiles.ts` + `client.ts` (1 dong Δ10) + `tests/p730-admin-mutate-offline.test.ts` + cap nhat 3 pin shape tests. Ly do gop: seam + leaf + migration la mot slice nguyen tu.
5. **Commit 5 — W1c ACQUIRE** (1 don vi): `acquisition-ref-resolver.ts` (moi) + `ingestion-consumer.ts` (5 edit) + 2 test `p730-acquire-*`. Chua kem composition (Δ-composition la commit/lease sau).
6. **Commit 6 — PREFCONSUME resolver** (1 don vi): `prompt-precedence.ts` + `tests/p730-prefconsume.test.ts`. An toan de merge som: leaf moi khong call-site, khong doi hanh vi hien tai; wiring la commit sau khi Δ-PC-1 chot.
7. **Bo sung Commit 1 (contract freeze):** `profile-commands.ts` + test cua no (ApiKeyRef `.transform()` non-breaking, wire cu van parse) gop vao commit freeze DTO (a) cua Part 3 — cung ban chat contract-freeze.

Thu tu 1→2→3→4→5→6 giu `git bisect` sach (contract → producer → claim → admin-mutate → acquire → prefconsume). Truoc moi commit: chay lai focused set tren dung tree se commit + `tsc --noEmit` (VERIFY-W1C-PC khong kem typecheck; bu bang pre-commit check).

---

## Ngoai pham vi (lap lai, khong doi)

W1b/W1c live PG/MinIO/composition (da liet ke dieu kien), T-API-01 closure, MEDIUM-1 parameters packet (Part 2-Q2 van mo), MEDIUM-2 tenantId uuid, `.passthrough()` ngoai duong W1, F-3 dead-404, DD-06 client type, stale comment `:227/:260`, scoped USER / prompt-override.* / assignment.*.

**Khong commit, khong tick. DB window: FREE (lane nay khong giu).**
