import type { MultipartBody, MultipartFile } from './legacy-multipart';
import {
  LEGACY_WORKFLOW_MAX_BYTES,
  LegacyWorkflowSchemaValidationError,
  parseLegacyWorkflowSchema,
  type LegacyWorkflowNode,
  type LegacyWorkflowSchema,
} from '@du/contracts';

export const LEGACY_WORKFLOW_PROCESSES = ['disbursement', 'lc-checker', 'doc-compare'] as const;
export type LegacyWorkflowProcess = (typeof LEGACY_WORKFLOW_PROCESSES)[number];

export interface LegacyWorkflowFile {
  readonly field: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly bytes: Buffer;
}

export interface LegacyNamedWorkflowRequest {
  readonly kind: 'named';
  readonly process: LegacyWorkflowProcess;
  readonly variables: Record<string, unknown>;
  readonly files: LegacyWorkflowFile[];
  readonly bodyApiKeyId?: string;
}

export interface LegacySchemaWorkflowRequest {
  readonly kind: 'schema';
  readonly schemaSlug: string;
  readonly input: Record<string, unknown>;
  readonly files: LegacyWorkflowFile[];
  readonly bodyApiKeyId?: string;
}

export type LegacyWorkflowRequest = LegacyNamedWorkflowRequest | LegacySchemaWorkflowRequest;

/**
 * Decode the canonical legacy Workflow Builder XML format.
 *
 * This is a bounded recursive-descent parser for the deliberately small XML
 * vocabulary used by the legacy editor. It is not an XML parser with DTD or
 * entity expansion support: declarations are rejected, only the five XML
 * predefined entities and numeric character references are expanded, and
 * document structure/attributes are checked before mapping. The resulting
 * object still passes the shared workflow-schema validator below.
 */
export function decodeLegacyWorkflowXml(source: string): LegacyWorkflowSchema {
  if (Buffer.byteLength(source, 'utf8') > LEGACY_WORKFLOW_MAX_BYTES) {
    throw new LegacyWorkflowDecodeError('INVALID_INPUT', 'Workflow XML exceeds the 512 KiB import limit.');
  }
  try {
    const root = new BoundedLegacyXmlParser(source).parse();
    if (root.name !== 'workflow') throw new Error('Missing <workflow> root element.');
    const rootAttrs = exactAttributes(root, ['slug', 'name', 'version', 'description'], 'workflow');
    const inputSections = childrenNamed(root, 'input');
    const nodeSections = childrenNamed(root, 'nodes');
    const flowSections = childrenNamed(root, 'flow');
    const outputSections = childrenNamed(root, 'output');
    assertOnlyChildren(root, ['input', 'nodes', 'flow', 'output']);
    if (nodeSections.length !== 1) throw new Error('Workflow XML must contain exactly one <nodes> section.');
    if (inputSections.length > 1 || flowSections.length !== 1 || outputSections.length > 1) {
      throw new Error('Workflow XML contains a repeated input, flow, or output section.');
    }

    const inputProperties: Record<string, unknown> = {};
    if (inputSections[0]) {
      assertOnlyChildren(inputSections[0], ['property']);
      for (const property of inputSections[0].children) {
        const attrs = exactAttributes(property, ['name', 'type', 'required', 'label', 'widget', 'description', 'default'], 'input property');
        assertNoElementChildren(property, 'input property');
        const name = requiredAttribute(attrs, 'name');
        if (Object.hasOwn(inputProperties, name)) throw new Error(`Workflow input property "${name}" is repeated.`);
        const type = attrs.type ?? 'string';
        if (!['string', 'number', 'boolean', 'string[]', 'object'].includes(type)) {
          throw new Error(`Workflow input property "${name}" has an unsupported type.`);
        }
        const required = booleanAttribute(attrs.required, false, 'required');
        const propertyValue: Record<string, unknown> = { type, required };
        for (const key of ['label', 'widget', 'description'] as const) if (attrs[key] !== undefined) propertyValue[key] = attrs[key];
        const descriptionText = property.text.trim();
        if (propertyValue.description === undefined && descriptionText !== '') propertyValue.description = descriptionText;
        if (attrs.default !== undefined) {
          try { propertyValue.default = JSON.parse(attrs.default); }
          catch { propertyValue.default = attrs.default; }
        }
        inputProperties[name] = propertyValue;
      }
    }

    const nodesSection = nodeSections[0]!;
    assertOnlyChildren(nodesSection, ['node']);
    const nodes = nodesSection.children.map((node) => mapLegacyXmlNode(node, 0));
    const flowSection = flowSections[0]!;
    assertOnlyChildren(flowSection, ['step']);
    const flow = flowSection.children.map((step) => {
      const attrs = exactAttributes(step, ['id'], 'flow step');
      assertNoElementChildren(step, 'flow step');
      return requiredAttribute(attrs, 'id');
    });

    const schema: Record<string, unknown> = {
      slug: requiredAttribute(rootAttrs, 'slug'),
      name: rootAttrs.name ?? rootAttrs.slug,
      ...(rootAttrs.version === undefined ? { version: 1 } : { version: integerAttribute(rootAttrs.version, 'version') }),
      ...(rootAttrs.description === undefined ? {} : { description: rootAttrs.description }),
      ...(Object.keys(inputProperties).length > 0 ? { input_schema: { type: 'object', properties: inputProperties } } : {}),
      nodes,
      flow,
    };
    if (outputSections[0]) {
      const attrs = exactAttributes(outputSections[0], ['from', 'extra_data_from'], 'output');
      assertNoElementChildren(outputSections[0], 'output');
      schema.output = { from: requiredAttribute(attrs, 'from'), ...(attrs.extra_data_from === undefined ? {} : { extra_data_from: attrs.extra_data_from }) };
    }
    const validated = parseLegacyWorkflowSchema(schema);
    validateLegacyWorkflowBindings(validated);
    return validated;
  } catch (error) {
    if (error instanceof LegacyWorkflowDecodeError) throw error;
    if (error instanceof LegacyWorkflowSchemaValidationError) {
      throw new LegacyWorkflowDecodeError('INVALID_INPUT', error.message);
    }
    throw new LegacyWorkflowDecodeError('INVALID_INPUT', error instanceof Error ? error.message : 'Workflow XML is invalid.');
  }
}

