# Vault machine identities & policies (VAULT-02)

Generated from \`@du/contracts \` → \`renderVaultPolicyHcl\` (source of truth:
\`packages/contracts/src/vault-policies.ts\`). Regenerate with:

\`\`\`
cd packages/contracts && npm run build
node -e "const p=require('./dist/vault-policies.js');const fs=require('fs');fs.mkdirSync('../../infra/vault/policies',{recursive:true});fs.writeFileSync('../../infra/vault/policies/orchestrator-writer.hcl',p.renderVaultPolicyHcl('orchestrator-writer'));fs.writeFileSync('../../infra/vault/policies/connector-reader.hcl',p.renderVaultPolicyHcl('connector-reader'));fs.writeFileSync('../../infra/vault/policies/worker-browser.hcl',p.renderVaultPolicyHcl('worker')+p.renderVaultPolicyHcl('browser'));"
\`\`\`

Identities (SEC-00 trust matrix — pending ADR, fail-closed defaults):

| Identity | Auth | Capabilities |
|---|---|---|
| \`orchestrator-writer\` | AppRole/K8s (NEVER root token) | create/update + metadata read on \`secret/data/du/connector/*\`; **no plaintext read** |
| \`connector-reader\` | AppRole/K8s (separate role_id/secret_id) | read + metadata read on same prefix; **no write** |
| \`worker\` / \`browser\` | — | **no Vault identity at all; direct access forbidden** |

Mount/prefix \`secret: du/connector\` is the DEV default; SEC-00 may rename it —
change \`VAULT_DEV_SCOPES\` callers via deploy config, re-render, re-run
\`packages/contracts/tests/vault-policies.test.ts\` (22 offline cases pin the
matrix incl. renewal/expiry/outage and value-free errors).

The dev fixture used by tests lives at
\`packages/contracts/tests/stubs/vault-dev-fixture.ts\` (in-memory KV v2: CAS,
metadata masking, virtual-clock tokens, outage/timeout). A real dev-Vault
compose boot (SEC-07 infra) is a separate follow-up once SEC-00 lands.
