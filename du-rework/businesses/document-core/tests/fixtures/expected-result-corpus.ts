/**
 * Non-Sensitive Expected Result Corpus (P0-05 / Wave 39 / RV-06)
 *
 * Contains 100% non-sensitive, synthetic test fixture inputs and their
 * machine-verified expected result envelopes for all 28 canonical document variants.
 *
 * DERIVATION GUARANTEE:
 * Every expected result envelope in this corpus was directly derived by executing
 * the actual documentCoreHandlers and document-kit parsers on synthetic inputs.
 * Zero results were inferred or hand-approximated.
 *
 * EXECUTION PARTITION:
 * - Native variants (DOC-01-01, DOC-01-04, DOC-04-01, DOC-04-04, DOC-04-05, DOC-06-01):
 *   executionMode='native', 0 tokens, 0 microUSD cost, zero provider connector calls.
 * - Provider-backed variants (22 variants):
 *   executionMode='provider', connector tokens tracked, model slot required.
 */

export interface CorpusVariantEntry {
  brdCaseId: string;
  action: string;
  variant: string;
  executionMode: 'native' | 'provider';
  expectedTokenUsage: {
    inputTokens: number;
    outputTokens: number;
    costMicrousd: number;
  };
  syntheticInput: Record<string, unknown>;
  derivedExpectedEnvelope: {
    status: 'COMPLETED';
    variant?: string;
    data: unknown;
    metadata?: Record<string, unknown>;
    provenance?: unknown;
    warnings?: unknown[];
    [key: string]: unknown;
  };
}