/** Canonical JSON import uses the same structural and binding checks as XML. */
export function decodeLegacyWorkflowJson(source: string): LegacyWorkflowSchema {
  if (Buffer.byteLength(source, 'utf8') > LEGACY_WORKFLOW_MAX_BYTES) {
    throw new LegacyWorkflowDecodeError('INVALID_INPUT', 'Workflow JSON exceeds the 512 KiB import limit.');
  }
  let value: unknown;
  try { value = JSON.parse(source) as unknown; }
  catch { throw new LegacyWorkflowDecodeError('INVALID_INPUT', 'Workflow JSON is not valid JSON.'); }
  try {
    const schema = parseLegacyWorkflowSchema(value);
    validateLegacyWorkflowBindings(schema);
    return schema;
  } catch (error) {
    throw new LegacyWorkflowDecodeError('INVALID_INPUT', error instanceof Error ? error.message : 'Workflow JSON is invalid.');
  }
}

/** Reject missing, future, sibling-branch and undeclared input bindings up front. */
export function validateLegacyWorkflowBindings(schema: LegacyWorkflowSchema): void {
  const declaredInputs = new Set(Object.keys(schema.input_schema?.properties ?? {}));
  const allIds = new Set<string>();
  const collect = (nodes: readonly LegacyWorkflowNode[]) => {
    for (const node of nodes) {
      allIds.add(node.id);
      if (node.type === 'parallel') for (const branch of node.branches ?? []) collect(branch);
    }
  };
  collect(schema.nodes);
  const flowIndex = new Map(schema.flow.map((id, index) => [id, index]));

  const checkValue = (value: unknown, available: ReadonlySet<string>, where: string): void => {
    if (typeof value === 'string') {
      const binding = /^\$([A-Za-z_][A-Za-z0-9_]*)(?:\.([A-Za-z0-9_.-]+))?$/.exec(value);
      if (binding) {
        const root = binding[1]!;
        const path = binding[2];
        if (root === 'input') {
          const key = path?.split('.')[0];
          if (key && declaredInputs.size > 0 && !declaredInputs.has(key)) throw new Error(`${where} binds undeclared workflow input "${key}".`);
          return;
        }
        if (root === 'file' || root === 'files') return;
        if (!allIds.has(root)) throw new Error(`${where} binds missing workflow node "${root}".`);
        if (!available.has(root)) throw new Error(`${where} binds a future, cyclic, or foreign-branch node "${root}".`);
      }
      return;
    }
    if (Array.isArray(value)) { for (const item of value) checkValue(item, available, where); return; }
    if (value !== null && typeof value === 'object') for (const child of Object.values(value as Record<string, unknown>)) checkValue(child, available, where);
  };

  const validateSequence = (nodes: readonly LegacyWorkflowNode[], prior: ReadonlySet<string>, topLevel: boolean): Set<string> => {
    const available = new Set(prior);
    for (const node of nodes) {
      if (node.type === 'connector') checkValue(node.inputs ?? {}, available, `Node "${node.id}"`);
      else if (node.type === 'file_parse' || node.type === 'archive_compress' || node.type === 'archive_extract') checkValue(node.source, available, `Node "${node.id}"`);
      else if (node.type === 'file_url_download') checkValue(node.urls, available, `Node "${node.id}"`);
      else if (node.type === 'callback') { checkValue(node.url, available, `Node "${node.id}"`); checkValue(node.payload, available, `Node "${node.id}"`); }
      if (node.type === 'input' && declaredInputs.size > 0 && !declaredInputs.has(String(node.key))) throw new Error(`Input node "${node.id}" references undeclared workflow input "${String(node.key)}".`);
      if (node.type === 'parallel') {
        for (const branch of node.branches ?? []) validateSequence(branch, available, false);
      }
      available.add(node.id);
    }
    if (topLevel) {
      for (let index = 0; index < schema.flow.length; index += 1) {
        const id = schema.flow[index]!;
        if (!available.has(id)) throw new Error(`Workflow flow references unknown node "${id}".`);
        if (!flowIndex.has(id)) throw new Error(`Workflow flow contains a duplicate node "${id}".`);
      }
    }
    return available;
  };

  const topLevelById = new Map(schema.nodes.map((node) => [node.id, node]));
  const executedTop = new Set<string>();
  for (const id of schema.flow) {
    const node = topLevelById.get(id);
    if (!node) throw new Error(`Workflow flow references unknown top-level node "${id}".`);
    if (node.type === 'connector') checkValue(node.inputs ?? {}, executedTop, `Node "${node.id}"`);
    else if (node.type === 'file_parse' || node.type === 'archive_compress' || node.type === 'archive_extract') checkValue(node.source, executedTop, `Node "${node.id}"`);
    else if (node.type === 'file_url_download') checkValue(node.urls, executedTop, `Node "${node.id}"`);
    else if (node.type === 'callback') { checkValue(node.url, executedTop, `Node "${node.id}"`); checkValue(node.payload, executedTop, `Node "${node.id}"`); }
    if (node.type === 'input' && declaredInputs.size > 0 && !declaredInputs.has(String(node.key))) throw new Error(`Input node "${node.id}" references undeclared workflow input "${String(node.key)}".`);
    if (node.type === 'parallel') for (const branch of node.branches ?? []) validateSequence(branch, executedTop, false);
    executedTop.add(node.id);
  }
  for (const node of schema.nodes) {
    if (!executedTop.has(node.id)) throw new Error(`Top-level node "${node.id}" is not included in workflow flow.`);
  }
  if (schema.output?.from && !executedTop.has(schema.output.from)) throw new Error('Workflow output references a node outside the executed flow.');
  if (schema.output?.extra_data_from && !executedTop.has(schema.output.extra_data_from)) throw new Error('Workflow extracted-data output references a node outside the executed flow.');
}

