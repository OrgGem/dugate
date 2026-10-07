import { createCredentialWorkflow, type ConnectorRevisionStore, type CredentialWorkflow, type TrustedInitialBinding } from './workflow';
import { createVaultKv2CredentialWriter } from './vault-kv2-writer';

/**
 * CREDWORKFLOW-IMPL (D3 adjudication): boot composition for the production
 * credential workflow.
 *
 * Policy, exactly as adjudicated:
 *   - ALL env absent  → `undefined` (workflow off; capabilities report
 *     `credentialWorkflow:false`, the surface stays 503 fail-closed);
 *   - env PARTIAL or malformed → REFUSE BOOT with a typed error — a
 *     half-configured production must not boot into silent 503s
 *     (same philosophy as `EncryptionBootConfigError`);
 *   - explicit `config.credentialWorkflow` keeps overriding the composition.
 */

export const VAULT_KV_OPTIONS_ENV = 'DU_VAULT_KV_OPTIONS';
export const VAULT_KV_TOKEN_ENV = 'DU_VAULT_KV_TOKEN';
export const CONNECTOR_INITIAL_BINDINGS_ENV = 'DU_CONNECTOR_INITIAL_BINDINGS';

export class CredentialWorkflowBootError extends Error {
  public constructor(message: string) {
    super('refusing to boot: ' + message);
    this.name = 'CredentialWorkflowBootError';
  }
}

export type CredentialWorkflowEnv = Readonly<Record<string, string | undefined>>;

function present(env: CredentialWorkflowEnv, name: string): string | undefined {
  const value = env[name];
  return value !== undefined && value.length > 0 ? value : undefined;
}

/** True when the operator asked for the workflow (any of the envs is set). */
export function credentialWorkflowEnvRequested(env: CredentialWorkflowEnv): boolean {
  return (
    present(env, VAULT_KV_OPTIONS_ENV) !== undefined ||
    present(env, VAULT_KV_TOKEN_ENV) !== undefined ||
    present(env, CONNECTOR_INITIAL_BINDINGS_ENV) !== undefined
  );
}

function parseOptions(raw: string): { vaultAddress: string; kvMount?: string; requestTimeoutMs?: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CredentialWorkflowBootError(VAULT_KV_OPTIONS_ENV + ' must be valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CredentialWorkflowBootError(VAULT_KV_OPTIONS_ENV + ' must be a JSON object');
  }
  const record = parsed as Record<string, unknown>;
  const vaultAddress = record['vaultAddress'];
  if (typeof vaultAddress !== 'string' || !/^https?:\/\//.test(vaultAddress)) {
    throw new CredentialWorkflowBootError(VAULT_KV_OPTIONS_ENV + '.vaultAddress must be an absolute http(s) URL');
  }
  const kvMount = record['kvMount'];
  if (kvMount !== undefined && (typeof kvMount !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/i.test(kvMount))) {
    throw new CredentialWorkflowBootError(VAULT_KV_OPTIONS_ENV + '.kvMount must be a valid mount name');
  }
  const requestTimeoutMs = record['requestTimeoutMs'];
  if (
    requestTimeoutMs !== undefined &&
    (typeof requestTimeoutMs !== 'number' || !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1)
  ) {
    throw new CredentialWorkflowBootError(VAULT_KV_OPTIONS_ENV + '.requestTimeoutMs must be a positive integer');
  }
  return {
    vaultAddress,
    ...(kvMount === undefined ? {} : { kvMount: kvMount as string }),
    ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs: requestTimeoutMs as number }),
  };
}

function parseInitialBindings(raw: string): Record<string, TrustedInitialBinding> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CredentialWorkflowBootError(CONNECTOR_INITIAL_BINDINGS_ENV + ' must be valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CredentialWorkflowBootError(CONNECTOR_INITIAL_BINDINGS_ENV + ' must be a JSON object');
  }
  const out: Record<string, TrustedInitialBinding> = {};
  for (const [connectorId, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof connectorId !== 'string' || connectorId.length === 0) {
      throw new CredentialWorkflowBootError(CONNECTOR_INITIAL_BINDINGS_ENV + ' has an empty connector id');
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new CredentialWorkflowBootError(CONNECTOR_INITIAL_BINDINGS_ENV + '.' + connectorId + ' must be an object');
    }
    const entry = value as Record<string, unknown>;
    const tenantId = entry['tenantId'];
    const accountId = entry['accountId'];
    if (typeof tenantId !== 'string' || tenantId.length === 0 || typeof accountId !== 'string' || accountId.length === 0) {
      throw new CredentialWorkflowBootError(
        CONNECTOR_INITIAL_BINDINGS_ENV + '.' + connectorId + ' requires non-empty tenantId and accountId'
      );
    }
    out[connectorId] = { tenantId, accountId };
  }
  return out;
}

export interface ComposeCredentialWorkflowInput {
  env: CredentialWorkflowEnv;
  /** The connector revision port (built from the same connector base URL). */
  revisions: ConnectorRevisionStore;
  fetchImpl?: typeof fetch;
}

export function composeCredentialWorkflow(input: ComposeCredentialWorkflowInput): CredentialWorkflow | undefined {
  const { env } = input;
  if (!credentialWorkflowEnvRequested(env)) return undefined;

  const optionsRaw = present(env, VAULT_KV_OPTIONS_ENV);
  const tokenRaw = present(env, VAULT_KV_TOKEN_ENV);
  if (optionsRaw === undefined) {
    throw new CredentialWorkflowBootError(
      VAULT_KV_OPTIONS_ENV + ' is required when ' + VAULT_KV_TOKEN_ENV + '/' + CONNECTOR_INITIAL_BINDINGS_ENV + ' are set'
    );
  }
  if (tokenRaw === undefined) {
    throw new CredentialWorkflowBootError(VAULT_KV_TOKEN_ENV + ' is required when ' + VAULT_KV_OPTIONS_ENV + ' is set');
  }
  const bindingsRaw = present(env, CONNECTOR_INITIAL_BINDINGS_ENV);
  const options = parseOptions(optionsRaw);
  const initialBindings = bindingsRaw === undefined ? undefined : parseInitialBindings(bindingsRaw);

  const vault = createVaultKv2CredentialWriter({
    vaultAddress: options.vaultAddress,
    ...(options.kvMount === undefined ? {} : { kvMount: options.kvMount }),
    // The token is read lazily per call (machine identity may rotate); the
    // env value is captured once at boot exactly like the Transit identity.
    token: () => tokenRaw,
    ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
  });

  // createCredentialWorkflow itself fail-closes on malformed initial
  // bindings (workflow.ts) — the parse above only guards the wire shape.
  return createCredentialWorkflow({
    vault,
    revisions: input.revisions,
    ...(initialBindings === undefined ? {} : { initialBindings }),
  });
}
