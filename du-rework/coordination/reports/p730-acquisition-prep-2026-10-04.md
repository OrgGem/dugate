# P730-ACQ-PREP — read-only acquisition prep (W1c) — lane qwen_4 — 2026-10-04

> [!IMPORTANT]
> **RESUME POINT — 2026-10-04 19:4x (+07).** Packet P730-ACQ-PREP (spec `coordination/dispatch-specs/2026-10-04-1835-P730-ACQ-PREP.md`, run_069ecd6957cd, task_085af29ae64d, dispatch ctx_f30cacf53f1c) **HOAN THANH** muc READ-ONLY. Receipt duyet ghi luc 19:31.
> Khong sua source, khong commit/push/reset, khong mo cua so DB/Redis/S3/Vault. Write-set = CHI file receipt nay.
>
> **Ket luan 1 dong:** SSRF + redirect-hop-bound + URL-query redaction **DA DU MANH** o `packages/worker-sdk/src/source-acquisition.ts` — khong can lam them. **GAP duy nhat va lon nhat: credential.** `fileUrlAuthConfig` duoc decrypt tai `profiles.ts:242` nhung **khong consumer nao inject no vao request** (0 duong toi socket). P730-ACQUIRE phai **TAO seam moi**: them param vao `AcquireSourceUrlOptions` — day la **thay doi chu ky SDK**, can named lease tu coordinator khi mo W1c (khong phai leaf moi tu do).
>
> **Doc tiep:** §2 bang chung phu dinh, §5 file release de xuat + dieu kien an toan, §7 delta can adjudicate.

---

## 0. Packet, ranh gioi, phuong phap

- **Spec:** `du-rework/coordination/dispatch-specs/2026-10-04-1835-P730-ACQ-PREP.md`. **Nguon:** `plan-review-730-2026-10-04.md` §3 (dong qwen_4) + §4 (P730-ACQUIRE = W1c).
- **Loai:** READ-ONLY product-prep. Khong implement, khong tick gate, khong DB window, khong commit/push/reset.
- **Ranh gioi da tuan:** khong cham `modules/admin-actions/dispatcher.ts`, `modules/profiles/file-url-auth.ts`, `app/bootstrap/crypto-wiring.ts`, bat ky source/test nao; chung chi DOC de map.
- **Repo:** `D:\Git\dugate`, branch `codex/fix-workflow-builder`, HEAD `b088eec` (2026-10-02).
- **Phuong phap:** doc source truc tiep + grep PHU DINH co kiem dong-cua-true (mo tung dong nghi van). Moi `file:line` da doc bang read_file/grep_search trong turn nay, khong suy tu receipt lane khac.

---

## 1. Credential ref: producer DA CO, consumer CHUA CO

### 1.1 Producer — encrypt/decrypt at rest (da ton tai, khong thuoc scope sua)

| Buoc | file:line | Noi dung |
|---|---|---|
| Key derive | `modules/profiles/file-url-auth.ts:37` | SHA-256(`ENCRYPTION_KEY` ?? `NEXTAUTH_SECRET`); ca hai vang = boot error, khong co fallback khong key |
| Encrypt | `modules/profiles/file-url-auth.ts:60` | AES-256-GCM, IV 12B moi lan; luu chuoi 3 phan hex thap `iv:tag:ciphertext` (shape co y, khong phai JSON envelope) |
| Schema gate | `modules/profiles/profiles.ts:190-200` | `FileUrlAuthConfigSchema.safeParse` TRUOC khi encrypt |
| Decrypt | `modules/profiles/profiles.ts:242` | `decryptFileUrlAuthConfig(row.file_url_auth_cipher, cryptoEnv, warnLegacyPlaintext)` — nam TRONG `resolveEffectiveProfile`, moi lan resolve la mot lan decrypt |
| Ra config | `modules/profiles/profiles.ts:249` | `fileUrlAuthConfig: decrypted?.config ?? null` trong plaintext tren `profile.policy` (RAM) |
| Snapshot | `modules/operations/submission.ts:512` | chi ghi **flag** `fileUrlAuthConfigured` (predicate `file-url-auth.ts:155`); snapshot KHONG chuyen secret — dung, giu nguyen |
| Wrong key | `modules/profiles/file-url-auth.ts:103-107` | GCM tag fail → return null (fail-closed, khong throw, khong partial) |

### 1.2 Consumer — KHONG TON TAI (gap chinh, 4 bang chung phu dinh)