export type LegacyWorkflowDecodeErrorCode =
  | 'MISSING_SELECTOR'
  | 'UNKNOWN_PROCESS'
  | 'INVALID_INPUT'
  | 'MISSING_FILES'
  | 'TOO_MANY_FILES';

export class LegacyWorkflowDecodeError extends TypeError {
  constructor(
    readonly code: LegacyWorkflowDecodeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LegacyWorkflowDecodeError';
  }
}

/**
 * Read fields with the same first-value behavior as `FormData.get`. File
 * selection mirrors legacy `normalizeFiles`: all `files[]` first, then one
 * each of source_file, target_file and file. Empty uploads are ignored.
 */
export function decodeLegacyNamedWorkflow(body: MultipartBody): LegacyNamedWorkflowRequest {
  const processRaw = firstField(body, 'process');
  const process = processRaw?.trim() ?? '';
  if (process === '') {
    throw new LegacyWorkflowDecodeError('MISSING_SELECTOR', "Form field 'process' is required.");
  }
  if (!isLegacyWorkflowProcess(process)) {
    throw new LegacyWorkflowDecodeError('UNKNOWN_PROCESS', `Workflow '${process}' is not registered.`);
  }

  const files = normalizedFiles(body);
  if (files.length === 0) {
    throw new LegacyWorkflowDecodeError('MISSING_FILES', 'Workflow requires at least 1 document.');
  }
  assertFileCount(files);

  const variables: Record<string, unknown> = {};
  // This is the only named-process field declared in the legacy registry.
  // Empty values were falsey and omitted by the old route.
  const resolutionData = firstField(body, 'resolution_data');
  if (process === 'disbursement' && resolutionData) {
    variables.resolution_data = resolutionData;
  }

  return {
    kind: 'named',
    process,
    variables,
    files,
    ...bodyApiKeyId(body),
  };
}

