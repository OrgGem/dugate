/**
 * CONV-03: crypto-config composition wiring, moved verbatim out of server.ts.
 * `buildCryptoConfigOptions` is called ONCE per app so the store keeps state;
 * `registerAdminCryptoConfigWiring` registers the shell pane resolver against
 * the same service instance the JSON API uses.
 */
import { HttpError } from '../../http/errors';
import type { Db } from '../../db/db';
import {
  applyCryptoConfig,
  readCryptoConfig,
  recipientKeyOptions,
  type CryptoConfigAudit,
  type CryptoConfigServiceOptions,
  type CryptoConfigStore,
} from '../admin/crypto-config-api';
import { PostgresCryptoConfigStore } from '../admin/crypto-config-store';
import {
  EMPTY_CRYPTO_CONFIG,
  type CryptoConfigPane,
  type CryptoConfigState,
} from '../admin/crypto-config-view-models';
import { registerCryptoConfigWiring } from '../admin/shell-router';
import type { DeliveryEncryptionConfig } from '../../modules/public-api';
import type { ServerConfig } from '../../server';

/**
 * ENC-08: build the crypto-configuration service options from platform config.
 *
 * Called ONCE per app, not per request, because the store holds state: a per-request
 * store would silently forget every change the moment the next request arrived, which
 * looks exactly like "the Admin save did nothing".
 *
 * A database-backed store persists settings across restarts. The in-memory fallback is
 * retained for callers that build the service without a database. The recipient key
 * registry defaults to the ENC-06 instance ENC-07 delivery already uses, so there is one
 * key source rather than two that can drift.
 */
export function buildCryptoConfigOptions(
  config: ServerConfig,
  audit: CryptoConfigAudit,
  db?: Pick<Db, 'query'>,
): CryptoConfigServiceOptions | null {
  if (!config.cryptoConfig) return null;
  let store: CryptoConfigStore;
  if (db) {
    store = new PostgresCryptoConfigStore(db, config.cryptoConfig.allowedKeyRefs);
  } else {
    const rows = new Map<string, CryptoConfigState>();
    store = {
      async get(tenantId) {
        return rows.get(tenantId) ?? EMPTY_CRYPTO_CONFIG;
      },
      async set(tenantId, next) {
        rows.set(tenantId, next);
        return next;
      },
    };
  }
  const registry =
    config.cryptoConfig.recipientKeyRegistry ?? config.deliveryEncryption?.recipientKeyRegistry;
  return {
    allowedKeyRefs: config.cryptoConfig.allowedKeyRefs,
    store,
    keys: {
      async listRecipientKeys(tenantId: string) {
        if (!registry) return [];
        return recipientKeyOptions(await registry.listKeys(tenantId), tenantId);
      },
    },
    audit,
  };
}

/**
 * W-ENC-08-WIRE-ENC07: the delivery-encryption configuration the app actually
 * runs with. When the crypto-config surface is configured, the policy comes from
 * its store - the Admin toggle and the pinned key version - so an operator's change
 * applies to the next delivery without a restart. Static `policyByTenant` is kept
 * only as the fallback for a platform with no crypto-config surface, and the
 * recipient key registry is the same instance for both consumers.
 */
/**
 * W-ADM-UX-08-SHELL (Delta 106): the Admin shell's crypto-configuration
 * wiring, built from the SAME service the JSON API uses.
 *
 * The shell sub-server builds its `ShellRuntimeConfig` from a fixed field list
 * inside shell-server.ts, which is outside this packet's scope, so the resolver
 * is registered into the shell router instead of threaded through
 * `ServerConfig`. Registering here - once, at composition - is what keeps the
 * pane and the API from ever disagreeing about a tenant's configuration.
 *
 * Both directions take the tenant from the request and pass it to the service,
 * so the allowlist / revocation / pin rules are enforced in ONE place. The
 * router has already gated the route on a signed admin session and, for the
 * POST, on the server-derived CSRF proof; nothing here re-derives a role.
 *
 * Absent configuration (no `cryptoConfig` block) registers `undefined`, which
 * renders the pane's honest error state instead of a fabricated one.
 */
export function registerAdminCryptoConfigWiring(
  config: ServerConfig,
  cryptoConfig: CryptoConfigServiceOptions | null,
): void {
  if (!config.cryptoConfig || !cryptoConfig) {
    registerCryptoConfigWiring({});
    return;
  }
  const service = cryptoConfig;
  // The shell authenticates to itself as the platform operator; the tenant
  // being edited is the one the request names.
  const auth = { principal: { role: 'platform' as const } };
  const paneFor = async (request: { query?: Record<string, string> }): Promise<CryptoConfigPane> => {
    const tenantId = (request.query?.['tenantId'] ?? '').trim();
    if (!tenantId) return { status: 'error', code: 'CRYPTO_CONFIG_TENANT_REQUIRED' };
    try {
      const view = await readCryptoConfig(service, { auth, tenantId });
      return { status: 'ready', view };
    } catch (err) {
      if (err instanceof HttpError && err.status === 403) {
        return { status: 'error', code: 'CRYPTO_CONFIG_FORBIDDEN' };
      }
      return { status: 'error', code: 'CRYPTO_CONFIG_UNAVAILABLE' };
    }
  };
  registerCryptoConfigWiring({
    pane: (request) => paneFor(request),
    apply: async (input) => {
      const result = await applyCryptoConfig(service, {
        auth,
        tenantId: input.tenantId,
        mutation: {
          storageKeyRef: input.storageKeyRef,
          deliveryEncryption: input.deliveryEncryption,
          recipientKeyVersion: input.recipientKeyVersion,
        },
      });
      return { status: 'ready', view: result.view };
    },
  });
}
export function buildDeliveryEncryptionConfig(
  config: ServerConfig,
  cryptoConfig: CryptoConfigServiceOptions | null,
): DeliveryEncryptionConfig | undefined {
  const staticPolicy = config.deliveryEncryption;
  if (!staticPolicy && !cryptoConfig) return undefined;
  const store = cryptoConfig?.store;
  return {
    ...(staticPolicy ?? {}),
    recipientKeyRegistry:
      staticPolicy?.recipientKeyRegistry
      ?? config.cryptoConfig?.recipientKeyRegistry,
    policySource: store
      ? {
          async getDeliveryPolicy(tenantId: string) {
            const state = await store.get(tenantId);
            return {
              enabled: state.deliveryEncryption,
              pinnedRecipientKeyVersion: state.pinnedRecipientKeyVersion,
            };
          },
        }
      : undefined,
  };
}
