ui = true
disable_mlock = false

api_addr = "http://vault:8200"
cluster_addr = "http://du-vault-persistent:8201"

storage "raft" {
  # The official image prepares /vault/file with the runtime Vault UID/GID.
  path    = "/vault/file"
  node_id = "du-vault-persistent"
}

listener "tcp" {
  address         = "0.0.0.0:8200"
  cluster_address = "0.0.0.0:8201"
  tls_disable     = true
}
