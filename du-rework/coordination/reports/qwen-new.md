# qwen-new — lane docs/evidence (kế thừa Codex-4) — receipt log

- **Identity**: Qwen lane `docs/evidence`, số hiệu **Codex-4** (lane trước chết theo Δ A8 của coordinator).
- **Vai trò**: chỉ cập nhật hồ sơ evidence trong `du-rework/docs` từ receipt của owner/Tester. Không code, không chạy test, không mở DB/Redis/S3 window, không adjudicate, không tick task row, không commit/push.
- **Điều phối viên**: Qwen `term_5a11bb91-9cae-4588-a46c-0718b48bb39b` (lịch `DUGate-Qwen-Coordinator`).
- **Repo state khi làm việc**: branch `codex/fix-workflow-builder`, HEAD `7811298`, mọi thứ ở working tree (KHÔNG commit). `docs/28-test-inventory.md` và `docs/35-acceptance-baseline.md` là file **untracked** (`git status --porcelain` → `??`), nên bằng chứng patch là nội dung file, không phải `git diff`.

> [!IMPORTANT]
> **RESUME POINT — 2026-09-25 khoảng 23:2x +07 (packet D-EVID-A6, cycle đầu của lane này).**
> Đọc hết khối này là đủ để tiếp tục, khỏi đọc lại transcript.
> 1. **D-EVID-A6 ĐÃ LAND** vào working tree: `docs/28-test-inventory.md` §8.16 và `docs/35-acceptance-baseline.md` §12.19 đổi header thành `D-EVID-A5 → A6` và append các row A6 (T-WINDOW-4 superseded, T-DATA-LIVE-3R, T-OIDC02-LIVE-1R, T-ANTIG-1/1B, T-DATA-LIVE-4, W-VAULT04-FIX1). Row A5 giữ nguyên như lịch sử; chỉ thêm cụm trỏ tới row mới ở những câu đã bị bằng chứng mới vượt qua.
> 2. **Anchor đã kiểm**: §8.16 vẫn ở dòng **517**, §12.19 vẫn ở dòng **674** sau patch, nên `[...](../../docs/28-test-inventory.md#L517)` và `#L674` trong `codex4.md` vẫn đúng. Toàn bộ phần chèn dòng nằm SAU hai dòng đó.
> 3. **Phát hiện quan trọng nhất của lane (không phải chép số)**: suite live `tests/data-02-04-live-s3.test.ts` **không có lệnh gọi `/api/v1/uploads` nào** (grep `api/v1` cho 3 hit, cả 3 đều là `/api/v1/businesses/.../actions/extract`). Vậy T-DATA-LIVE-4 xanh 5/5 là bằng chứng live cho **nhánh runtime/lease**, KHÔNG đóng gate live của nhánh public. Cả hai docs đều ghi rõ scope limit này.
> 4. **Δ4 đóng**: migration `0016_public_upload_token_index.sql` đã apply, và `migrate:status` / `migrate` / `migrate:verify` **mỗi lệnh** literal ExitCode 0 (tester.md#L7249). Row cũ của Qwen-5R từng ghi `0016 is unapplied` đã sửa thành lịch sử có trỏ row mới.
> 5. **Ledger divergence 102 vs 104**: ghi đúng là divergence, **KHÔNG quy chủ**. 102 = snapshot implementer 20:59; 104 = đo trên cây hiện tại (Antigravity, exit 0 ×3). Lane đã tự đọc lại mtime file test = 21:45 PM và xác nhận 2 test có thật ở cuối `multipart-service-offline.test.ts`.
> 6. **Việc còn mở**: receipt W-VAULT04-FIX1 (Codex-6) chưa về — docs chỉ ghi 'in flight, no receipt'. Receipt `T-ANTIG-2` đã xuất hiện ở `tester-antigravity.md` dòng 133 nhưng **ngoài phạm vi A6** nên lane không tự chép vào docs; cần packet riêng.
> 7. **Không làm**: không tick `[x]`, không nâng mức ACCEPTED, không sửa report của Reviewer/Tester, không sửa source/test.

## Ledger của lane

- 1 — D-EVID-A6: đồng bộ §8.16 + §12.19 với receipt T-WINDOW-4/5, T-DATA-LIVE-3R, T-OIDC02-LIVE-1R, T-ANTIG-1/1B, T-DATA-LIVE-4, W-VAULT04-FIX1 — Mục 1.

---

## 1 — CYCLE 1: D-EVID-A6 (docs-only ledger sync cho các receipt A5→A8)

- **Packet**: `D-EVID-A6` — chỉ sửa hai mục evidence `docs/28-test-inventory.md` §8.16 và `docs/35-acceptance-baseline.md` §12.19 để đồng bộ ledger; tạo báo cáo này; trả lời `D-EVID-A6 DONE`.
- **Nguồn đã đọc để chép số**: `tester.md` (cuối file: T-WINDOW-4, T-WINDOW-5), `tester-antigravity.md` (T-ANTIG-1, T-ANTIG-1B, T-DATA-LIVE-4), `codex4.md` (receipt v1.17.0 để lấy tên day đủ), `qwen5r.md` (W49-Q5R-1), `coordinator-qwen.md` (Δ A6/A7/A8), `du-rework/AGENTS.md`.
- **Thời điểm**: 2026-09-25, phiên lane docs/evidence kế thừa Codex-4.

### Ledger đã đồng bộ (6 mục của packet)

| # | Mục | Nội dung đã ghi vào §8.16 / §12.19 | Nguồn receipt |
|---|---|---|---|
| 1 | T-WINDOW-4 RED | Ghi là **harness red do thiếu `DATABASE_URL`**: wrapper chết trước khi kịp ghi ExitCode, OIDC02 NOT RUN theo stop rule, **đã được T-WINDOW-5 thay thế**, không dùng làm bằng chứng cho 0016 hay OIDC-02 | `tester.md#L7197`, `#L7226` |
| 2 | T-DATA-LIVE-3R | `migrate:status` + `migrate` + `migrate:verify` **mỗi lệnh literal ExitCode 0** (0016 apply đúng một lần, schema verify pass); live suite **literal ExitCode 1, 2 passed / 3 failed / 0 skipped trên 5**; CLAIM 22:45:33.970 → RELEASE 22:49:38.285; ghi **Δ4 đóng**, bản thân suite vẫn not verified | `tester.md#L7234`, `#L7249` |
| 3 | T-OIDC02-LIVE-1R XANH | **13/13 exit 0** trên Redis live, gồm case **KILL+RESPAWN**; CLAIM 22:51:01.986 → RELEASE 22:52:11.299; OIDC-02 = VERIFIED ở phạm vi suite, **không** ACCEPTED (còn IdP ngoài, browser, G-SEC deployment) | `tester.md#L7264` |
| 4 | T-ANTIG-1 + 1B | Offline **4 suites / 104 passed, exit 0 ×3** (52/30/16/6); **LỆCH +2** so với 102 của Qwen-5R (W49-Q5R-1) → ghi là **ledger divergence**; 2 test trong `multipart-service-offline.test.ts` có mtime 21:45:59 **chưa có receipt implementer**, **KHÔNG quy chủ sở hữu**; hai số không cộng gộp | `tester-antigravity.md#L32`, `#L65` |
| 5 | T-DATA-LIVE-4 XANH | **5/5 exit 0 ×2** (35.782 s / 35.809 s), CLAIM 23:05:00.000 → RELEASE 23:06:15.000; root cause của màu đỏ trước là **AWS credential không khớp MinIO pilot** (Tester đọc credential bằng `docker inspect minio`); kèm **scope limit**: suite không gọi `/api/v1/uploads` | `tester-antigravity.md#L98` |
| 6 | W-VAULT04-FIX1 | Ghi **đang chạy, chưa receipt** (`codex6.md` mtime 14:32); red `TS2345` mock-Vault vẫn mở | `codex6.md` |

### Câu chữ đã sửa trong row cũ (giữ lịch sử, không xoá)

- `docs/28` row Qwen-3 W49-Q3-25 (skip-mode): thêm 'the live run landed later in this section (T-OIDC02-LIVE-1R, D-EVID-A6)'.
- `docs/28` row Qwen-5R W-DATA02-PUB-1: nhãn `102` gắn snapshot 20:59 + trỏ divergence 104; `Δ1–Δ4` → `Δ1–Δ3`; `0016 is unapplied` → đã đóng ở T-WINDOW-5; thêm 'the live suite that went green (T-DATA-LIVE-4) drives the runtime branch only'.
- `docs/35` row MinIO pilot: thêm 'Superseded as to migration state and suite outcome by the T-DATA-LIVE-3R and T-DATA-LIVE-4 rows below'.
- `docs/35` row Qwen-3 skip-mode và row Qwen-5R: cùng loại trỏ neo như trên.
- `docs/35` row Acceptance boundary: viết lại danh sách gate — đã đóng (0016 apply+verify, live OIDC-02 revoke/restart) so với còn mở (Δ1–Δ3, live public `/api/v1/uploads`, deployed sweeper cadence, credential sourcing cho pilot, `TS2345`, 2 test chưa receipt).
- Đoạn kết mỗi file: nêu rõ bản vá không chạy test, không mở DB/Redis/S3, không apply migration, không sửa source/test.

### Bằng chứng lệnh đã chạy (instrument + ExitCode nguyên văn)

Tất cả là lệnh đọc; không lệnh nào là test.

| # | cwd | Lệnh | Kết quả đo được | Exit Code nguyên văn |
|---|---|---|---|---|
| V1 | `D:\Git\dugate` | `git -C D:/Git/dugate status --porcelain du-rework/services/orchestrator/tests du-rework/docs` | `docs/28-test-inventory.md` và `docs/35-acceptance-baseline.md` ở trạng thái `??` (untracked) → patch không có `git diff` làm bằng chứng; `tests/runtime.test.ts` là ` M` của lane khác, lane không đụng | `Exit Code: 0` |
| V2 | `D:\Git\dugate` | `find /c /v "" D:\Git\dugate\du-rework\coordination\reports\tester.md` | `7273` dòng → mọi anchor `#L71xx`/`#L72xx` đang dùng đều trong phạm vi | `Exit Code: 0` |
| V3 | `D:\Git\dugate` | `dir /-C /T:W du-rework\services\orchestrator\tests\multipart-*.test.ts` (+ `s3-multipart-*.test.ts`, `data-02-04-live-s3.test.ts`, `oidc02-process-replicas-offline.test.ts`) | `multipart-service-offline.test.ts` = **09:45 PM (21:45)**; `multipart-routes-offline.test.ts` 20:54; `s3-multipart-storage-offline.test.ts` 20:55; `s3-multipart-upload.test.ts` 07:47; `data-02-04-live-s3.test.ts` 21:59; `oidc02-process-replicas-offline.test.ts` 20:25 → khớp mtime T-ANTIG-1B công bố | `Exit Code: 0` |
| V4 | `D:\Git\dugate` | `find /c /v "" du-rework\services\orchestrator\tests\multipart-service-offline.test.ts` | `705` (read_file báo 707 do cách đếm dòng cuối; lane ghi nhận lệch 2 dòng này, không ảnh hưởng 2 tên test đã xác minh) | `Exit Code: 0` |
| V5 | `D:\Git\dugate` | grep `api/v1` trong `tests/data-02-04-live-s3.test.ts` | 3 hit, tất cả là `/api/v1/businesses/...actions/extract` (dòng 129, 508, 514); **0 hit `/api/v1/uploads`** → cơ sở của scope limit ở mục 5 | `Exit Code: 0` |
| V6 | `D:\Git\dugate` | grep `test(`/`describe(` trong suite live | đúng 5 `test(` + 1 `liveDescribe(` → khớp con số 5/5 của T-DATA-LIVE-4 | `Exit Code: 0` |
| V7 | `D:\Git\dugate` | đọc `multipart-service-offline.test.ts` dòng 661–680 và 689–707 | hai describe/test mà T-ANTIG-1B định danh **có thật** trong cây hiện tại (lane không tin số liệu chép tay) | `Exit Code: 0` |
| L1 | `D:\Git\dugate` (cwd mặc định của wrapper — lệnh có `cwd: C:\Users\Gem` bị từ chối vì ngoài workspace) | `C:\Users\Gem\AppData\Local\Temp\qwennew-link-check.cmd` | `FILES=6 TARGETS=445 ANCHORS=232 BROKEN=0 EXTERNAL_SKIPPED=0`, marker `PSCAPE_EXIT=0` | `Exit Code: 0` (khớp marker) |
| L2 | `D:\Git\dugate` (cwd mặc định của wrapper) | rerun `C:\Users\Gem\AppData\Local\Temp\qwennew-link-check.cmd` sau khi chốt báo cáo | `FILES=6 TARGETS=445 ANCHORS=232 BROKEN=0 EXTERNAL_SKIPPED=0`, marker `PSCAPE_EXIT=0` — **giống hệt L1**, chứng tỏ phần chốt báo cáo không sinh link/anchor mới | `Exit Code: 0` (khớp marker) |

### Instrument caveat (để coordinator/Reviewer không đọc sai số của lane)

- Checker mà lane tự viết **chỉ** resolve target tương đối + `file:///` và **chỉ** validate anchor dạng số `#L<n>` (đếm dòng bằng `[IO.File]::ReadAllLines`). Anchor slug (`#heading`) và external URL bị bỏ qua, nên '0 broken' nghĩa là *không có target/line anchor sai*, không phải 'mọi anchor đều đúng mọi mặt'.
- Lần chạy đầu của checker **báo sai**: `Split-Path -LiteralPath ... -Parent` trả null nên mọi anchor bị tính là `BROKEN_ANCHOR ... (target_lines=0)`. Lane đã đổi sang `[IO.Path]::GetDirectoryName` + `GetFullPath`/`Combine` và chạy lại; chỉ số L1 là của bản đã sửa. Con số BROKEN của lần sai đầu **không** được dùng ở bất kỳ đâu.
- Một scan phụ (đếm backtick lẻ theo dòng để tìm code span hở) báo `ODD_TICKS` tại `docs/28` dòng 254–276 và `docs/35` dòng 381–415: đó là **false positive** của chính scan — các dòng ấy là fence ` ```powershell ` có sẵn từ trước, không thuộc vùng lane vá. Vùng patch (sau dòng 517/674) không bị báo.
- `BRACKET_CHECK docs/28:521 open=3 link=2` cũng là false positive: dòng đó chứa `[~]` trong code span, không phải link hở.
- phạm vi check: `docs/28`, `docs/35`, `tasks/P8-release-readiness.md`, `tasks/README.md`, `coordination/reports/codex4.md`, `coordination/reports/qwen-new.md` (6 file).
- Khi probe PowerShell trực tiếp qua wrapper, có một lần lệnh in lỗi `op_Subtraction` mà wrapper vẫn báo `Exit Code: 0`. Lane vì vậy không lấy ExitCode của lời gọi powershell trực tiếp, mà bọc trong tập lệnh `.cmd` có `exit /b %errorlevel%` để marker `PSCAPE_EXIT=` và `Exit Code:` của wrapper phải khớp nhau. Số ở L1/L2 đo theo cách đó.
- Không có raw log riêng cho V1–V7 (lệnh ngắn, output đã dán nguyên văn trong bảng). Checker giữ tại `C:\Users\Gem\AppData\Local\Temp\qwennew-link-check.ps1` và `.cmd` để tái lập.

### Dấu vết file sau bản vá (V8)

- cwd `D:\Git\dugate`, lệnh `for %f in (...) do @find /c /v "" %f` → `docs/28-test-inventory.md: 536`, `docs/35-acceptance-baseline.md: 694`, `Exit Code: 0`. Đầu đọc công cụ (`read_file`) báo 531 → 537 và 689 → 695; lệch 1 dòng với `find` là quy ước đếm dòng cuối, không phải nội dung mất.
- `dir /-C` lúc 23:2x: `28-test-inventory.md` 86577 B (mtime 23:20), `35-acceptance-baseline.md` 120661 B (mtime 23:19), `qwen-new.md` 13707 B. Con số 13707 B **đã lỗi thời ngay sau đó** vì báo cáo còn được vá thêm (mục Ledger + V8 + ghi chú chốt); đo lại lúc 23:30 được 15249 B (và câu đo này tự làm nó lớn hơn thêm một lần nữa — lane chấp nhận độ chính xác tới cấp 'file đã đổi', không thể tự tham chiếu chính xác tuyệt đối). Hai file docs không đổi sau mốc trên vì lane không sửa lại chúng từ đó.
- `git status --porcelain du-rework/docs du-rework/coordination/reports/qwen-new.md` → hai file docs ở `??` (untracked từ trước, lane vá tiếp trên working tree), `qwen-new.md` là `??` mới tinh. Các file ` M` còn lại (`01`, `03`, `04`, `07`, `09`, `11`, `12`, `13`, `15`) là thay đổi của lane khác có từ trước — lane **không** đụng tới.
- Chạy chốt lần 3 sau khi sửa dòng cuối của báo cáo (thêm mục Ledger): `FILES=6 TARGETS=445 ANCHORS=232 BROKEN=0 EXTERNAL_SKIPPED=0`, `PSCAPE_EXIT=0`, `Exit Code: 0` — **không đổi so với L1/L2**, nên mọi số trong receipt này ứng với trạng thái chốt của file. Không file nào được tạo trong `du-rework/` ngoài báo cáo này (checker nằm ở `C:\Users\Gem\AppData\Local\Temp\`).

### Trạng thái thật (4 mức, không tự nâng)

| Hạng mục | Mức sau bản vá này |
|---|---|
| Hồ sơ evidence `docs/28` §8.16, `docs/35` §12.19 | Đã cập nhật + đã tự kiểm link/anchor offline. Không phải bằng chứng test. |
| DATA-02 nhánh runtime (>64 MiB live) | Có bằng chứng live pilot xanh 5/5 ×2 của một Tester — **chưa ACCEPTED**; credential sourcing và deployed sweeper còn mở. |
| DATA-02 nhánh public | IMPLEMENTED + VERIFIED-OFFLINE (kèm ghi chú divergence 102/104). Live public **chưa có** vì suite live không chạm `/api/v1/uploads`. |
| Δ4 (migration 0016) | Đóng ở góc độ hồ sơ: apply + verify exit 0 (bằng chứng của Tester). |
| OIDC-02 | VERIFIED ở phạm vi suite Redis live; acceptance còn mở. |
| VAULT-04 drift `TS2345` | Vẫn ĐỎ, receipt chủ sở hữu chưa về. |

### Việc còn / next owner

1. **Codex-6**: nộp receipt `W-VAULT04-FIX1` → lane docs sẽ biến row 'in flight' thành bằng chứng thật khi có packet.
2. **Coordinator**: quyết định có giao lane docs phản ánh `T-ANTIG-2` (receipt BIND-1R độc lập, `tester-antigravity.md` dòng 133) hay không — ngoài phạm vi A6 nên lane không tự chép.
3. **Coordinator → Tester**: nếu muốn đóng gate live public, cần packet chạy đúng `/api/v1/uploads` với fixture >64 MiB (grant → part → complete → submit public); hồ sơ hiện tại ghi gate này còn mở.
4. **Reviewer**: divergence 102/104 và việc 2 test không có receipt implementer là chuyện adjudicate; lane chỉ ghi ledger, không kết luận chủ sở hữu.

> /compress
