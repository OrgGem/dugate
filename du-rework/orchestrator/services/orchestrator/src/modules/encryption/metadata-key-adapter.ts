/**
 * Delta 61: adapt the Vault Transit `KeyProvider` to the metadata seam's
 * `MetadataKeyProvider`.
 *
 * The two interfaces are NOT structurally identical, which is why this is an
 * adapter and not a cast:
 *
 *   KeyProvider          wrapDek({keyRef, dek, keyVersion}) -> {keyRef, keyVersion, ciphertext}
 *   MetadataKeyProvider  wrapDek(dek, keyRef, keyVersion)    -> {version, keyName, keyVersion, wrappedKey}
 *
 * Two things differ beyond the field names, and both are load-bearing:
 *  1. ARGUMENT ORDER: object-with-fields vs positional. Passing the object to a
 *     positional signature would silently bind `keyRef` to the DEK bytes.
 *  2. `MetadataWrappedDek` is SELF-DESCRIBING: it carries `version` and the
 *     `keyName` it was wrapped under, so a reader does not need the keyRef to be
 *     told which key to use. The Vault shape does not. Copying the keyRef into
 *     `keyName` is what makes an envelope opened in a later process (a different
 *     request, a restarted server) still know its own key.
 *
 * Nothing here decides WHETHER encryption is on. That is the caller's job, and
 * the seam stays optional everywhere: absent config means the plaintext path,
 * exactly as before this delta.
 */
import type { KeyProvider, WrappedDek } from './vault-transit-provider';
import type { MetadataKeyProvider, MetadataWrappedDek } from '../runtime/metadata-crypto';

/** Envelope version stamped on metadata DEKs; matches MetadataWrappedDek.version. */
const METADATA_DEK_VERSION = 1;

export function adaptKeyProviderForMetadata(keyProvider: KeyProvider): MetadataKeyProvider {
  return {
    async wrapDek(dek: Buffer, keyRef: string, keyVersion?: number): Promise<MetadataWrappedDek> {
      const wrapped: WrappedDek = await keyProvider.wrapDek({ keyRef, dek, ...(keyVersion === undefined ? {} : { keyVersion }) });
      // keyName comes from the KEY the provider actually used, not from the
      // caller's argument: a provider that maps an opaque ref to a Vault name
      // would otherwise pin the wrong identity into the envelope.
      return {
        version: METADATA_DEK_VERSION,
        keyName: wrapped.keyRef,
        keyVersion: wrapped.keyVersion,
        wrappedKey: wrapped.ciphertext,
      };
    },
    async unwrapDek(wrapped: MetadataWrappedDek): Promise<Buffer> {
      return keyProvider.unwrapDek({
        keyRef: wrapped.keyName,
        keyVersion: wrapped.keyVersion,
        ciphertext: wrapped.wrappedKey,
      });
    },
  };
}
