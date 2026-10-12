/** JSON-only admission snapshots kept in memory while a result is uncertain. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type DeepReadonly<T> = T extends string | number | boolean | null
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export type AttemptState = 'READY' | 'SENDING' | 'UNCERTAIN' | 'ACCEPTED';

export type ImmutableAttempt<T extends { tenantId: string }> = Readonly<{
  tenantId: string;
  idempotencyKey: string;
  request: DeepReadonly<T>;
  state: AttemptState;
  operationId?: string;
}>;

type TenantAttemptEntry = {
  tenantId: string;
  idempotencyKey: string;
  request: unknown;
  state: AttemptState;
  operationId?: string;
};

/** In-memory, tenant-partitioned attempt storage shared by the Admin screens.
 * An accepted operation can only be removed after matching terminal evidence. */
export class TenantAttemptRegistry<Attempt extends TenantAttemptEntry> {
  private readonly attempts = new Map<string, Attempt>();

  get(tenantId: string): Attempt | null {
    return this.attempts.get(tenantId) ?? null;
  }

  has(tenantId: string): boolean {
    return this.attempts.has(tenantId);
  }

  set(tenantId: string, attempt: Attempt | null): boolean {
    if (!tenantId || tenantId.length > 128) throw new Error('Attempt registry requires a bounded tenant scope.');
    if (attempt && attempt.tenantId !== tenantId) throw new Error('Attempt registry scope does not match the request tenant.');
    const current = this.attempts.get(tenantId);
    if (current?.state === 'ACCEPTED'
      && (!attempt || attempt.state !== 'ACCEPTED' || attempt.operationId !== current.operationId
        || attempt.idempotencyKey !== current.idempotencyKey || attempt.request !== current.request)) return false;
    if (attempt) this.attempts.set(tenantId, attempt);
    else this.attempts.delete(tenantId);
    return true;
  }

  /** Clear only the accepted operation whose terminal state was just observed. */
  clearAcceptedOperation(tenantId: string, operationId: string): boolean {
    const current = this.attempts.get(tenantId);
    if (!current || current.state !== 'ACCEPTED' || current.operationId !== operationId) return false;
    this.attempts.delete(tenantId);
    return true;
  }
}

type UploadedArtifact = { tenantId: string; apiKeyId: string; artifactId: string };

/** File upload reuse is based on object identity and its exact auth context.
 * Filenames, lengths and timestamps are deliberately not cache keys. */
export class FileArtifactCache<FileRef extends object> {
  private readonly entries = new WeakMap<FileRef, UploadedArtifact>();

  get(file: FileRef, tenantId: string, apiKeyId: string): string | null {
    const entry = this.entries.get(file);
    return entry?.tenantId === tenantId && entry.apiKeyId === apiKeyId ? entry.artifactId : null;
  }

  set(file: FileRef, tenantId: string, apiKeyId: string, artifactId: string): void {
    if (!tenantId || tenantId.length > 128 || !apiKeyId || apiKeyId.length > 256 || !artifactId || artifactId.length > 256) {
      throw new Error('Uploaded artifact cache requires bounded tenant, key and artifact identities.');
    }
    this.entries.set(file, { tenantId, apiKeyId, artifactId });
  }
}

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_DEPTH = 32;
const MAX_NODES = 20_000;

function cloneJson(value: unknown, depth: number, budget: { nodes: number }): JsonValue {
  budget.nodes += 1;
  if (budget.nodes > MAX_NODES || depth > MAX_DEPTH) throw new Error('Admission request exceeds its structural limit.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Admission request contains a non-finite number.');
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_NODES) throw new Error('Admission request contains an oversized array.');
    const copy: JsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) throw new Error('Admission request contains a sparse array.');
      copy.push(cloneJson(value[index], depth + 1, budget));
    }
    return copy;
  }
  if (typeof value !== 'object') throw new Error('Admission request must contain JSON values only.');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error('Admission request contains a non-plain object.');
  const keys = Object.keys(value);
  if (keys.length > 512) throw new Error('Admission request contains too many object fields.');
  const copy: Record<string, JsonValue> = {};
  for (const key of keys) {
    if (key.length > 256) throw new Error('Admission request contains an oversized field name.');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new Error('Admission request contains an accessor property.');
    Object.defineProperty(copy, key, {
      value: cloneJson(descriptor.value, depth + 1, budget),
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return copy;
}

function freezeDeep<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

/**
 * Capture the exact JSON request before admission is dispatched. The clone is
 * detached from editable form state and frozen so a later retry cannot change
 * artifact IDs, tenant scope, or any other request field.
 */
export function createImmutableAttempt<T extends { tenantId: string }>(
  tenantId: string,
  idempotencyKey: string,
  request: T,
): ImmutableAttempt<T> {
  if (!tenantId || tenantId.length > 128 || request.tenantId !== tenantId) {
    throw new Error('Admission request tenant does not match its captured scope.');
  }
  if (!idempotencyKey || idempotencyKey.length > 256) throw new Error('Admission request requires a bounded idempotency key.');
  const copy = cloneJson(request, 0, { nodes: 0 });
  if (copy === null || Array.isArray(copy) || typeof copy !== 'object') throw new Error('Admission request must be a JSON object.');
  const serialized = JSON.stringify(copy);
  if (new TextEncoder().encode(serialized).byteLength > MAX_REQUEST_BYTES) throw new Error('Admission request exceeds its byte limit.');
  return Object.freeze({
    tenantId,
    idempotencyKey,
    request: freezeDeep(copy) as DeepReadonly<T>,
    state: 'READY' as const,
  });
}

/** Unknown transport/server outcomes stay uncertain, including after later
 * authorization, stale-revision, or conflict rejections. */
export function classifyAdmissionFailure(
  status: number,
  priorState: AttemptState,
): 'UNCERTAIN' | 'DEFINITIVE_REJECTION' {
  if (priorState === 'UNCERTAIN' || priorState === 'ACCEPTED') return 'UNCERTAIN';
  if (!Number.isInteger(status) || status < 400 || status > 599) return 'UNCERTAIN';
  if (status === 408 || status === 425 || status === 429 || status >= 500) return 'UNCERTAIN';
  return 'DEFINITIVE_REJECTION';
}

export function markAttemptDispatched<T extends { tenantId: string }>(
  attempt: ImmutableAttempt<T>,
): ImmutableAttempt<T> {
  if (attempt.state !== 'READY') return attempt;
  return Object.freeze({ ...attempt, state: 'SENDING' as const });
}

export function retainAfterFailure<T extends { tenantId: string }>(
  attempt: ImmutableAttempt<T>,
  status: number,
): ImmutableAttempt<T> | null {
  if (attempt.state === 'ACCEPTED') return attempt;
  if (classifyAdmissionFailure(status, attempt.state) === 'DEFINITIVE_REJECTION') return null;
  return Object.freeze({ ...attempt, state: 'UNCERTAIN' as const });
}

/** A 2xx admission only resolves the request when the server returned an ID. */
export function acceptAttempt<T extends { tenantId: string }>(
  attempt: ImmutableAttempt<T>,
  operationId: string,
): ImmutableAttempt<T> {
  if (!operationId || operationId.length > 256) throw new Error('Accepted request requires a bounded operation ID.');
  return Object.freeze({ ...attempt, state: 'ACCEPTED' as const, operationId });
}
