import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { createPinnedFetch } from '@du/egress';

const MAX_ORIGINS = 64;
const MAX_ORIGIN_LIST_BYTES = 8_192;
const MAX_ORIGIN_BYTES = 2_048;

export interface WorkflowPrivateHttpsEgressPolicy {
  readonly origins: readonly string[];
  readonly digest: string;
  allowsPrivateNetworksForOrigin(origin: string): boolean;
  createPinnedFetchForOrigin(origin: string): typeof fetch;
}

/** Parse the operator-owned, comma-separated exact HTTPS origin list. */
export function parseWorkflowPrivateHttpsOrigins(value: string | undefined): readonly string[] {
  if (value === undefined || value === '') return Object.freeze([]);
  if (Buffer.byteLength(value, 'utf8') > MAX_ORIGIN_LIST_BYTES) {
    throw new Error('WORKFLOW_PRIVATE_HTTPS_ORIGINS exceeds the 8192-byte limit');
  }
  const entries = value.split(',');
  if (entries.length > MAX_ORIGINS) {
    throw new Error(`WORKFLOW_PRIVATE_HTTPS_ORIGINS may contain at most ${MAX_ORIGINS} origins`);
  }
  const origins = entries.map(validateCanonicalHttpsOrigin);
  if (new Set(origins).size !== origins.length) {
    throw new Error('WORKFLOW_PRIVATE_HTTPS_ORIGINS contains a duplicate origin');
  }
  return Object.freeze(origins);
}

/** Build a private-per-worker policy; the captured origin set is never exposed. */
export function createWorkflowPrivateHttpsEgressPolicy(
  configuredOrigins: readonly string[] = [],
): WorkflowPrivateHttpsEgressPolicy {
  if (!Array.isArray(configuredOrigins) || configuredOrigins.length > MAX_ORIGINS) {
    throw new Error(`Workflow private HTTPS policy may contain at most ${MAX_ORIGINS} origins`);
  }
  const origins = configuredOrigins.map(validateCanonicalHttpsOrigin);
  const listBytes = origins.reduce((total, origin) => total + Buffer.byteLength(origin, 'utf8'), 0)
    + Math.max(0, origins.length - 1);
  if (listBytes > MAX_ORIGIN_LIST_BYTES) {
    throw new Error('Workflow private HTTPS policy exceeds the 8192-byte limit');
  }
  if (new Set(origins).size !== origins.length) {
    throw new Error('Workflow private HTTPS policy contains a duplicate origin');
  }
  origins.sort();
  const immutableOrigins = Object.freeze([...origins]);
  const privateOrigins = new Set(immutableOrigins);
  const digest = `sha256:${createHash('sha256').update(JSON.stringify(immutableOrigins), 'utf8').digest('hex')}`;

  return Object.freeze({
    origins: immutableOrigins,
    digest,
    allowsPrivateNetworksForOrigin(origin: string): boolean {
      return privateOrigins.has(origin);
    },
    createPinnedFetchForOrigin(origin: string): typeof fetch {
      return createPinnedFetch({
        timeoutMs: 15_000,
        allowPrivateNetworks: privateOrigins.has(origin),
      });
    },
  });
}

function validateCanonicalHttpsOrigin(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > MAX_ORIGIN_BYTES ||
    value.trim() !== value ||
    /[\s*]/.test(value)
  ) {
    throw new Error('WORKFLOW_PRIVATE_HTTPS_ORIGINS entries must be canonical HTTPS origins');
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('WORKFLOW_PRIVATE_HTTPS_ORIGINS entries must be canonical HTTPS origins');
  }

  const hostname = parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']')
    ? parsed.hostname.slice(1, -1)
    : parsed.hostname;
  const isIpAddress = isIP(hostname) !== 0;
  const validDnsName = hostname.length <= 253 && !hostname.endsWith('.') && hostname.split('.').every((label) =>
    label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
  );
  const validPort = parsed.port === '' || (Number(parsed.port) >= 1 && Number(parsed.port) <= 65_535);

  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.pathname !== '/' ||
    parsed.hostname === '' ||
    !validPort ||
    (!isIpAddress && !validDnsName) ||
    parsed.origin !== value
  ) {
    throw new Error('WORKFLOW_PRIVATE_HTTPS_ORIGINS entries must be canonical HTTPS origins');
  }
  return value;
}
