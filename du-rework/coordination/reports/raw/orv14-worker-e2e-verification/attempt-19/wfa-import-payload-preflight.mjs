import { createHash } from 'node:crypto';
import {
  LegacyWorkflowSchemaPinSchema,
  LegacyWorkflowSchemaSchema,
  WorkflowImportPreviewRequestSchema,
  WorkflowImportPreviewResponseSchema,
} from '../../../../../orchestrator/packages/contracts/dist/index.js';

const tenantId = '7deca786-d2b8-49cd-b552-0c3b2da83bb0';
const xmlSlug = 'orv14-import-xml-preflight';
const xmlSource = `<?xml version="1.0"?>
  <workflow slug="${xmlSlug}" name="Imported XML human workflow" version="1">
    <input><property name="reference" type="string" required="true" /></input>
    <nodes>
      <node id="request_value" type="input" key="reference" />
      <node id="human_review" type="human" message="Review imported XML result" resumeInputs="extracted_data" />
    </nodes>
    <flow><step id="request_value" /><step id="human_review" /></flow>
    <output from="human_review" extra_data_from="human_review" />
  </workflow>`;
const xmlSchema = {
  slug: xmlSlug,
  name: 'Imported XML human workflow',
  version: 1,
  input_schema: { type: 'object', properties: { reference: { type: 'string', required: true } } },
  nodes: [
    { id: 'request_value', type: 'input', key: 'reference' },
    { id: 'human_review', type: 'human', message: 'Review imported XML result', resumeInputs: ['extracted_data'] },
  ],
  flow: ['request_value', 'human_review'],
  output: { from: 'human_review', extra_data_from: 'human_review' },
};
const jsonSlug = 'orv14-import-json-preflight';
const jsonSchema = {
  slug: jsonSlug,
  name: 'Imported JSON branch join workflow',
  version: 1,
  input_schema: {
    type: 'object',
    properties: {
      left: { type: 'string', required: true },
      right: { type: 'string', required: true },
    },
  },
  nodes: [
    {
      id: 'parallel_import',
      type: 'parallel',
      branches: [
        [{ id: 'left_value', type: 'input', key: 'left' }],
        [{ id: 'right_value', type: 'input', key: 'right' }],
      ],
    },
    { id: 'join_import', type: 'join', combine: 'first' },
  ],
  flow: ['parallel_import', 'join_import'],
  output: { from: 'join_import' },
};

const preflight = [];
function check(name, parsed) {
  if (!parsed.success) throw new Error(`${name} rejected: ${JSON.stringify(parsed.error.issues.map(({ path, message }) => ({ path, message })))}`);
  preflight.push({ name, passed: true });
}

const xmlRequest = { tenantId, format: 'xml', source: xmlSource };
check('WorkflowImportPreviewRequestSchema XML request', WorkflowImportPreviewRequestSchema.safeParse(xmlRequest));
check('LegacyWorkflowSchemaSchema XML decoder result shape', LegacyWorkflowSchemaSchema.safeParse(xmlSchema));
check('WorkflowImportPreviewResponseSchema XML response shape', WorkflowImportPreviewResponseSchema.safeParse({
  tenantId, format: 'xml', schema: xmlSchema, connectorNames: [], egress: [],
  sourceDigest: `sha256:${createHash('sha256').update(xmlSource).digest('hex')}`,
}));
check('LegacyWorkflowSchemaPinSchema XML revision-1 pin', LegacyWorkflowSchemaPinSchema.safeParse({
  tenantId, slug: xmlSlug, revision: 1, digest: `sha256:${'a'.repeat(64)}`, schema: xmlSchema,
}));

const jsonSource = JSON.stringify(jsonSchema);
check('WorkflowImportPreviewRequestSchema JSON request', WorkflowImportPreviewRequestSchema.safeParse({ tenantId, format: 'json', source: jsonSource }));
check('LegacyWorkflowSchemaSchema JSON schema', LegacyWorkflowSchemaSchema.safeParse(jsonSchema));
check('WorkflowImportPreviewResponseSchema JSON response shape', WorkflowImportPreviewResponseSchema.safeParse({
  tenantId, format: 'json', schema: jsonSchema, connectorNames: [], egress: [],
  sourceDigest: `sha256:${createHash('sha256').update(jsonSource).digest('hex')}`,
}));
check('LegacyWorkflowSchemaPinSchema JSON revision-1 pin', LegacyWorkflowSchemaPinSchema.safeParse({
  tenantId, slug: jsonSlug, revision: 1, digest: `sha256:${'b'.repeat(64)}`, schema: jsonSchema,
}));

process.stdout.write(`${JSON.stringify({
  scope: 'offline current compiled-contract DTO preflight only; no HTTP, DB, Redis, Connector, Worker, or provider calls',
  sourceFormats: ['xml', 'json'],
  checks: preflight,
  passed: preflight.length,
  failed: 0,
}, null, 2)}\n`);
