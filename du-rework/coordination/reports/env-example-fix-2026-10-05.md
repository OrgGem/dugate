# ENV-EXAMPLE-FIX (qwen_2) — mo ta Vault bindings trong .env.example — 2026-10-05

**Loai:** DOC-ONLY. Khong doi ten bien, khong doi logic runtime. Khong commit.
**Nguon:** finding VFY-801 (V2 chay voi `VAULT_TOKEN` rong + `VAULT_MOUNT` unset nhung compose van len).
**Lease:** `.env.example` + receipt nay.

## 1. Defect

Comment trong `.env.example` mo ta 3 binding Vault nhu the **bat buoc**, trong khi `compose.ts` cho phep unset:
`composeCredentialWorkflow` (`services/orchestrator/src/modules/connector-credentials/compose.ts`) tra `undefined` (workflow TAT) khi **khong** env nao duoc set — boot binh thuong. Cau cu `Toàn bộ hoặc không: đủ bộ ⇒ workflow bật; một phần / sai JSON ⇒ TỪ CHỐI BOOT` khong noi ro rang TAT-ca-ba la hop le, va khong noi field nao trong JSON la tuy chon.

## 2. Sua (mo ta, khong doi bien/logic)

Thay khoi comment 2 dong bang khoi mo ta chinh xac (van giu nguyen 3 ten bien `DU_VAULT_KV_OPTIONS`, `DU_VAULT_KV_TOKEN`, `DU_CONNECTOR_INITIAL_BINDINGS`):
- **TUY CHON ca ba**; khong set bien nao => workflow TAT (mac dinh: `credentialWorkflow=false`, surface 503 fail-closed), boot binh thuong.
- **Bat workflow:** can `DU_VAULT_KV_OPTIONS` + `DU_VAULT_KV_TOKEN`; `DU_CONNECTOR_INITIAL_BINDINGS` tuy chon.
- Trong JSON `DU_VAULT_KV_OPTIONS`: chi **`vaultAddress`** (http/https tuyet doi) bat buoc; **`kvMount`** va **`requestTimeoutMs`** tuy chon (mac dinh do `vault-kv2-writer` quyet).
- Gia tri rong duoc coi nhu **khong set** (`present()` doi `length > 0`).
- Thieu OPTIONS hoac TOKEN trong khi da set bien khac => **TU CHOI BOOT** (typed `CredentialWorkflowBootError`).
- `config.credentialWorkflow` tuong minh de len composition.
- Dan chieu nguon su that: `services/orchestrator/src/modules/connector-credentials/compose.ts`.

## 3. Bang chung — diff literal

```diff
@@ -28,6 +33,20 @@ SERVICE_IDENTITY_SECRET=
+# Vault credential workflow (CREDWORKFLOW-IMPL) — xem docs/12b-deployment-guide.md §3.2
+# TUY CHON: ca ba bien duoi deu co the de trong. Khong set bien nao => workflow TAT
+#   (mac dinh: capabilities credentialWorkflow=false, surface 503 fail-closed) va boot binh thuong.
+# Bat workflow: can DU_VAULT_KV_OPTIONS + DU_VAULT_KV_TOKEN (DU_CONNECTOR_INITIAL_BINDINGS tuy chon).
+#   - DU_VAULT_KV_OPTIONS (JSON): chi `vaultAddress` (http/https tuyet doi) la BAT BUOC;
+#     `kvMount` va `requestTimeoutMs` la TUY CHON (mac dinh do vault-kv2-writer quyet).
+#   - DU_VAULT_KV_TOKEN: bat buoc khi da bat workflow; gia tri rong duoc coi nhu KHONG set.
+#   - Thieu DU_VAULT_KV_OPTIONS hoac DU_VAULT_KV_TOKEN trong khi da set bien khac => TU CHOI BOOT (typed).
+#   - `config.credentialWorkflow` tuong minh de len composition nay.
+# Nguon su that: services/orchestrator/src/modules/connector-credentials/compose.ts
```

Kiem: dong cu `Toàn bộ hoặc không` -> **da xoa** (present=False); dong moi `TUY CHON: ca ba bien` -> **co** (present=True); file 55 dong. `git diff` la **pure addition** cho khoi Vault (khong xoa dong nao khac).

## 4. Δ

- **Δ-ENV-1:** diff cua `.env.example` vs HEAD con chua **khoi AWEB-08** (`DU_ADMIN_WEB`...) do **lane khac** them vao cung file trong working tree — khong phai cua toi; toi chi sua khoi Vault.
- Khong doi ten bien nao; khong cham `compose.ts` hay bat ky source nao.

## 5. File da ghi

`du-rework/.env.example` (khoi comment Vault), `coordination/reports/env-example-fix-2026-10-05.md`.
