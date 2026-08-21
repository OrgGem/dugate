// lib/workflow-builder/types.ts
// Shared type definitions for the schema-driven workflow builder.
// A workflow is described as a JSON schema (canonical form) which the
// interpreter (interpreter.ts) executes through existing primitives.

// ─── Input schema (business variables captured from UI / request) ────────────

export interface InputSchemaProperty {
  type: 'string' | 'number' | 'boolean' | 'string[]' | 'object';
  label?: string;
  required?: boolean;
  widget?: string; // e.g. 'textarea', 'number', 'select'
  description?: string;
  default?: unknown;
}

export interface InputSchema {
  type: 'object';
  properties: Record<string, InputSchemaProperty>;
}

// ─── Node types ──────────────────────────────────────────────────────────────

export type NodeType =
  | 'connector'        // call an ExternalApiConnection (prompt override via _prompt)
  | 'parallel'         // run N branches concurrently
  | 'join'             // merge outputs of branches
  | 'file_parse'       // parse docx/xlsx (or pdf optional) to text/markdown
  | 'file_url_download'// download files from URLs (with optional auth)
  | 'callback'         // send result to a URL (webhook) with optional auth
  | 'archive_compress' // bundle files/content into a zip
  | 'archive_extract'  // unzip files safely
  | 'human'            // HITL pause for approval / data entry
  | 'input';           // declare a business variable to inject

// ─── Bindings ──
// R-value expressions resolved during execution:
//   $a.b.c                    -> output of node 'a', dot-path 'b.c'
//   $input.var                -> business variable from request/form
//   $file / $files            -> current uploaded file(s)
//   literal                   -> used as-is

export type Binding = unknown;

// ─── Workflow nodes ──────────────────────────────────────────────────────────

export interface WorkflowNodeBase {
  id: string;
  type: NodeType;
  description?: string;
}

export interface ConnectorNode extends WorkflowNodeBase {
  type: 'connector';
  connector: string;          // ExternalApiConnection.slug
  promptOverrideKey?: string; // key into promptOverrides
  inputs?: Record<string, Binding>;
  outputPath?: string;        // dot-path into connector result JSON to use as this node's value
}

export interface ParallelNode extends WorkflowNodeBase {
  type: 'parallel';
  branches: WorkflowNode[][];
  // each branch is an ordered list of nodes
}

export interface JoinNode extends WorkflowNodeBase {
  type: 'join';
  // Inputs provided by branches automatically collected by the runner; here we
  // may declare how to combine (currently simply concatenate / merge).
  combine?: 'concat' | 'first' | 'merge';
}

export interface FileParseNode extends WorkflowNodeBase {
  type: 'file_parse';
  source: Binding;            // usually $file / $files / $download.output / $unzip.files
  parser?: 'auto' | 'excel' | 'word' | 'pdf';
}

export interface FileUrlNode extends WorkflowNodeBase {
  type: 'file_url_download';
  urls: Binding;
  auth?: {
    type: 'none' | 'bearer' | 'header' | 'query';
    token?: string;
    header_name?: string;
    header_value?: string;
    query_key?: string;
    query_value?: string;
  };
  allowedExtensions?: string;
}

export interface CallbackNode extends WorkflowNodeBase {
  type: 'callback';
  url: Binding;               // fixed string or $input.callback_url
  payload?: Binding;          // what to send (default: this node's accumulated output)
  method?: 'POST' | 'GET';
  auth?: {
    type: 'none' | 'bearer' | 'header' | 'query';
    token?: string;
    header_name?: string;
    header_value?: string;
  };
}

export interface ArchiveNodeCompress extends WorkflowNodeBase {
  type: 'archive_compress';
  source: Binding;            // array of entries (ArchiveEntryInput) OR array of file paths
  name?: string;
  level?: number;
}

export interface ArchiveNodeExtract extends WorkflowNodeBase {
  type: 'archive_extract';
  source: Binding;            // buffer (from prior output) or file path
  destName?: string;
  maxTotalBytes?: number;
  maxEntries?: number;
}

export interface HumanNode extends WorkflowNodeBase {
  type: 'human';
  message: string;
  // Which node outputs are available for human review/edit before resume
  resumeInputs?: string[];    // node ids
  nextStep?: number;          // index used by resume route (optional)
}

export interface InputNode extends WorkflowNodeBase {
  type: 'input';
  key: string;
}

export type WorkflowNode =
  | ConnectorNode
  | ParallelNode
  | JoinNode
  | FileParseNode
  | FileUrlNode
  | CallbackNode
  | ArchiveNodeCompress
  | ArchiveNodeExtract
  | HumanNode
  | InputNode;

// ─── Workflow schema (top-level) ─────────────────────────────────────────────

export interface WorkflowSchema {
  slug: string;
  name: string;
  version?: number;
  description?: string;
  input_schema?: InputSchema;
  nodes: WorkflowNode[];
  /** Ordered list of node ids forming the main linear flow (parallel expands inline) */
  flow: string[];
  output?: {
    from: string;         // node id whose output is the final content
    extra_data_from?: string; // node id whose extracted data becomes result.extracted_data
  };
}

// ─── Node result shape passed between nodes & to bindings ────────────────────

export interface NodeResult {
  nodeId: string;
  type: NodeType;
  content?: string;                 // primary textual output
  extractedData?: unknown;          // structured JSON
  files?: string[];                 // file paths (for file-producing nodes)
  /** container for arbitrary data referenced by $path bindings */
  data: Record<string, unknown>;
  output?: unknown;                 // resolved value used by downstream bindings
}
