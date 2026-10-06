# ACQ-PREP RECEIPT AUDIT — p730-acquisition-prep (qwen_4) — cc_2, READ-ONLY

**Packet:** `coordination/dispatch-specs/2026-10-04-2010-ACQ-PREP-RECEIPT-AUDIT.md` · **Lane:** cc_2 (`term_ee7e9f33`) · **Run:** `run_069ecd6957cd` (task `task_80400947ca7e`, dispatch `ctx_ed4eb6af9d20`).
**Date:** 2026-10-04 (~20:10–20:3x +07). **Mode:** READ-ONLY — file duy nhất được ghi là receipt này; không sửa source/test/plan; không tick/commit.
**Đối tượng:** `coordination/reports/p730-acquisition-prep-2026-10-04.md` (lane qwen_4; file mtime **19:51:08**).
**Phương pháp:** re-derive từ source hiện tại (đọc file trực tiếp + grep phủ định), không echo receipt; HEAD `b088eec` (đã kiểm); mtime scan cửa sổ hoạt động để kiểm lease.

---

## 0. TL;DR — verdict

**Đạt ở phạm vi prep (read-only), không có claim nào bị source phủ định.** Chuỗi bằng chứng chính (credential gap; SSRF/redirect; extension map; release list) **đúng ngữ nghĩa**; 4 nits nhỏ (F1–F3 + line-drift) + 1 observation điều phối (F4 — ngoài lane qwen_4, không phản bác read-only claim của nó):

| # | Nội dung | Verdict |
|---|---|---|
| 1 | Claims ↔ artifacts (§1.1 producer, §1.2 consumer gap, §2 SSRF, §3 tenant/key/tag, §4 extension, §5 release) | **SUPPORTED** (chi tiết §1; line-drift nhỏ ở vài range) |
| 2 | Release list an toàn (no 2-writer; profiles.ts read-only; serialization) | **SUPPORTED** — kèm F4 (profiles.ts vừa bị ghi bởi lane khác, xem §3) |
| 3 | 5 Δ well-formed; Δ2 khớp adjudication "CẤM raw secret trong URL query" | **SUPPORTED** (§4) |
| 4 | F1 — tự khai "literal Exit Code: 0" nhưng receipt không có block literal nào | Minor (format/lane-rule) |
| 5 | F2 — RESUME ghi "receipt ghi lúc 19:31" vs mtime thực 19:51:08 | Minor (chưa giải thích lần ghi sau) |
| 6 | F3 — line-drift nhỏ (4 chỗ) | Info (không sai bản chất) |

---

## 1. Claims ↔ artifacts (đọc trực tiếp source hiện tại)

### 1.1 Producer chain — SUPPORTED

| Claim (receipt) | Kiểm chứng (file:line) | Verdict |
|---|---|---|
| Key derive SHA-256(`ENCRYPTION_KEY` ?? `NEXTAUTH_SECRET`); cả hai vắng = boot error | `file-url-auth.ts:37-46` — throw khi thiếu cả hai; không unkeyed fallback | ✓ |
| Encrypt AES-256-GCM, IV 12B, `iv:tag:ciphertext` | `file-url-auth.ts:60-71` (IV_LENGTH 12 :26; order iv→tag→ct :69-70) | ✓ |
| Schema gate trước encrypt | `profiles.ts:190-197` — `FileUrlAuthConfigSchema.safeParse` → 422 | ✓ |
| Decrypt tại `profiles.ts:242` (mỗi lần resolve) | `profiles.ts:242` trong `resolveEffectiveProfile`; :249 trả `decrypted?.config ?? null` | ✓ |
| Snapshot chỉ ghi flag, không chuyển secret | `submission.ts:512` = `fileUrlAuthConfigCarriesSecret(...)`; predicate `file-url-auth.ts:155-162` | ✓ |
| Wrong key/tag fail-closed → null | `file-url-auth.ts:103-110` — catch return null (receipt ghi ":103-107", thực tế catch :107-110 — lệch ±3) | ✓ (±3) |

### 1.2 Consumer gap — SUPPORTED (4/4 bằng chứng phủ định)