/** Decode the old multipart schema runner request, with object-only JSON input. */
export function decodeLegacySchemaWorkflow(body: MultipartBody): LegacySchemaWorkflowRequest {
  const schemaSlug = firstField(body, 'schemaSlug')?.trim() ?? '';
  if (schemaSlug === '') {
    throw new LegacyWorkflowDecodeError('MISSING_SELECTOR', "Form field 'schemaSlug' is required.");
  }

  const inputRaw = firstField(body, 'input');
  let input: unknown = {};
  if (inputRaw) {
    try {
      input = JSON.parse(inputRaw) as unknown;
    } catch {
      throw new LegacyWorkflowDecodeError('INVALID_INPUT', 'Form field "input" must be a valid JSON object string.');
    }
  }
  if (!isRecord(input)) {
    throw new LegacyWorkflowDecodeError('INVALID_INPUT', 'Form field "input" must be a JSON object.');
  }

  const files = normalizedFiles(body);
  assertFileCount(files);
  return {
    kind: 'schema',
    schemaSlug,
    input,
    files,
    ...bodyApiKeyId(body),
  };
}

export function isLegacyWorkflowProcess(value: string): value is LegacyWorkflowProcess {
  return (LEGACY_WORKFLOW_PROCESSES as readonly string[]).includes(value);
}

function firstField(body: MultipartBody, name: string): string | undefined {
  return body.fields.get(name)?.[0];
}

