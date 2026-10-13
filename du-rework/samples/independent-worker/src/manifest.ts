import { createHash } from 'node:crypto';

export interface JsonSchema {
  [key: string]: unknown;
}

export interface BusinessManifest {
  contractVersion: '1';
  businessId: string;
  version: string;
  displayName: string;
  description: string;
  imageDigest: string;
  runtime: { wireVersion: '1'; handlerKinds: string[] };
  capabilities: { cancel: boolean; resume: boolean; parallel: boolean };
  actions: Array<{
    name: string;
    displayName: string;
    description: string;
    inputSchema: JsonSchema;
    outputSchema: JsonSchema;
    profileSchema: JsonSchema;
    connectorSlots: Array<{
      name: string;
      required: boolean;
      acceptedCapabilities: string[];
    }>;
    artifactPolicy: { minFiles: number; maxFiles: number; acceptedMimeTypes?: string[] };
    capabilities: { cancel: boolean; resume: boolean };
    defaultLimits: { maxParallelTasks?: number; timeoutSeconds?: number };
  }>;
}

export function createManifest(version: string, imageDigest: string): BusinessManifest {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error('BUSINESS_VERSION must be an exact semantic version');
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(imageDigest)) {
    throw new Error('WORKER_IMAGE_DIGEST must be sha256 followed by 64 lowercase hex characters');
  }

  return {
    contractVersion: '1',
    businessId: 'independent-worker',
    version,
    displayName: 'Independent Worker Sample',
    description: 'A standalone Runtime v1 protocol example that echoes short inline text.',
    imageDigest,
    runtime: { wireVersion: '1', handlerKinds: ['root'] },
    capabilities: { cancel: true, resume: false, parallel: true },
    actions: [{
      name: 'echo',
      displayName: 'Echo text',
      description: 'Return the submitted text in an inline sample result reference.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', minLength: 1, maxLength: 32768 } },
        required: ['text'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
      profileSchema: { type: 'object', additionalProperties: false },
      connectorSlots: [],
      artifactPolicy: { minFiles: 0, maxFiles: 0 },
      capabilities: { cancel: true, resume: false },
      defaultLimits: { maxParallelTasks: 4, timeoutSeconds: 60 },
    }],
  };
}

/** Runtime v1 canonical JSON: sort object keys recursively, preserve arrays. */
export function canonicalize(value: unknown): string {
  const sort = (current: unknown): unknown => {
    if (Array.isArray(current)) return current.map(sort);
    if (typeof current === 'object' && current !== null) {
      const output: Record<string, unknown> = {};
      for (const key of Object.keys(current as Record<string, unknown>).sort()) {
        const nested = (current as Record<string, unknown>)[key];
        if (nested !== undefined) output[key] = sort(nested);
      }
      return output;
    }
    return current;
  };
  return JSON.stringify(sort(value));
}

export function manifestDigest(manifest: BusinessManifest): string {
  return `sha256:${createHash('sha256').update(canonicalize(manifest)).digest('hex')}`;
}

export function contentHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalize(value)).digest('hex')}`;
}

export function businessQueueName(businessId: string, version: string): string {
  return `du-business-${businessId}-${version}`;
}
