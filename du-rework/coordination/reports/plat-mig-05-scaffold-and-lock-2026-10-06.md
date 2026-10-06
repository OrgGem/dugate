# PLAT-MIG-05 — shim -> scaffold/postinstall + provenance lock (qwen_2) — 2026-10-06

**Nguon:** Codex Arch GO BO NO-GO (module resolution da giai quyet). Chuyen 5 shim tinh thanh co che scaffold/postinstall ben vung, khoa provenance + lockfile.
**Lease:** `businesses/document-core/template/**`. **Khong sua shared contracts.** Khong commit, khong tick.

## 1. Co che scaffold/postinstall

`template/scripts/scaffold-shims.mjs` — tao 5 shim `node_modules/@du/*/package.json` (idempotent, `--check` mode cho CI).

- **Idempotent:** chay nhieu lan khong loi, khong ghi de noi dung giong nhau.
- **`--check`:** exit 1 khi shim thieu hoac lech — dung cho CI gate.
- **Chay tu `postinstall`:** `template/package.json` co `"postinstall": "node scripts/scaffold-shims.mjs"` → fresh container / scratch directory chay `npm install` la shim tu dong tao.
- **Script rieng:** `npm run scaffold` (tao) / `npm run scaffold:check` (kiem).

### Vi sao khong con la 5 file tinh

Shim goc la 5 file `package.json` tao bang tay. Giu nguyen se hong khi: (a) fresh container khong co file do; (b) `npm install` xoa `node_modules` → shim mat; (c) khong co gi chong lai. Postinstall dung ca 3.

## 2. Provenance lock

`template/VENDOR-LOCK.json` — 59 file vendored, moi file co `sha256`.

```json
{
  "baseCommit": "b088eececcb5f3df0b4edbe073a29401dafda624",
  "generated": "2026-10-06",
  "files": { "contracts/src/operations.ts": { "sha256": "..." }, ... }
}
```

- **Sinh lai:** `node scripts/gen-vendor-lock.mjs` (node, khong phu thuoc PowerShell).
- **Kiem:** `node scripts/verify-vendor-lock.mjs` — exit 1 khi file thieu / hash lech / co file khong khoa.

### Loi cua toi da sua (ghi lai)

Lan sinh lock dau tung dung PowerShell `Add-Member` tren **hashtable** → `files` rong → verify bao 60 UNLOCKED. Da chuyen sang node (`gen-vendor-lock.mjs`) → **59 file khop hash**.

## 3. Bang chung (literal, 3 verify cung lan)

```
verify-vendor-lock: 59 vendored files match b088eececcb5f3df0b4edbe073a29401dafda624
VERIFY_EXIT=0
scaffold-shims: all 5 shims present and up to date
SCAFFOLD_CHECK_EXIT=0
boot: {"message":"Failed to parse worker environment configuration"}  (khong co MODULE_NOT_FOUND)
```

- **Vendor lock:** 59/59 file khop sha256, exit 0.
- **Scaffold:** 5/5 shim hien tai va dung, `--check` exit 0.
- **Boot:** khong con `MODULE_NOT_FOUND`; dung o **config** (boot khong env) — dung trang thai ket thuc cho boot co lap.

## 4. package.json scripts (moi)

```json
"scripts": {
  "postinstall": "node scripts/scaffold-shims.mjs",
  "build": "tsc -p tsconfig.json",
  "typecheck": "tsc --noEmit -p tsconfig.json",
  "scaffold": "node scripts/scaffold-shims.mjs",
  "scaffold:check": "node scripts/scaffold-shims.mjs --check",
  "verify:vendor": "node scripts/verify-vendor-lock.mjs",
  "boot:check": "node scripts/scaffold-shims.mjs --check && tsc -p tsconfig.json"
}
```

## 5. Gioi han (ghi trung thuc)

- **Chua chay `npm install` that** trong container doc lap → chua chung minh postinstall tu dong tao shim tu dong (can network cho `zod`/`pdf-lib`/`bullmq`).
- **Chua co lockfile that** (`package-lock.json` / `pnpm-lock.yaml`) — can `npm install` de sinh; packet nay chi khoa **provenance** vendored, khong phai lockfile npm.
- **Chua chay test** — chi typecheck + boot.
- Khong sua shared contracts. Khong commit, khong tick.

## 6. File da ghi

`template/scripts/scaffold-shims.mjs`, `template/scripts/gen-vendor-lock.mjs`, `template/scripts/verify-vendor-lock.mjs`, `template/package.json` (postinstall + scripts), `template/VENDOR-LOCK.json`, receipt nay.
