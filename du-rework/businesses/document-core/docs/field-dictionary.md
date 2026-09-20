# Business Field Dictionary — document-core

This dictionary defines canonical fields, data types, legacy aliases, validation constraints, and defaults for the `document-core` business across all 6 actions (`ingest`, `extract`, `analyze`, `transform`, `generate`, `compare`) and 28 variants.

---

## 1. Core Common Fields

| Canonical Field | Type | Legacy Alias | Description | Constraints & Validation | Default |
|---|---|---|---|---|---|
| `action` | string | `action` | Action name or subcase discriminator in `transform` | Required. For `transform`, values: `convert`, `translate`, `rewrite`, `redact`, `template`. Normalized internally to `variant`. | N/A |
| `mode` | string | `mode` | Subcase discriminator in `ingest` and `compare` | For `ingest`: `parse`, `ocr`, `digitize`, `split`. For `compare`: `diff`, `semantic`, `version`. | N/A |
| `type` | string | `type` | Subcase discriminator in `extract` | Values: `invoice`, `contract`, `receipt`, `table`, `custom`. | N/A |
| `task` | string | `task` | Subcase discriminator in `analyze` and `generate` | For `analyze`: `classify`, `sentiment`, `compliance`, `quality`, `risk`. For `generate`: `summary`, `outline`, `report`, `email`, `minutes`, `qa`. | N/A |
| `output_format` / `outputFormat` | enum | `output_format` | Desired output serialization | `['json', 'md', 'text', 'html', 'csv']`. Only subset valid per action variant. | `'json'` |
| `language` | string | `language` | Document source language | ISO 639-1 / BCP-47 code (e.g., `'vi'`, `'en'`, `'ja'`, `'zh'`). | Variant-specific / profile default |
| `text` | string | `text`, `content` | Direct raw text payload | Non-empty string. Max length governed by profile quota (e.g. 1,000,000 chars). | `undefined` |
| `artifact_ids` / `artifactIds` | array[string] | `artifact_ids`, `file_ids` | Staged artifact references | Array of valid UUIDs corresponding to tenant-authorized artifacts. | `[]` |

---

## 2. Ingest Fields

| Field | Type | Legacy Alias | Used in Variants | Description & Constraints | Default |
|---|---|---|---|---|---|
| `mode` | enum | `mode` | All 4 | Discriminator: `'parse'`, `'ocr'`, `'digitize'`, `'split'`. Required. | N/A |
| `pages` | string | `pages` | `split`, `parse`, `ocr` | Page selection range string. Formats: `"1"`, `"1-5"`, `"1,3,5"`, `"1-3,5,7-9"`. Positive integers only. Must not exceed total page count. | Entire document |
| `language` | string | `language` | `ocr`, `parse` | Recognition language hint (e.g., `'vie'`, `'eng'`, `'vi+en'`). | Profile default |

---

## 3. Extract Fields

| Field | Type | Legacy Alias | Used in Variants | Description & Constraints | Default |
|---|---|---|---|---|---|
| `type` | enum | `type` | All 5 | Discriminator: `'invoice'`, `'contract'`, `'receipt'`, `'table'`, `'custom'`. Required. | N/A |
| `fields` | array[string] \| string | `fields` | `custom` | Comma-separated or array of target property keys to extract. Max 100 items. | `undefined` |
| `schema` | object \| string | `schema` | `custom` | JSON Schema (Draft 2020-12) defining the target structure. Must be valid JSON object with `properties` or `items`. Max depth 5, max properties 50. Rejects `$ref` over network. | `undefined` |

---

## 4. Analyze Fields

| Field | Type | Legacy Alias | Used in Variants | Description & Constraints | Default |
|---|---|---|---|---|---|
| `task` | enum | `task` | All 5 | Discriminator: `'classify'`, `'sentiment'`, `'compliance'`, `'quality'`, `'risk'`. Required. | N/A |
| `categories` | array[string] \| string | `categories` | `classify` | Target classification taxonomy categories. Non-empty array or comma-separated string. Max 50 categories. | Required for `classify` |
| `criteria` | string \| array[string] | `criteria` | `compliance`, `quality` | Specific audit/evaluation criteria or rule guidelines to check against document. | Required for `compliance` / `quality` |
| `reference_data` / `referenceData` | object \| string | `reference_data` | `compliance` | Reference ground truth for cross-referencing discrepancies. | `undefined` |