export const EXPECTED_RESULT_CORPUS: Record<string, CorpusVariantEntry> = {
  "DOC-01-01": {
    "brdCaseId": "DOC-01-01",
    "action": "ingest",
    "variant": "parse",
    "executionMode": "native",
    "expectedTokenUsage": {
      "inputTokens": 0,
      "outputTokens": 0,
      "costMicrousd": 0
    },
    "syntheticInput": {
      "mode": "parse",
      "text": "Sample document text for ingestion"
    },
    "derivedExpectedEnvelope": {
      "status": "COMPLETED",
      "data": {
        "text": "Sample document text for ingestion",
        "markdown": "Sample document text for ingestion",
        "metadata": {
          "detectedFormat": "txt",
          "parser": "inline-text",
          "provenance": "native_parse"
        }
      },
      "provenance": {
        "method": "native_parse",
        "parserUsed": "inline-text"
      },
      "warnings": []
    }
  },
  "DOC-01-02": {
    "brdCaseId": "DOC-01-02",
    "action": "ingest",
    "variant": "ocr",
    "executionMode": "provider",
    "expectedTokenUsage": {
      "inputTokens": 100,
      "outputTokens": 50,
      "costMicrousd": 250
    },
    "syntheticInput": {
      "mode": "ocr",
      "text": "Scanned image text content"
    },
    "derivedExpectedEnvelope": {
      "status": "COMPLETED",
      "data": {
        "text": "Scanned receipt text",
        "markdown": "# Scanned receipt",
        "metadata": {
          "detectedFormat": "image/scan",
          "parser": "connector:ocr",
          "provenance": "ocr"
        }
      },
      "provenance": {
        "method": "ocr",
        "modelSlot": "ocr",
        "parserUsed": "connector:ocr"
      },
      "warnings": []
    }
  },
  "DOC-01-03": {
    "brdCaseId": "DOC-01-03",
    "action": "ingest",
    "variant": "digitize",
    "executionMode": "provider",
    "expectedTokenUsage": {
      "inputTokens": 100,
      "outputTokens": 50,
      "costMicrousd": 250
    },
    "syntheticInput": {
      "mode": "digitize",
      "text": "Handwritten intake form"
    },
    "derivedExpectedEnvelope": {
      "status": "COMPLETED",
      "data": {
        "text": "Patient Intake Form",
        "markdown": "",
        "formFields": {
          "patientName": "John Doe",
          "age": 35
        },
        "metadata": {
          "detectedFormat": "image/form",
          "parser": "connector:vision",
          "provenance": "vision"
        }
      },
      "provenance": {
        "method": "ocr",
        "modelSlot": "vision",
        "parserUsed": "connector:vision"
      },
      "warnings": []
    }
  },
  "DOC-01-04": {
    "brdCaseId": "DOC-01-04",
    "action": "ingest",
    "variant": "split",
    "executionMode": "native",
    "expectedTokenUsage": {
      "inputTokens": 0,
      "outputTokens": 0,
      "costMicrousd": 0
    },
    "syntheticInput": {
      "mode": "split",
      "pages": "1",
      "artifactIds": [
        "ed632a91-34ee-4009-9ff7-340a94579b96"
      ]
    },
    "derivedExpectedEnvelope": {
      "status": "COMPLETED",
      "data": {
        "splitArtifacts": [
          {
            "artifactId": "2e83864f-438f-4195-bf86-0b6678a30a11",
            "fileName": "split_1.pdf",
            "pageCount": 1,
            "pageRange": "1"
          }
        ],
        "metadata": {
          "pageCount": 1,
          "detectedFormat": "pdf",
          "parser": "document-kit:pdf-splitter",
          "provenance": "native_parse"
        }
      },
      "provenance": {
        "method": "native_parse",
        "parserUsed": "document-kit:pdf-splitter"
      },
      "warnings": []
    }
  },
  "DOC-02-01": {
    "brdCaseId": "DOC-02-01",
    "action": "extract",
    "variant": "invoice",
    "executionMode": "provider",
    "expectedTokenUsage": {
      "inputTokens": 100,
      "outputTokens": 50,
      "costMicrousd": 250
    },
    "syntheticInput": {
      "type": "invoice",
      "text": "Invoice #101 for $500.00 from Acme Corp"
    },
    "derivedExpectedEnvelope": {
      "status": "COMPLETED",
      "data": {
        "invoiceNumber": "INV-101",
        "supplier": "Acme Corp",
        "total": "$500.00"
      },
      "provenance": {
        "method": "llm_extraction",
        "modelSlot": "reasoning"
      },
      "warnings": []
    }
  },
  "DOC-02-02": {
    "brdCaseId": "DOC-02-02",
    "action": "extract",
    "variant": "contract",
    "executionMode": "provider",
    "expectedTokenUsage": {
      "inputTokens": 100,
      "outputTokens": 50,
      "costMicrousd": 250
    },
    "syntheticInput": {
      "type": "contract",
      "text": "Agreement between Party A and Party B effective 2026-01-01"
    },
    "derivedExpectedEnvelope": {
      "status": "COMPLETED",
      "data": {
        "title": "Master Service Agreement",
        "parties": [
          "Party A",
          "Party B"
        ],
        "effectiveDate": "2026-01-01"
      },
      "provenance": {
        "method": "llm_extraction",
        "modelSlot": "reasoning"
      },
      "warnings": []
    }
  },
  "DOC-02-03": {
    "brdCaseId": "DOC-02-03",
    "action": "extract",
    "variant": "receipt",
    "executionMode": "provider",
    "expectedTokenUsage": {
      "inputTokens": 100,
      "outputTokens": 50,
      "costMicrousd": 250
    },
    "syntheticInput": {
      "type": "receipt",
      "text": "Grocery store receipt for $25.50"
    },
    "derivedExpectedEnvelope": {
      "status": "COMPLETED",
      "data": {
        "merchantName": "Corner Grocery",
        "totalAmount": 25.5,
        "items": [
          {
            "name": "Milk",
            "price": 3.5
          }
        ]
      },
      "provenance": {
        "method": "llm_extraction",
        "modelSlot": "reasoning"
      },
      "warnings": []
    }
  },
  "DOC-02-04": {
    "brdCaseId": "DOC-02-04",
    "action": "extract",
    "variant": "table",
    "executionMode": "provider",
    "expectedTokenUsage": {
      "inputTokens": 100,
      "outputTokens": 50,
      "costMicrousd": 250
    },
    "syntheticInput": {
      "type": "table",
      "text": "Col1,Col2\nVal1,Val2"
    },
    "derivedExpectedEnvelope": {
      "status": "COMPLETED",
      "data": {
        "headers": [
          "Col1",
          "Col2"
        ],
        "rows": [
          [
            "Val1",
            "Val2"
          ]
        ]
      },
      "provenance": {
        "method": "llm_extraction",
        "modelSlot": "reasoning"
      },
      "warnings": []
    }
  },
  "DOC-02-05": {
    "brdCaseId": "DOC-02-05",
    "action": "extract",
    "variant": "custom",
    "executionMode": "provider",
    "expectedTokenUsage": {
      "inputTokens": 100,
      "outputTokens": 50,
      "costMicrousd": 250
    },
    "syntheticInput": {
      "type": "custom",
      "text": "Project documentation for PRJ-99",
      "schema": {
        "type": "object",
        "properties": {
          "projectId": {
            "type": "string"
          },
          "status": {
            "type": "string"
          }
        },
        "required": [
          "projectId",
          "status"
        ]
      }
    },
    "derivedExpectedEnvelope": {
      "status": "COMPLETED",
      "data": {
        "projectId": "PRJ-99",
        "status": "ACTIVE"
      },
      "provenance": {
        "method": "llm_extraction",
        "modelSlot": "reasoning"
      },
      "warnings": []
    }
  },
  "DOC-03-01": {
    "brdCaseId": "DOC-03-01",
    "action": "analyze",
    "variant": "classify",
    "executionMode": "provider",
    "expectedTokenUsage": {
      "inputTokens": 100,
      "outputTokens": 50,
      "costMicrousd": 250
    },
    "syntheticInput": {
      "task": "classify",
      "categories": [
        "Legal",
        "Finance"
      ],
      "text": "Quarterly financial statements"
    },
    "derivedExpectedEnvelope": {
      "status": "COMPLETED",
      "data": {
        "category": "Finance",
        "confidence": 0.98
      },
      "provenance": {
        "method": "llm_evaluation",
        "modelSlot": "reasoning"
      },
      "warnings": []
    }
  },
  "DOC-03-02": {
    "brdCaseId": "DOC-03-02",
    "action": "analyze",
    "variant": "sentiment",
    "executionMode": "provider",
    "expectedTokenUsage": {
      "inputTokens": 100,
      "outputTokens": 50,
      "costMicrousd": 250
    },
    "syntheticInput": {
      "task": "sentiment",
      "text": "Outstanding execution and wonderful collaboration!"
    },
    "derivedExpectedEnvelope": {
      "status": "COMPLETED",
      "data": {
        "sentiment": "positive",
        "score": 0.95
      },
      "provenance": {
        "method": "llm_evaluation",
        "modelSlot": "reasoning"
      },
      "warnings": []
    }
  },
  "DOC-03-03": {
    "brdCaseId": "DOC-03-03",
    "action": "analyze",
    "variant": "compliance",
    "executionMode": "provider",
    "expectedTokenUsage": {
      "inputTokens": 100,
      "outputTokens": 50,
      "costMicrousd": 250
    },
    "syntheticInput": {
      "task": "compliance",
      "criteria": [
        "HIPAA"
      ],
      "text": "Healthcare patient privacy safeguard checklist"
    },
    "derivedExpectedEnvelope": {
      "status": "COMPLETED",
      "data": {
        "status": "PASS",
        "findings": []
      },
      "provenance": {
        "method": "llm_evaluation",
        "modelSlot": "reasoning"
      },
      "warnings": []
    }
  },
  "DOC-03-04": {
    "brdCaseId": "DOC-03-04",
    "action": "analyze",
    "variant": "quality",
    "executionMode": "provider",
    "expectedTokenUsage": {
      "inputTokens": 100,
      "outputTokens": 50,
      "costMicrousd": 250
    },
    "syntheticInput": {
      "task": "quality",
      "text": "Code review documentation and developer guideline"
    },
    "derivedExpectedEnvelope": {
      "status": "COMPLETED",
      "data": {
        "qualityScore": 92,
        "readability": "high",
        "suggestions": []
      },
      "provenance": {
        "method": "llm_evaluation",
        "modelSlot": "reasoning"
      },
      "warnings": []
    }
  },
  "DOC-03-05": {
    "brdCaseId": "DOC-03-05",
    "action": "analyze",
    "variant": "risk",
    "executionMode": "provider",
    "expectedTokenUsage": {
      "inputTokens": 100,
      "outputTokens": 50,
      "costMicrousd": 250
    },
    "syntheticInput": {
      "task": "risk",
      "text": "Contract clauses with unlimited liability provisions"
    },
    "derivedExpectedEnvelope": {
      "status": "COMPLETED",
      "data": {
        "riskLevel": "HIGH",
        "factors": [
          {
            "name": "liability",
            "level": "high"
          }
        ]
      },
      "provenance": {
        "method": "llm_evaluation",
        "modelSlot": "reasoning"
      },
      "warnings": []
    }
  },
  "DOC-04-01": {
    "brdCaseId": "DOC-04-01",
    "action": "transform",
    "variant": "convert",
    "executionMode": "native",
    "expectedTokenUsage": {
      "inputTokens": 0,
      "outputTokens": 0,
      "costMicrousd": 0
    },
    "syntheticInput": {
      "variant": "convert",
      "text": "# Title\n\nParagraph text.",
      "outputFormat": "text"
    },
    "derivedExpectedEnvelope": {
      "status": "COMPLETED",
      "data": {
        "transformedText": "Title\n\nParagraph text.",
        "outputFormat": "text",
        "metadata": {
          "method": "native_conversion"
        }
      },
      "provenance": {
        "method": "native_parse"
      },
      "warnings": []
    }
  },
  "DOC-04-02": {
    "brdCaseId": "DOC-04-02",
    "action": "transform",
    "variant": "translate",
    "executionMode": "provider",
    "expectedTokenUsage": {
      "inputTokens": 100,
      "outputTokens": 50,
      "costMicrousd": 250
    },
    "syntheticInput": {
      "variant": "translate",
      "targetLanguage": "French",
      "text": "Hello, welcome to our platform."
    },
    "derivedExpectedEnvelope": {
      "status": "COMPLETED",
      "data": {
        "transformedText": "Bonjour, bienvenue sur notre plateforme.",
        "outputFormat": "md",
        "metadata": {
          "targetLanguage": "French",
          "method": "llm_translation",
          "chunksCount": 1
        }
      },
      "provenance": {
        "method": "llm_translation",
        "modelSlot": "reasoning"
      },
      "warnings": []
    }
  },
  "DOC-04-03": {
    "brdCaseId": "DOC-04-03",
    "action": "transform",
    "variant": "rewrite",
    "executionMode": "provider",
    "expectedTokenUsage": {
      "inputTokens": 100,
      "outputTokens": 50,
      "costMicrousd": 250
    },
    "syntheticInput": {
      "variant": "rewrite",
      "style": "executive",
      "text": "Deep technical stack trace details."
    },
    "derivedExpectedEnvelope": {
      "status": "COMPLETED",
      "data": {
        "transformedText": "High-level operational overview.",
        "outputFormat": "md",
        "metadata": {
          "style": "executive",
          "method": "llm_rewrite",
          "chunksCount": 1
        }
      },
      "provenance": {
        "method": "llm_evaluation",
        "modelSlot": "reasoning"
      },
      "warnings": []
    }
  },
  "DOC-04-04": {
    "brdCaseId": "DOC-04-04",
    "action": "transform",
    "variant": "redact",
    "executionMode": "native",
    "expectedTokenUsage": {
      "inputTokens": 0,
      "outputTokens": 0,
      "costMicrousd": 0
    },
    "syntheticInput": {
      "variant": "redact",
      "text": "Call 415-555-1212 or email admin@company.com",
      "redactPatterns": [
        "email",
        "phone"
      ]
    },
    "derivedExpectedEnvelope": {
      "status": "COMPLETED",
      "data": {
        "transformedText": "Call [REDACTED:PHONE] or email [REDACTED:EMAIL]",
        "outputFormat": "text",
        "metadata": {
          "redactionsCount": 2,
          "countsByPattern": {
            "EMAIL": 1,
            "PHONE": 1
          },
          "method": "local_pii_redactor"
        }
      },
      "provenance": {
        "method": "native_parse"
      },
      "warnings": []
    }
  },
  "DOC-04-05": {
    "brdCaseId": "DOC-04-05",
    "action": "transform",
    "variant": "template",
    "executionMode": "native",
    "expectedTokenUsage": {
      "inputTokens": 0,
      "outputTokens": 0,
      "costMicrousd": 0
    },
    "syntheticInput": {
      "variant": "template",
      "text": "{\"client\":\"Global Corp\"}",
      "template": "Welcome {{client}} to DU Gate."
    },
    "derivedExpectedEnvelope": {
      "status": "COMPLETED",
      "data": {
        "transformedText": "Welcome Global Corp to DU Gate.",
        "outputFormat": "text",
        "metadata": {
          "missingVariables": [],
          "method": "local_template_engine"
        }
      },
      "provenance": {
        "method": "native_parse"
      },
      "warnings": []
    }
  },
  "DOC-05-01": {
    "brdCaseId": "DOC-05-01",
    "action": "generate",
    "variant": "summary",
    "executionMode": "provider",
    "expectedTokenUsage": {
      "inputTokens": 100,
      "outputTokens": 50,
      "costMicrousd": 250
    },
    "syntheticInput": {
      "task": "summary",
      "text": "The project achieved all deliverables ahead of schedule with zero defect reports."
    },
    "derivedExpectedEnvelope": {
      "status": "COMPLETED",
      "data": {
        "content": "Project completed ahead of schedule with zero defects."
      },
      "provenance": {
        "method": "llm_evaluation",
        "modelSlot": "reasoning"
      },
      "warnings": []
    }
  },
  "DOC-05-02": {
    "brdCaseId": "DOC-05-02",
    "action": "generate",
    "variant": "outline",
    "executionMode": "provider",
    "expectedTokenUsage": {
      "inputTokens": 100,
      "outputTokens": 50,
      "costMicrousd": 250
    },
    "syntheticInput": {
      "task": "outline",
      "text": "Document covering architecture, data flows, and security policies."
    },
    "derivedExpectedEnvelope": {
      "status": "COMPLETED",
      "data": {
        "content": "# System Outline\n1. Architecture\n2. Data Flows\n3. Security"
      },
      "provenance": {
        "method": "llm_evaluation",
        "modelSlot": "reasoning"
      },
      "warnings": []
    }
  },
  "DOC-05-03": {
    "brdCaseId": "DOC-05-03",
    "action": "generate",
    "variant": "report",
    "executionMode": "provider",
    "expectedTokenUsage": {
      "inputTokens": 100,
      "outputTokens": 50,
      "costMicrousd": 250
    },
    "syntheticInput": {
      "task": "report",
      "text": "Audit trail results for security compliance wave 4."
    },
    "derivedExpectedEnvelope": {
      "status": "COMPLETED",
      "data": {
        "content": "# Security Audit Report\nAll audit controls passed."
      },
      "provenance": {
        "method": "llm_evaluation",
        "modelSlot": "reasoning"
      },
      "warnings": []
    }
  },
  "DOC-05-04": {
    "brdCaseId": "DOC-05-04",
    "action": "generate",
    "variant": "email",
    "executionMode": "provider",
    "expectedTokenUsage": {
      "inputTokens": 100,
      "outputTokens": 50,
      "costMicrousd": 250
    },
    "syntheticInput": {
      "task": "email",
      "text": "Key notes for client project delivery announcement."
    },
    "derivedExpectedEnvelope": {
      "status": "COMPLETED",
      "data": {
        "content": "Subject: Delivery Announcement\n\nDear Partner, ..."
      },
      "provenance": {
        "method": "llm_evaluation",
        "modelSlot": "reasoning"
      },
      "warnings": []
    }
  },
  "DOC-05-05": {
    "brdCaseId": "DOC-05-05",
    "action": "generate",
    "variant": "minutes",
    "executionMode": "provider",
    "expectedTokenUsage": {
      "inputTokens": 100,
      "outputTokens": 50,
      "costMicrousd": 250
    },
    "syntheticInput": {
      "task": "minutes",
      "text": "Transcript: Alice agreed to merge PR; Bob will deploy to staging."
    },
    "derivedExpectedEnvelope": {
      "status": "COMPLETED",
      "data": {
        "content": "Meeting Minutes:\n- Alice: Merge PR\n- Bob: Deploy staging"
      },
      "provenance": {
        "method": "llm_evaluation",
        "modelSlot": "reasoning"
      },
      "warnings": []
    }
  },
  "DOC-05-06": {
    "brdCaseId": "DOC-05-06",
    "action": "generate",
    "variant": "qa",
    "executionMode": "provider",
    "expectedTokenUsage": {
      "inputTokens": 100,
      "outputTokens": 50,
      "costMicrousd": 250
    },
    "syntheticInput": {
      "task": "qa",
      "text": "The return policy allows full refunds within 30 days of purchase.",
      "questions": [
        "What is the refund window?"
      ]
    },
    "derivedExpectedEnvelope": {
      "status": "COMPLETED",
      "data": {
        "answers": [
          {
            "question": "What is the refund window?",
            "answer": "Full refunds are permitted within 30 days."
          }
        ]
      },
      "provenance": {
        "method": "grounded_qa",
        "modelSlot": "reasoning"
      },
      "warnings": []
    }
  },
  "DOC-06-01": {
    "brdCaseId": "DOC-06-01",
    "action": "compare",
    "variant": "diff",
    "executionMode": "native",
    "expectedTokenUsage": {
      "inputTokens": 0,
      "outputTokens": 0,
      "costMicrousd": 0
    },
    "syntheticInput": {
      "mode": "diff",
      "source": {
        "text": "Alpha Bravo"
      },
      "target": {
        "text": "Alpha Charlie"
      }
    },
    "derivedExpectedEnvelope": {
      "status": "COMPLETED",
      "data": {
        "diffStats": {
          "additions": 1,
          "deletions": 1,
          "unmodified": 0
        },
        "hunks": [
          {
            "type": "DELETE",
            "content": "Alpha Bravo",
            "sourceLineNumber": 1
          },
          {
            "type": "ADD",
            "content": "Alpha Charlie",
            "targetLineNumber": 1
          }
        ],
        "unifiedDiff": "--- source\n+++ target\n- Alpha Bravo\n+ Alpha Charlie",
        "method": "native_diff"
      },
      "provenance": {
        "method": "diff"
      },
      "warnings": []
    }
  },
  "DOC-06-02": {
    "brdCaseId": "DOC-06-02",
    "action": "compare",
    "variant": "semantic",
    "executionMode": "provider",
    "expectedTokenUsage": {
      "inputTokens": 100,
      "outputTokens": 50,
      "costMicrousd": 250
    },
    "syntheticInput": {
      "mode": "semantic",
      "source": {
        "text": "Standard vendor SLA"
      },
      "target": {
        "text": "Premium vendor SLA"
      }
    },
    "derivedExpectedEnvelope": {
      "status": "COMPLETED",
      "data": {
        "similarityScore": 0.85,
        "keyDifferences": [
          "Response time differs (4h vs 1h)"
        ],
        "semanticAlignment": "high"
      },
      "provenance": {
        "method": "llm_evaluation",
        "modelSlot": "reasoning"
      },
      "warnings": []
    }
  },
  "DOC-06-03": {
    "brdCaseId": "DOC-06-03",
    "action": "compare",
    "variant": "version",
    "executionMode": "provider",
    "expectedTokenUsage": {
      "inputTokens": 100,
      "outputTokens": 50,
      "costMicrousd": 250
    },
    "syntheticInput": {
      "mode": "version",
      "source": {
        "text": "API spec v1.0"
      },
      "target": {
        "text": "API spec v2.0"
      }
    },
    "derivedExpectedEnvelope": {
      "status": "COMPLETED",
      "data": {
        "changes": [
          {
            "type": "added",
            "description": "New endpoints added"
          }
        ],
        "backwardCompatible": true
      },
      "provenance": {
        "method": "llm_evaluation",
        "modelSlot": "reasoning"
      },
      "warnings": []
    }
  }
};

