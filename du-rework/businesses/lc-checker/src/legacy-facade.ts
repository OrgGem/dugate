/**
 * Legacy wire adapter for `POST /api/v1/docs/workflows` with `process=lc-checker`.
 *
 * This is a PURE translation layer: it turns a legacy multipart submission into the
 * versioned business input, and turns a business result back into the legacy operation
 * envelope, with no HTTP framework, no database and no queue. Mounting it is a one-route
 * change in the Orchestrator, which is a different lease — see the P9-02 report.
 *
 * Two legacy behaviours are deliberately NOT reproduced:
 *
 *   - `apiKeyId` as a FORM FIELD. The legacy read the caller's key from the multipart
 *     body and, when absent, fell back to the OLDEST role=ADMIN key in the database. That
 *     is not authentication, it is a way to borrow someone else's identity. Here a
 *     submission carrying `apiKeyId` is refused outright rather than ignored, because a
 *     silent ignore looks like it worked.
 *   - A 202 for an unregistered process. Legacy returned 404 with the process name echoed
 *     back; the mapping is preserved.
 */

import { MAX_LC_DOCUMENTS, normalizeLcCheckerInput, type LcCheckerResult } from './lc-checker';
import { LC_DEFAULT_RULE_SET_VERSION } from './rules/rule-registry';
import { LC_CHECKER_INPUT_VERSION, type LcCheckerInput } from './types';

export const LEGACY_LC_PROCESS = 'lc-checker';
export const LEGACY_WORKFLOW_ENDPOINT_SLUG = 'workflows:' + LEGACY_LC_PROCESS;

export interface LegacyProblem {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
}

export type LegacySubmissionResult =
  | { readonly ok: true; readonly businessInput: LcCheckerInput }
  | { readonly ok: false; readonly problem: LegacyProblem };

function problem(status: number, title: string, detail: string): LegacyProblem {
  return {
    type: 'https://dugate.vn/errors/' + title.toLowerCase().replace(/\s+/g, '-'),
    title,
    status,
    detail,
  };
}

/** Form fields the legacy collected into the pipeline variables. None of them is identity. */
const LEGACY_VARIABLE_FIELDS = [
  'maxConcurrency',
  'failurePolicy',
  'requireEncryptedEvidence',
  'ruleSetVersion',
] as const;

const FORBIDDEN_FIELDS = ['apiKeyId', 'api_key_id', 'apiKey', 'userId', 'tenantId', 'role', 'adminToken'] as const;

export interface LegacySubmissionFields {
  readonly process: string | null | undefined;
  readonly fileNames: readonly string[];
  readonly fields: Readonly<Record<string, string>>;
}

/**
 * Translate a legacy multipart submission into the versioned business input.
 *
 * Artifact ids are NOT invented here: the caller has already uploaded the documents and
 * knows their durable ids, so they arrive alongside the names. A caller that cannot supply
 * an id per file has not finished uploading, and that is an error rather than something
 * this layer papers over.
 */
export function parseLegacySubmission(input: {
  readonly fields: LegacySubmissionFields;
  readonly artifactIds: readonly string[];
  readonly defaultMaxConcurrency?: number;
}): LegacySubmissionResult {
  const { fields, artifactIds } = input;

  const processName = typeof fields.process === 'string' ? fields.process.trim() : '';
  if (processName.length === 0) {
    return { ok: false, problem: problem(400, 'Missing Parameter', "Form field 'process' is required.") };
  }
  if (processName !== LEGACY_LC_PROCESS) {
    return {
      ok: false,
      problem: problem(404, 'Workflow Not Found', "Workflow '" + processName + "' is not registered."),
    };
  }

  for (const field of FORBIDDEN_FIELDS) {
    if (fields.fields[field] !== undefined) {
      return {
        ok: false,
        problem: problem(
          400,
          'Invalid Profile API Key',
          "Form field '" +
            field +
            "' is not accepted. Identity is resolved by the platform from the Authorization header, never from the request body."
        ),
      };
    }
  }

  if (fields.fileNames.length === 0) {
    return { ok: false, problem: problem(400, 'Missing Files', 'Workflow requires at least 1 document.') };
  }
  if (fields.fileNames.length !== artifactIds.length) {
    return {
      ok: false,
      problem: problem(
        400,
        'Missing Files',
        'Each uploaded document must have a matching artifact reference; received ' +
          artifactIds.length +
          ' for ' +
          fields.fileNames.length +
          ' files.'
      ),
    };
  }
  if (artifactIds.length > MAX_LC_DOCUMENTS) {
    return {
      ok: false,
      problem: problem(
        400,
        'Missing Files',
        'Workflow accepts at most ' + MAX_LC_DOCUMENTS + ' documents; received ' + artifactIds.length + '.',
      ),
    };
  }

  const variables: Record<string, string> = {};
  for (const key of LEGACY_VARIABLE_FIELDS) {
    const value = fields.fields[key];
    if (value) variables[key] = value;
  }

  // Every legacy variable arrives as a multipart string. Coercing here, in the adapter,
  // is the right place: the machine keeps its strict types and never has to know that a
  // wire format has no numbers.
  const rawConcurrency = variables['maxConcurrency'] ?? String(input.defaultMaxConcurrency ?? 4);
  const maxConcurrency = Number(rawConcurrency);

  const raw = {
    inputVersion: LC_CHECKER_INPUT_VERSION,
    artifactIds: [...artifactIds],
    fileNames: [...fields.fileNames],
    ruleSetVersion: variables['ruleSetVersion'] ?? LC_DEFAULT_RULE_SET_VERSION,
    maxConcurrency,
    failurePolicy: variables['failurePolicy'] ?? 'fail-closed',
    requireEncryptedEvidence: variables['requireEncryptedEvidence'] !== 'false',
  };

  // normalizeLcCheckerInput is the single authority on what a valid input is, so the
  // adapter cannot drift from the machine by re-implementing the checks.
  try {
    return { ok: true, businessInput: normalizeLcCheckerInput(raw) };
  } catch (error) {
    return {
      ok: false,
      problem: problem(400, 'Invalid Workflow Variables', error instanceof Error ? error.message : String(error)),
    };
  }
}

