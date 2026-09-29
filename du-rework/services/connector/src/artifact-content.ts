import { createHash } from 'node:crypto';
import { ConnectorError } from './errors';
import type { InvocationArtifactContent, InvocationArtifactPin } from '@du/contracts';

/** Decode only canonical base64 payloads whose metadata describes those bytes. */
export function decodeVerifiedArtifact(artifact: InvocationArtifactContent): Buffer {
  const bytes = Buffer.from(artifact.contentBase64, 'base64');
  if (
    bytes.byteLength !== artifact.sizeBytes ||
    bytes.toString('base64') !== artifact.contentBase64 ||
    createHash('sha256').update(bytes).digest('hex') !== artifact.sha256
  ) {
    throw new ConnectorError('BINDING_DENIED', 'Artifact content does not match its authorized integrity metadata.');
  }
  return bytes;
}

export function assertArtifactGrantBindings(
  artifacts: readonly InvocationArtifactContent[] | undefined,
  artifactIds: readonly string[] | undefined,
  artifactPins: readonly InvocationArtifactPin[] | undefined,
): void {
  const supplied = artifacts ?? [];
  const signedIds = artifactIds ?? [];
  const pins = artifactPins ?? [];
  if (supplied.length !== signedIds.length || supplied.length !== pins.length) {
    if (supplied.length || signedIds.length || pins.length) {
      throw new ConnectorError('BINDING_DENIED', 'Invocation grant does not authorize the supplied artifact set.');
    }
    return;
  }
  for (let index = 0; index < supplied.length; index += 1) {
    const artifact = supplied[index]!;
    const pin = pins[index]!;
    if (
      artifact.artifactId !== signedIds[index] ||
      artifact.artifactId !== pin.artifactId ||
      artifact.fileName !== pin.fileName ||
      artifact.mimeType !== pin.mimeType ||
      artifact.sizeBytes !== pin.sizeBytes ||
      artifact.sha256 !== pin.sha256 ||
      artifact.storageVersionId !== pin.storageVersionId
    ) {
      throw new ConnectorError('BINDING_DENIED', 'Invocation grant does not match the supplied artifact version.');
    }
    decodeVerifiedArtifact(artifact);
  }
}
