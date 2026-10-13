/** Render the stored document result into the legacy requested textual format. */
export function renderLegacyDocumentContent(data: unknown, format: string): string {
  const json = JSON.stringify(data);
  if (format === 'json') return json;
  const object = data && typeof data === 'object' ? data as Record<string, unknown> : {};
  const candidate = object.transformedText ?? object.markdown ?? object.text ?? object.summaryText ?? object.content;
  const text = typeof candidate === 'string' ? candidate : json;
  if (format === 'html') {
    if (object.outputFormat === 'html' && typeof object.transformedText === 'string') return object.transformedText;
    return `<pre>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')}</pre>`;
  }
  if (format === 'csv') {
    const values: unknown[] = Array.isArray(data) ? data : Array.isArray(object.rows) ? object.rows : [data];
    const rows: Record<string, unknown>[] = values.map(value => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : { value });
    const keys = [...new Set(rows.flatMap(row => Object.keys(row)))];
    const cell = (value: unknown) => `"${(typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value)).replace(/"/g, '""')}"`;
    return [keys.map(cell).join(','), ...rows.map(row => keys.map(key => cell(row[key])).join(','))].join('\r\n');
  }
  return text;
}

export interface LegacyCoreCompletionProjection {
  readonly pipelineJson: string;
  readonly stepsResultJson: string | null;
  readonly currentStep: number | null;
  readonly progressPercent: number;
  readonly progressMessage: null;
}

/**
 * Core actions execute as one admitted business action in the rework runtime.
 * The result artifact does not retain the old connector chain or intermediate
 * provider outputs, so the stable action slug is the only honest processor
 * identity available for a new projection.
 */
export function legacyCorePipelineJson(action: string): string {
  // Core actions are admitted as one processor, but their callbacks still use
  // the original notification-only wire contract. Keep both meanings in one
  // entry so webhook scheduling and legacy pollers see the same persisted
  // projection.
  return JSON.stringify([{ processor: action, legacyCallback: true }]);
}

function parsedArray(value: string | null | undefined): unknown[] | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function pipelineProcessorNames(value: string | null | undefined): string[] {
  return (parsedArray(value) ?? []).flatMap((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const processor = (entry as { processor?: unknown }).processor;
    return typeof processor === 'string' && processor.length > 0 ? [processor] : [];
  });
}

/**
 * Replace only the old callback placeholder (or an absent/unusable pipeline)
 * with the admitted Core action. Real persisted legacy pipeline entries stay
 * byte-for-byte intact for existing operations.
 */
export function legacyCorePipelineSnapshot(
  pipelineJson: string | null | undefined,
  action: string,
): string {
  const parsed = parsedArray(pipelineJson);
  const isCallbackPlaceholder = parsed?.some((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const marker = entry as { legacyCallback?: unknown; processor?: unknown };
    // Older Core rows used a marker-only entry to select notification-only
    // callbacks. A real processor entry may carry the same marker and must be
    // preserved so both the processor and callback mode survive projection.
    return marker.legacyCallback === true
      && !(typeof marker.processor === 'string' && marker.processor.length > 0);
  }) === true;
  if (!isCallbackPlaceholder && pipelineProcessorNames(pipelineJson).length > 0) {
    return pipelineJson!;
  }
  return legacyCorePipelineJson(action);
}

/**
 * Restore the old result fields that can be proven from a completed Core
 * result artifact. Existing detailed pipeline steps are retained. If the
 * stored pipeline is the new action-level snapshot and no step result was
 * persisted, add the one completed action result without inventing internal
 * connector steps.
 */
export function projectLegacyCoreCompletion(input: {
  action: string;
  data: unknown;
  outputFormat: string;
  outputContent: string;
  pipelineJson?: string | null;
  stepsResultJson?: string | null;
  currentStep?: number | null;
}): LegacyCoreCompletionProjection {
  const pipelineJson = legacyCorePipelineSnapshot(input.pipelineJson, input.action);
  const storedSteps = parsedArray(input.stepsResultJson);
  const hasStoredSteps = storedSteps !== null && storedSteps.length > 0;
  const processors = pipelineProcessorNames(pipelineJson);
  const isActionLevelPipeline = processors.length === 1 && processors[0] === input.action;
  const canProjectActionStep = !hasStoredSteps && isActionLevelPipeline;
  const stepsResultJson = hasStoredSteps
    ? input.stepsResultJson!
    : canProjectActionStep
      ? JSON.stringify([{
        step: 0,
        processor: input.action,
        output_format: input.outputFormat,
        content_preview: input.outputContent ? input.outputContent.slice(0, 500) : null,
        extracted_data: input.data,
      }])
      : input.stepsResultJson ?? null;

  return {
    pipelineJson,
    stepsResultJson,
    currentStep: hasStoredSteps ? input.currentStep ?? null : canProjectActionStep ? 0 : input.currentStep ?? null,
    progressPercent: 100,
    progressMessage: null,
  };
}