| Claim | Kiểm chứng | Verdict |
|---|---|---|
| Fetch call không headers | `source-acquisition.ts:211` — `fetcher(current.href, { method:'GET', redirect:'manual', signal })` | ✓ exact |
| `AcquireSourceUrlOptions` không có option auth/headers/credential | Interface tại `:84-108` (receipt ghi ":66-106": doc-comment bắt đầu ~:66, interface :84-108) — fields: maxBytes/expectedSha256/expectedSizeBytes/allowHttp/maxRedirects/timeoutMs/idleTimeoutMs/signal/fetcher/highWaterMarkBytes — **không auth** | ✓ (range lệch) |
| `SdkFetcher = typeof fetch` | `fan-out.ts:54` | ✓ |
| "headers" trong source-acquisition.ts toàn là đọc RESPONSE | 4 hit: comment L37/L79; `res.headers.get('location')` L218; `content-length` L252 | ✓ |
| `fileUrlAuthConfig` chỉ ở 4 file orch/src; ingestion-consumer = 0 | grep = **đúng 4 file** (profiles.ts, submission.ts, policy.ts, file-url-auth.ts); `ingestion-consumer.ts` không có | ✓ |
| source-ingestion.ts = 0 `headers\|token\|auth` | grep `headers\|token\|auth\|fileUrlAuth` = **0 match** | ✓ |
| worker-sdk Authorization là service token (runtime/connector), không phải fileUrlAuth | receipt cite runtime-client:133 / fan-out:134 / connector-invoker:144 — **không re-verify từng dòng** (ngoài trọng tâm; không mâu thuẫn ngữ cảnh) | ~n/v |
| Contract có `query_key/query_value` | `packages/contracts/src/profile-policy.ts:185-186` (strict, snake_case) | ✓ |

**Kết luận gap:** xác nhận — không có đường inject credential vào acquisition; receipt's "credential bị cắt hoàn toàn giữa DB và socket" **SUPPORTED**.

### 2. SSRF / redirect / redaction — SUPPORTED

| Claim | Kiểm chứng | Verdict |
|---|---|---|
| Default pinned fetcher | `source-acquisition.ts:201` = `options.fetcher ?? createPinnedFetch()`; `pinned-fetch.ts:164` tồn tại; `DestinationDeniedError` `:47` | ✓ |
| Redirect bound 3, re-validate từng hop, userinfo reject | `:78` DEFAULT_MAX_SOURCE_REDIRECTS=3; `validateTarget` `:132`; throw userinfo `:147` (receipt ghi ":146", ±1); re-validate `:238` | ✓ (±1) |
| Control chars refused (x00-x1f x7f) | `source-ingestion.ts:357` — `/[\x00-\x1f\x7f]/.test(task.sourceUrl)` → 422 | ✓ exact |
| Error hygiene chỉ typed code + class name | `errorClassName` tồn tại (source-acq `:165`; source-ingestion `:108`); message không chứa URL/body (spot-check các call site :335/:390/:242) | ✓ (không exhaustive) |
| Byte/time/idle caps + partial cleanup | **không re-derive từng dòng** (ngoài trọng tâm; không thấy mâu thuẫn) | ~n/v |
| Δ1: `IngestionTransferPolicy.fetcher` cho phép override | `ingestion-consumer.ts:64-72` — `fetcher?: SdkFetcher` với comment "Tests inject… production omits it" | ✓ |

### 3. Wrong tenant/key/tag — SUPPORTED

| Claim | Kiểm chứng | Verdict |
|---|---|---|
| Tenant đọc lại từ DB (`OPERATION_LOAD_SQL` :210), không tin payload | `:210-214` JOIN `operations`; `:549` query | ✓ |
| `taskId` phải khớp `task_key='root'` | `:574-576` — mismatch → escalate permanent | ✓ |
| `sourceUrl` phải khớp envelope | `:633-635` | ✓ |
| `openDispatchSourceUrl` + `KEY_PROVIDER_FAILED` retryable / crypto-failure khác escalate trước network | `:282`; sourceUrl branch `:590-596`; envelope branch `:610-625` (retryable `:619-622`, escalate `:623`) — receipt ghi ":607-614 / :620-631": **lệch ~10-15 dòng** ở nhánh sourceUrl nhưng đúng bản chất 2 nhánh | ✓ (drift) |
| Chiều credential còn thiếu (do gap §1.2) | ✓ nhất quán | ✓ |

