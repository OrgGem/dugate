// lib/workflow-builder/xml-converter.ts
// Convert a workflow XML definition into the canonical JSON WorkflowSchema
// (and back). XML is a convenience authoring format; JSON is canonical.
import { XMLParser, XMLBuilder } from 'fast-xml-parser';
import type { WorkflowSchema, WorkflowNode, InputSchema, InputSchemaProperty } from './types';

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

export interface XmlDocument {
  workflow?: any;
}

/** Convert workflow XML to canonical JSON schema. */
export function xmlToSchema(xml: string): WorkflowSchema {
  let raw: XmlDocument;
  try {
    raw = parser.parse(xml) as XmlDocument;
  } catch (err) {
    throw new Error(`Invalid workflow XML: ${err instanceof Error ? err.message : String(err)}`);
  }

  const wf = raw?.workflow;
  if (!wf) throw new Error('Missing <workflow> root element.');

  const slug = wf['@_slug'] ?? '';
  const name = wf['@_name'] ?? slug;

  // Input schema
  const inputSchema: InputSchema = { type: 'object', properties: {} };
  const inputBlock = wf.input;
  if (inputBlock?.property) {
    const props = Array.isArray(inputBlock.property) ? inputBlock.property : [inputBlock.property];
    for (const p of props) {
      const propName = p['@_name'];
      if (!propName) continue;
      inputSchema.properties[propName] = {
        type: (p['@_type'] as InputSchemaProperty['type']) ?? 'string',
        required: p['@_required'] === 'true',
        label: p['@_label'],
        widget: p['@_widget'],
        description: p['@_description'] ?? p['#text'],
      } as InputSchemaProperty;
    }
  }

  // Nodes
  const nodes: WorkflowNode[] = [];
  if (!wf.nodes || !wf.nodes.node) throw new Error("Invalid workflow XML: missing <nodes> section.");
  const rawNodes = wf.nodes?.node;
  const nodeList = rawNodes === undefined ? [] : (Array.isArray(rawNodes) ? rawNodes : [rawNodes]);

  for (const rawNode of nodeList) {
    const id = rawNode['@_id'];
    const type = rawNode['@_type'];
    const base: any = { id, type };
    if (rawNode['@_description']) base.description = rawNode['@_description'];

    switch (type) {
      case 'connector': {
        base.connector = rawNode['@_connector'];
        if (rawNode['@_promptOverrideKey']) base.promptOverrideKey = rawNode['@_promptOverrideKey'];
        if (rawNode['@_outputPath']) base.outputPath = rawNode['@_outputPath'];
        if (rawNode.overrideConnector) {
          base.overrideConnector = {};
          const oc = rawNode.overrideConnector;
          if (oc['@_prompt']) base.overrideConnector.prompt = oc['@_prompt'];
          if (oc['@_staticFormFields']) base.overrideConnector.staticFormFields = oc['@_staticFormFields'];
          if (oc['@_extraHeaders']) base.overrideConnector.extraHeaders = oc['@_extraHeaders'];
          if (oc['@_responseContentPath']) base.overrideConnector.responseContentPath = oc['@_responseContentPath'];
          if (oc['@_timeoutSec']) base.overrideConnector.timeoutSec = Number(oc['@_timeoutSec']);
        }
        base.inputs = parseInputs(rawNode.input);
        nodes.push(base);
        break;
      }
      case 'parallel': {
        const branches: WorkflowNode[][] = [];
        const bs = rawNode.branch;
        if (bs) {
          const list = Array.isArray(bs) ? bs : [bs];
          for (const branch of list) {
            const inner = branch.node;
            const innerList = inner === undefined ? [] : (Array.isArray(inner) ? inner : [inner]);
            branches.push(innerList.map((n: any) => convertNode(n)));
          }
        }
        base.branches = branches;
        nodes.push(base);
        break;
      }
      case 'join': {
        if (rawNode['@_combine']) base.combine = rawNode['@_combine'];
        nodes.push(base);
        break;
      }
      case 'human': {
        base.message = rawNode['@_message'] ?? '';
        if (rawNode['@_resumeInputs']) base.resumeInputs = rawNode['@_resumeInputs'].split(',');
        nodes.push(base);
        break;
      }
      case 'file_parse': {
        base.source = rawNode['@_source'] ?? '$files';
        if (rawNode['@_parser']) base.parser = rawNode['@_parser'];
        nodes.push(base);
        break;
      }
      case 'file_url_download': {
        base.urls = rawNode['@_urls'] ?? '$input.urls';
        if (rawNode['@_allowedExtensions']) base.allowedExtensions = rawNode['@_allowedExtensions'];
        if (rawNode.auth) base.auth = parseAuth(rawNode.auth);
        nodes.push(base);
        break;
      }
      case 'callback': {
        base.url = rawNode['@_url'];
        base.method = (rawNode['@_method'] ?? 'POST').toUpperCase();
        if (rawNode['@_payload']) base.payload = rawNode['@_payload'];
        if (rawNode.auth) base.auth = parseAuth(rawNode.auth);
        nodes.push(base);
        break;
      }
      case 'archive_compress': {
        base.source = rawNode['@_source'] ?? '$output';
        if (rawNode['@_name']) base.name = rawNode['@_name'];
        nodes.push(base);
        break;
      }
      case 'archive_extract': {
        base.source = rawNode['@_source'];
        if (rawNode['@_maxTotalBytes']) base.maxTotalBytes = Number(rawNode['@_maxTotalBytes']);
        if (rawNode['@_maxEntries']) base.maxEntries = Number(rawNode['@_maxEntries']);
        if (rawNode['@_destName']) base.destName = rawNode['@_destName'];
        nodes.push(base);
        break;
      }
      case 'input': {
        base.key = rawNode['@_key'];
        nodes.push(base);
        break;
      }
      default:
        throw new Error(`Unsupported node type '${type}' in workflow XML.`);
    }
  }

  // Flow
  const flow: string[] = [];
  const fsRaw = wf.flow?.step;
  if (fsRaw) {
    const steps = Array.isArray(fsRaw) ? fsRaw : [fsRaw];
    for (const s of steps) {
      if (s['@_id']) flow.push(s['@_id']);
    }
  }

  const schema: WorkflowSchema = {
    slug,
    name,
    version: wf['@_version'] ? Number(wf['@_version']) : 1,
    description: wf['@_description'],
    input_schema: Object.keys(inputSchema.properties).length > 0 ? inputSchema : undefined,
    nodes,
    flow,
  };

  if (wf.output) {
    schema.output = { from: wf.output['@_from'] };
    if (wf.output['@_extra_data_from']) schema.output.extra_data_from = wf.output['@_extra_data_from'];
  }

  return schema;
}

