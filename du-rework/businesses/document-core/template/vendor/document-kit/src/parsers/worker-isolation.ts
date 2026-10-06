// VENDORED from @du/document-kit @ b088eececcb5f3df0b4edbe073a29401dafda624 (worktree 2026-10-06)
// source: packages/document-kit/src/parsers/worker-isolation.ts (lines=192) sha256=665EB4CBE8C03B438075D16E758C15B63F108152B0E8C491EF8AFE7AAF2AE0AB
// why: transitive dep of parsers/factory.ts (DEFAULT_PARSER_CPU_TIMEOUT_MS, parseDocumentInWorker)

import { Worker } from 'worker_threads';
import * as path from 'path';
import { ParseResult, ParserOptions } from '../types';

export const DEFAULT_PARSER_CPU_TIMEOUT_MS = 30_000;

interface WorkerErrorPayload {
  name?: string;
  message: string;
  code?: string;
}

interface WorkerResponse<T> {
  ok: boolean;
  value?: T;
  error?: WorkerErrorPayload;
}

const DOCUMENT_PARSER_WORKER_SOURCE = String.raw`
const fs = require('node:fs');
const { parentPort, workerData } = require('node:worker_threads');

function installTypeScriptLoader(packageRoot) {
  const ts = require(require.resolve('typescript', { paths: [packageRoot] }));
  require.extensions['.ts'] = function loadTypeScript(module, filename) {
    const source = fs.readFileSync(filename, 'utf8');
    const result = ts.transpileModule(source, {
      fileName: filename,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        moduleResolution: ts.ModuleResolutionKind.NodeJs,
        esModuleInterop: true,
      },
    });
    module._compile(result.outputText, filename);
  };
}

(async () => {
  try {
    if (workerData.modulePath.endsWith('.ts')) {
      installTypeScriptLoader(workerData.packageRoot);
    }
    let result;
    if (workerData.mode === 'factory') {
      const { DocumentParserFactory } = require(workerData.modulePath);
      const factory = new DocumentParserFactory();
      result = await factory.parseBufferCore(
        Buffer.from(workerData.buffer),
        workerData.fileName,
        workerData.mimeHint,
        workerData.parserOptions
      );
    } else {
      const parserModule = require(workerData.modulePath);
      const Parser = parserModule[workerData.parserClassName];
      const parser = new Parser();
      result = await parser.parseCore(
        Buffer.from(workerData.buffer),
        workerData.fileName,
        workerData.parserOptions
      );
    }
    parentPort.postMessage({ ok: true, value: result });
  } catch (error) {
    const record = error && typeof error === 'object' ? error : {};
    parentPort.postMessage({
      ok: false,
      error: {
        name: typeof record.name === 'string' ? record.name : 'Error',
        message: typeof record.message === 'string' ? record.message : String(error),
        code: typeof record.code === 'string' ? record.code : undefined,
      },
    });
  } finally {
    parentPort.close();
  }
})();
`;

/** Runs synchronous and asynchronous parser work on a terminable worker thread. */
export function runIsolatedWorker<T>(
  workerSource: string,
  workerData: unknown,
  timeoutMs: number,
  label: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const worker = new Worker(workerSource, { eval: true, workerData });
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      void worker.terminate().then(
        () => reject(new Error(`${label} timed out after ${timeoutMs}ms budget`)),
        () => reject(new Error(`${label} timed out after ${timeoutMs}ms budget`))
      );
    }, timeoutMs);

    worker.once('message', (response: WorkerResponse<T>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      void worker.terminate().then(
        () => {
          if (response?.ok) {
            resolve(response.value as T);
            return;
          }

          const error = new Error(response?.error?.message ?? `${label} worker failed`);
          error.name = response?.error?.name ?? 'Error';
          if (response?.error?.code) {
            (error as NodeJS.ErrnoException).code = response.error.code;
          }
          reject(error);
        },
        (error: Error) => reject(error)
      );
    });

    worker.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });

    worker.once('exit', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`${label} worker exited unexpectedly with code ${exitCode}`));
    });
  });
}

export function parseDocumentInWorker(
  buffer: Buffer,
  fileName: string | undefined,
  mimeHint: string | undefined,
  parserOptions: ParserOptions | undefined,
  timeoutMs: number
): Promise<ParseResult> {
  const extension = path.extname(__filename) === '.ts' ? '.ts' : '.js';
  const modulePath = path.join(__dirname, `factory${extension}`);
  const packageRoot = path.resolve(__dirname, '..', '..');

  return runIsolatedWorker<ParseResult>(
    DOCUMENT_PARSER_WORKER_SOURCE,
    {
      mode: 'factory',
      modulePath,
      packageRoot,
      buffer,
      fileName,
      mimeHint,
      parserOptions: { ...parserOptions, timeoutMs: undefined },
    },
    timeoutMs,
    'Parser execution'
  );
}

export function parseBuiltInParserInWorker(
  parserModuleName: 'text-parser' | 'word-parser' | 'excel-parser' | 'pdf-parser',
  parserClassName: 'TextParser' | 'WordParser' | 'ExcelParser' | 'PdfParser',
  buffer: Buffer,
  fileName: string | undefined,
  parserOptions: ParserOptions | undefined,
  timeoutMs: number
): Promise<ParseResult> {
  const extension = path.extname(__filename) === '.ts' ? '.ts' : '.js';
  const modulePath = path.join(__dirname, `${parserModuleName}${extension}`);
  const packageRoot = path.resolve(__dirname, '..', '..');

  return runIsolatedWorker<ParseResult>(
    DOCUMENT_PARSER_WORKER_SOURCE,
    {
      mode: 'parser',
      modulePath,
      packageRoot,
      parserClassName,
      buffer,
      fileName,
      parserOptions: { ...parserOptions, timeoutMs: undefined },
    },
    timeoutMs,
    'Parser execution'
  );
}
