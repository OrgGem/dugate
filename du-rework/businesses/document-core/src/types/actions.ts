/**
 * Typed domain interfaces for document-core 6 actions and 28 variants.
 */

// ── Ingest Variants (4) ──────────────────────────────────────────────────────────
export type IngestMode = 'parse' | 'ocr' | 'digitize' | 'split';

export interface IngestInput {
  mode: IngestMode;
  artifactIds?: string[];
  text?: string;
  pages?: string;
  language?: string;
  outputFormat?: 'json' | 'md' | 'text';
}

export interface IngestResultData {
  text?: string;
  markdown?: string;
  splitArtifacts?: Array<{
    artifactId: string;
    fileName: string;
    pageCount: number;
    pageRange: string;
  }>;
  formFields?: Record<string, unknown>;
  metadata: {
    pageCount?: number;
    detectedFormat?: string;
    parser: string;
    provenance: 'native_parse' | 'ocr' | 'vision';
  };
}

// ── Extract Variants (5) ─────────────────────────────────────────────────────────
export type ExtractType = 'invoice' | 'contract' | 'receipt' | 'table' | 'custom';

export interface ExtractInput {
  type: ExtractType;
  artifactIds?: string[];
  text?: string;
  fields?: string[] | string;
  schema?: Record<string, unknown>;
  outputFormat?: 'json';
}

export interface InvoiceData {
  supplier: { name: string; taxId?: string };
  buyer: { name: string; taxId?: string };
  invoiceNumber: string;
  invoiceDate: string;
  lineItems: Array<{
    description: string;
    quantity: number;
    unitPrice: number;
    amount: number;
  }>;
  subtotal: number;
  vatRate?: number;
  vatAmount?: number;
  total: number;
  currency: string;
}

export interface ContractData {
  title?: string;
  parties: { partyA: string; partyB: string };
  effectiveDate?: string;
  expiryDate?: string;
  value?: number;
  currency?: string;
  penaltyClauses?: string[];
  governingLaw?: string;
}

export interface ReceiptData {
  merchantName: string;
  date?: string;
  items: Array<{ name: string; price: number }>;
  totalAmount: number;
  paymentMethod?: string;
}

export interface TableData {
  tables: Array<{
    title?: string;
    headers: string[];
    rows: string[][];
  }>;
}

// ── Analyze Variants (5) ─────────────────────────────────────────────────────────
export type AnalyzeTask = 'classify' | 'sentiment' | 'compliance' | 'quality' | 'risk';

export interface AnalyzeInput {
  task: AnalyzeTask;
  artifactIds?: string[];
  text?: string;
  categories?: string[] | string;
  criteria?: string[] | string;
  referenceData?: Record<string, unknown> | string;
}

export interface ClassificationResult {
  category: string;
  confidence: number;
  reasoning: string;
  secondaryCategories?: Array<{ category: string; confidence: number }>;
}

export interface SentimentResult {
  sentiment: 'positive' | 'negative' | 'neutral' | 'mixed';
  score: number; // -1.0 to 1.0
  explanation: string;
}

export interface ComplianceResult {
  status: 'PASS' | 'FAIL';
  score: number;
  violations: Array<{
    ruleId?: string;
    rule: string;
    excerpt?: string;
    severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    recommendation?: string;
  }>;
}

export interface QualityResult {
  overallScore: number;
  grammarScore: number;
  clarityScore: number;
  logicScore: number;
  suggestions: string[];
}

export interface RiskResult {
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  riskScore: number;
  risks: Array<{
    type: string;
    description: string;
    clauseReference?: string;
    severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  }>;
}

// ── Transform Variants (5) ───────────────────────────────────────────────────────
export type TransformVariant = 'convert' | 'translate' | 'rewrite' | 'redact' | 'template';

export interface TransformInput {
  variant: TransformVariant;
  artifactIds?: string[];
  text?: string;
  targetLanguage?: string;
  style?: 'academic' | 'executive' | 'simplified' | 'bullet_points';
  tone?: 'formal' | 'casual' | 'business' | 'academic';
  redactPatterns?: string[];
  template?: string;
  outputFormat?: string;
}

export interface TransformResultData {
  transformedText: string;
  outputFormat: string;
  metadata?: Record<string, unknown>;
}

// ── Generate Variants (6) ────────────────────────────────────────────────────────
export type GenerateTask = 'summary' | 'outline' | 'report' | 'email' | 'minutes' | 'qa';

export interface GenerateInput {
  task: GenerateTask;
  artifactIds?: string[];
  text?: string;
  format?: 'paragraph' | 'bullets' | 'numbered' | 'table';
  maxWords?: number;
  tone?: 'formal' | 'casual' | 'business' | 'academic';
  audience?: string;
  questions?: string[] | string;
}

export interface SummaryResult {
  summaryText: string;
  keyPoints?: string[];
  wordCount: number;
}

export interface OutlineResult {
  outlineItems: Array<{
    level: number;
    title: string;
    summary?: string;
  }>;
}

export interface ReportResult {
  title: string;
  executiveSummary: string;
  sections: Array<{ heading: string; content: string }>;
  recommendations: string[];
}

export interface EmailResult {
  subject: string;
  salutation: string;
  body: string;
  signoff: string;
}

export interface MinutesResult {
  meetingTopic?: string;
  attendees?: string[];
  decisions: string[];
  actionItems: Array<{
    assignee: string;
    task: string;
    deadline?: string;
  }>;
}

export interface QAResult {
  answers: Array<{
    question: string;
    answer: string;
    evidenceQuote?: string;
    confidence: number;
  }>;
}

// ── Compare Variants (3) ─────────────────────────────────────────────────────────
export type CompareMode = 'diff' | 'semantic' | 'version';

export interface CompareSide {
  artifactId?: string;
  text?: string;
}

export interface CompareInput {
  mode: CompareMode;
  source: CompareSide;
  target: CompareSide;
  focus?: string;
  outputFormat?: 'json' | 'md' | 'text';
}

export interface SemanticChange {
  clauseTitle?: string;
  sourceExcerpt?: string;
  targetExcerpt?: string;
  changeType: 'ADDED' | 'MODIFIED' | 'DELETED';
  legalSignificance: 'NEGLIGIBLE' | 'MODERATE' | 'HIGH';
  commentary: string;
}

export interface VersionChangelog {
  versionSummary: string;
  additions: string[];
  modifications: string[];
  deletions: string[];
}