### 4. Extension map — SUPPORTED (5/5 dòng)

| Đường | Kiểm chứng | Verdict |
|---|---|---|
| upload-init KHÔNG enforce — cố ý | `submission.ts:750-761` comment "deliberately NOT one of them… guessing would 422" | ✓ |
| sourceUrl (top-level) | gọi `:365-367` trong tx (comment :363 "zero rows behind"); nhánh `:781-795` | ✓ |
| artifacts | `:797-805` | ✓ |
| file_urls | `:807-820` (dùng `fileUrlEntryName` `policy.ts:307`) | ✓ |
| Test Endpoint không extension-check/không decrypt | `public.ts:196-206` — route gọi `ctx.connectors.testConnector(id)`; comment "No caller headers are forwarded and no upstream error text echoed"; không có nhánh fileUrlAuth/extension | ✓ |
| Helpers chuẩn hoá + CSV string | `policy.ts:242` (normalizedAllowedFileExtensions), `:286` (extensionDeniedReason), `:39-40` (CSV as stored) | ✓ |

### 5. Release list — SUPPORTED (existence + serialization)

| Mục | Kiểm chứng | Verdict |
|---|---|---|
| Nhóm A: policy.ts / submission.ts = W1-held, cần release + serialize | hai file thuộc hot-set W1 (topology/W1 spec); receipt ghi đúng điều kiện | ✓ |
| ingestion-consumer.ts = W1c named (trong spec W1c) | file tồn tại; refresh §2 P730-ACQUIRE cũng tên file này | ✓ |
| **LEAF MỚI** `source-credential.ts` **chưa tồn tại** | glob `modules/operations/source-credential*` = 0 | ✓ |
| source-acquisition.ts + index.ts = shared SDK, 1 lease riêng, serialize W1b | file tồn tại; exports `index.ts:132-143` (receipt ghi ":138-143" — block bắt đầu :132, lệch start); **không có writer nào ghi worker-sdk/src trong cửa sổ** (mtime scan 18:30+ = rỗng) | ✓ (drift) |
| Tests owner tồn tại | `packages/worker-sdk/tests/source-acquisition.test.ts` + `source-ingestion.test.ts` — cả hai có | ✓ |
| file-url-auth.ts / contracts / server/main / dispatcher = không đụng | đúng hướng dẫn audit; file-url-auth.ts dùng nguyên as-is (đã verify §1.1) | ✓ |
| Không 2-writer trong danh sách | không file nào xuất hiện ở 2 nhóm; điều kiện (1)(2)(3) ghi rõ | ✓ |

---

## 6–7. Δ + lease/boundary

**Δ list (5):** Δ1 low ✓ (evidence `ingestion-consumer.ts:71`); **Δ2 high ✓ well-formed** — legacy thật sự cho `type:'query'`: `lib/file-url-downloader.ts:90-98` `applyQueryAuth` set `query_key/query_value` vào URL; contract giữ `query_*` (`profile-policy.ts:185-186`); hiện chưa consumer nào inject ⇒ **khớp adjudication của coordinator ("CẤM raw secret trong URL query — deny/redact có chủ đích")**: đây đúng là điểm Δ2 đặt ra, phương án (i) chính là ban; Δ3 medium ✓ (route evidence §4); Δ4 medium ✓ (grep `Content-Disposition` trong worker-sdk = 0; orch/src chỉ comment + `compat/legacy-multipart.ts` — không có download leg `file_urls`); Δ5 info ✓ (`profiles.ts:242` mỗi resolve). **Không Δ nào cần adjudicate thêm ngoài các quyết định đã ghi.**

