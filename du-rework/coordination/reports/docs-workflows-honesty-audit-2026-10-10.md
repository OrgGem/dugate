# Docs — Workflows honesty audit: 4 điểm đối chiếu trung thực (2026-10-10)

| Mục | Giá trị |
|---|---|
| Ngày | 2026-10-10 (Asia/Bangkok) |
| Scope | màn `apps/admin-web/src/features/workflows/workflows-screen.tsx` (1217 dòng tại thời điểm đọc) |
| Lease | chỉ file này + receipt của nó |
| Mục tiêu | tổng kết toàn bộ điểm trung thực đã sửa trên màn Workflows, và đối chiếu với khảo sát `survey-workflows-connectors-2026-10-10.md` §2 |
| Ràng buộc | KHÔNG git add/commit/push. Document không chứa dấu nháy kép nào |

## 0. Nguyên tắc: tự đọc lại, không kế thừa

Cây đang thay đổi giữa chừng (ba lần tôi đo thấy số dòng khác nhau trong cùng phiên: khảo sát ghi 1191, các receipt của tôi thấy 1213 → 1217). Vì vậy **từng dòng dưới đây được đọc lại từ source ngày 2026-10-10**, không sao chép từ khảo sát. Số dòng ở khảo sát và ở hai receipt của tôi đã lệch (ví dụ nhánh simulation từ `:425` → `:429`, `openTestModal` từ `:413` → `:411`); bảng dùng số **đọc hôm nay**.

## 1. Bốn điểm — tồn tại gì, sửa thế nào, bằng chứng

### 1.1 AWEB-17 — simulation honesty

**Lỗi cũ:** một id giả `sim-op-*` được báo thành công, và nhánh backend có thể khoe thành công giả; khảo sát §2.1 đã xác nhận hết.

| Hành vi | Vị trí hiện tại |
|---|---|
| Modal mở ra mặc định là backend thật: `setTestSource('backend')` | `:411` |
| Nhánh simulation chỉ chạy khi người dùng **chọn** `testSource === 'simulation'` | `:429` |
| Nó tự nhận mình là mô phỏng: `SIMULATED_SUCCESS` + message *was simulated locally; no backend request was sent* | `:431`, `:433` |
| Nhánh backend trả `ACCEPTED`, chỉ spread `operationId`/`stagesCompleted` khi có thật trong response | `:449-459` |
| Lỗi backend → `FAILED` kèm mã thật từ server | `:464`, `:476` |
| Id giả `sim-op-*` đã biến mất khỏi toàn bộ `features/` (khảo sát §2.1: grep 0 hit) | — |

**Đối chiếu:** khớp từng điểm với §2.1 của khảo sát. **Bằng chứng:** `receipt-aweb-17-2026-10-10.md` + kiểm chứng độc lập `verify-aweb-17-18-INDEPENDENT-DSH-2026-10-10.md`. **Trạng thái: đã sửa trước các packet của tôi; tôi chỉ xác nhận lại trên cây hiện tại.**

### 1.2 Cột số stage: fallback `?? 1` → `?? 0`

**Lỗi cũ:** `{wf.nodesCount ?? (wf.stages ? wf.stages.length : 1)} stages` — khi cả `nodesCount` và `stages` đều vắng mặt thì **bịa ra 1**, nên một workflow chưa khai stage nào vẫn hiện *1 stages*.

- **Sửa tại `:755-759`:** comment chủ ý + `{wf.nodesCount ?? wf.stages?.length ?? 0} stages`.
- **Đúng kiểu sửa được yêu cầu: 0 stages khi không có stage.** `nodesCount = 0` không bị mất vì `??` chỉ rơi khi null/undefined; `stages` rỗng vẫn là 0 như trước.
- **Bằng chứng phạm vi hẹp** (bảng chân trị, chạy `node -e`, không sửa source): 6 trường hợp, đúng 2 dòng đổi (`stages=null` và `stages=undefined`: old 1 → new 0); 4 trường hợp còn lại giữ nguyên giá trị (3→3, 0→0, 2→2, 0→0).
- **Bằng chứng giao:** `tsc --noEmit` exit 0; full suite admin-web 48 test / 0 fail / exit 0.
- **Receipt:** `receipt-aweb-workflow-stage-count-2026-10-10.md`.
- **Đối chiếu khảo sát:** mục này **không có** trong §6 của khảo sát — nó ra đời từ bullet 3 trong receipt sim-honesty của tôi (do khảo sát chỉ điểm `simulatedStages ?? []`, không điểm cột danh sách). ⇒ **đóng bổ sung, không trùng**.

### 1.3 Simulation với stage rỗng — nói rõ, không để danh sách trống

**Lỗi cũ:** `simulatedStages: selectedWorkflow.stages ?? []` (`:435`) và panel kết quả chỉ đổ JSON thô → `[]` hiện ra không lời giải thích, một lượt mô phỏng **trông như thành công** dù không stage nào tồn tại. Đây chính là **W-D** của khảo sát (§6) và *diem nho can xet* ở §2.2.

Sửa tại `:1180-1201`, ba nhánh:

1. simulation **có** stage → in số + tên stage (`:1183-1186`);
2. simulation **rỗng/vắng** → *No stages defined for this workflow* + nghĩa: không stage nào chạy, rỗng là **lỗ cấu hình chứ không phải lượt đạt** (`:1189-1192`);
3. backend **không trả `stagesCompleted`** (hoặc mảng rỗng) → *No stage list returned for this run* (`:1196-1200`).

