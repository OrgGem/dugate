# Xoá UI không sử dụng (dead code) — 2026-10-09

**Yêu cầu:** xoá phần UI không dùng trên du-rework. **Không commit, không `git add`/`git rm`/push, không tick gate.**

## 1. Cách xác định "không sử dụng" (không đoán)

Viết import-graph quét **828 file** (`.ts/.tsx/.cjs/.js/.mjs/.cts`) của `src`, `tests`, `packages`, `apps`, `tests/browser`, `scripts`, `mock-service`, resolve cả alias `@/`, và tính inbound edges cho **56 module** trong `src/app/admin` + **154 file** trong `apps/admin-web/src`. Chỉ coi là dead khi **zero inbound** trong toàn bộ code (không tính chính nó).

Kết quả: 1 module zero-inbound trong `src/app/admin`, và 6 file zero-inbound trong SPA — trong đó `main.tsx` là Vite entry (phải giữ), nên SPA còn **3**, và 2 trong số đó liên động nhau.

## 2. ĐÃ XOÁ (4 file — tất cả tracked + clean, phục hồi được)

| File | Size | Bằng chứng |
|---|---|---|
| `orchestrator/apps/admin-web/src/components/ui/demo.tsx` | 18 759 B | zero inbound. `ComponentDemo` không được import ở đâu. README `ui/README.md:106` từng mô tả nó |
| `orchestrator/apps/admin-web/src/components/ui/fixtures.ts` | 2 316 B | inbound **duy nhất** là `demo.tsx:38`. Xoá `demo.tsx` ⇒ thành orphan, nên xoá kèm |
| `orchestrator/apps/admin-web/src/features/index.ts` | 354 B | barrel không ai import; `router.tsx` import trực tiếp từng screen |
| `orchestrator/services/orchestrator/src/app/admin/crypto-config-index.ts` | 1 155 B | barrel ENC-08 zero inbound; các consumer thật (`crypto-wiring.ts`, `shell-router.ts`, store) import module trực tiếp |

Cộng **22 584 B** dead code. **Không** dùng `git rm` (không stage) → trạng thái ` D`, phục hồi bằng:

```bash
git checkout -- orchestrator/apps/admin-web/src/components/ui/demo.tsx \
                orchestrator/apps/admin-web/src/components/ui/fixtures.ts \
                orchestrator/apps/admin-web/src/features/index.ts \
                orchestrator/services/orchestrator/src/app/admin/crypto-config-index.ts
```

## 3. SỬA ĐIỂM THEO (1 file)

`orchestrator/apps/admin-web/src/components/ui/README.md` mục 12: bỏ dòng *Fixtures & Demo … subpaths* và dòng *ComponentDemo*, và nói rõ demo/fixtures đã bị xoá làm dead code — nếu không sửa thì README mô tả file không tồn tại.

## 4. Verify

```text
pnpm --filter @du/admin-web typecheck              → Exit Code: 0
pnpm --filter @du/orchestrator typecheck           → Exit Code: 0
pnpm --filter @du/admin-web build                  → ✓ built in 8.75s (dist/ là gitignored, không đụng file tracked)

# 6 suite crypto-config + aweb08 (suite nối mount admin-web):
Test Suites: 6 passed, 6 total
Tests:       290 passed, 290 total
REAL_EXIT=0
```

## 5. KHÔNG xoá — và lý do đo được

**Toàn bộ legacy shell ở `src/app/admin` KHÔNG phải dead code.** Import-graph cho thấy **55/56 module còn lại đều có inbound**: toàn bộ 5 renderer + `section-dispatch`/`mutation-dispatch`/`shell-render`/`shell-router`/`shell-auth`/`shell-types`/`p6-01-shell-fixtures` nối trực tiếp vào legacy router đang phục vụ `/admin/*`, **và** BFF của Portal mới type-import `shell-types.ts` + `shell-router.ts` ở cả 9 file (`operations.ts:21-22`, `context.ts:18-19`, `profiles.ts:22-23`, `secrets.ts:29-30`, `identity.ts:30-31`, `security.ts:16-17`, `settings.ts:34-35`, `health.ts:3-4`). Xoá chúng sẽ làm mất type của **toàn bộ BFF** ⇒ Portal mới không build được — đúng điều ngược lại với mục tiêu.

Không có file template/CSS legacy nào để xoá: shell legacy render HTML inline trong TS (`shell-render.ts`); các file `.css` duy nhất thuộc SPA mới và đều đang dùng.

Cũng **không** xoá `main.tsx` (Vite entry, được `index.html` tham chiếu).

## 6. Lưu ý trung thực

1. **Đây không làm thay đổi thứ bạn thấy ở `:3001/admin`.** Route vẫn là legacy shell; đổi sang Portal là việc riêng (AWEB-10) và đã có lane khác làm dở đúng `shell-server.ts` tối nay — tôi không đụng.
2. **Lỗi của tôi đã được bắt bằng tool:** lần quét SPA đầu tiên không resolve alias `@/`, dẫn tới báo 39 file zero-inbound (sai). Quét lại có alias cho 3. Nếu tôi xoá theo con số đầu tiên thì sẽ **phá 30+ component đang dùng**. Có ghi nhận để không lặp.
3. `docs/28-test-inventory.md:758` và các receipt lịch sử nhắc `crypto-config-index.ts` — nay đã stale (file không còn). Tôi **không** sửa docs/28 vì nó là inventory ghi theo receipt, thuộc lịch sử lane khác; để coordinator quyết định.
4. Các file ` M` còn lại trong `apps/admin-web/src` (router, routes, screens, api client…) **không phải của tôi** — là công việc chưa commit của các lane AP-01..05 đang hoạt động song song. Tôi chỉ xoá 4 file + sửa 1 README.
