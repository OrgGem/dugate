# LIV-05b — Vault policy scoping + rotation/revoke verify (READ-ONLY ve code, live Vault)

## RESUME POINT — 2026-10-04

- **Ket luan 1 dong:** scope/negative **PASS** cho ca 2 policy tren Vault dev; **rotation + revoke PASS**; **transit/encrypt|decrypt FAIL** — khong co identity nao ngoai root duoc dung transit ⇒ muc 2 cua packet **khong the dat** voi policy hien tai.
- **Bang chung chinh:** capability map that tu `sys/capabilities-self` (U1–U12), khong suy tu 403.
- **Con 1 residue cua chinh toi:** 1 token co policy `root` tao ra de do capability map ma **khong revoke duoc** (Muc 6, FINDING-D). Khong tu fix vi se anh huong lane khac.
- **Bien doi state tren dev Vault:** transit key `du-app-encryption-key` **latest_version 1 → 3** (2 lan rotate, theo packet); secret test **da xoa**; 11 token tao, 10 revoke + verify chet, 1 con lai (Muc 5).
- Source/test/plan **khong dong vao**; khong tick; khong commit.

## 1 — Moi truong (literal)

| Buoc | Command | Exit | Ket qua |
|---|---|---:|---|
| V1 | `docker ps --filter name=du-live-vault` | 0 | `hashicorp/vault:latest`, **Up (healthy)**, `127.0.0.1:8200->8200/tcp` |
| V2 | `docker exec -e VAULT_ADDR=http://127.0.0.1:8200 -e VAULT_TOKEN=root-dev-token du-live-vault vault status` | 0 | Initialized true, seal shamir |
| V3 | `vault secrets list` | 0 | co mount `secret/` (agent-registry, cubbyhole, …) |
| V4 | `vault auth list` | 0 | **chi co `token/`** — khong co approle, khong co kubernetes |
| V5 | `vault read transit/keys/du-app-encryption-key` | 0 | key ton tai |
| V6 | `vault policy list` | 0 | `connector-reader`, `default`, `default-ceiling`, `orchestrator-writer`, `root` |

- **Live policy == file trong repo:** `vault policy read <name>` so voi `infra/vault/policies/*.hcl` (bo comment + dong trong) → **IDENTICAL** cho ca 2. Khong co drift giua fixture va source.
- Moi lenh duoi deu chay qua `docker exec du-live-vault vault …` (khong dung HTTP truc tiep, khong dung port cua user khac).

## 2 — FINDING A (product, quan trong): KHONG co identity nao dung duoc transit

Policy `orchestrator-writer` **khong khai bao bat ky `transit/*` path** (chi `secret/data/du/connector/*` + `secret/metadata/du/connector/*`). Do do:

| Buoc | Identity | Command | Exit | Ky vong packet | Verdict |
|---|---|---|---:|---|---|
| D2 | writer | `vault write transit/encrypt/du-app-encryption-key plaintext=<b64>` | **2** | 0 | **FAIL** (403) |
| D3 | writer | `vault write transit/decrypt/…` | **2** | 0 | **FAIL** (403) |
| K5 | writer | `vault write transit/decrypt/…` (ciphertext tao truoc rotation) | **2** | 0 | **FAIL** (403) |

Capability map xac nhan o cap policy (khong phai do CLI):

```
U8  writer @ transit/decrypt   caps=["deny"]
U10 writer @ transit/encrypt   caps=["deny"]
U11 writer @ transit rotate    caps=["deny"]
U7  reader @ transit/decrypt   caps=["deny"]
U9  reader @ transit/encrypt   caps=["deny"]
R9  root   @ transit/encrypt   caps=["root"]      <- chi root dung duoc
```

- Policy `default` cung **khong** cap transit (chi `auth/token/*`, `cubbyhole/*`, `sys/tools/hash/*`…).
- **Hau qua:** `du-app-encryption-key` chi dung voi root token — ma chinh comment trong policy lai quy dinh **khong bao gio dung root** (VAULT-02). Day la **lo hong thiet ke**, khong phai bug Vault.
- **Ve owner:** them `path "transit/encrypt/du-app-encryption-key"` (+ `decrypt`, co can `rotate` khong) vao `orchestrator-writer.hcl`, va render lai bang `renderVaultPolicyHcl` (sinh tu `packages/contracts/src/vault-policies.ts`). **Khong tu sua** — ngoai lease va la quyet dinh policy cua SEC/VAULT owner.

