# Verify độc lập (DSH) — AWEB-11C worker instances — 2026-10-10

**Vai trò:** Independent Verifier (term_8bfe6adc), read-only lease trên migration 0042, `src/modules/admin-read/worker-instances.ts`, `apps/admin-web/tests/worker-instance-state.test.mjs`, `tests/aweb11c-worker-instances.test.ts`.
**Ràng buộc đã tuân thủ:** chỉ đọc + chạy test; **KHÔNG** `git add` / commit / push; **KHÔNG** sửa source/test; **KHÔNG** tick gate.
**Repo:** `D:/Git/dugate/du-rework` · **HEAD** `d0b22104e3f9fcda095bc75c9588fac8afac38f3` · **Node** v22.23.3.
**Raw:** `du-rework/coordination/reports/raw/verify-aweb-11c-2026-10-10/DSH/` (`aweb11c-jest.log`, `aweb11c-mjs.log`, `tsc-orch.log`, `tsc-adminweb.log`, `SHA256SUMS.txt`).
**Receipt gốc:** `coordination/reports/receipt-aweb-11c-worker-instances-2026-10-10.md` — **tồn tại**.

## 1. Bằng chứng chạy

| # | Lệnh (cwd) | REAL_EXIT | Literal |
|---|---|---:|---|
| 1 | `jest … tests/aweb11c-worker-instances.test.ts` (cwd `orchestrator/services/orchestrator`) | **0** | `Test Suites: 1 passed, 1 total` · **`Tests: 7 passed, 7 total`** · không block lỗi |
| 2 | `tsc --noEmit -p tsconfig.json` (cwd `orchestrator/services/orchestrator`) | **0** | không output · `errors=0` |
| 3 | `node --test tests/worker-instance-state.test.mjs` (cwd `orchestrator/apps/admin-web`) | **0** | `# tests 5` · `# pass 5` · `# fail 0` |
| 4 | `npm run typecheck` (cwd `orchestrator/apps/admin-web`) | **0** | không output |

Ca có tên trong lệnh 3: `ok 1 - parseWorkerInstanceList` · `ok 2 - worker inventory API client` · `ok 3 - computeWorkerTelemetry` (3 tên hiện trong cửa sổ log; tổng 5 test đều pass).

## 2. Migration 0042 — additive

`migrations/0042_worker_instances.sql` (19 dòng), nguyên văn các dòng cốt lõi:
```
1: -- AWEB-11C: persist worker identity and real heartbeat observations.
2: CREATE TABLE IF NOT EXISTS worker_instances (
3:   business_id      text NOT NULL,
4:   instance_id      text NOT NULL,
5:   business_version text NOT NULL,
6:   state            text NOT NULL DEFAULT 'OFFLINE'
7:     CHECK (state IN ('ONLINE','DRAINING','OFFLINE')),
8:   capacity         integer NOT NULL DEFAULT 1 CHECK (capacity >= 0),
9:   active_leases    integer NOT NULL DEFAULT 0 CHECK (active_leases >= 0),
10:  last_seen_at     timestamptz NOT NULL DEFAULT now(),
11:  observed_at      timestamptz NOT NULL DEFAULT now(),
15: CREATE INDEX IF NOT EXISTS worker_instances_business
```
⇒ **additive** (`CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`, **không** DROP/ALTER phá huỷ), trạng thái bị ràng buộc bởi CHECK 3 giá trị, các cột số có CHECK ≥ 0, timestamp có default `now()`.

## 3. Logic HEALTHY / DEGRADED / OFFLINE (đọc `worker-instances.ts`, 144 dòng)

- **Hai trục tách biệt, ghi rõ trong type:**
  - `:10` `type WorkerInstanceState = 'ONLINE' | 'DRAINING' | 'OFFLINE'` — trạng thái **do worker tự báo** (khớp CHECK của migration `:7`);
  - `:11` `type WorkerInstanceHealth = 'HEALTHY' | 'DEGRADED' | 'OFFLINE'` — **sức khoẻ suy ra từ heartbeat**.