**Receipt:** `receipt-aweb-workflow-sim-honesty-2026-10-10.md`. **Đối chiếu:** §2.2 của khảo sát **đã đóng theo hướng tốt hơn đề xuất** (khảo sát chỉ nói *hiển thị rỗng*, ở đây còn phân biệt *không có stage* với *backend không trả stage*).

### 1.4 provisionWorkflow action honesty

Handler `handleProvisionPreset` (`:313-340`) — trung thực ở bốn chỗ, đều đọc lại hôm nay:

- **Từ chối sớm với lý do thật, không giả vờ:** thiếu tenant → *Select an Organization / Tenant before activating a workflow*; đã chọn business mà chưa chọn version → thông báo chọn hoặc bỏ gán (`:315-321`). Không gọi API khi thiếu điều kiện;
- **Thành công chỉ khi server xác nhận:** `if (res.ok)` rồi mới hiện *Provisioned the sample workflow ...* (`:331-332`);
- **Lỗi là lỗi của server, không tự bịa:** `res.problem?.title || res.problem?.code` kèm chuỗi dự phòng (`:335`);
- **Danh sách được nạp lại từ server** (`:333`) ⇒ UI không bao giờ tự sinh hàng mình chưa có; hai nơi gọi (`:326` cài preset, `:715` nút ở trạng thái rỗng) dùng chung một handler nên không có đường tắt nào lệch hành vi.

Khảo sát §2.2 ghi nhận `PRESET_SAMPLES` là **danh mục mẫu để cài đặt, không phải dữ liệu giả dâng lên trang** — tôi xác nhận lại: chúng chỉ được gửi đi khi người dùng bấm *Provision*, và không có hàng nào được báo thành công khi server từ chối.

### 1.5 JSON schema honesty (nhập schema thủ công)

Handler `handleImportSubmit` (`:344-379`) + modal (`:1026-1046`):

- **JSON hỏng → nói thẳng và dừng trước khi gửi mạng:** *The content is not valid JSON. Check the syntax and try again.* (`:352-359`, trong đó `:358` là thông báo); không có lời gọi API nào xảy ra;
- **Server từ chối → hiện đúng lý do server:** `problem.title || problem.code` với chuỗi dự phòng *The workflow schema failed validation.* (`:374`);
- **Thành công → đóng modal, xoá nội dung dán, nạp lại danh sách** (`:369-373`) — trạng thái cuối cùng luôn là dữ liệu server trả về;
- **Không có digest/id nào được tự sinh;** placeholder *Paste the JSON schema here...* (`:1046`) là gợi ý dán, không phải schema có sẵn.

## 2. Đối chiếu với khảo sát §2 — bảng tổng hợp

| Mục tiêu khảo sát | Trạng thái hôm nay | Bằng chứng |
|---|---|---|
| §2.1 AWEB-17 simulation honesty | **XÁC NHẬN lại** trên cây hiện tại | `receipt-aweb-17-2026-10-10.md`, `verify-aweb-17-18-INDEPENDENT-DSH-2026-10-10.md`, và mục 1.1 |
| §2.2 *simulatedStages rỗng* (= đề xuất **W-D**) | **ĐÃ ĐÓNG**, chi tiết hơn đề xuất | mục 1.3, `receipt-aweb-workflow-sim-honesty-2026-10-10.md` |
| Cột *1 stages* bịa số (ngoài lưới khảo sát) | **ĐÃ ĐÓNG** | mục 1.2, `receipt-aweb-workflow-stage-count-2026-10-10.md` |
| §2.3 **W-E** thay ngôn ngữ Việt/Anh | **CHƯA ĐỤNG** — ngoài 4 mục của packet này | khảo sát §2.3 vẫn đúng |
| **W-A** AWEB-16b Overview metrics | **CHƯA ĐỤNG** | ngoài phạm vi |
| **W-B** AWEB-21 đọc URL query | **CHƯA ĐỤNG** | ngoài phạm vi |
| **W-C** link Audit đối xứng với Trace | **CHƯA ĐỤNG** | ngoài phạm vi |

## 3. Giới hạn của báo cáo này (đừng đọc thành nghiệm thu)

- **Chưa kiểm bằng trình duyệt.** Không tôi, không packet nào chạy Playwright; mọi khẳng định ở trên là đọc code + chạy test/typecheck.
- **Suite 48 test của admin-web không render màn Workflows** — chúng là test lớp state. Chứng minh 48/48 **không** chứng minh giao diện mới hiển thị đúng; nó chỉ chứng minh không hỏng gì.
- **Dòng đang di chuyển.** Ba lần đo trong cùng phiên cho kết quả khác nhau (1191 / 1213 / 1217); các dòng trong bảng là của thời điểm đọc hôm nay và sẽ lệch nếu lane khác sửa tiếp. Đây là lý do mọi dòng trong báo cáo đều kèm mô tả, không chỉ số dòng.
- **Chưa có test khoá hành vi** cho bốn điểm này (lease chỉ cho một file màn hình), nên điểm yếu thật sự nằm ở chỗ: nếu ai đổi logic mà không đụng test, chỉ typecheck sẽ không bắt được.

## 4. Ranh giới

- Tài liệu này chỉ đọc + ghi báo cáo. **0 sửa code sản phẩm**, 0 git add/commit/push.
- Không tick gate, không viết VERIFIED/ACCEPTED cho bất kỳ AWEB nào ở trên — việc chốt thuộc coordinator/Reviewer.
- Tài liệu không chứa dấu nháy kép (đã đo bằng kiểm ký tự, xem receipt).