1. **Cho goi fetcher thieu headers:** `packages/worker-sdk/src/source-acquisition.ts:211` — `fetcher(current.href, { method: GET, redirect: manual, signal })`. Khong co truong `headers`, khong co `query`.
2. **Kieu fetcher du nhung cho goi khong truyen:** `SdkFetcher = typeof fetch` (`fan-out.ts:54`) — signature ho tro headers; chu ky `AcquireSourceUrlOptions` (`source-acquisition.ts:66-106`) **khong co** bat ky tuy chon auth/headers/credential nao.
3. **4 dong chua "headers" trong `source-acquisition.ts` da mo tung dong:** L37 + L79 la comment; L218 doc `res.headers.get(location)`; L252 doc `res.headers.get(content-length)`. **Ca 4 la doc RESPONSE header, 0 dong inject request header.**
4. **Grep phu dinh von bao:** trong `services/orchestrator/src`, `fileUrlAuthConfig` xuat o DUNG 4 file (file-url-auth.ts, policy.ts, submission.ts, profiles.ts) — toan bo la producer/snapshot; `ingestion-consumer.ts` = **0** occurrence `fileUrlAuth`; `source-ingestion.ts` = **0** occurrence `headers|token|auth`. Trong `worker-sdk/src`, Authorization chi la runtime/connector service token (`runtime-client.ts:133`, `fan-out.ts:134`, `connector-invoker.ts:144`) — KHONG phai profile fileUrlAuth.

**Nuong ket luan:** credential bi **cut hoan toan** giua DB va socket. Hom nay acquisition luon fetch **khong** auth. voi `fileUrlAuthConfig` type `bearer|header|query` bi bo yen. Do vay P730-ACQUIRE la **TAO seam** (duong ref→decrypt→headers ngay truoc fetch + fail-closed), khong phai noi lai day noi kia. Luu y them: `query_key/query_value` (contract `profile-policy.ts:185-186`) yeu cau app-render vao URL — tuc la secret se nam trong query — xem Δ2.

---

## 2. SSRF / redirect / URL-query redaction — danh gia: DAT, khong can lam them

- **SSRF pinned:** default fetcher = `createPinnedFetch()` (`packages/egress/src/pinned-fetch.ts:164`, dung tai `source-acquisition.ts:201`) — MỘT lan DNS nuoi ca policy adjudication va socket; private/loopback/link-local/metadata/CGNAT/multicast tu truoc connect; `DestinationDeniedError` thong diep tinh + reason enum.
- **Redirect:** egress khong bao gio tu follow (`redirect: manual`); vong follow o `source-acquisition.ts` (`DEFAULT_MAX_SOURCE_REDIRECTS = 3` tai `:78`); moi hop re-pass `validateTarget` (`:132`) — scheme https-only tru khi opt-in `allowHttp`, userinfo tu choi (`:146`) — va fetcher re-resolve + re-adjudicate. Chuoi hop khong ke thua tra loi cua hop truoc.
- **Byte/time/idle caps:** Content-Length check truoc write + mid-stream tren DECODED bytes; deadline toan bo + idle watchdog; moi loi xoa partial file (fail-closed, khong de "half bytes").
- **Redaction:** loi chi mang typed code + error CLASS name (`errorClassName`), khong bao gio echo URL/upstream body/signed query. `assertIngestionTask` (`source-ingestion.ts`) tu choi URL co ky tu dieu khien (`x00-x1f x7f`) — chong URL-smuggling qua WHATWG strip.
- **Con trong (nhat ki, khong gap W1c):** deployment opt-in `allowPrivateNetworks`/`allowHosts` (`PinnedFetchOptions`) duoc thiet ke chat nhung ingestion consumer truyen `transfer.fetcher` tuy y (`ingestion-consumer.ts` `IngestionTransferPolicy.fetcher`) — mot deployment truyen global fetch thi tu bo fence; day la seam co y de test, ghi o Δ1.

---

## 3. Wrong tenant / key / tag — fail TRUOC network (hien trang: DAT 3/3 chieu, thieu chieu credential)

