export interface ScriptedSqlResult {
  rows: unknown[];
  rowCount: number;
}

/** Return the initialized OPEN gate row expected by offline app boot fixtures. */
export function mockOpenBackupEffectGateResult(sql: string): ScriptedSqlResult | undefined {
  if (!/FROM maintenance_backup_effect_gate/i.test(sql)) return undefined;
  return { rows: [{ state: 'OPEN', fence_id: null, fence_revision: 0 }], rowCount: 1 };
}

export function mockCreateStorageGenerationFixture(): {
  answer(sql: string, params?: unknown[]): ScriptedSqlResult | undefined;
} {
  let row: Record<string, unknown> = {
    generation_id: '64000000-0000-4000-8000-000000000001',
    revision: 0,
    backend: 'postgres',
    endpoint: 'postgres',
    bucket: '',
    region: 'postgres',
    force_path_style: false,
    credential_version_ref: null,
    credential_owner_tenant_id: null,
    url_ttl_seconds: 900,
    state: 'ACTIVE',
    tested_at: null,
    test_result: null,
    activated_at: new Date(0).toISOString(),
    control_revision: 1,
  };
  return {
    answer(sql, params = []) {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      if (/INSERT INTO storage_generations/i.test(normalized)) {
        const initialInsert = /VALUES \(\$1,0,\$2/i.test(normalized);
        const fieldOffset = initialInsert ? 1 : 2;
        row = {
          ...row,
          generation_id: String(params[0] ?? row.generation_id),
          revision: initialInsert ? 0 : Number(params[1] ?? 0),
          backend: String(params[fieldOffset] ?? row.backend),
          endpoint: String(params[fieldOffset + 1] ?? row.endpoint),
          bucket: String(params[fieldOffset + 2] ?? row.bucket),
          region: String(params[fieldOffset + 3] ?? row.region),
          force_path_style: Boolean(params[fieldOffset + 4] ?? row.force_path_style),
          credential_version_ref: params[fieldOffset + 5] ?? null,
          credential_owner_tenant_id: params[fieldOffset + 6] ?? null,
          url_ttl_seconds: params[fieldOffset + 7] ?? row.url_ttl_seconds,
          state: initialInsert ? 'ACTIVE' : 'STAGED',
        };
        return { rows: [], rowCount: 1 };
      }
      if (/INSERT INTO storage_generation_state/i.test(normalized)) return { rows: [], rowCount: 1 };
      if (/FROM storage_generation_state s JOIN storage_generations g/i.test(normalized)) {
        return { rows: [{ ...row }], rowCount: 1 };
      }
      if (/FROM storage_generations WHERE generation_id=\$1/i.test(normalized)) {
        return { rows: [{ ...row }], rowCount: 1 };
      }
      return undefined;
    },
  };
}
