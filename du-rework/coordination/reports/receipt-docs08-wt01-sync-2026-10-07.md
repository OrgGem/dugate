# Receipt — docs/08 sync với mã lỗi terminal WT-01 (CB-05) — qwen_2 — 2026-10-07

**Task:** Sync `docs/08-connector-api.md` với mã lỗi terminal `WEBHOOK_AUTH_RESOLVER_NOT_CONFIGURED` (WT-01 / CB-05, Δ4 của receipt `wt01-callback-resolver-2026-10-07.md`).
**Scope:** `du-rework/docs/08-connector-api.md` ONLY. **Khong commit, khong push** (code freeze).

## 1. Da lam

Them muc moi **`### Callback secret resolution errors (WT-01, 2026-10-07)`** ngay sau bullet `Auth:` trong phan CB-05, ghi ro:

- `WEBHOOK_AUTH_RESOLVER_NOT_CONFIGURED` — **terminal**. Xay ra khi callback mang credential (`oauth2_client_credentials` / managed-secret) nhung orchestrator **khong** duoc cau hinh `resolveCallbackSecret`. Hanh vi: `status='FAILED'` lap tuc, `attempts=0`, `last_error=WEBHOOK_AUTH_RESOLVER_NOT_CONFIGURED`, **zero fetch calls**, sweep sau khong re-open row — khong retry vo han.
- Phan biet ro voi `WEBHOOK_AUTH_UNAVAILABLE` — **transient** (resolver da co nhung tam thoi khong reachable), chay theo deadline/backoff thong thuong.
- Composition **khong** tu dat resolver (`main.ts` khong co `resolveCallbackSecret:`): wiring la quyet dinh cua operator, nen missing-resolver + credential policy la loi **configuration terminal**, khong phai transient.
- Wire shape (`CallbackResultEnvelope`) khong doi; field error moi chi o `last_error` cua webhook delivery, khong tren wire ban ra consumer.

## 2. Diff literal (docs/08-connector-api.md)

```diff
@@ phan CB-05, sau bullet Auth:
+
+### Callback secret resolution errors (WT-01, 2026-10-07)
+
+- `WEBHOOK_AUTH_RESOLVER_NOT_CONFIGURED` — **terminal**. Xay ra khi callback mang credential
+  (`oauth2_client_credentials` / managed-secret) nhung orchestrator **khong** duoc cau hinh
+  `resolveCallbackSecret`. Hanh vi: chuyen `status='FAILED'` lap tuc, `attempts=0`,
+  `last_error=WEBHOOK_AUTH_RESOLVER_NOT_CONFIGURED`, zero fetch calls, sweep sau khong re-open row
+  — **khong retry vo han**.
+- Phan biet ro voi `WEBHOOK_AUTH_UNAVAILABLE` — **transient** ...
+- Composition **khong** tu dat resolver (`main.ts` khong co `resolveCallbackSecret:`) ...
+- Wire sha256 / `CallbackResultEnvelope` shape khong doi ...
```

**Diffstat:** `du-rework/docs/08-connector-api.md | 9 insertions(+), 2 deletions(-)`.

## 3. Kiem tra toan ven (literal)

**OpenAPI validator** — cwd `du-rework`:

```
python tools/openapi/validate_openapi.py
paths=58 x-absent=9
SC-CB-CANONICAL-SCHEMAS-VALIDATED count=37 refs=resolved operationIds=unique
OPENAPI-EXAMPLES-VALIDATED
Exit Code: 0
```

**`docs/21-openapi.json` KHONG bi sua tay boi toi** — toi chi sua `docs/08-connector-api.md`, va chi chay `validate_openapi.py` (validator, read-only), khong chay `gen_openapi.py` (generator, la thu ghi JSON).

## 4. Δ / ghi chu trung thuc

- **Δ-WT01-1 (can kiem tra boi coordinator):** `git status` cho thay `du-rework/docs/21-openapi.json` dang o trang thai **`M` (modified)** trong working tree. **Do KHONG phai thay doi cua toi** — toi khong chay generator. Nguyen nhan co the la lane khac chay `gen_openapi.py`, hoac thay doi tu truoc. Can xac dinh truoc khi ket luan ve tinh dong bo docs/JSON.
- Validator `Exit Code: 0` sau khi sua docs => ban sua docs khong lam vo bat ky assertion nao cua validator.
- Khong commit, khong push, khong tick.

## 5. File da ghi

`du-rework/docs/08-connector-api.md` (them 1 muc), receipt nay.