- **Tenant:** consumer KHONG tin queue payload; toan bo toa do doc lai tu DB (`OPERATION_LOAD_SQL`, `ingestion-consumer.ts:210`) — tenant lay tu `operations.tenant_id` cua operation, KHONG phai tu payload. Payload `taskId` khop `task_key=root` bang bat buoc (`:574`); `sourceUrl` dispatch phai bang ban trong task envelope (`:633`). Sai tenant → khong co toa do dung de fetch; artifact id sinh tat dinh (RFC4122 v5) tu (tenant, operation, key, version, sha) nen khong the ghi de chen tenant khac.
- **Key:** envelope sealed mo binding (tenant, slot, refId) — `openDispatchSourceUrl` (`:282`) + `readStored(tasks.payload_ref)`. **Truoc moi network/storage:** `KEY_PROVIDER_FAILED` = retryable; moi crypto-failure khac = escalate permanent (`:607-614` va canh envelope `:620-631`).
- **Tag:** GCM auth-tag fail trong `decryptFileUrlAuthConfig` → null → tu `fileUrlAuthConfigured` = false hoac config null; khong co partial decrypt.
- **Chieu CON THIEU:** khong co "wrong credential cho host dich" vi chua co credential (muc 1.2). Khi them seam, dieu kien an toan bat buoc: decrypt THAT (wrong-key/tag) → fail truoc `fetcher(...)` dau tien, khong bao gio fetch roi moi check.

---

## 4. Extension map — producer/consumer 4 duong

| Duong | Producer (khai bao) | Enforce | Ghi chu |
|---|---|---|---|
| **upload** | `POST /api/v1/uploads` | **KHONG enforce — CO Y** (`submission.ts:756-759`): upload-init khong mang business/action, khong the biet profile; doan = 422 nham action | Dich doi nay co y de o submission |
| **sourceUrl** | top-level submission | `submission.ts:781` (nhánh sourceUrl trong `assertProfileExtensionAllowed`, goi tai `:366` trong tx TRUOC INSERT dau tien) | Ten lay tu URL path, POLICY tren metadata, truoc network |
| **artifacts** | submission artifact refs | `submission.ts:797` | `fileName` cua artifact row READY |
| **file_urls** | `effectiveInput.fileUrls` | `submission.ts:807-819` | `fileUrlEntryName` (`policy.ts:307`) — legacy name resolution, tru Content-Disposition (thuoc download leg) |
| **Test Endpoint** | `GET /api/v1/connectors/:id/test` (`http/routes/public.ts:204` → `ctx.connectors.testConnector`) | **KHONG co extension check** — day la probe connector, khong phai duong tai file; **KHONG co** chỗ giải mã `fileUrlAuthConfig` (xem Δ3) | W1c khong son; thuoc scope connector/W3 |
- San pham phu: `normalizedAllowedFileExtensions` (`policy.ts:242`) + `extensionDeniedReason` (`policy.ts:286`) da chuan hoa hoa; CSV la STRING tren wire/cot (`policy.ts:39-40`).
- **Gap ghi nhan:** download-leg (Content-Disposition name) chua enforce extension vi can response — do download leg chua ton tai cho `file_urls` trong rework (chi co sourceUrl leg). Ghi Δ4.

---

## 5. EXACT shared file releases cho P730-ACQUIRE (de xuat — coordinator cap named lease khi mo W1c)

**Nhom A — file W1 dang giu (can RELEASE tu checkpoint (b), serialize writer):**
1. `services/orchestrator/src/modules/profiles/policy.ts` — W1/W1a dang dung (`policy.ts:82-85` consumer F-PP1). Can cho: (neu tam) leaf resolve ref→decrypt theo service scope.
2. `services/orchestrator/src/modules/operations/submission.ts` — W1 in-flight (hot-file Claude, topology §4). Chi can NEU acquisition seam dat tai submit; theo thiet ke toi uu (decrypt o consumer) thi KHONG can — release nay de phong.

**Nhom B — file W1c du kien qwen_4 ghi (can cap lease, tu PREP xac dinh):**
3. `services/orchestrator/src/modules/operations/ingestion-consumer.ts` — noi decrypt that dien ra (them credential resolve giua `openDispatchSourceUrl` va `openGate`, truyen vao `transfer`). W1c spec da ten file nay.
4. **LEAF MOI** `services/orchestrator/src/modules/operations/source-credential.ts` (ten de xuat) — pure leaf: doc `profile_bindings.file_url_auth_cipher` theo pinned operation snapshot → `decryptFileUrlAuthConfig` → tra header-pairs/query-pair hoac null; wrong tenant/key/tag → null/typed error TRUOC khi goi fetch. Leaf moi = tranh va chạm W1a tren profiles.ts.
5. `packages/worker-sdk/src/source-acquisition.ts` — **THAY DOI CHU KY**: `AcquireSourceUrlOptions` them tuy chon auth (headers va/hoac query-params ap-dung-per-hop, re-validate moi hop). **Day la shared SDK surface, KHONG phai leaf — can named lease rieng, serialize voi W1b (qwen_2 SDK-PREP).**
6. `packages/worker-sdk/src/index.ts` — export type auth moi (`source-acquisition.ts` exports tai `index.ts:138-143`). Chung file voi moi export SDK → lease cung luot voi (5).
7. `packages/worker-sdk/tests/source-acquisition.test.ts` + `tests/source-ingestion.test.ts` — test owner cho slice (file ton tai, gan nhu chac W1b khong ghi vong nay).

