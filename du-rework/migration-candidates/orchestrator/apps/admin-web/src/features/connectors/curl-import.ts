/**
 * Bounded "Import cURL" text parser for the Orchestrator Portal connectors screen (CFGADM-07).
 *
 * The pasted command is tokenized the way a shell would quote it, and the flags the
 * legacy importer understood are read off the token list. Pure text: nothing is
 * executed, no request is sent, nothing is evaluated. Flags and syntax outside the
 * supported set are reported as a note or an error, never guessed at.
 *
 * Secret discipline — two shapes on purpose:
 *  - CurlImportDraft carries auth.secretValue so the apply path can prefill the
 *    credential editor. It exists in memory for the lifetime of the call only.
 *  - CurlImportSummary carries neither a secret nor a full header value. It is the
 *    only shape the preview renders, so nothing in it can be logged or persisted.
 *
 * Error and note messages come from a fixed code table plus a token position, never
 * from the pasted text, so a malformed paste cannot echo a token back into the UI,
 * a log line or a receipt.
 */

/** Hard bounds — each of these fails the parse instead of truncating. */
export const CURL_IMPORT_LIMITS = {
  maxInputChars: 65536,
  maxTokens: 512,
  maxHeaders: 32,
  maxFormFields: 32,
  maxValueChars: 8192,
  maxUrlChars: 2048,
  maxMethodChars: 16,
} as const;

export type CurlImportErrorCode =
  | 'EMPTY_INPUT'
  | 'INPUT_TOO_LONG'
  | 'NOT_A_CURL_COMMAND'
  | 'COMMAND_SUBSTITUTION_UNSUPPORTED'
  | 'TOO_MANY_TOKENS'
  | 'TOKEN_TOO_LONG'
  | 'UNTERMINATED_QUOTE'
  | 'FLAG_VALUE_MISSING'
  | 'METHOD_UNSUPPORTED'
  | 'HEADER_MALFORMED'
  | 'HEADER_NAME_INVALID'
  | 'TOO_MANY_HEADERS'
  | 'FORM_FIELD_MALFORMED'
  | 'TOO_MANY_FORM_FIELDS'
  | 'BEARER_TOKEN_MISSING'
  | 'URL_MISSING'
  | 'URL_TOO_LONG'
  | 'URL_MALFORMED'
  | 'URL_SCHEME_UNSUPPORTED';

const ERROR_MESSAGES: Record<CurlImportErrorCode, string> = {
  EMPTY_INPUT: 'Paste a cURL command to import.',
  INPUT_TOO_LONG: 'The paste is longer than ' + CURL_IMPORT_LIMITS.maxInputChars + ' characters.',
  NOT_A_CURL_COMMAND:
    'This does not start with curl. Copy the command itself, without the shell prompt ($ or >).',
  COMMAND_SUBSTITUTION_UNSUPPORTED:
    'The command uses shell substitution (for example $(...) or backticks). Nothing is expanded here — replace it with the literal value you want imported.',
  TOO_MANY_TOKENS: 'The command has more than ' + CURL_IMPORT_LIMITS.maxTokens + ' arguments.',
  TOKEN_TOO_LONG: 'One argument is longer than ' + CURL_IMPORT_LIMITS.maxValueChars + ' characters.',
  UNTERMINATED_QUOTE: 'A quote is never closed. Check that every single or double quote is paired.',
  FLAG_VALUE_MISSING: 'A flag is missing the value it requires.',
  METHOD_UNSUPPORTED: 'The request method is not a plain token such as GET, POST or PUT.',
  HEADER_MALFORMED: 'A header is not in Name: value form.',
  HEADER_NAME_INVALID: 'A header name contains characters that are not valid in a header name.',
  TOO_MANY_HEADERS: 'The command carries more than ' + CURL_IMPORT_LIMITS.maxHeaders + ' headers.',
  FORM_FIELD_MALFORMED: 'A form field is not in name=value form.',
  TOO_MANY_FORM_FIELDS: 'The command carries more than ' + CURL_IMPORT_LIMITS.maxFormFields + ' form fields.',
  BEARER_TOKEN_MISSING: 'The authorization header uses the Bearer scheme but carries no token.',
  URL_MISSING: 'No http(s) URL found. Include the URL argument, or pass it with --url.',
  URL_TOO_LONG: 'The URL is longer than ' + CURL_IMPORT_LIMITS.maxUrlChars + ' characters.',
  URL_MALFORMED: 'The URL could not be read as a URL.',
  URL_SCHEME_UNSUPPORTED: 'Only http and https URLs are supported.',
};

