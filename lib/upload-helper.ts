// lib/upload-helper.ts
// Utility to save uploaded files to disk

import path from 'path';
import fs from 'fs/promises';

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? './uploads';

export async function saveUploadedFile(
  file: File,
  operationId: string,
  prefix?: string,
): Promise<{ path: string; size: number }> {
  const dir = path.join(UPLOAD_DIR, operationId);
  await fs.mkdir(dir, { recursive: true });

  const safeName = prefix ? `${prefix}_${file.name}` : file.name;
  const filePath = path.join(dir, safeName);

  const buffer = Buffer.from(await file.arrayBuffer());
  await fs.writeFile(filePath, buffer);

  return { path: filePath, size: buffer.length };
}