**KHONG can / khong dung toi:** `modules/profiles/file-url-auth.ts` (dung NGUYEN as-is — ham decrypt da dung); `packages/contracts/*` (khong can schema moi cho Phase 1 seam — credential header mang noi bo, khong ra wire); `server.ts`/`main.ts`/route mount (integration lease rieng, W3); `dispatcher.ts` (ngoai W1c).

**C 3 dieu kien an toan (user packet ghi ro, nhan lai):**
- (1) **Khong 2 writer cung file**: nhom A chi move khi W1 checkpoint (b); nhom B file 5+6 la MỘT lease (chung package, chung luot); nhom A file 2 neu qwen_4 dung toi thi serialize sau W1a.
- (2) **Khong raw credential trong claim/queue/checkpoint/log**: credential KHONG gia `tasks.payload_ref` hay outbox payload; chi gia `profile_bindings` (da cipher) va decrypt tai consumer. Log typed-code only (pattern hien tai giu duoc).
- (3) **Fail-closed truoc network**: wrong tenant/key/tag = tu `fetcher(...)` dau tien; credential ap dung moi hop redirect (hop 301 toi host khac VANTAI dung credential — quyets dinh hop-hop o P730-ACQUIRE, de xuat: chi gui credential khi hostname kh doi hoac nam trong allowlist redirect-cua-profile).

---

## 6. Trang thai 4 cap

- **Packet P730-ACQ-PREP: [DONE]** — 4 muc spec tra loi du (credential-resolve-sites, SSRF/redirect/redaction danh gia DAT, wrong-tenant/key/tag, extension map, exact file releases).
- **P730-ACQUIRE (W1c): [BLOCKED-CHỜ]** — do coordinator: (a) W1 checkpoint (b), (b) release named nhom A, (c) named lease nhom B (dac biet file 5+6 SDK serialize voi W1b).
- Bang chung verification: khong co test chay (packet read-only, 0 source diff — dung yeu cau). Do luong grep/powershell trong receipt co literal `Exit Code: 0` turn do.

---

## 7. Δ-DEVIATION cho coordinator adjudicate

- **Δ1 (low):** `IngestionTransferPolicy.fetcher` cho phep override egress mac dinh — seam co y de test, nhung deployment truyen global fetch se tu bo SSRF fence. De xuat: boot warning khi fetcher override co mat o production profile.
- **Δ2 (high, quyets dinh P730-ACQUIRE):** `fileUrlAuthConfig` type `query` nghia la secret xuat hien trong URL query — trong khi request-line/URL la do duoc log/echo nhieu noi (proxy, access log). Can quyet: (i) cam type `query` khi acquisition, hay (ii) ap dat URL-query redaction o moi seam log + egress. Legacy cho phep `query` (`lib/file-url-downloader.ts:90` applyQueryAuth) → parity duoi nay nen adjudicate co chu, khong im lang.
- **Δ3 (medium):** Test Endpoint (`/api/v1/connectors/:id/test`) khong giai `fileUrlAuthConfig` va khong extension-check. W1c khong son; ghi de coordinator xep vao connector/W3 ledger.
- **Δ4 (medium):** `file_urls` trong rework CHUA co download leg (chi submission-side check); Content-Disposition name de cho leg sau. Khong phai regression — do leg chua ton tai.
- **Δ5 (info):** decrypt tai `profiles.ts:242` chay MOI lan `resolveEffectiveProfile`; them credential resolve o consumer se la them mot decrypt/operation. OK o quy mo hien tai; neu thanh hot path thi cache — KHONG lam bay gio.

---

## LEDGER
- 1 — P730-ACQ-PREP: read-only acquisition prep (credential gap + SSRF assessment + extension map + exact shared file releases) — Muc 1-7.