---

## 5. Transform Fields

| Field | Type | Legacy Alias | Used in Variants | Description & Constraints | Default |
|---|---|---|---|---|---|
| `action` / `variant` | enum | `action` | All 5 | Discriminator: `'convert'`, `'translate'`, `'rewrite'`, `'redact'`, `'template'`. Required. | N/A |
| `target_language` / `targetLanguage` | string | `target_language` | `translate` | Target language code (e.g. `'vi'`, `'en'`, `'fr'`). | Required for `translate` |
| `tone` | enum | `tone` | `translate`, `rewrite` | Desired tone: `['formal', 'casual', 'business', 'academic']`. | `'formal'` |
| `style` | enum | `style` | `rewrite` | Desired paraphrasing style: `['academic', 'executive', 'simplified', 'bullet_points']`. | `'executive'` |
| `redact_patterns` / `redactPatterns` | array[string] | `redact_patterns` | `redact` | List of PII categories or regex pattern identifiers (e.g. `['PHONE', 'EMAIL', 'CREDIT_CARD', 'NATIONAL_ID']`). | `['PHONE', 'EMAIL', 'CREDIT_CARD', 'NATIONAL_ID']` |
| `template` | string | `template` | `template` | Template template string with `{{variable}}` placeholders or artifact ID of template document. | Required for `template` |

---

## 6. Generate Fields

| Field | Type | Legacy Alias | Used in Variants | Description & Constraints | Default |
|---|---|---|---|---|---|
| `task` | enum | `task` | All 6 | Discriminator: `'summary'`, `'outline'`, `'report'`, `'email'`, `'minutes'`, `'qa'`. Required. | N/A |
| `format` | enum | `format` | `summary`, `outline`, `minutes` | Layout format: `['paragraph', 'bullets', 'numbered', 'table']`. | `'paragraph'` |
| `max_words` / `maxWords` | integer | `max_words` | `summary`, `report` | Maximum word count cap for output. Positive integer between 50 and 50,000. | Profile default |
| `tone` | enum | `tone` | `email`, `report` | Tone of generated content: `['formal', 'casual', 'business', 'academic']`. | `'business'` |
| `audience` | string | `audience` | `report`, `summary` | Target audience description (e.g., `"Board of Directors"`, `"Engineering team"`). | `'General readership'` |
| `questions` | array[string] \| string | `questions` | `qa` | Array of specific questions or comma/line separated string. Non-empty. Max 20 questions per call. | Required for `qa` |

---

## 7. Compare Fields

| Field | Type | Legacy Alias | Used in Variants | Description & Constraints | Default |
|---|---|---|---|---|---|
| `mode` | enum | `mode` | All 3 | Discriminator: `'diff'`, `'semantic'`, `'version'`. Required. | N/A |
| `source` | object | `source`, `source_file` | All 3 | Source document side: `{ artifactId?: string, text?: string }`. Exactly one must be provided. | Required |
| `target` | object | `target`, `target_file` | All 3 | Target document side: `{ artifactId?: string, text?: string }`. Exactly one must be provided. | Required |
| `focus` | string | `focus` | `semantic`, `version` | Specific aspect or clause to focus comparison on (e.g. `"liability limits"`, `"pricing terms"`). | `undefined` |

---

## 8. General Validation Rules
1. **No direct prompt injection**: Parameters like `_prompt` or raw instructions that circumvent the profile prompt template are rejected with `INVALID_ARGUMENT`.
2. **Discriminator required**: Omitting `mode`, `type`, `task`, or `action` for their respective endpoints immediately returns a validation error with code `MISSING_DISCRIMINATOR`.
3. **MIME / Extension verification**: Ingest files must have valid extensions (`.pdf`, `.docx`, `.xlsx`, `.csv`, `.png`, `.jpg`, `.jpeg`, `.tiff`, `.txt`, `.md`).
4. **Normalized camelCase**: All incoming payloads are mapped to standard camelCase properties before entering business action pipelines.
