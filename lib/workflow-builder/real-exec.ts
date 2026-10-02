// lib/workflow-builder/real-exec.ts
// Real leaf-node executor: wires the schema interpreter to actual DUGate
// primitives. Injected into runSchemaDag as the `exec` function.
//
// Supported leaf node types:
//   connector          -> enqueueSubStep(ctx, connector, variables, filesJson)
//   file_parse         -> ParserFactory (word/excel; pdf optional)
//   file_url_download  -> downloadAllFileUrls (with auth)
//   callback           -> fetch to URL (with auth), default POST
//   archive_compress   -> createArchiveFromEntries -> buffer
//   archive_extract    -> extractArchive (safe unzip)
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import os from 'os';
import type { WorkflowNode, NodeResult, ConnectorNode, FileParseNode, FileUrlNode, CallbackNode, ArchiveNodeCompress, ArchiveNodeExtract } from './types';
import type { WorkflowContext } from '@/lib/pipelines/workflow-engine';
import { enqueueSubStep } from '@/lib/pipelines/workflow-engine';
import { ParserFactory } from '@/lib/parsers/factory';
import { downloadAllFileUrls, type FileUrlAuthConfig, type FileUrlEntry } from '@/lib/file-url-downloader';
import { createArchiveFromEntries, archiveToBuffer, extractArchive, type ArchiveEntryInput } from '@/lib/archive';

export interface ExecDeps {
  ctx: WorkflowContext;
}

/** Map promptOverrideKey to ctx.promptOverrides[key], or null. */
export function resolvePromptOverride(node: ConnectorNode, overrides: Record<string, string>): string | null {
  const key = node.promptOverrideKey;
  if (!key) return null;
  return overrides[key] ?? null;
}

function buildAuthHeaders(auth?: { type?: string; token?: string; header_name?: string; header_value?: string }): Record<string, string> {
  if (!auth) return {};
  if (auth.type === 'bearer' && auth.token) return { Authorization: `Bearer ${auth.token}` };
  if (auth.type === 'header' && auth.header_name && auth.header_value) return { [auth.header_name]: auth.header_value };
  return {};
}

/**
 * Build the real executor used by runSchemaDag.
 */