/**
 * Regex patterns for nondeterministic field normalization
 */
const UUID_REGEX = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO_DATE_REGEX = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/gi;

/**
 * Recursively normalize dynamic/nondeterministic fields (UUIDs, timestamps, hashes)
 */
export function normalizeNondeterministicFields<T>(val: T): T {
  if (val === null || val === undefined) return val;
  if (typeof val === 'string') {
    let s = val.replace(UUID_REGEX, '[UUID]');
    s = s.replace(ISO_DATE_REGEX, '[TIMESTAMP]');
    return s as unknown as T;
  }
  if (Array.isArray(val)) {
    return val.map((elem) => normalizeNondeterministicFields(elem)) as unknown as T;
  }
  if (typeof val === 'object') {
    const res: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val)) {
      if (k === 'artifactId' && typeof v === 'string') {
        res[k] = '[UUID]';
      } else {
        res[k] = normalizeNondeterministicFields(v);
      }
    }
    return res as unknown as T;
  }
  return val;
}

/**
 * Lookup an expected result entry by BRD case ID (e.g. 'DOC-02-01')
 */
export function getCorpusEntry(brdCaseId: string): CorpusVariantEntry | undefined {
  return EXPECTED_RESULT_CORPUS[brdCaseId];
}

/**
 * Compare an actual action result envelope against the derived expected corpus,
 * with deterministic field normalization for dynamic UUIDs and timestamps.
 */
export function verifyAgainstCorpus(
  brdCaseId: string,
  actualEnvelope: Record<string, unknown>
): { matched: boolean; mismatches: string[] } {
  const entry = EXPECTED_RESULT_CORPUS[brdCaseId];
  if (!entry) {
    return { matched: false, mismatches: [`Unknown BRD case ID: ${brdCaseId}`] };
  }

  const mismatches: string[] = [];
  if (actualEnvelope.status !== entry.derivedExpectedEnvelope.status) {
    mismatches.push(`status: expected ${entry.derivedExpectedEnvelope.status}, got ${actualEnvelope.status}`);
  }
  if (!actualEnvelope.data) {
    mismatches.push('data: missing result data object');
  }

  const normActual = normalizeNondeterministicFields(actualEnvelope);
  const normExpected = normalizeNondeterministicFields(entry.derivedExpectedEnvelope);

  const normActualStr = JSON.stringify(normActual);
  const normExpectedStr = JSON.stringify(normExpected);
  if (normActualStr !== normExpectedStr) {
    mismatches.push(`envelope content divergence: actual=${normActualStr.slice(0, 100)}... vs expected=${normExpectedStr.slice(0, 100)}...`);
  }

  return { matched: mismatches.length === 0, mismatches };
}