export interface CurlImportError {
  code: CurlImportErrorCode;
  message: string;
  /** 1-based position of the offending token; null when the whole command is at fault. */
  tokenIndex: number | null;
}

export type CurlImportNoteCode =
  | 'BODY_NOT_IMPORTED'
  | 'FILE_NOT_IMPORTED'
  | 'FLAGS_IGNORED'
  | 'ARGUMENTS_IGNORED'
  | 'SHELL_EXPANSION_NOT_EVALUATED'
  | 'ESCAPE_NOT_EVALUATED';

const NOTE_MESSAGES: Record<CurlImportNoteCode, string> = {
  BODY_NOT_IMPORTED:
    'Request bodies (-d/--data, --data-raw, --data-binary, --data-urlencode) are not imported; the method is still set.',
  FILE_NOT_IMPORTED: 'File uploads are not imported — pick the file yourself in the form.',
  FLAGS_IGNORED:
    'Flags outside -X/--request, -H/--header, -F/--form, --url and the data flags are ignored (for example --compressed, --location, -s).',
  ARGUMENTS_IGNORED: 'Some arguments were not imported, including any URL beyond the first.',
  SHELL_EXPANSION_NOT_EVALUATED:
    'Shell variables ($NAME) are not expanded — the text is imported exactly as pasted.',
  ESCAPE_NOT_EVALUATED: 'Backslashes outside quotes are kept literally, not interpreted.',
};

export interface CurlImportNote {
  code: CurlImportNoteCode;
  message: string;
}

export type CurlImportAuthType = 'NONE' | 'BEARER' | 'API_KEY_HEADER';

export interface CurlImportAuth {
  type: CurlImportAuthType;
  /** Header the secret belongs to: authorization for bearer, the pasted name otherwise. */
  headerName: string;
  /** In-memory only. Never render this — render the summary. */
  secretValue: string | null;
}

export interface CurlImportHeader {
  name: string;
  value: string;
}

export interface CurlImportFormField {
  name: string;
  value: string;
  isFile: boolean;
  secret: boolean;
}

/** In-memory parse result: carries the secret. Hand it to the form, never to a log. */
export interface CurlImportDraft {
  endpointUrl: string;
  httpMethod: string;
  auth: CurlImportAuth;
  headers: CurlImportHeader[];
  formFields: CurlImportFormField[];
  notes: CurlImportNote[];
}

export interface CurlImportHeaderSummary {
  name: string;
  secret: boolean;
  valueChars: number;
  /** Masked for secret names, a character count otherwise — never the value. */
  preview: string;
}

export interface CurlImportFormFieldSummary {
  name: string;
  secret: boolean;
  isFile: boolean;
  valueChars: number;
  preview: string;
}

/** Safe shape: no secret, no full header value. This is what the preview renders. */
export interface CurlImportSummary {
  endpointUrl: string;
  httpMethod: string;
  auth: {
    type: CurlImportAuthType;
    headerName: string;
    secretPresent: boolean;
    preview: string;
  };
  headers: CurlImportHeaderSummary[];
  formFields: CurlImportFormFieldSummary[];
  notes: CurlImportNote[];
}

export type CurlImportParseResult =
  | { ok: true; draft: CurlImportDraft; summary: CurlImportSummary }
  | { ok: false; error: CurlImportError };

/** Names that are secret whatever they carry. */
const SECRET_NAMES = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'apikey',
  'x-auth-token',
  'x-access-token',
  'x-amz-security-token',
  'x-goog-api-key',
  'x-csrf-token',
  'x-session-token',
  'x-secret',
  'x-secret-key',
  'x-client-secret',
  'x-password',
  'x-passwd',
]);