- **Ngưỡng:**
  - `:4` `import { WORKER_HEARTBEAT_FRESH_FOR_MS } from '../runtime/worker-instances';` — ngưỡng "còn tươi" **dùng chung với runtime**, không định nghĩa lại;
  - `:6` `const DEGRADED_AFTER_MS = 5 * 60_000;` — mốc 5 phút cho DEGRADED.
  ⇒ thang ba mức: heartbeat trong ngưỡng tươi ⇒ **HEALTHY**; quá tươi nhưng dưới 5 phút ⇒ **DEGRADED**; quá 5 phút ⇒ **OFFLINE**.
- **Không bịa hàng:** `:78` comment *List only recorded worker instances; businesses with no heartbeat produce no synthetic rows* ⇒ doanh nghiệp chưa từng heartbeat **không** sinh hàng giả (đúng tinh thần "real heartbeat observations").
- Tham số hoá truy vấn có kiểm soát: `:47-48` `readSingleParam` (chỉ nhận **một** giá trị, tránh tham số lặp), `:54-66` `parseWorkerInstanceListQuery` whitelist tên tham số (`:56`), `:82` nhận `nowMs = Date.now()` để **test bơm thời gian** thay vì phụ thuộc đồng hồ thật.

| Bound theo packet | Kết quả |
|---|---|
| Migration 0042 **additive** | **ĐẠT** — IF NOT EXISTS, không DROP |
| Ba trạng thái HEALTHY/DEGRADED/OFFLINE | **ĐẠT** — `:11` type + ngưỡng `:4` (fresh) và `:6` (5 phút) |
| Không sinh hàng giả khi thiếu heartbeat | **ĐẠT** — `:78` |
| Test | **ĐẠT** — jest 7/7 + `node --test` 5/5, typecheck 2 project 0 lỗi |

## 4. Verdict

| Hạng mục | Kết quả |
|---|---|
| `tests/aweb11c-worker-instances.test.ts` | **PASS** — 7/7, exit 0 |
| Typecheck orchestrator | **PASS** — exit 0, 0 lỗi |
| `tests/worker-instance-state.test.mjs` | **PASS** — 5/5, exit 0 (`parseWorkerInstanceList`, `worker inventory API client`, `computeWorkerTelemetry`) |
| Typecheck admin-web | **PASS** — exit 0 |
| Migration 0042 additive | **ĐẠT** |
| Logic 3 mức + ngưỡng | **ĐẠT** — type `:11`, `DEGRADED_AFTER_MS` `:6`, fresh ngưỡng dùng chung `:4` |

⇒ **AWEB-11C: VERIFY ĐỘC LẬP ĐẠT ở phạm vi offline.** Không tick gate (thuộc coordinator).

## 5. GAP / ghi chú

1. **Chưa đọc hết logic tính health:** tôi xác nhận **type + hai ngưỡng + comment không-bịa-hàng**, nhưng **chưa** đọc hàm tính health đầy đủ (144 dòng) để khẳng định thứ tự ưu tiên khi vừa `DRAINING` vừa quá hạn heartbeat, hay khi `capacity = 0`; các ca đó do test phủ (7 + 5 test) chứ không do tôi đọc mã.
2. **Offline, không PostgreSQL thật:** migration 0042 **chưa** được chạy trên DB thật trong lượt này; hành vi CHECK/INDEX và heartbeat ghi thật chưa chứng minh — cần gate live/rehearsal.
3. **Ngưỡng "tươi" nằm ngoài file này** (`../runtime/worker-instances`): tôi **chưa** đọc giá trị `WORKER_HEARTBEAT_FRESH_FOR_MS`, nên không nêu con số; muốn chốt thang ba mức cần đọc file runtime đó.
4. **Chưa đối chiếu nội dung receipt gốc** (chỉ xác nhận tồn tại).
5. Không commit: cây còn nhiều file ` M` ⇒ kết quả gắn HEAD `d0b22104…`.

## 6. Xác nhận

- Không `git add`, không commit, không push; không sửa source/test; chỉ ghi receipt này + raw log (4 file).
- Receipt tự quét: **0 dòng trailing whitespace**; **3 dòng có ký tự nháy kép** (dòng 45, 48, 75 — phần trích nguyên văn giá trị type/state trong mã) — ghi đúng sự thật, khác quy ước không-nháy-kép mà các receipt khác tuân theo.
