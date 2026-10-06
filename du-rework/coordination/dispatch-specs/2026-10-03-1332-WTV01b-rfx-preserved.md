# WTV-01b — Cross-verify RFX-10/11/12 sống sót trong CONV refactor (READ-ONLY)

**Packet:** wtv01b-rfx-preserved | **Lane:** cc_2 | Dispatch 2026-10-03T13:32+07:00 (coordinator command-code).

**Nguồn:** `tasks/WORKTREE-VERIFY-COMMIT-2026-10-03.md` WTV-01 (mục "xác nhận fix RFX-10/11/12 không mất trong refactor"); `coordination/reports/wtv08-rfx-gapcheck-2026-10-03.md` §0–1 — RFX-10 nằm ở `app/bootstrap/create-app.ts:155,:227-248`; RFX-11/12 ở `http/routes/runtime.ts:106-167,:349`; các row này **self-authored bởi lane khác** ⇒ cần verify chéo độc lập.

**Việc:**
1. Xác nhận 3 fix hiện diện và không mất semantics sau khi code dời file (CONV-01/02/03):
   - RFX-10: seed dev-fallback bị gate (`shouldSeedDevFallback`), không chạy ở production.
   - RFX-11: grant URL không dựng từ Host header (`allowHostDerivedGrantUrl`, `requestGrantUrl`).
   - RFX-12: heartbeat không còn stub số liệu cố định.
2. Chạy focused suite offline liên quan (`rfx10-seed-gate`, `rfx11-12-route-hardening`) + `tsc --noEmit`; literal command/cwd/exit.
3. Spot-check public re-export: symbol chính từ `server.ts` cũ còn resolve từ vị trí mới.
4. Verdict `PRESERVED / DRIFT` + bằng chứng `file:line`.

**Ranh giới:** READ-ONLY (được chạy test). Chỉ ghi `du-rework/coordination/reports/wtv01b-rfx-preserved-2026-10-03.md`. Không sửa `server.ts`/source; không tick; không commit; không chạm `nocobase-10`.