function bodyApiKeyId(body: MultipartBody): { bodyApiKeyId?: string } {
  const value = firstField(body, 'apiKeyId');
  return value === undefined ? {} : { bodyApiKeyId: value };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertFileCount(files: readonly LegacyWorkflowFile[]): void {
  if (files.length > 64) {
    throw new LegacyWorkflowDecodeError('TOO_MANY_FILES', 'Workflow accepts at most 64 uploaded files.');
  }
}

function normalizedFiles(body: MultipartBody): LegacyWorkflowFile[] {
  const result: LegacyWorkflowFile[] = [];
  const add = (file: MultipartFile): void => {
    if (file.content.length === 0) return;
    result.push({
      field: file.fieldName,
      fileName: file.fileName,
      mimeType: file.contentType,
      bytes: file.content,
    });
  };

  for (const file of body.files) {
    if (file.fieldName === 'files[]') add(file);
  }
  for (const field of ['source_file', 'target_file', 'file']) {
    const file = body.files.find((candidate) => candidate.fieldName === field);
    if (file !== undefined) add(file);
  }
  return result;
}

interface LegacyXmlElement {
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: readonly LegacyXmlElement[];
  readonly text: string;
}

class BoundedLegacyXmlParser {
  private position = 0;
  private elementCount = 0;
  private attributeCount = 0;

  constructor(private readonly source: string) {}

  parse(): LegacyXmlElement {
    if (this.source.charCodeAt(0) === 0xfeff) this.position = 1;
    this.skipMisc();
    if (this.position >= this.source.length) throw new Error('Workflow XML is empty.');
    const root = this.readElement(0);
    this.skipMisc();
    if (this.position !== this.source.length) throw new Error('Workflow XML contains content after the root element.');
    return root;
  }

  private readElement(depth: number): LegacyXmlElement {
    if (depth > 16) throw new Error('Workflow XML nesting exceeds 16 levels.');
    if (this.source[this.position] !== '<' || this.source[this.position + 1] === '/') throw new Error('Workflow XML element is malformed.');
    this.position += 1;
    const name = this.readName();
    const attributes: Record<string, string> = Object.create(null) as Record<string, string>;
    let selfClosing = false;
    while (true) {
      this.skipWhitespace();
      if (this.consume('/>')) { selfClosing = true; break; }
      if (this.consume('>')) break;
      const attributeName = this.readName();
      if (Object.hasOwn(attributes, attributeName)) throw new Error(`Workflow XML repeats attribute "${attributeName}".`);
      this.skipWhitespace();
      if (!this.consume('=')) throw new Error(`Workflow XML attribute "${attributeName}" is missing its value.`);
      this.skipWhitespace();
      const quote = this.source[this.position];
      if (quote !== '"' && quote !== "'") throw new Error(`Workflow XML attribute "${attributeName}" must be quoted.`);
      this.position += 1;
      const start = this.position;
      while (this.position < this.source.length && this.source[this.position] !== quote) {
        if (this.source[this.position] === '<') throw new Error('Workflow XML attribute values cannot contain <.');
        this.position += 1;
      }
      if (this.position >= this.source.length) throw new Error(`Workflow XML attribute "${attributeName}" is unterminated.`);
      const value = decodeLegacyXmlEntities(this.source.slice(start, this.position));
      this.position += 1;
      if (Buffer.byteLength(value, 'utf8') > 64 * 1024) throw new Error('Workflow XML attribute value exceeds 64 KiB.');
      this.attributeCount += 1;
      if (this.attributeCount > 4096) throw new Error('Workflow XML contains too many attributes.');
      attributes[attributeName] = value;
    }

    this.elementCount += 1;
    if (this.elementCount > 1024) throw new Error('Workflow XML contains too many elements.');
    if (selfClosing) return { name, attributes, children: [], text: '' };

    const children: LegacyXmlElement[] = [];
    let text = '';
    while (this.position < this.source.length) {
      if (this.consume(`</${name}`)) {
        this.skipWhitespace();
        if (!this.consume('>')) throw new Error(`Workflow XML closing tag for <${name}> is malformed.`);
        return { name, attributes, children, text };
      }
      if (this.source.startsWith('<!--', this.position)) {
        this.position += 4;
        const end = this.source.indexOf('-->', this.position);
        if (end < 0 || this.source.slice(this.position, end).includes('--')) throw new Error('Workflow XML comment is malformed.');
        this.position = end + 3;
        continue;
      }
      if (this.source.startsWith('<![CDATA[', this.position)) {
        this.position += 9;
        const end = this.source.indexOf(']]>', this.position);
        if (end < 0) throw new Error('Workflow XML CDATA section is unterminated.');
        text += this.source.slice(this.position, end);
        this.position = end + 3;
        continue;
      }
      if (this.source.startsWith('<?', this.position)) { this.skipProcessingInstruction(); continue; }
      if (this.source.startsWith('<!', this.position)) throw new Error('Workflow XML DTD and declarations are not supported.');
      if (this.source[this.position] === '<') { children.push(this.readElement(depth + 1)); continue; }
      const start = this.position;
      while (this.position < this.source.length && this.source[this.position] !== '<') this.position += 1;
      text += decodeLegacyXmlEntities(this.source.slice(start, this.position));
    }
    throw new Error(`Workflow XML element <${name}> is not closed.`);
  }

  private readName(): string {
    const start = this.position;
    const first = this.source.charCodeAt(this.position);
    if (!isXmlNameStart(first)) throw new Error('Workflow XML name is invalid.');
    this.position += 1;
    while (isXmlNamePart(this.source.charCodeAt(this.position))) this.position += 1;
    const name = this.source.slice(start, this.position);
    if (name.length > 128 || name.includes(':')) throw new Error('Workflow XML names must be unqualified and at most 128 characters.');
    return name;
  }

  private skipWhitespace(): void {
    while (isXmlWhitespace(this.source.charCodeAt(this.position))) this.position += 1;
  }

  private skipMisc(): void {
    while (true) {
      this.skipWhitespace();
      if (this.source.startsWith('<!--', this.position)) {
        this.position += 4;
        const end = this.source.indexOf('-->', this.position);
        if (end < 0 || this.source.slice(this.position, end).includes('--')) throw new Error('Workflow XML comment is malformed.');
        this.position = end + 3;
        continue;
      }
      if (this.source.startsWith('<?', this.position)) { this.skipProcessingInstruction(); continue; }
      if (this.source.startsWith('<!', this.position)) throw new Error('Workflow XML DTD and declarations are not supported.');
      return;
    }
  }

  private skipProcessingInstruction(): void {
    this.position += 2;
    const end = this.source.indexOf('?>', this.position);
    if (end < 0 || end - this.position > 1024) throw new Error('Workflow XML processing instruction is malformed.');
    this.position = end + 2;
  }

  private consume(value: string): boolean {
    if (!this.source.startsWith(value, this.position)) return false;
    this.position += value.length;
    return true;
  }
}

function isXmlWhitespace(code: number): boolean { return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d; }
function isXmlNameStart(code: number): boolean { return code === 0x5f || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a); }
function isXmlNamePart(code: number): boolean { return isXmlNameStart(code) || (code >= 0x30 && code <= 0x39) || code === 0x2d || code === 0x2e; }