**Lease/boundary (scan độc lập):**
- Mtime scan `services/orchestrator/src` + `packages/worker-sdk/src` + `packages/egress/src`, cửa sổ **19:20–19:55**: **duy nhất 1 file** đổi — `modules/profiles/profiles.ts` @ **19:29:44**; các file receipt tuyên bố không đụng (file-url-auth.ts 15:27, policy.ts 16:31, worker-sdk/src rỗng) **không đổi** ✓.
- HEAD vẫn `b088eec` (2026-10-02) — **không commit** trong phiên ✓. Checkbox/plan không thuộc lane này.
- **Attribution của profiles.ts@19:29:44 (F4 — không kết luận thay coordinator):** bằng chứng nghiêng về **qwen_1 (DD-05 late work)**, không phải qwen_4: (a) coordinator fresh-read 19:30 ghi "qwen_1 **ACTIVE — DD-05 verification run 3/3**", trong khi qwen_4 "**BLOCKED-CHỜ-COORDINATOR** — hỏi về SDK signature" (`reviews/2026-10-04-1935-coordinator.md:9,12`); (b) `tests/p730-prof03-invariant1.test.ts` (19:29:02) là test DD-05/same-tx pin, import `createRevision` từ `profiles.ts` và gọi `createRevision(binding(), client)`; (c) `profiles.ts` hiện có `import { pinActiveRevision }` (:27) + call same-tx (:397-398, comment "T-DB-02 invariant #1 — SAME transaction") + param `activeClient` (:327-329) — đúng surface test đó chạy; (d) `qwen1.md` mtime **19:18:48** < 2 vết ghi ⇒ receipt qwen_1 **chưa document** test/edits này (coverage gap cho coordinator reconcile; ngoài scope lane qwen_4).
- Hệ quả cho audit này: **không có bằng chứng chống read-only claim của qwen_4** (không file acquisition nào bị ghi; artifact duy nhất của qwen_4 = receipt @19:51:08); đồng thời xác nhận `profiles.ts` đang **HOT** ⇒ điều kiện release §5 càng đúng: W1c chỉ READ + leaf mới, không ghi profiles.ts.

---

## 8. Findings (minor) + đề xuất

| # | Finding | Severity | Đề xuất |
|---|---|---|---|
| F1 | Receipt tự khai "các đo lường grep/powershell trong receipt có literal Exit Code: 0" nhưng **không có block literal nào** trong file (chỉ 1 câu văn) | Minor (lane-rule format) | Nếu coordinator cần literal, yêu cầu qwen_4 append nguyên văn command+output vào receipt; không tự sửa |
| F2 | RESUME POINT ghi "Receipt duyệt ghi lúc **19:31**" vs mtime thực **19:51:08** | Minor | Coordinator hỏi qwen_4 lần ghi 19:51 (rewrite/append gì) để timeline chính xác |
| F3 | Line-drift nhỏ: options interface ":66-106"→":84-108"; index exports ":138-143"→block ":132-143"; crypto escalation ":607-614/:620-631"→nhánh ":590-596/:610-625"; file-url-auth ":103-107"→catch ":107-110"; userinfo ":146"→":147" | Info | Không cần fix (bản chất đúng); nếu muốn chuẩn, ghi correction khi append |
| F4 | `profiles.ts` ghi @19:29:44 trong cửa sổ chồng lấn; nghiêng qwen_1 DD-05; `qwen1.md` (19:18:48) chưa phủ | Observation điều phối | Coordinator reconcile: kiểm terminal qwen_1 + yêu cầu append receipt DD-05 (test + edit) và xác nhận lease của edit này |

## 9. Limitations (không kiểm được)

1. Không re-run test/build (read-only); các số "3/3 run" là claim của receipt, không re-derive.
2. Không re-derive từng dòng: byte/time/idle cap internals, `DestinationDeniedError` message/reason enum, 3 dòng Authorization service-token trong worker-sdk.
3. Attribution mtime có giới hạn khi 2 lane hoạt động chồng lấn (19:29); kết luận F4 dựa trên **tổ hợp** log coordinator + nội dung test/code, không phải suy từ mtime đơn thuần.
4. Line-ref theo snapshot ~20:10–20:3x; cây đang được nhiều lane sửa — re-anchor nếu đọc muộn.

## Ledger

1 — Đọc receipt đích + spec; 2 — verify §1.1/§1.2/§2/§3/§4/§5 bằng đọc trực tiếp + grep phủ định (danh sách file:line trong §1); 3 — Δ adjudication check (legacy applyQueryAuth, contract query_*); 4 — lease scan mtime 3 src dirs + HEAD + attribution F4; 5 — findings + limitations.

**Boundary:** chỉ receipt này được ghi; không tick; không commit/push; không sửa source/test/plan; không chạm `nocobase-10`.