export function buildExecFunc(ctx: WorkflowContext) {
  return async function execFunc(
    node: WorkflowNode,
    resolve: (binding: unknown) => unknown,
    _nodeResults: Record<string, NodeResult>,
  ): Promise<Partial<NodeResult>> {

    const logger = ctx.logger;
    switch (node.type) {
      case 'connector': {
        const n = node as ConnectorNode;
        const variables: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(n.inputs ?? {})) {
          variables[k] = resolve(v);
        }

        // Apply overrideConnector settings (per-node overrides from UI)
        const oc = n.overrideConnector;
        if (oc?.prompt) {
          variables['_prompt'] = oc.prompt;
        } else {
          // Fallback to promptOverrideKey from profile
          const override = resolvePromptOverride(n, ctx.promptOverrides ?? {});
          if (override) variables['_prompt'] = override;
        }
        if (oc?.staticFormFields) {
          variables['_staticFormFields'] = oc.staticFormFields;
        }
        if (oc?.extraHeaders) {
          variables['_extraHeaders'] = oc.extraHeaders;
        }
        if (oc?.responseContentPath) {
          variables['_responseContentPath'] = oc.responseContentPath;
        }
        if (oc?.timeoutSec) {
          variables['_timeoutSec'] = oc.timeoutSec;
        }

        // Determine files binding: look for a $file/$files in any input value
        let filesJson: string | null = null;
        for (const binding of Object.values(n.inputs ?? {})) {
          const resolved = resolve(binding);
          if (Array.isArray(resolved)) {
            const boundFiles = resolved.map((file) => {
              if (typeof file !== 'string') return file;
              return ctx.filesData?.find((entry) => entry.path === file) ?? file;
            });
            filesJson = JSON.stringify(boundFiles);
          }
        }

        const result = await enqueueSubStep(ctx, n.connector, variables, filesJson);
        return {
          content: result.content ?? undefined,
          extractedData: result.extractedData,
          data: { processor: n.connector, variables, overrideConnector: oc },
        };
      }

      case 'file_parse': {
        const n = node as FileParseNode;
        const source = resolve(n.source) as any;
        const files: any[] = Array.isArray(source) ? source : (source?.files ?? (source ? [source] : []));
        const outputs: unknown[] = [];
        for (const file of files) {
          const p = typeof file === 'string' ? file : file?.path;
          if (!p) continue;
          const fileName = path.basename(p);
          const parser = ParserFactory.getParserForFile(file?.mime ?? '', fileName);
          if (!parser) {
            outputs.push({ file: fileName, status: 'no_parser' });
            continue;
          }
          const buf = await fsPromises.readFile(p);
          const result = await parser.parse(buf, fileName);
          outputs.push({ file: fileName, status: 'success', text: result.text, markdown: result.markdown });
        }
        return { content: outputs.map((o: any) => o?.text ?? JSON.stringify(o)).join('\n'), data: { parsed: outputs }, output: outputs };
      }

      case 'file_url_download': {
        const n = node as FileUrlNode;
        const urls = resolve(n.urls) as FileUrlEntry[];
        if (!Array.isArray(urls) || urls.length === 0) {
          throw new Error(`file_url_download '${n.id}' requires a non-empty urls array.`);
        }
        const auth: FileUrlAuthConfig = {
          type: (n.auth?.type as FileUrlAuthConfig['type']) ?? 'none',
          token: n.auth?.token,
          header_name: n.auth?.header_name,
          header_value: n.auth?.header_value,
          query_key: n.auth?.query_key,
          query_value: n.auth?.query_value,
        };
        const downloaded = await downloadAllFileUrls(urls, ctx.operationId, auth, n.allowedExtensions);
        return { files: downloaded.map((d) => d.path), data: { downloaded }, output: downloaded };
      }

      case 'callback': {
        const n = node as CallbackNode;
        const url = resolve(n.url) as string;
        if (!url) throw new Error(`callback '${n.id}' requires a URL.`);
        const payload = resolve(n.payload);
        const method = (n.method ?? 'POST').toUpperCase();
        const headers = { 'Content-Type': 'application/json', ...buildAuthHeaders(n.auth) };
        const init: RequestInit = { method, headers };
        if (method === 'POST') init.body = typeof payload === 'string' ? payload : JSON.stringify(payload);
        await fetch(url, init);
        logger.info(`[WB-CALLBACK] Sent to ${url}`);
        return { content: 'callback sent', data: { url } };
      }

      case 'archive_compress': {
        const n = node as ArchiveNodeCompress;
        const source = resolve(n.source) as unknown;
        const entries: ArchiveEntryInput[] = [];
        if (Array.isArray(source)) {
          for (const item of source) {
            if (typeof item === 'string') {
              entries.push({ name: path.basename(item), filePath: item });
            } else if (item && typeof item === 'object') {
              // ArchiveEntryInput-like or downloaded-file-like
              const anyItem = item as any;
              if (anyItem.filePath || anyItem.path) {
                entries.push({ name: anyItem.name ?? path.basename(anyItem.filePath ?? anyItem.path), filePath: anyItem.filePath ?? anyItem.path });
              } else if (anyItem.name !== undefined) {
                entries.push({ name: anyItem.name, content: anyItem.content });
              }
            }
          }
        }
        const stream = createArchiveFromEntries(entries, { format: 'zip', level: n.level });
        const buf = await archiveToBuffer(stream);
        return { data: { entries: entries.map((e) => e.name) }, output: buf, content: `zip:${entries.length} entries` };
      }

      case 'archive_extract': {
        const n = node as ArchiveNodeExtract;
        const source = resolve(n.source) as any;
        let inputBuffer: Buffer;
        if (Buffer.isBuffer(source)) {
          inputBuffer = source;
        } else if (typeof source === 'string' && fs.existsSync(source)) {
          inputBuffer = await fsPromises.readFile(source);
        } else {
          throw new Error(`archive_extract '${n.id}' requires a Buffer or file path source.`);
        }
        const destDir = path.join(os.tmpdir(), `wb-extract-${n.destName ?? node.id}-${Date.now()}`);
        const result = await extractArchive(inputBuffer, {
          dest: destDir,
          maxTotalBytes: n.maxTotalBytes,
          maxEntries: n.maxEntries,
        });
        return { files: result.files, data: { dest: destDir }, output: result.files };
      }

      default:
        return { content: String(node.id), data: { type: node.type } };
    }
  };
}
