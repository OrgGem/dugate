/**
 * Component Fixtures & Test Data for AWEB-03a (Antigravity).
 * Covers light/dark, 320px reflow, long text wrapping, and all 5 screen states.
 */

export interface TestProfileItem {
  id: string;
  name: string;
  service: string;
  status: 'active' | 'draft' | 'archived' | 'error';
  priority: 'LOW' | 'MEDIUM' | 'HIGH';
  revision: number;
  description: string;
  updatedAt: string;
}

export const FIXTURE_PROFILES: TestProfileItem[] = [
  {
    id: 'prof_extract_default_v1',
    name: 'Default Ingest Pipeline Profile',
    service: 'extract',
    status: 'active',
    priority: 'MEDIUM',
    revision: 3,
    description: 'Standard extraction workflow with PDF, DOCX and TXT parsers enabled.',
    updatedAt: '2026-10-04 10:15:00 UTC',
  },
  {
    id: 'prof_financial_audit_high_priority_enterprise_v2',
    name: 'High Priority Financial Report Pipeline with Strict Lock on Security Fields',
    service: 'analyze',
    status: 'draft',
    priority: 'HIGH',
    revision: 7,
    description:
      'Very long description demonstrating word wrapping and container reflow at 320px viewport without horizontal scroll overflow: This profile requires strict schema verification, locked provider endpoints, and AES-256-GCM cipher encryption for all download authentication payloads.',
    updatedAt: '2026-10-04 11:20:00 UTC',
  },
  {
    id: 'prof_legacy_scaffold_archived',
    name: 'Legacy OCR Connector Binding (Retired)',
    service: 'transform',
    status: 'archived',
    priority: 'LOW',
    revision: 1,
    description: 'Historical archive entry.',
    updatedAt: '2026-09-24 08:00:00 UTC',
  },
];

export const FIXTURE_LONG_TEXT = {
  short: 'Admin API Key',
  medium: 'Enterprise Multi-tenant Connector with Vault Integration and Custom TLS Handshake',
  extraLong:
    'https://internal-s3-gateway.dugate.local:9003/buckets/tenant-production-alpha-001/documents/2026/10/04/statement-very-long-name-financial-compliance-report-with-extended-metadata-and-hashes-0123456789abcdef.pdf',
  longDescription:
    'A carefully configured profile setting with multiple locked parameters including concurrency limits (maxConcurrency: 10), timeout thresholds (operationTimeoutSeconds: 300), and custom connector overrides directing to hashicorp-vault://secret/data/tenants/alpha/connector-v2.',
};
