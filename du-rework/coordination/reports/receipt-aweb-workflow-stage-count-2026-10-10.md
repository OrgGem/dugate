# Receipt — AWEB-WORKFLOW-STAGE-COUNT-HONESTY (2026-10-10)

> **RESUME POINT — IMPLEMENTED + verification chạy sạch, CHƯA ACCEPTED.** Sửa fallback `: 1` ở cột số stage trong danh sách workflow → hiển thị **0 stages** khi wire không trả stage. Chỉ 1 dòng sinh JSX đổi + 4 dòng comment, đúng file lease. Typecheck exit 0; full suite 48 test / 0 fail / exit 0; bảng chân trị chứng minh chỉ 2 trường hợp đổi hành vi.

- **Lease (1 file duy nhất):** `du-rework/orchestrator/apps/admin-web/src/features/workflows/workflows-screen.tsx`
- **Không** git add / commit / push. Không sửa backend, contracts, test, docs.
- **Zero double quotes** trong receipt này (bound của packet): dùng single quote và backtick.

## 1. Vấn đề (kế thừa bullet 3 của packet trước)

Cũ (`workflows-screen.tsx:755`, trước sửa):

```
{wf.nodesCount ?? (wf.stages ? wf.stages.length : 1)} stages
```

| Trường hợp | Hành vi cũ | Có trung thực? |
|---|---|---|
| `nodesCount` có số (kể cả 0) | dùng nó | đúng |
| không có `nodesCount`, `stages` là mảng | `stages.length` (mảng rỗng → 0) | đúng |
| **không có `nodesCount` và `stages` vắng mặt/null** | **bịa ra 1** | **SAI** — một workflow chưa khai stage nào lại hiện *1 stages*, đúng loại giả mạo mà packet sim-honesty vừa diệt ở luồng simulation |

Đây là chỗ duy nhất còn bịa số ở màn: quét `?? 1`, `: 1}`, `length : 1`, `count ?? 1` trên toàn file cho **0 hit** sau sửa (trước sửa có đúng 1 hit là dòng trên). Hai chỗ hiển thị stage còn lại đều trung thực sẵn: timeline chi tiết có câu *Không tìm thấy cấu hình node trong schema.* (`:909-911`), và panel simulation đã có câu trung thực từ packet trước (`:1180+`).

## 2. Sửa — tối thiểu, không đổi hành vi ở nơi khác

```
{wf.nodesCount ?? wf.stages?.length ?? 0} stages
```

Kèm 4 dòng comment tại `:755-758` ghi rõ chủ ý (không bịa số, `0` không bị `??` nuốt) để không ai vô tình thêm lại fallback. Từ vựng giữ nguyên: *0 stages* theo đúng yêu cầu.

### Bảng chân trị — bằng chứng phạm vi hẹp (chạy `node -e`, không sửa source)

```
nodesCount=3        stages=[a,b]  old=3 new=3
nodesCount=0        stages=[a]    old=0 new=0
nodesCount=undef    stages=[a,b]  old=2 new=2
nodesCount=undef    stages=[]     old=0 new=0
nodesCount=undef    stages=null   old=1 new=0
nodesCount=undef    stages=undef  old=1 new=0
```

Đúng 2 dòng cuối đổi — tức **chỉ** trường hợp stage-list vắng mặt đổi sang 0; mọi trường hợp khác giữ nguyên giá trị. Lý do `nodesCount = 0` không bị mất: `??` chỉ rơi khi null/undefined, nên 0 là giá trị thật và được giữ nguyên.

## 3. Verification (cwd `orchestrator/apps/admin-web`, Node v24.21.0)

```
node <tsc 5.9.3> --noEmit -p tsconfig.json
REAL_EXIT: 0        (output rỗng, 0 diagnostic)

node --test tests/audit-state.test.mjs tests/operations-state.test.mjs tests/profiles-row-key.test.mjs tests/profiles-state.test.mjs tests/trace-state.test.mjs
ℹ tests 48   ℹ suites 9   ℹ pass 48   ℹ fail 0
REAL_EXIT: 0
```

Giới hạn ý nghĩa của 48/48 (giữ nguyên cảnh báo của receipt trước): toàn suite là test lớp **state**, **không test nào render màn Workflows** ⇒ đây là cổng hồi quy, không phải bằng chứng hành vi hiển thị. Cần kiểm bằng trình duyệt (một workflow không có stage phải hiện *0 stages*, không còn *1 stages*) — tôi không chạy Playwright.

## 4. Phân định thay đổi + cảnh báo đồng thời

| Mục | Delta của TÔI (task này) |
|---|---|
| `workflows-screen.tsx` | đổi **1 dòng sinh JSX** (`:759`) + thêm 4 dòng comment (`:755-758`) |

**Cảnh báo đồng thời (đo được, không phỏng đoán):** `git diff --numstat` của file này so với HEAD đã là `+268/-108`, trong khi ở receipt trước (cùng phiên, vài chục phút trước) là `+179/-23` — tức **một lane khác đã sửa file này giữa hai task**. Hệ quả:

- con số numstat **không phải** của tôi và không nên dùng để đánh giá thay đổi này;
- tôi đã kiểm lại sau cùng: hai thay đổi của tôi vẫn còn nguyên — cột stage tại `:755-759` và câu trung thực simulation tại `:1180` — nên việc verify (`tsc` + 48 test) là trên trạng thái cây **đúng tại thời điểm đọc**;
- ai đọc lại receipt này sau cần đối chiếu lại `file:line`, vì cây đang thay đổi giữa chừng.

## 5. Bằng chứng định danh

| File | SHA-256 (sau thay đổi) |
|---|---|
| `src/features/workflows/workflows-screen.tsx` | `7797884b04e28f3c08c315004cf2372974ca400808369efeda5cb17ad3f991dc` |

## 6. Ranh giới + còn mở

- Chỉ file lease được sửa; không file test/docs/backend/contracts bị chạm.
- Không git add / commit / push; không tick gate; không viết VERIFIED/ACCEPTED — coordinator/Reviewer chốt.
- Offline: typecheck + node test runner, không trình duyệt, không API.
- **Đề xuất theo dõi (ngoài lease):** *1 stages* (số ít mà chữ số nhiều) vẫn hiển thị khi `nodesCount = 1` hoặc `stages.length = 1` — thuộc lớp trình bày, không phải trung thực; nếu muốn thì cần packet sửa số ít/số nhiều.
- File duy nhất tôi ghi ngoài thay đổi trên: receipt này.