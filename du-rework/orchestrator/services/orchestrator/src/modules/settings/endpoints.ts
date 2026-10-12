export const CORE_ENDPOINTS = new Set(Object.entries({
  ingest: ['parse', 'ocr', 'digitize', 'split'], extract: ['invoice', 'contract', 'id-card', 'receipt', 'table', 'custom'],
  analyze: ['classify', 'sentiment', 'compliance', 'fact-check', 'quality', 'risk', 'summarize-eval'],
  transform: ['convert', 'translate', 'rewrite', 'redact', 'template'], generate: ['summary', 'outline', 'report', 'email', 'minutes', 'qa'], compare: ['diff', 'semantic', 'version'],
}).flatMap(([action, variants]) => variants.map(variant => `${action}:${variant}`)));

