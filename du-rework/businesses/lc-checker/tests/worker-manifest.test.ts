import { lcCheckerHandlers, mainLcCheckerHandler, ocrChildHandler, visualChildHandler } from '../src/worker';
import { LC_CHECKER_HANDLER_KINDS, lcCheckerManifest } from '../src/manifest';
import { LC_DEFAULT_RULE_SET_VERSION, LC_RULE_SET_STATUS } from '../src/rules/rule-registry';
import { LC_CHECKER_INPUT_VERSION } from '../src/types';
import {
  compliantPayload,
  digestJoinEntry,
  discrepantPayload,
  makeHarness,
  ocrJoinEntry,
  screenPayload,
  validInput,
} from './fakes';

const action = lcCheckerManifest.actions[0]!;
const OCR_JOIN = {
  'ocr-0': ocrJoinEntry('invoice.pdf', 'INVOICE TEXT'),
  'ocr-1': ocrJoinEntry('bill-of-lading.pdf', 'BL TEXT'),
};
const VISUAL_JOIN = { 'visual-0': digestJoinEntry(1, true) };

/** The runtime hands a parent its join on the delivery AFTER the fan-out it is answering. */
function deliver(harness: ReturnType<typeof makeHarness>, joinSummary: Record<string, string>): void {
  Object.assign(harness.ctx.input, { joinSummary });
}

describe('P9-02 manifest', () => {
  it('declares the business the result claims to come from', () => {
    expect(lcCheckerManifest.businessId).toBe('lc-checker');
    expect(lcCheckerManifest.version).toBe('1.0.0');
    expect(lcCheckerManifest.capabilities).toEqual({ cancel: true, resume: true, parallel: true });
  });

  it('declares exactly the handler kinds the worker actually registers', () => {
    expect([...lcCheckerManifest.runtime.handlerKinds].sort()).toEqual([...LC_CHECKER_HANDLER_KINDS].sort());
    for (const kind of LC_CHECKER_HANDLER_KINDS) {
      expect(typeof lcCheckerHandlers[kind]).toBe('function');
    }
    expect(Object.keys(lcCheckerHandlers).sort()).toEqual([...LC_CHECKER_HANDLER_KINDS].sort());
  });

  it('binds visual inspection to its own slot, not to the text OCR one', () => {
    const slots = action.connectorSlots.map((slot) => slot.name).sort();
    expect(slots).toEqual(['crosscheck', 'ocr', 'report', 'vision']);
    for (const slot of action.connectorSlots) {
      expect(slot.required).toBe(true);
    }
    const vision = action.connectorSlots.find((slot) => slot.name === 'vision');
    expect(vision?.acceptedCapabilities).toContain('vision');
  });

  it('exposes one action', () => {
    expect(lcCheckerManifest.actions).toHaveLength(1);
    expect(action.name).toBe('lc-checker');
  });

  it('accepts only the shipped input version and ruleset version', () => {
    const properties = action.inputSchema.properties as Record<string, { enum?: readonly string[] }>;
    expect(properties['inputVersion']?.enum).toEqual([LC_CHECKER_INPUT_VERSION]);
    expect(properties['ruleSetVersion']?.enum).toEqual([LC_DEFAULT_RULE_SET_VERSION]);
    expect(action.inputSchema.additionalProperties).toBe(false);
  });

  it('bounds the document set in the published schema', () => {
    const properties = action.inputSchema.properties as Record<string, { maxItems?: number }>;
    expect(properties['artifactIds']?.maxItems).toBe(50);
    expect(properties['fileNames']?.maxItems).toBe(50);
  });

  it('pins the human sign-off, the ruleset status and the visual-verification shape', () => {
    const properties = action.outputSchema.properties as Record<string, { const?: unknown }>;
    expect(properties['humanSignOffRequired']?.const).toBe(true);
    const evidence = (action.outputSchema.properties as Record<string, {
      properties: Record<string, { const?: unknown; enum?: readonly string[]; required: readonly string[] }>;
      required: readonly string[];
    }>)['evidence'];
    expect(evidence?.properties['ruleSetId']?.const).toBe('lc-rules-base');
    expect(evidence?.properties['ruleSetStatus']?.enum).toEqual([LC_RULE_SET_STATUS]);
    expect(evidence?.properties['visualVerification']?.required).toEqual(['requested', 'satisfied', 'complete']);
    expect(action.outputSchema.required).toContain('outstandingVisualChecks' as never);
  });

  it('requires a ruleId on every discrepancy, so an uncited finding cannot be published', () => {
    const properties = action.outputSchema.properties as Record<string, { items: { required: readonly string[] } }>;
    expect(properties['discrepancies']?.items.required).toContain('ruleId');
  });
});