## 3 — Scope / negative: PASS (bang chung truc tiep)

Capability map (`sys/capabilities-self`, duoc `default` policy cap):

| Buoc | Path | Reader | Writer |
|---|---|---|---|
| U1/U2 | `secret/data/du/connector/x` | `["read"]` | `["create","update"]` |
| U3/U4 | `secret/metadata/du/connector/x` | `["read"]` | `["list","read"]` |
| U5/U6 | `secret/data/du/other/x` (**ngoai scope**) | `["deny"]` | `["deny"]` |

Hanh vi that (khop 1-1 voi map tren):

| Buoc | Identity | Hanh vi | Exit | Ky vong | Verdict |
|---|---|---|---:|---|---|
| B1 | root | `kv put secret/du/connector/liv05b-probe` | 0 | 0 | PASS |
| C1 | reader | doc trong scope (`kv get -field=value`) | **0**, gia tri doc dung | 0 | **PASS** |
| C2 | reader | `kv put` cung path | **2** (403) | 403 | **PASS** |
| C3 | reader | doc `secret/du/other/liv05b-probe` | **2** (403) | 403 | **PASS** |
| I1 | reader | `kv list secret/du/connector` | **2** (403) | 403 | **PASS** |
| I2 | writer | `kv list secret/du/connector` | **0** (thay `liv05b-probe`) | 0 | **PASS** |
| D1 | writer | `kv put` trong scope | **0** | 0 | **PASS** |
| D4 | writer | `kv get` data path (khong co cap read) | **2** (403) | 403 | **PASS** |

- **Tenant boundary (case 3 cua LIV-05): PASS** o ca hai cap — policy deny va API 403 cho path ngoai `du/connector/*`.
- Policy **khong qua rong** theo y muc 1 cua packet (reader khong ghi duoc, khong xoa duoc, khong list duoc).

## 4 — Rotation + revoke: PASS (case 5)

| Buoc | Command | Exit | Ket qua |
|---|---|---:|---|
| E2/K2 | `vault write -f transit/keys/du-app-encryption-key/rotate` | 0 | x2 lan trong phi nay |
| E1/K1 → K3 | `vault read -format=json transit/keys/…` | 0 | `latest_version` **1 → 2 → 3** |
| J2 | root `transit/encrypt` (truoc rotation) | 0 | ciphertext `vault:v2:…` (77 ky tu) |
| K4 | root `transit/decrypt` ciphertext **tao TRUOC** rotation | **0**, **roundtrip MATCH** | **PASS** |
| L2/P2 | `vault token revoke <writer>` | 0 | Success! Revoked token |
| Q4/V1 | revoke reader + writer (2 vong) | 0 | — |
| V2/V3 | `vault token lookup <token>` sau revoke | **2** | `* bad token` — chet that |
| L4 | reader `kv get` sau revoke | **2** (403) | **PASS** |

- **Rotation giu key cu**: ciphertext tao o version truoc van decrypt duoc sau 2 lan rotate ⇒ khong co destructive rotation. Day la tin **tot** cho envelope dang chay.

## 5 — State thay doi tren dev Vault (minh bach)

| Muc | Trc | Sau |
|---|---|---|
| `transit/keys/du-app-encryption-key` latest_version | **1** | **3** (2 lan rotate theo packet) |
| `secret/du/connector/liv05b-probe` | khong co | **da xoa** (`kv get` → `No value found`, `kv list` → `No value found`) |
| Token tao | — | **11** (2 reader + 2 writer o moi vong + 1 token policy `root`); **10 revoke + verify chet**; **1 con lai** |
| Policy upload | 5 | 5 (khong doi) |
| Container | Up 49 phut | **khong restart** |

## 6 — FINDINGS khac

**FINDING-B (env, can chu y):** dev Vault **chi bat `token/` auth** (V4), trong khi ca 2 policy ghi ro `AppRole/Kubernetes auth only`. Nghia la fixture hien tai **khong chứng minh** duong AppRole/K8s — moi verify duoc bang root-tao-token. Muon verify machine identity that can AppRole hoac k8s. `vault auth enable approle` la thay doi fixture (ngoai lease) ⇒ de coordinator quyet.