export interface LegacyAccepted {
  readonly status: 202;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: {
    readonly name: string;
    readonly done: false;
    readonly metadata: {
      readonly state: 'RUNNING';
      readonly workflow: string;
      readonly progress_percent: number;
      readonly progress_message: string;
    };
  };
}

export function legacyAccepted(operationId: string): LegacyAccepted {
  return {
    status: 202,
    headers: { 'Operation-Location': '/api/v1/operations/' + operationId },
    body: {
      name: 'operations/' + operationId,
      done: false,
      metadata: {
        state: 'RUNNING',
        workflow: LEGACY_LC_PROCESS,
        progress_percent: 0,
        progress_message: 'Initializing workflow...',
      },
    },
  };
}

export type LegacyViewState = 'RUNNING' | 'DONE' | 'ERROR';

export interface LegacyOperationViewInput {
  readonly operationId: string;
  readonly state: LegacyViewState;
  readonly progressPercent: number;
  readonly progressMessage: string;
  readonly result?: LcCheckerResult;
  readonly failure?: { readonly status: number; readonly title: string; readonly detail: string };
  readonly errorCode?: string;
}

/**
 * The polling envelope a legacy client already parses. `output` carries the report text
 * and `outputContent` the verdict, so an existing consumer does not have to be taught a
 * new result shape to read a rewritten backend.
 */
export function legacyOperationView(input: LegacyOperationViewInput): Record<string, unknown> {
  const base: Record<string, unknown> = {
    name: 'operations/' + input.operationId,
    done: input.state !== 'RUNNING',
    metadata: {
      state: input.state,
      workflow: LEGACY_LC_PROCESS,
      progress_percent: input.progressPercent,
      progress_message: input.progressMessage,
    },
  };
  if (input.state === 'DONE' && input.result) {
    base['output'] = input.result.report;
    base['outputContent'] = input.result.summary;
    base['verdict'] = input.result.verdict;
    base['recommendation'] = input.result.recommendation;
    base['ruleSetVersion'] = input.result.evidence.ruleSetVersion;
    base['humanSignOffRequired'] = input.result.humanSignOffRequired;
  }
  if (input.state === 'ERROR') {
    base['error'] = input.failure
      ? problem(input.failure.status, input.failure.title, input.failure.detail)
      : { code: input.errorCode ?? 'WORKFLOW_FAILED', message: 'The LC examination did not complete.' };
  }
  return base;
}

/** Progress bands carried over from the legacy workflow so a polling client sees the same shape. */
const LEGACY_PROGRESS_BANDS: Readonly<Record<string, readonly [number, number]>> = {
  'ocr:start': [5, 30],
  'ocr:end': [30, 30],
  'compliance:start': [35, 80],
  'compliance:end': [80, 80],
  'report:start': [85, 95],
  'report:end': [95, 95],
  done: [100, 100],
};

export function legacyProgressPercent(stage: string, phase: 'start' | 'end' | 'done'): number {
  if (phase === 'done') return 100;
  const band = LEGACY_PROGRESS_BANDS[stage + ':' + phase];
  if (!band) return 50;
  return phase === 'start' ? band[0] : band[1];
}