function convertNode(rawNode: any): WorkflowNode {
  const id = rawNode['@_id'];
  const type = rawNode['@_type'];
  const base: any = { id, type };
  if (type === 'connector') {
    base.connector = rawNode['@_connector'];
    if (rawNode['@_promptOverrideKey']) base.promptOverrideKey = rawNode['@_promptOverrideKey'];
    if (rawNode.overrideConnector) {
      base.overrideConnector = {};
      const oc = rawNode.overrideConnector;
      if (oc['@_prompt']) base.overrideConnector.prompt = oc['@_prompt'];
      if (oc['@_staticFormFields']) base.overrideConnector.staticFormFields = oc['@_staticFormFields'];
      if (oc['@_extraHeaders']) base.overrideConnector.extraHeaders = oc['@_extraHeaders'];
      if (oc['@_responseContentPath']) base.overrideConnector.responseContentPath = oc['@_responseContentPath'];
      if (oc['@_timeoutSec']) base.overrideConnector.timeoutSec = Number(oc['@_timeoutSec']);
    }
    base.inputs = parseInputs(rawNode.input);
  } else if (type === 'human') {
    base.message = rawNode['@_message'] ?? '';
  } else if (type === 'file_parse') {
    base.source = rawNode['@_source'] ?? '$files';
  } else if (type === 'callback') {
    base.url = rawNode['@_url'];
    base.method = (rawNode['@_method'] ?? 'POST').toUpperCase();
    if (rawNode['@_payload']) base.payload = rawNode['@_payload'];
    if (rawNode.auth) base.auth = parseAuth(rawNode.auth);
  } else if (type === 'file_url_download') {
    base.urls = rawNode['@_urls'] ?? '$input.urls';
    if (rawNode['@_allowedExtensions']) base.allowedExtensions = rawNode['@_allowedExtensions'];
    if (rawNode.auth) base.auth = parseAuth(rawNode.auth);
  } else if (type === 'archive_extract') {
    base.source = rawNode['@_source'];
    if (rawNode['@_maxTotalBytes']) base.maxTotalBytes = Number(rawNode['@_maxTotalBytes']);
    if (rawNode['@_maxEntries']) base.maxEntries = Number(rawNode['@_maxEntries']);
    if (rawNode['@_destName']) base.destName = rawNode['@_destName'];
  } else if (type === 'join') {
    if (rawNode['@_combine']) base.combine = rawNode['@_combine'];
  }
  return base as WorkflowNode;
}

function parseInputs(inputEl: any): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};
  if (!inputEl) return inputs;
  // single <input key=".." value=".."/>
  if (!Array.isArray(inputEl) && inputEl['@_key']) {
    inputs[inputEl['@_key']] = inputEl['@_value'] ?? (inputEl['#text'] ?? '');
    return inputs;
  }
  const items = Array.isArray(inputEl) ? inputEl : [inputEl];
  for (const item of items) {
    if (item && item['@_key']) {
      inputs[item['@_key']] = item['@_value'] ?? (item['#text'] ?? '');
    }
  }
  return inputs;
}

