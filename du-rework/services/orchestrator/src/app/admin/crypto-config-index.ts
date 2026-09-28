/**
 * ENC-08: Admin crypto configuration - Admin UI + Admin API for crypto configuration.
 *
 * ENC-08 UI/API modules and the Postgres store adapter are exported here. Server.ts
 * composition-root wiring remains a separate integration concern.
 */

export {
  CryptoConfigState,
  EMPTY_CRYPTO_CONFIG,
  RecipientKeyOption,
  CryptoConfigViewModel,
  CryptoConfigViewInput,
  effectiveRecipientKeyVersion,
  pinInvalidReason,
  fingerprintPreview,
  buildCryptoConfigView,
  CryptoConfigPane,
  cryptoConfigEmptyPane,
} from './crypto-config-view-models';

export {
  renderCryptoConfig,
  renderCryptoConfigForm,
} from './crypto-config-renderer';

export {
  CryptoConfigStore,
  RecipientKeyLister,
  CryptoConfigAudit,
  CryptoConfigServiceOptions,
  CryptoConfigAuth,
  CryptoConfigReadRequest,
  CryptoConfigMutation,
  CryptoConfigWriteRequest,
  CryptoConfigChange,
  recipientKeyOptions,
  readCryptoConfig,
  applyCryptoConfig,
  cryptoConfigPane,
  principalForRequest,
} from './crypto-config-api';

export {
  PostgresCryptoConfigStore,
  createPostgresCryptoConfigStore,
  PostgresCryptoConfigStoreOptions,
} from './crypto-config-store';