/** Substrings that mark a name as secret-bearing (tested against the lowercased name). */
const SECRET_NAME_FRAGMENTS = [
  'secret',
  'password',
  'passwd',
  'token',
  'credential',
  'signature',
  'api-key',
  'api_key',
  'apikey',
  'private-key',
  'private_key',
];

const CONTINUATION_RE = /\\\r?\n/g;
const BARE_ESCAPE_RE = /\\[^\r\n]/;
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_~-]+$/;
const BEARER_RE = /^bearer(?:[ \t]+(.*))?$/i;
const PATH_SEGMENT_RE = /[\\/]/;
const FORM_VALUE_PREVIEW_CHARS = 120;
const MASK = '****';
const COMMAND_SUBSTITUTION_MARKERS = ['$(', '`', '<(', '>('] as const;

export function isSecretTokenName(name: string): boolean {
  const lower = name.trim().toLowerCase();
  if (lower.length === 0) return false;
  if (SECRET_NAMES.has(lower)) return true;
  return SECRET_NAME_FRAGMENTS.some((fragment) => lower.includes(fragment));
}

/** Fingerprint only: enough to tell two secrets apart, useless as a credential. */
function maskValue(value: string): string {
  if (value.length === 0) return '';
  if (value.length <= 4) return MASK;
  return MASK + value.slice(-4);
}

function truncateForPreview(value: string): string {
  return value.length <= FORM_VALUE_PREVIEW_CHARS ? value : value.slice(0, FORM_VALUE_PREVIEW_CHARS) + '...';
}

/** Local paths are not shown in the preview — the operator only needs the file name. */
function baseNameOfReference(reference: string): string {
  const withoutMarker = reference.startsWith('@') ? reference.slice(1) : reference;
  const segments = withoutMarker.split(PATH_SEGMENT_RE);
  return segments[segments.length - 1] ?? withoutMarker;
}

function fail(code: CurlImportErrorCode, tokenIndex: number | null): CurlImportParseResult {
  return { ok: false, error: { code, message: ERROR_MESSAGES[code], tokenIndex } };
}

function notesFrom(codes: Set<CurlImportNoteCode>): CurlImportNote[] {
  const order = Object.keys(NOTE_MESSAGES) as CurlImportNoteCode[];
  return order
    .filter((code) => codes.has(code))
    .map((code) => ({ code, message: NOTE_MESSAGES[code] }));
}

interface TokenizeResult {
  tokens: string[];
  error: CurlImportErrorCode | null;
}

function tokenize(text: string): TokenizeResult {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let error: CurlImportErrorCode | null = null;

  const push = (): void => {
    if (error !== null) return;
    if (current.length > CURL_IMPORT_LIMITS.maxValueChars) {
      error = 'TOKEN_TOO_LONG';
      return;
    }
    tokens.push(current);
    current = '';
    if (tokens.length > CURL_IMPORT_LIMITS.maxTokens) error = 'TOO_MANY_TOKENS';
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === undefined) break;

    if (quote !== null) {
      if (char === '\\' && index + 1 < text.length) {
        const next = text[index + 1];
        if (next === quote) {
          current += quote;
          index += 1;
        } else {
          current += char;
        }
      } else if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '\\') {
      current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ' ' || char === '\t') {
      if (current.length > 0) push();
      continue;
    }
    current += char;
  }

  if (error === null && quote !== null) error = 'UNTERMINATED_QUOTE';
  if (error === null && current.length > 0) push();
  return { tokens, error };
}

interface FlagScan {
  url: string;
  method: string;
  methodExplicit: boolean;
  headers: CurlImportHeader[];
  formFields: CurlImportFormField[];
  error: CurlImportErrorCode | null;
  /** 0-based position of the offending token. */
  errorIndex: number;
}

