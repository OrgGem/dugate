# VAULT-02 machine identity: connector-reader
# AppRole/Kubernetes auth only — never the root token (SEC-04/07).
path "secret/data/du/connector/*" {
  capabilities = ["read"]
}
path "secret/metadata/du/connector/*" {
  capabilities = ["read"]
}
# No create/update capability anywhere: the reader cannot mutate or rotate.
