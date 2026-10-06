import { hashInvocationInput as contractsHash } from '@du/contracts';
import {
  hashInvocationInput,
  jsonHttpAdapter,
  multipartHttpAdapter,
  parseContractInvocationRequest,
  toContractInvocationResponse,
} from '../src';
import type { AdapterConfig, LocalInvocationRequest } from '../src';

/**
 * SESSION-LEG - close delta-4 of S745-CONSUME (provider side).
 *
 * delta-4, verbatim from the SESSION-CONSUME impl receipt:
 *   "sessionRef len wire qua `InvocationRequest.sessionRef` (contract da co) nhung
 *    **provider co that su doc/gan no hay khong la quyet dinh phia Connector**; offline chi
 *    chung minh SDK/dat do, khong chung minh provider ton tai session. Can leg Connector
 *    (P745-ACQ/connector lane) xac nhan."
 *
 * ## Why this suite exists at all
 *
 * Every pre-existing connector fixture passes `sessionRef: null` - all seven of them
 * (`connector.test.ts`, `p8-03-convergence`, `r1-d-lifecycle-offline`,
 * `r1-d-03-mock-provider-reconciliation`, `p745-options-passthrough`,
 * `canonical-hash-parity`). So the forwarding path existed in code but had ZERO
 * evidence for a real session: a `null` ref exercises none of it. These tests
 * inject a non-null ref and assert it reaches the provider.
 *
 * ## What this suite does NOT prove
 *
 * The mock provider has no `sessionRef` handling at all (grep: 0 matches under
 * `tests/mock-provider`). So nothing here proves a real provider PERSISTS a session
 * or re-emits the same handle. This suite proves only the connector-side plumbing:
 * SDK -> connector request -> provider body, provider body -> normalized result ->
 * wire response, and the canonical hash. Provider session semantics remain open.
 */

const SESSION = 'sess_01HZ3M8QWERTYUIOPASDFGHJKL';
const OTHER_SESSION = 'sess_01HZ3M9ZXCVBNMASDFGHJKLQW';