function decodeLegacyXmlEntities(value: string): string {
  let result = '';
  for (let index = 0; index < value.length;) {
    if (value[index] !== '&') { result += value[index]!; index += 1; continue; }
    const end = value.indexOf(';', index + 1);
    if (end < 0 || end - index > 12) throw new Error('Workflow XML contains an unknown or malformed entity reference.');
    const entity = value.slice(index + 1, end);
    const predefined: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    let decoded = predefined[entity];
    if (decoded === undefined && entity.startsWith('#')) {
      const hex = entity[1] === 'x' || entity[1] === 'X';
      const digits = entity.slice(hex ? 2 : 1);
      if (digits === '' || !(hex ? /^[0-9a-fA-F]+$/ : /^[0-9]+$/).test(digits)) throw new Error('Workflow XML character reference is invalid.');
      const point = Number.parseInt(digits, hex ? 16 : 10);
      if (!Number.isSafeInteger(point) || !isValidXmlCodePoint(point)) throw new Error('Workflow XML character reference is not allowed.');
      decoded = String.fromCodePoint(point);
    }
    if (decoded === undefined) throw new Error('Workflow XML contains an unsupported entity reference.');
    result += decoded;
    index = end + 1;
  }
  return result;
}

function isValidXmlCodePoint(point: number): boolean {
  return point === 0x9 || point === 0xa || point === 0xd
    || (point >= 0x20 && point <= 0xd7ff)
    || (point >= 0xe000 && point <= 0xfffd)
    || (point >= 0x10000 && point <= 0x10ffff);
}

function childrenNamed(element: LegacyXmlElement, name: string): LegacyXmlElement[] {
  return element.children.filter((child) => child.name === name);
}

function assertOnlyChildren(element: LegacyXmlElement, names: readonly string[]): void {
  if (element.text.trim() !== '') throw new Error(`Workflow XML <${element.name}> has unsupported text content.`);
  const allowed = new Set(names);
  const unsupported = element.children.find((child) => !allowed.has(child.name));
  if (unsupported) throw new Error(`Unsupported <${unsupported.name}> element inside <${element.name}>.`);
}

function assertNoElementChildren(element: LegacyXmlElement, parent: string): void {
  if (element.children.length > 0) throw new Error(`Unexpected child element inside ${parent}.`);
}

function exactAttributes(element: LegacyXmlElement, names: readonly string[], label: string): Readonly<Record<string, string>> {
  const allowed = new Set(names);
  const unsupported = Object.keys(element.attributes).find((name) => !allowed.has(name));
  if (unsupported) throw new Error(`Unsupported ${label} attribute "${unsupported}".`);
  return element.attributes;
}