function scanFlags(tokens: string[], noteCodes: Set<CurlImportNoteCode>): FlagScan {
  const scan: FlagScan = {
    url: '',
    method: 'GET',
    methodExplicit: false,
    headers: [],
    formFields: [],
    error: null,
    errorIndex: 0,
  };
  const reject = (code: CurlImportErrorCode, index: number): void => {
    scan.error = code;
    scan.errorIndex = index;
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) continue;
    if (token.toLowerCase() === 'curl') continue;

    if (token === '-X' || token === '--request') {
      const value = tokens[index + 1];
      if (value === undefined) {
        reject('FLAG_VALUE_MISSING', index);
        return scan;
      }
      const method = value.toUpperCase();
      if (method.length > CURL_IMPORT_LIMITS.maxMethodChars || !/^[A-Z]+$/.test(method)) {
        reject('METHOD_UNSUPPORTED', index + 1);
        return scan;
      }
      scan.method = method;
      scan.methodExplicit = true;
      index += 1;
      continue;
    }

    if (token === '-H' || token === '--header') {
      const line = tokens[index + 1];
      if (line === undefined) {
        reject('FLAG_VALUE_MISSING', index);
        return scan;
      }
      const separator = line.indexOf(':');
      if (separator <= 0) {
        reject('HEADER_MALFORMED', index + 1);
        return scan;
      }
      const name = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim();
      if (name.length === 0) {
        reject('HEADER_MALFORMED', index + 1);
        return scan;
      }
      if (!HEADER_NAME_RE.test(name)) {
        reject('HEADER_NAME_INVALID', index + 1);
        return scan;
      }
      if (scan.headers.length >= CURL_IMPORT_LIMITS.maxHeaders) {
        reject('TOO_MANY_HEADERS', index + 1);
        return scan;
      }
      const existing = scan.headers.findIndex((header) => header.name.toLowerCase() === name.toLowerCase());
      if (existing >= 0) scan.headers[existing] = { name, value };
      else scan.headers.push({ name, value });
      index += 1;
      continue;
    }

    if (token === '-F' || token === '--form') {
      const line = tokens[index + 1];
      if (line === undefined) {
        reject('FLAG_VALUE_MISSING', index);
        return scan;
      }
      const separator = line.indexOf('=');
      const name = separator <= 0 ? '' : line.slice(0, separator).trim();
      if (name.length === 0) {
        reject('FORM_FIELD_MALFORMED', index + 1);
        return scan;
      }
      if (scan.formFields.length >= CURL_IMPORT_LIMITS.maxFormFields) {
        reject('TOO_MANY_FORM_FIELDS', index + 1);
        return scan;
      }
      const value = line.slice(separator + 1).trim();
      const isFile = value.startsWith('@');
      if (isFile) noteCodes.add('FILE_NOT_IMPORTED');
      scan.formFields.push({ name, value, isFile, secret: isSecretTokenName(name) });
      if (!scan.methodExplicit) scan.method = 'POST';
      index += 1;
      continue;
    }

    if (
      token === '-d' ||
      token === '--data' ||
      token === '--data-raw' ||
      token === '--data-binary' ||
      token === '--data-urlencode'
    ) {
      if (tokens[index + 1] === undefined) {
        reject('FLAG_VALUE_MISSING', index);
        return scan;
      }
      noteCodes.add('BODY_NOT_IMPORTED');
      if (!scan.methodExplicit) scan.method = 'POST';
      index += 1;
      continue;
    }

    if (token === '--url') {
      const value = tokens[index + 1];
      if (value === undefined) {
        reject('FLAG_VALUE_MISSING', index);
        return scan;
      }
      if (scan.url !== '') noteCodes.add('ARGUMENTS_IGNORED');
      scan.url = value;
      index += 1;
      continue;
    }

    if (token.startsWith('http://') || token.startsWith('https://')) {
      if (scan.url === '') scan.url = token;
      else noteCodes.add('ARGUMENTS_IGNORED');
      continue;
    }

    if (token.startsWith('-')) {
      noteCodes.add('FLAGS_IGNORED');
      continue;
    }

    noteCodes.add('ARGUMENTS_IGNORED');
  }

  return scan;
}

interface AuthExtraction {
  auth: CurlImportAuth;
  headers: CurlImportHeader[];
  error: CurlImportErrorCode | null;
}

