# Receipt: SEC-ENC-05 — cấu hình Benchmark Extract KEK (CONNECTOR_INVOCATION_ENCRYPTION_KEYS)

- **Task:** dispatch sửa `compose/connector.yml` + `scripts/docker/init-env.cjs` để khắc phục Benchmark Extract 0/12 `PROVIDER_UNAVAILABLE` (theo `diag-benchmark-extract-failure-2026-10-07.md` và Section 13.8).
- **Worker:** OpenCode (term_169a5da5-5a0c-4cbf-b226-7f2d51264b24) · **Thời điểm:** 2026-10-07 ~01:00 · **HEAD:** `4308cc54eda32cfcca54e0c55554fc85d720a43b` · Node chạy kiểm tra: v22.16.0.
- **Code freeze:** không commit, không push. Không tạo/sửa file nào ngoài receipt này.

## 1. Kết quả chính: hai sửa đổi ĐÃ hiện hữu trong working tree (uncommitted), khớp verbatim spec

Khi nhận việc, tôi đọc 2 file trong lease và phát hiện cả hai thay đổi dispatch yêu cầu **đã có sẵn dưới dạng uncommitted diff so với HEAD** (ai đó đã áp dụng trước; tôi **không** claim authorship, không sửa chồng lên vì sẽ tạo duplicate key trong YAML). Tôi chuyển vai trò sang **kiểm chứng tính toàn vẹn**.

### Diff hiện trường (`git diff HEAD -- du-rework/compose/connector.yml du-rework/scripts/docker/init-env.cjs`, exit 0)

```diff
# compose/connector.yml (environment của service connector)
+      CONNECTOR_INVOCATION_ENCRYPTION_KEYS: ${CONNECTOR_INVOCATION_ENCRYPTION_KEYS:-}

# scripts/docker/init-env.cjs (trong localEnvironment())
+    // SEC-ENC-02/05: ledger field crypto; unset = sensitive invocation writes refuse (502).
+    // Shape expected by resolveInvocationStorageCryptoFromEnv (LocalInvocationKekConfig).
+    CONNECTOR_INVOCATION_ENCRYPTION_KEYS: JSON.stringify({
+      keyRef: 'du-connector-invocation-v1',
+      activeVersion: 1,
+      keys: { 1: randomBytes(32).toString('base64') },
+    }),
```

Đối chiếu spec dispatch: dòng env forward đúng cú pháp `${CONNECTOR_INVOCATION_ENCRYPTION_KEYS:-}`; block sinh đúng `keyRef: du-connector-invocation-v1`, `activeVersion: 1`, `keys.1 = base64(randomBytes(32))`. Consumer thật khớp: `services/connector/src/db/invocation-crypto.ts:481` đọc `process.env.CONNECTOR_INVOCATION_ENCRYPTION_KEYS` qua `resolveInvocationStorageCryptoFromEnv`.

## 2. Kiểm tra tính toàn vẹn (đã chạy thật)

| # | Lệnh | cwd | exit | Kết quả |
|---|---|---|---|---|
| 1 | `git diff HEAD -- du-rework/compose/connector.yml du-rework/scripts/docker/init-env.cjs` | `D:\Git\dugate` | 0 | diff đúng như §1, không dòng nào khác |
| 2 | `git diff --check HEAD -- <2 file>` | `D:\Git\dugate` | 0 | không whitespace/conflict marker |
| 3 | `node scripts/docker/init-env.cjs .env.kekcheck.tmp` | `D:\Git\dugate\du-rework` | 0 | file sinh OK, không lỗi cú pháp/runtime |
| 4 | node parse dòng `CONNECTOR_INVOCATION_ENCRYPTION_KEYS` từ file sinh ra | cùng cwd | 0 | `{"parseOk":true,"keyRef":"du-connector-invocation-v1","activeVersion":1,"keyVersions":["1"],"decodedKeyBytes":32}` |
| 5 | `Remove-Item .env.kekcheck.tmp` + `Test-Path` | cùng cwd | — | `False` (dọn sạch, không để sót file env) |

Không in giá trị secret vào receipt; chỉ ghi metadata cấu trúc.

## 3. Kết luận và hàm ý

1. **Phần source/compose của defect đã được khắc phục trong working tree** — connector container giờ nhận được `CONNECTOR_INVOCATION_ENCRYPTION_KEYS` từ env file do `init-env.cjs` sinh.
2. **Nếu Benchmark Extract vẫn 0/12 `PROVIDER_UNAVAILABLE`**, nguyên nhân còn lại nằm ở **deployment**: env file hiện hành (sinh trước khi có block KEK) và/hoặc container đang chạy với env cũ. Cần: tái sinh env (`node scripts/docker/init-env.cjs <file env mới>`) hoặc bổ sung biến vào env hiện hữu, rồi recreate connector (`docker compose ... up -d --force-recreate connector`) trước khi chạy lại benchmark. Đây là thao tác deploy — **ngoài lease của packet này**, cần owner benchmark thực hiện.
3. Đề xuất owner tài liệu cập nhật `diag-benchmark-extract-failure-2026-10-07.md`: mục "deployment gap" nay chỉ còn đúng với env/image đã bake trước sửa đổi, không còn đúng với source tree.
4. Trạng thái packet: **IMPLEMENTED (cấu hình) + integrity smoke PASS**. Chưa VERIFIED theo nghĩa benchmark 12/12 — cần chạy lại benchmark sau redeploy bởi owner tương ứng.