function requiredAttribute(attributes: Readonly<Record<string, string>>, name: string): string {
  const value = attributes[name];
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`Workflow XML is missing the "${name}" attribute.`);
  return value;
}

function booleanAttribute(value: string | undefined, fallback: boolean, label: string): boolean {
  if (value === undefined) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`Workflow XML ${label} must be true or false.`);
}

function integerAttribute(value: string, label: string): number {
  if (!/^-?\d+$/.test(value)) throw new Error(`Workflow XML ${label} must be an integer.`);
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`Workflow XML ${label} is outside the supported range.`);
  return number;
}

function mapLegacyXmlNode(element: LegacyXmlElement, depth: number): LegacyWorkflowNode {
  if (element.name !== 'node') throw new Error('Workflow <nodes> and <branch> sections may contain only <node> elements.');
  if (depth > 8) throw new Error('Workflow XML parallel nesting exceeds the supported depth.');
  const type = element.attributes.type;
  const id = requiredAttribute(element.attributes, 'id');
  if (typeof type !== 'string') throw new Error(`Workflow node "${id}" is missing its type.`);
  const description = element.attributes.description;
  const base = { id, type, ...(description === undefined ? {} : { description }) } as Record<string, unknown>;
  const noChildren = ['join', 'human', 'file_parse', 'archive_compress', 'archive_extract', 'input'];
  if (noChildren.includes(type) && element.children.length > 0) throw new Error(`Node "${id}" does not support child elements.`);
  if (element.text.trim() !== '') throw new Error(`Node "${id}" has unsupported text content.`);

  switch (type) {
    case 'connector': {
      const attrs = exactAttributes(element, ['id', 'type', 'description', 'connector', 'promptOverrideKey', 'outputPath'], 'connector node');
      base.connector = requiredAttribute(attrs, 'connector');
      if (attrs.promptOverrideKey !== undefined) base.promptOverrideKey = attrs.promptOverrideKey;
      if (attrs.outputPath !== undefined) base.outputPath = attrs.outputPath;
      const inputValues: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      let override: Record<string, unknown> | undefined;
      for (const child of element.children) {
        if (child.name === 'input') {
          const inputAttrs = exactAttributes(child, ['key', 'value'], 'connector input');
          assertNoElementChildren(child, 'connector input');
          const key = requiredAttribute(inputAttrs, 'key');
          if (Object.hasOwn(inputValues, key)) throw new Error(`Node "${id}" repeats input key "${key}".`);
          inputValues[key] = inputAttrs.value ?? child.text;
        } else if (child.name === 'overrideConnector') {
          if (override) throw new Error(`Node "${id}" repeats <overrideConnector>.`);
          const o = exactAttributes(child, ['prompt', 'staticFormFields', 'extraHeaders', 'responseContentPath', 'timeoutSec'], 'connector override');
          assertNoElementChildren(child, 'connector override');
          override = {};
          for (const key of ['prompt', 'staticFormFields', 'extraHeaders', 'responseContentPath'] as const) if (o[key] !== undefined) override[key] = o[key];
          if (o.timeoutSec !== undefined) override.timeoutSec = integerAttribute(o.timeoutSec, 'timeoutSec');
        } else throw new Error(`Unsupported <${child.name}> element inside connector node "${id}".`);
      }
      if (Object.keys(inputValues).length > 0) base.inputs = inputValues;
      if (override) base.overrideConnector = override;
      return base as unknown as LegacyWorkflowNode;
    }
    case 'parallel': {
      exactAttributes(element, ['id', 'type', 'description'], 'parallel node');
      assertOnlyChildren(element, ['branch']);
      if (element.children.length === 0 || element.children.length > 32) throw new Error(`Parallel node "${id}" must contain 1 to 32 branches.`);
      const branches = element.children.map((branch) => {
        if (branch.name !== 'branch') throw new Error(`Parallel node "${id}" contains an invalid branch.`);
        exactAttributes(branch, [], 'parallel branch');
        assertOnlyChildren(branch, ['node']);
        return branch.children.map((node) => mapLegacyXmlNode(node, depth + 1));
      });
      base.branches = branches;
      return base as unknown as LegacyWorkflowNode;
    }
    case 'join': {
      const attrs = exactAttributes(element, ['id', 'type', 'description', 'combine'], 'join node');
      if (attrs.combine !== undefined) base.combine = attrs.combine;
      return base as unknown as LegacyWorkflowNode;
    }
    case 'human': {
      const attrs = exactAttributes(element, ['id', 'type', 'description', 'message', 'resumeInputs'], 'human node');
      base.message = requiredAttribute(attrs, 'message');
      if (attrs.resumeInputs !== undefined) base.resumeInputs = attrs.resumeInputs.split(',').map((part) => part.trim());
      return base as unknown as LegacyWorkflowNode;
    }
    case 'file_parse': {
      const attrs = exactAttributes(element, ['id', 'type', 'description', 'source', 'parser'], 'file_parse node');
      base.source = attrs.source ?? '$files';
      if (attrs.parser !== undefined) base.parser = attrs.parser;
      return base as unknown as LegacyWorkflowNode;
    }
    case 'file_url_download': {
      const attrs = exactAttributes(element, ['id', 'type', 'description', 'urls', 'allowedExtensions'], 'file_url_download node');
      assertOnlyChildren(element, ['auth']);
      base.urls = attrs.urls ?? '$input.urls';
      if (attrs.allowedExtensions !== undefined) base.allowedExtensions = attrs.allowedExtensions;
      const auth = childrenNamed(element, 'auth');
      if (auth.length > 1) throw new Error(`Node "${id}" repeats <auth>.`);
      if (auth[0]) base.auth = mapLegacyXmlAuth(auth[0], 'download auth');
      return base as unknown as LegacyWorkflowNode;
    }
    case 'callback': {
      const attrs = exactAttributes(element, ['id', 'type', 'description', 'url', 'method', 'payload'], 'callback node');
      assertOnlyChildren(element, ['auth']);
      base.url = requiredAttribute(attrs, 'url');
      if (attrs.method !== undefined) base.method = attrs.method.toUpperCase();
      if (attrs.payload !== undefined) base.payload = attrs.payload;
      const auth = childrenNamed(element, 'auth');
      if (auth.length > 1) throw new Error(`Node "${id}" repeats <auth>.`);
      if (auth[0]) base.auth = mapLegacyXmlAuth(auth[0], 'callback auth');
      return base as unknown as LegacyWorkflowNode;
    }
    case 'archive_compress': {
      const attrs = exactAttributes(element, ['id', 'type', 'description', 'source', 'name', 'level'], 'archive_compress node');
      base.source = attrs.source ?? '$output';
      if (attrs.name !== undefined) base.name = attrs.name;
      if (attrs.level !== undefined) base.level = integerAttribute(attrs.level, 'level');
      return base as unknown as LegacyWorkflowNode;
    }
    case 'archive_extract': {
      const attrs = exactAttributes(element, ['id', 'type', 'description', 'source', 'destName', 'maxTotalBytes', 'maxEntries'], 'archive_extract node');
      base.source = requiredAttribute(attrs, 'source');
      if (attrs.destName !== undefined) base.destName = attrs.destName;
      if (attrs.maxTotalBytes !== undefined) base.maxTotalBytes = integerAttribute(attrs.maxTotalBytes, 'maxTotalBytes');
      if (attrs.maxEntries !== undefined) base.maxEntries = integerAttribute(attrs.maxEntries, 'maxEntries');
      return base as unknown as LegacyWorkflowNode;
    }
    case 'input': {
      const attrs = exactAttributes(element, ['id', 'type', 'description', 'key'], 'input node');
      base.key = requiredAttribute(attrs, 'key');
      return base as unknown as LegacyWorkflowNode;
    }
    default:
      throw new Error(`Unsupported node type "${type}" in workflow XML.`);
  }
}

function mapLegacyXmlAuth(element: LegacyXmlElement, label: string): Record<string, unknown> {
  if (element.name !== 'auth') throw new Error(`${label} element is malformed.`);
  const attrs = exactAttributes(element, ['type', 'token', 'header_name', 'header_value', 'query_key', 'query_value'], label);
  assertNoElementChildren(element, label);
  const auth: Record<string, unknown> = {};
  for (const key of ['type', 'token', 'header_name', 'header_value', 'query_key', 'query_value'] as const) if (attrs[key] !== undefined) auth[key] = attrs[key];
  return auth;
}