function extractAuth(headers: CurlImportHeader[]): AuthExtraction {
  const auth: CurlImportAuth = { type: 'NONE', headerName: 'x-api-key', secretValue: null };
  const rest: CurlImportHeader[] = [];

  for (const header of headers) {
    const name = header.name.toLowerCase();
    if (name === 'authorization') {
      const bearer = BEARER_RE.exec(header.value);
      if (bearer === null) {
        // Legacy parity: a non-Bearer authorization header stays a plain header.
        // It is still masked in the preview — authorization is a secret name.
        rest.push(header);
        continue;
      }
      const secret = (bearer[1] ?? '').trim();
      if (secret.length === 0) return { auth, headers: rest, error: 'BEARER_TOKEN_MISSING' };
      auth.type = 'BEARER';
      auth.headerName = header.name;
      auth.secretValue = secret;
      continue;
    }
    if (name === 'x-api-key' || name === 'api-key') {
      auth.type = 'API_KEY_HEADER';
      auth.headerName = header.name;
      auth.secretValue = header.value;
      continue;
    }
    rest.push(header);
  }

  return { auth, headers: rest, error: null };
}

/** Rebuild the redacted summary from any draft (same rules as the parse). */
export function summarizeCurlImport(draft: CurlImportDraft): CurlImportSummary {
  const secret = draft.auth.secretValue ?? '';
  return {
    endpointUrl: draft.endpointUrl,
    httpMethod: draft.httpMethod,
    auth: {
      type: draft.auth.type,
      headerName: draft.auth.headerName,
      secretPresent: secret.length > 0,
      preview: draft.auth.type === 'NONE' ? 'none' : maskValue(secret),
    },
    headers: draft.headers.map((header) => {
      const isSecret = isSecretTokenName(header.name);
      return {
        name: header.name,
        secret: isSecret,
        valueChars: header.value.length,
        preview: isSecret ? maskValue(header.value) : 'set (' + header.value.length + ' chars)',
      };
    }),
    formFields: draft.formFields.map((field) => ({
      name: field.name,
      secret: field.secret,
      isFile: field.isFile,
      valueChars: field.value.length,
      preview: field.secret
        ? maskValue(field.value)
        : field.isFile
          ? '@' + baseNameOfReference(field.value)
          : truncateForPreview(field.value),
    })),
    notes: draft.notes,
  };
}

export function parseCurlImport(text: string): CurlImportParseResult {
  if (text.trim().length === 0) return fail('EMPTY_INPUT', null);
  if (text.length > CURL_IMPORT_LIMITS.maxInputChars) return fail('INPUT_TOO_LONG', null);

  const normalized = text.replace(CONTINUATION_RE, ' ');
  if (COMMAND_SUBSTITUTION_MARKERS.some((marker) => normalized.includes(marker))) {
    return fail('COMMAND_SUBSTITUTION_UNSUPPORTED', null);
  }

  const noteCodes = new Set<CurlImportNoteCode>();
  if (normalized.includes('$')) noteCodes.add('SHELL_EXPANSION_NOT_EVALUATED');
  if (BARE_ESCAPE_RE.test(normalized)) noteCodes.add('ESCAPE_NOT_EVALUATED');

  const tokenized = tokenize(normalized);
  if (tokenized.error !== null) return fail(tokenized.error, null);

  const first = tokenized.tokens[0];
  if (first === undefined || first.toLowerCase() !== 'curl') return fail('NOT_A_CURL_COMMAND', 1);

  const scan = scanFlags(tokenized.tokens, noteCodes);
  if (scan.error !== null) return fail(scan.error, scan.errorIndex + 1);

  if (scan.url === '') return fail('URL_MISSING', null);
  if (scan.url.length > CURL_IMPORT_LIMITS.maxUrlChars) return fail('URL_TOO_LONG', null);
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(scan.url);
  } catch {
    return fail('URL_MALFORMED', null);
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return fail('URL_SCHEME_UNSUPPORTED', null);
  }

  const extracted = extractAuth(scan.headers);
  if (extracted.error !== null) return fail(extracted.error, null);

  const draft: CurlImportDraft = {
    endpointUrl: scan.url,
    httpMethod: scan.method,
    auth: extracted.auth,
    headers: extracted.headers,
    formFields: scan.formFields,
    notes: notesFrom(noteCodes),
  };

  return { ok: true, draft, summary: summarizeCurlImport(draft) };
}
