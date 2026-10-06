# Reproducible local candidate for the Orchestrator, Connector, and worker images.
# Run from the repository root; set DU_IMAGE_TAG to a unique candidate tag.
variable "DU_IMAGE_PREFIX" {
  default = "du"
}

variable "DU_IMAGE_TAG" {
  default = "candidate-local"
}

target "_candidate" {
  context    = "."
  dockerfile = "Dockerfile"
  pull       = true
  no-cache   = true
}

target "orchestrator" {
  inherits = ["_candidate"]
  target   = "orchestrator"
  tags     = ["${DU_IMAGE_PREFIX}-orchestrator:${DU_IMAGE_TAG}"]
}

target "connector" {
  inherits = ["_candidate"]
  target   = "connector"
  tags     = ["${DU_IMAGE_PREFIX}-connector:${DU_IMAGE_TAG}"]
}

target "document-core" {
  inherits = ["_candidate"]
  target   = "document-core"
  tags     = ["${DU_IMAGE_PREFIX}-document-core:${DU_IMAGE_TAG}"]
}

target "lc-checker" {
  inherits = ["_candidate"]
  target   = "lc-checker"
  tags     = ["${DU_IMAGE_PREFIX}-lc-checker:${DU_IMAGE_TAG}"]
}

target "example-review" {
  inherits = ["_candidate"]
  target   = "example-review"
  tags     = ["${DU_IMAGE_PREFIX}-example-review:${DU_IMAGE_TAG}"]
}

group "candidate" {
  targets = ["orchestrator", "connector", "document-core", "lc-checker", "example-review"]
}
