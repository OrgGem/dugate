// lib/workflow-builder/loader.ts
// Load & store workflow schemas. Schemas are stored as JSON in the appSettings
// store under the key `wb_schema:<slug>` (reuse existing appSettings table,
// which is a simple key/value store). Also supports inline passes.
import { db } from '@/lib/db';
import { appSettings } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import type { WorkflowSchema } from './types';

const SCHEMA_KEY_PREFIX = 'wb_schema:';

export async function saveSchema(schema: WorkflowSchema): Promise<void> {
  if (!schema.slug) throw new Error('Schema requires a slug to save.');
  const key = SCHEMA_KEY_PREFIX + schema.slug;
  const value = JSON.stringify(schema);
  await db.insert(appSettings).values({ key, value })
    .onConflictDoUpdate({ target: [appSettings.key], set: { value, updatedAt: new Date() } });
}

export async function loadSchema(slug: string): Promise<WorkflowSchema | null> {
  if (!slug) return null;
  const [row] = await db
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, SCHEMA_KEY_PREFIX + slug))
    .limit(1);
  if (!row) return null;
  try {
    return JSON.parse(row.value) as WorkflowSchema;
  } catch {
    return null;
  }
}

export async function deleteSchema(slug: string): Promise<void> {
  await db.delete(appSettings).where(eq(appSettings.key, SCHEMA_KEY_PREFIX + slug));
}

export async function listSchemas(): Promise<Array<{ slug: string; name: string }>> {
  const rows = await db.select().from(appSettings);
  const out: Array<{ slug: string; name: string }> = [];
  for (const r of rows) {
    if (!r.key.startsWith(SCHEMA_KEY_PREFIX)) continue;
    try {
      const s = JSON.parse(r.value as string) as WorkflowSchema;
      out.push({ slug: s.slug, name: s.name });
    } catch {
      out.push({ slug: r.key.slice(SCHEMA_KEY_PREFIX.length), name: r.key });
    }
  }
  return out;
}
