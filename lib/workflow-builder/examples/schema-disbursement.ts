// lib/workflow-builder/examples/schema-disbursement.ts
// Example schema mirroring the existing code-driven `runDisbursement` workflow
// (classify -> extract -> HITL -> crosscheck -> report) in schema form.
import type { WorkflowSchema } from '../types';

const schema: WorkflowSchema = {
  slug: 'disbursement',
  name: 'Đối chiếu giải ngân (schema-driven)',
  version: 1,
  description: 'Schema-driven version of the disbursement approval workflow.',
  input_schema: {
    type: 'object',
    properties: {
      resolution_data: {
        type: 'object', required: true, widget: 'textarea',
        label: 'Nghị quyết tham chiếu', description: 'Số NQ, hạn mức, lãi suất, điều kiện.',
      },
      limit_amount: { type: 'number', required: true, widget: 'number', label: 'Hạn mức (VND)', default: 5000000000 },
      rate: { type: 'number', required: false, widget: 'number', label: 'Lãi suất (%)', default: 9.5 },
    },
  },
  nodes: [
    { id: 'classify', type: 'connector', connector: 'ext-classifier', promptOverrideKey: 'classify',
      inputs: { file: '$files' } },
    { id: 'extract', type: 'connector', connector: 'ext-data-extractor', promptOverrideKey: 'extract',
      inputs: { file: '$files', logical_docs: '$classify.output' } },
    { id: 'human_review', type: 'human', message: 'Vui lòng kiểm tra và phê duyệt kết quả bóc tách trước khi tiếp tục.',
      resumeInputs: ['extract'] },
    { id: 'crosscheck', type: 'connector', connector: 'ext-fact-verifier', promptOverrideKey: 'crosscheck',
      inputs: { text: '$extract.content', reference: '$input.resolution_data', limit: '$input.limit_amount' } },
    { id: 'report', type: 'connector', connector: 'ext-content-gen', promptOverrideKey: 'report',
      inputs: { text: '$crosscheck.content' } },
  ],
  flow: ['classify', 'extract', 'human_review', 'crosscheck', 'report'],
  output: { from: 'report', extra_data_from: 'crosscheck' },
};

export default schema;