**FINDING-C (env, phac nghy):** policy `worker-browser` **co trong repo** (`infra/vault/policies/worker-browser.hcl`) nhung **khong duoc upload** len dev Vault (`vault policy read worker-browser` → exit 2 `No policy named`). Theo README thi `worker`/`browser` **khong co Vault identity**, nen **co the la co y**, khong phai loi — chi ghi de nguoi sau khong goi la missing.

**FINDING-D (LOI CUA CHINH TOI — can owner xu ly):** o vong do capability map, toi tao **1 token gan policy `root`** de do `R9` va **khong revoke duoc** — gia tri token khong duoc luu lai trong harness nen khong goi `token revoke` duoc.
- **Vi sao khong tu fix:** Vault CLI nay khong co `token list` (V/Q3), nen khong biet accessor nao la cua token do; `sys/token/revoke-accessor` se **co the gat token cua lane khac** dang chay live tren cung dev Vault; `docker restart` se **pha san fixture dev dung chung** (secrets + policies + tat ca token). Ca hai hau qua nam ngoai pham vi task nay.
- **De xuat (co quyen la coordinator):** recreate container `du-live-vault` (dev fixture, ton tai ~50 phut, in-mem) la cach sach nhat; hoac chay lenh nay neu chac chan token do da het TTL. **Toi khong tu quyet.**

## 7 — Sai sot cua chinh toi da bat va sua (de khong ai dung lai)

| Sai sot | Hien tuong | Sua bang cach |
|---|---|---|
| `vault kv list secret/metadata/du/connector` | URL sai `…/secret/metadata/metadata/…` ⇒ 403 **vi sai duong dan**, khong phai vi policy | dung `kv list secret/du/connector` → 403 **dung ly do** (I1) |
| `vault kv metadata delete -force` | `flag provided but not defined: -force` (exit 1) | bo `-force` (M2) |
| `vault token lookup -self` | flag khong ton tai (exit 1) | lookup bang gia tri token (V2/V3) |
| `vault token capabilities <tok> <path>` | tra `deny` cho **moi** path ke ca reader doc duoc ⇒ **CLI artifact**, khong phai bang chung | doi sang `sys/capabilities-self` (U1–U12) |
| path logical `secret/du/connector/x` khi hoi capability | policy khai `secret/data/*` ⇒ `deny` gia | hoi bang `secret/data/...` |

- **Quy tac suy ra cho lane sau:** Vault CLI exit **2** cho loi API/permission, **1** cho sai flags; doc **noi dung loi**, khong chi exit code. `vault token capabilities` trong image nay khong tin — dung `sys/capabilities-self`.

## 8 — Acceptance

| Muc packet | Verdict | Bang chung |
|---|---|---|
| 1. reader doc duoc trong scope / ghi bi 403 / doc ngoai scope bi 403 | **PASS 3/3** | C1, C2, C3 + U1/U5 |
| 2. writer ghi KV OK **+ transit encrypt/decrypt OK** | **HALF PASS** | ghi KV PASS (D1, U2); **transit FAIL** (D2/D3/K5, U8/U10/U11) → xem FINDING-A |
| 3. rotation: version tang + ciphertext cu giai ma duoc | **PASS** | K1→K3 (1→3), K4 roundtrip MATCH |
| 4. revoke: call sau revoke = 403 | **PASS** | L4 + V2/V3 `bad token` |
| 5. cleanup: revoke token + xoa secret test | **PARTIAL** | secret da xoa; 10/11 token revoke; **1 token policy `root` con lai** — FINDING-D |
| Khong sua source/test/plan | **MET** | chi dung `docker exec` vao Vault; khong mo file nao de ghi |
| Khong tick / khong commit | **MET** | — |

## 9 — Ledger

- 1 — Preflight 6 lenh literal + policy live khop file repo — Muc 1.
- 2 — FINDING-A: khong identity nao ngoai root dung transit; 403 + capability deny — Muc 2.
- 3 — Scope/negative PASS 9/9, capability map U1-U6 khop hanh vi — Muc 3.
- 4 — Rotation version 1→3 + roundtrip MATCH; revoke chet that (`bad token`) — Muc 4.
- 5 — Bang state thay doi (version, secret, 11 token, policy khong doi) — Muc 5.
- 6 — FINDING-B (thieu approle), FINDING-C (worker-browser khong upload), FINDING-D (residue cua toi) — Muc 6.
- 7 — 5 sai sot harness cua toi + quy tac exit code/su dung lenh cho lane sau — Muc 7.
- 8 — Acceptance map 5/6 met, 1 partial co ghi ro — Muc 8.