function parseAuth(authEl: any): Record<string, unknown> {
  const auth: Record<string, unknown> = {};
  if (!authEl) return auth;
  if (authEl['@_type']) auth.type = authEl['@_type'];
  if (authEl['@_token']) auth.token = authEl['@_token'];
  if (authEl['@_header_name']) auth.header_name = authEl['@_header_name'];
  if (authEl['@_header_value']) auth.header_value = authEl['@_header_value'];
  if (authEl['@_query_key']) auth.query_key = authEl['@_query_key'];
  if (authEl['@_query_value']) auth.query_value = authEl['@_query_value'];
  return auth;
}

/** Convert canonical JSON schema back to an XML string (for round-trip / authoring). */
export function schemaToXml(schema: WorkflowSchema): string {
  const builder = new XMLBuilder({ ignoreAttributes: false, format: true, attributeNamePrefix: '@_' });

  const wf: any = {
    '@_slug': schema.slug,
    '@_name': schema.name,
    nodes: { node: schema.nodes.map((n) => nodeToXml(n)) },
    flow: { step: schema.flow.map((id) => ({ '@_id': id })) },
  };
  if (schema.version) wf['@_version'] = schema.version;
  if (schema.description) wf['@_description'] = schema.description;
  if (schema.input_schema) {
    wf.input = {
      property: Object.entries(schema.input_schema.properties).map(([k, v]) => ({
        '@_name': k, '@_type': v.type, '@_required': v.required ? 'true' : undefined, '@_label': v.label,
      })),
    };
  }
  if (schema.output) {
    wf.output = { '@_from': schema.output.from };
    if (schema.output.extra_data_from) wf.output['@_extra_data_from'] = schema.output.extra_data_from;
  }

  const xml = builder.build({ workflow: wf });
  return xml;
}

function nodeToXml(n: WorkflowNode): any {
  const anyNode = n as any;
  const out: any = { '@_id': n.id, '@_type': n.type };
  if (anyNode.connector) out['@_connector'] = anyNode.connector;
  if (anyNode.promptOverrideKey) out['@_promptOverrideKey'] = anyNode.promptOverrideKey;
  if (anyNode.message) out['@_message'] = anyNode.message;
  if (anyNode.source) out['@_source'] = typeof anyNode.source === 'string' ? anyNode.source : JSON.stringify(anyNode.source);
  if (anyNode.connector && anyNode.inputs) {
    out.input = Object.entries(anyNode.inputs).map(([k, v]) => ({
      '@_key': k,
      '@_value': typeof v === 'string' ? v : JSON.stringify(v),
    }));
  }
  if (anyNode.overrideConnector) {
    const oc = anyNode.overrideConnector;
    out.overrideConnector = {};
    if (oc.prompt) out.overrideConnector['@_prompt'] = oc.prompt;
    if (oc.staticFormFields) out.overrideConnector['@_staticFormFields'] = oc.staticFormFields;
    if (oc.extraHeaders) out.overrideConnector['@_extraHeaders'] = oc.extraHeaders;
    if (oc.responseContentPath) out.overrideConnector['@_responseContentPath'] = oc.responseContentPath;
    if (oc.timeoutSec) out.overrideConnector['@_timeoutSec'] = oc.timeoutSec;
  }
  if (anyNode.branches) {
    out.branch = anyNode.branches.map((b: WorkflowNode[]) => ({ node: b.map(nodeToXml) }));
  }
  if (anyNode.auth) {
    const a = anyNode.auth;
    out.auth = { '@_type': a.type };
    if (a.token) out.auth['@_token'] = a.token;
    if (a.header_name) out.auth['@_header_name'] = a.header_name;
    if (a.header_value) out.auth['@_header_value'] = a.header_value;
    if (a.query_key) out.auth['@_query_key'] = a.query_key;
    if (a.query_value) out.auth['@_query_value'] = a.query_value;
  }
  if (anyNode.maxTotalBytes) out['@_maxTotalBytes'] = anyNode.maxTotalBytes;
  if (anyNode.maxEntries) out['@_maxEntries'] = anyNode.maxEntries;
  if (anyNode.destName) out['@_destName'] = anyNode.destName;
  if (anyNode.level) out['@_level'] = anyNode.level;
  if (anyNode.urls) out['@_urls'] = typeof anyNode.urls === 'string' ? anyNode.urls : JSON.stringify(anyNode.urls);
  if (anyNode.url) out['@_url'] = anyNode.url;
  if (anyNode.method) out['@_method'] = anyNode.method;
  if (anyNode.payload) out['@_payload'] = anyNode.payload;
  if (anyNode.parser) out['@_parser'] = anyNode.parser;
  if (anyNode.combine) out['@_combine'] = anyNode.combine;
  if (anyNode.key) out['@_key'] = anyNode.key;
  return out;
}