function req(overrides: Partial<LocalInvocationRequest> = {}): LocalInvocationRequest {
  return {
    contractVersion: '1',
    invocationId: 'inv-p745-session',
    tenantId: 'tenant-1',
    operationId: '11111111-1111-4111-8111-111111111111',
    taskId: '22222222-2222-4222-8222-222222222222',
    stepKey: 'extract-document',
    bindingSlot: 'reasoning',
    input: { prompt: 'extract', task: 'extract_custom' },
    options: {},
    sessionRef: SESSION,
    deadlineAt: '2099-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const jsonConfig: AdapterConfig = {
  baseUrl: 'https://provider.example/',
  path: '/v1/infer',
  timeoutMs: 1000,
};

const multipartConfig: AdapterConfig = {
  baseUrl: 'https://provider.example/',
  path: '/v1/ocr',
  timeoutMs: 1000,
};

function jsonBody(request: LocalInvocationRequest, config: AdapterConfig = jsonConfig): Record<string, unknown> {
  const built = jsonHttpAdapter.buildRequest(request, config);
  return JSON.parse(built.body as string) as Record<string, unknown>;
}

describe('SESSION-LEG: sessionRef reaches the provider request (delta-4)', () => {
  test('json adapter forwards a REAL sessionRef into the provider body verbatim', () => {
    const body = jsonBody(req());
    expect(body.sessionRef).toBe(SESSION);
  });

  test('multipart adapter forwards a REAL sessionRef into the form field', () => {
    const built = multipartHttpAdapter.buildRequest(req(), multipartConfig);
    const form = built.body as FormData;
    expect(form.get('sessionRef')).toBe(SESSION);
  });

  test('the ref is forwarded alongside the input, not in place of it', () => {
    const body = jsonBody(req());
    expect(body.sessionRef).toBe(SESSION);
    expect(body.task).toBe('extract_custom');
    // The default mapping FLATTENS input into the body: prompt lands at the top
    // level, not under an `input` key.
    expect(body.prompt).toBe('extract');
    expect(body.input).toBeUndefined();
  });

  test('a custom mapping that RENAMES the field still carries it', () => {
    // mapping is destination -> sourcePath, so the destination key is the
    // provider-facing name and the value is where to read it on the source.
    const body = jsonBody(req(), { ...jsonConfig, requestMapping: { session_ref: 'sessionRef', prompt: 'input.prompt' } });
    expect(body.session_ref).toBe(SESSION);
  });
});

describe('SESSION-LEG: absent-ref shape differs between the two adapters', () => {
  test('json sends sessionRef: null explicitly when there is no session', () => {
    const body = jsonBody(req({ sessionRef: null }));
    expect(body.sessionRef).toBeNull();
  });

  test('multipart OMITS the sessionRef form field entirely when there is no session', () => {
    const built = multipartHttpAdapter.buildRequest(req({ sessionRef: null }), multipartConfig);
    const form = built.body as FormData;
    expect(form.has('sessionRef')).toBe(false);
  });

  test('the two adapters disagree on the absent case - pinned, not endorsed', () => {
    // json: `sessionRef: null` is a real field. multipart: the field is gone.
    // A provider written against the json shape sees an explicit null; one
    // written against multipart sees an absent key. Neither is wrong on its own,
    // but a provider cannot treat the two shapes identically. See receipt delta-2.
    expect(jsonBody(req({ sessionRef: null })).sessionRef).toBeNull();
    const form = multipartHttpAdapter.buildRequest(req({ sessionRef: null }), multipartConfig).body as FormData;
    expect(form.has('sessionRef')).toBe(false);
  });
});

describe('SESSION-LEG: sessionRef is part of the invocation identity', () => {
  test('a different sessionRef produces a different canonical hash', () => {
    expect(hashInvocationInput(req())).not.toBe(hashInvocationInput(req({ sessionRef: OTHER_SESSION })));
  });

  test('a sessionRef hashes differently from no session at all', () => {
    expect(hashInvocationInput(req())).not.toBe(hashInvocationInput(req({ sessionRef: null })));
  });

  test('the connector hash agrees with the contracts-side canonical hash', () => {
    const r = req();
    expect(hashInvocationInput(r)).toBe(contractsHash({
      contractVersion: r.contractVersion,
      tenantId: r.tenantId,
      operationId: r.operationId,
      taskId: r.taskId,
      stepKey: r.stepKey,
      bindingSlot: r.bindingSlot,
      input: r.input,
      options: r.options,
      sessionRef: r.sessionRef,
      deadlineAt: r.deadlineAt,
    }));
  });
});

describe('SESSION-LEG: the ref comes back from the provider', () => {
  test('normalizeResponse maps a provider-returned sessionRef into the result', () => {
    const normalized = jsonHttpAdapter.normalizeResponse(
      { status: 200, body: { content: 'ok', sessionRef: SESSION } },
      jsonConfig
    );
    expect(normalized.sessionRef).toBe(SESSION);
  });

  test('the result carries the ref out on the connector wire response', () => {
    const normalized = jsonHttpAdapter.normalizeResponse(
      { status: 200, body: { content: 'ok', sessionRef: SESSION } },
      jsonConfig
    );
    const wire = toContractInvocationResponse('inv-p745-session', { state: 'completed', result: normalized });
    expect(wire.result?.sessionRef).toBe(SESSION);
  });

  test('ROUND-TRIP: the same ref that went out comes back in', () => {
    const request = req();
    const body = jsonBody(request);
    // The provider echoes the handle it was handed.
    const normalized = jsonHttpAdapter.normalizeResponse(
      { status: 200, body: { content: 'ok', sessionRef: body.sessionRef } },
      jsonConfig,
    );
    expect(normalized.sessionRef).toBe(SESSION);
    expect(normalized.sessionRef).toBe(body.sessionRef);
  });

  test('a provider that returns no sessionRef yields undefined, not a stale one', () => {
    const normalized = jsonHttpAdapter.normalizeResponse(
      { status: 200, body: { content: 'ok' } },
      jsonConfig,
    );
    expect(normalized.sessionRef).toBeUndefined();
  });
});

describe('SESSION-LEG: inbound contract hop (SDK -> connector)', () => {
  function envelope(sessionRef?: unknown): Record<string, unknown> {
    const base: Record<string, unknown> = {
      contractVersion: '1',
      invocationId: 'inv-p745-session',
      grant: 'signed.token.value',
      operationId: '11111111-1111-4111-8111-111111111111',
      taskId: '22222222-2222-4222-8222-222222222222',
      stepKey: 'extract-document',
      bindingSlot: 'reasoning',
      input: { prompt: 'extract' },
      deadlineAt: '2099-01-01T00:00:00.000Z',
    };
    if (sessionRef !== undefined) base.sessionRef = sessionRef;
    return base;
  }

  test('a non-null sessionRef survives the inbound strict parse', () => {
    expect(parseContractInvocationRequest(envelope(SESSION)).sessionRef).toBe(SESSION);
  });

  test('null and absent are both accepted by the contract', () => {
    expect(parseContractInvocationRequest(envelope(null)).sessionRef).toBeNull();
    expect(parseContractInvocationRequest(envelope()).sessionRef).toBeUndefined();
  });
});

describe('SESSION-LEG gap pins: custom mappings can drop the ref', () => {
  test('json + a custom mapping that omits sessionRef SILENTLY DROPS it', () => {
    // Current behavior, pinned so it cannot change unnoticed. Unlike
    // `artifacts` - which the adapter force-includes because authorized document
    // bytes must reach the provider - there is no such floor for sessionRef.
    const body = jsonBody(req(), { ...jsonConfig, requestMapping: { prompt: 'input.prompt' } });
    expect(body.sessionRef).toBeUndefined();
    expect(body.prompt).toBe('extract');
  });

  test('the same custom mapping does NOT drop it on multipart (asymmetry)', () => {
    // The multipart adapter never consults requestMapping for sessionRef, so the
    // two adapters answer the same config differently. See receipt delta-1.
    const built = multipartHttpAdapter.buildRequest(req(), {
      ...multipartConfig,
      requestMapping: { prompt: 'input.prompt' },
    });
    expect((built.body as FormData).get('sessionRef')).toBe(SESSION);
  });

  test('a custom responseMapping that omits sessionRef drops the returned ref', () => {
    const normalized = jsonHttpAdapter.normalizeResponse(
      { status: 200, body: { content: 'ok', sessionRef: SESSION } },
      { ...jsonConfig, responseMapping: { content: 'content' } },
    );
    expect(normalized.sessionRef).toBeUndefined();
  });
});