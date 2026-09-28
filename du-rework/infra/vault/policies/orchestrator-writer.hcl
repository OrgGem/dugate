# VAULT-02 machine identity: orchestrator-writer
# AppRole/Kubernetes auth only — never the root token (SEC-04/07).
path "secret/data/du/connector/*" {
  capabilities = ["create", "update"]
}
path "secret/metadata/du/connector/*" {
  capabilities = ["read", "list"]
}
# No "read" capability on any data path: the writer never sees plaintext.