describe('P9-02 worker adapter', () => {
  it('plans the OCR fan-out and yields the queue slot on the first delivery', async () => {
    const harness = makeHarness();
    const disposition = await mainLcCheckerHandler(harness.ctx);
    expect(disposition.kind).toBe('waiting-children');
    expect(harness.spawnCalls).toHaveLength(1);
    expect(harness.spawnCalls[0]?.taskKeys).toEqual(['ocr-0', 'ocr-1']);
    expect(harness.spawnCalls[0]?.kinds).toEqual(['lc-checker-ocr', 'lc-checker-ocr']);
    expect(harness.spawnCalls[0]?.continuationRef).toBe('join:lc-checker:ocr');
    expect(harness.screenCallCount()).toBe(0);
  });

  it('persists the machine state before the children run, so the next delivery can resume', async () => {
    const harness = makeHarness();
    await mainLcCheckerHandler(harness.ctx);
    const saved = harness.savedStates();
    expect(saved).toHaveLength(1);
    const state = JSON.parse(saved[0]!) as { pendingJoinToken?: string };
    expect(state.pendingJoinToken).toBe('ocr:' + LC_CHECKER_INPUT_VERSION);
  });

  it('inlines the artifact bytes for the OCR provider, because the contract carries content', async () => {
    const harness = makeHarness({ input: { artifactId: 'art-invoice', fileName: 'invoice.pdf' } });
    const disposition = await ocrChildHandler(harness.ctx);
    expect(disposition.kind).toBe('completed');
    expect(harness.ocrCalls).toEqual(['1']);
    if (disposition.kind !== 'completed') throw new Error('unreachable');
    const decoded = JSON.parse(
      Buffer.from(disposition.resultRef.slice('data:application/json;base64,'.length), 'base64').toString('utf8')
    );
    expect(decoded).toEqual({ kind: 'ocr', fileName: 'invoice.pdf', text: 'OCR TEXT' });
  });

  it('refuses to inline an artifact above the connector size cap', async () => {
    const harness = makeHarness({
      input: { artifactId: 'art-invoice', fileName: 'invoice.pdf' },
      artifactBytes: 11 * 1024 * 1024,
    });
    await expect(ocrChildHandler(harness.ctx)).rejects.toThrow('above the connector limit');
  });

  it('inspects one document for one question, rendering only the rules that question serves', async () => {
    const harness = makeHarness({
      input: {
        artifactId: 'art-bl',
        fileName: 'bill-of-lading.pdf',
        documentIndex: 1,
        purpose: 'Is the bill of lading endorsed on the reverse?',
        ruleIds: ['PROC-3.8'],
        ruleSetVersion: LC_DEFAULT_RULE_SET_VERSION,
      },
    });
    const disposition = await visualChildHandler(harness.ctx);
    expect(disposition.kind).toBe('completed');
    expect(harness.visionCalls).toHaveLength(1);
    expect(harness.visionCalls[0]?.purpose).toContain('[PROC-3.8]');
    expect(harness.visionCalls[0]?.purpose).not.toContain('[UCP600-ART-28]');
    if (disposition.kind !== 'completed') throw new Error('unreachable');
    const decoded = JSON.parse(
      Buffer.from(disposition.resultRef.slice('data:application/json;base64,'.length), 'base64').toString('utf8')
    );
    expect(decoded.document_index).toBe(1);
  });

  it('drives three deliveries: plan, OCR join, visual join, then terminates', async () => {
    const harness = makeHarness();
    const first = await mainLcCheckerHandler(harness.ctx);
    expect(first.kind).toBe('waiting-children');
    expect(harness.spawnCalls[0]?.continuationRef).toBe('join:lc-checker:ocr');

    deliver(harness, OCR_JOIN);
    const second = await mainLcCheckerHandler(harness.ctx);
    expect(second.kind).toBe('waiting-children');
    expect(harness.spawnCalls[1]?.taskKeys).toEqual(['visual-0']);
    expect(harness.spawnCalls[1]?.kinds).toEqual(['lc-checker-visual']);
    expect(harness.screenCallCount()).toBe(1);

    deliver(harness, VISUAL_JOIN);
    const third = await mainLcCheckerHandler(harness.ctx);
    expect(third.kind).toBe('completed');
    if (third.kind !== 'completed') throw new Error('unreachable');
    expect(third.artifacts?.[0]?.fileName).toBe('lc-checker-result.json');
    expect(harness.reportCallCount()).toBe(1);
    expect(harness.adjudicateCalls).toEqual([{ digests: 1, outstanding: 0 }]);
  });

  it('skips the second fan-out when screening asked for nothing', async () => {
    const harness = makeHarness({ screen: screenPayload([]) });
    await mainLcCheckerHandler(harness.ctx);
    deliver(harness, OCR_JOIN);
    const second = await mainLcCheckerHandler(harness.ctx);
    expect(second.kind).toBe('completed');
    expect(harness.spawnCalls).toHaveLength(1);
  });

  it('records a document the join never returned, instead of examining a smaller set silently', async () => {
    const harness = makeHarness({ screen: screenPayload([]), adjudicate: discrepantPayload() });
    await mainLcCheckerHandler(harness.ctx);
    deliver(harness, { 'ocr-0': OCR_JOIN['ocr-0'] });
    const second = await mainLcCheckerHandler(harness.ctx);
    expect(second.kind).toBe('completed');
    // One document survived, so the run proceeds, but the gap is on the record rather than
    // quietly absorbed. fail-closed only refuses when NOTHING could be read.
    expect(harness.spawnCalls).toHaveLength(1);
  });

  it('refuses an empty join rather than reporting a compliant empty set', async () => {
    const harness = makeHarness({ joinSummary: {} });
    await expect(mainLcCheckerHandler(harness.ctx)).rejects.toThrow('no fan-out is pending');
  });

  it('refuses a child result that is not an OCR payload', async () => {
    const harness = makeHarness();
    await mainLcCheckerHandler(harness.ctx);
    deliver(harness, {
      'ocr-0': 'data:application/json;base64,' + Buffer.from(JSON.stringify({ kind: 'other' })).toString('base64'),
      'ocr-1': OCR_JOIN['ocr-1'],
    });
    await expect(mainLcCheckerHandler(harness.ctx)).rejects.toThrow('not an OCR payload');
  });

  it('refuses a child result that is not an inline data reference', async () => {
    const harness = makeHarness();
    await mainLcCheckerHandler(harness.ctx);
    deliver(harness, { 'ocr-0': 'artifact-uuid', 'ocr-1': OCR_JOIN['ocr-1'] });
    await expect(mainLcCheckerHandler(harness.ctx)).rejects.toThrow('expects a data: reference');
  });

  it('refuses a compliance result that fails validation, rather than publishing it', async () => {
    const bad = { ...compliantPayload(), total_discrepancies: 4 };
    const harness = makeHarness({ screen: screenPayload([]), adjudicate: bad });
    await mainLcCheckerHandler(harness.ctx);
    deliver(harness, OCR_JOIN);
    await expect(mainLcCheckerHandler(harness.ctx)).rejects.toThrow('total_discrepancies');
  });

  it('refuses a COMPLIANT verdict when a screening question is still outstanding', async () => {
    const harness = makeHarness({ adjudicate: compliantPayload() });
    await mainLcCheckerHandler(harness.ctx);
    deliver(harness, OCR_JOIN);
    await mainLcCheckerHandler(harness.ctx);
    deliver(harness, {});
    await expect(mainLcCheckerHandler(harness.ctx)).rejects.toThrow('visual checks were satisfied');
  });

  it('still publishes a DISCREPANT verdict when a visual check is outstanding', async () => {
    const harness = makeHarness({ adjudicate: discrepantPayload() });
    await mainLcCheckerHandler(harness.ctx);
    deliver(harness, OCR_JOIN);
    await mainLcCheckerHandler(harness.ctx);
    deliver(harness, {});
    const third = await mainLcCheckerHandler(harness.ctx);
    expect(third.kind).toBe('completed');
    expect(harness.adjudicateCalls).toEqual([{ digests: 0, outstanding: 1 }]);
  });

  it('refuses to act once cancellation has been requested', async () => {
    const harness = makeHarness();
    Object.defineProperty(harness.ctx, 'cancelRequested', { value: true });
    await expect(mainLcCheckerHandler(harness.ctx)).rejects.toThrow('Cancellation was requested');
  });

  it('rejects an input that carries an identity field before touching anything', async () => {
    const harness = makeHarness({ input: validInput({ apiKeyId: 'dg_stolen' }) });
    await expect(mainLcCheckerHandler(harness.ctx)).rejects.toThrow('must not carry an identity field');
  });
});
