import { parseWorkerConfig, getRedactedConfig, WorkerEnvSchema } from '../src/config';
import { DocumentCoreProcess } from '../src/main';

describe('Document Core Worker Configuration & Process Lifecycle', () => {
  const validEnv: Record<string, string> = {
    RUNTIME_URL: 'http://localhost:3000/api/runtime/v1',
    RUNTIME_TOKEN: 'secret-bearer-token-12345',
    REDIS_URL: 'redis://localhost:6380',
    CONNECTOR_URL: 'http://localhost:3100/internal/v1',
    CONNECTOR_SERVICE_TOKEN: 'connector-service-token-test',
    CONCURRENCY: '4',
    HEARTBEAT_INTERVAL_MS: '5000',
    WORKER_INSTANCE_ID: 'worker-doc-test-1',
    IMAGE_DIGEST: 'sha256:test-image-digest',
    SHUTDOWN_GRACE_MS: '10000',
  };

  describe('1. Environment Parsing & Defaults', () => {
    it('parses complete valid environment configuration', () => {
      const config = parseWorkerConfig(validEnv);
      expect(config.runtimeUrl).toBe('http://localhost:3000/api/runtime/v1');
      expect(config.runtimeToken).toBe('secret-bearer-token-12345');
      expect(config.redisUrl).toBe('redis://localhost:6380');
      expect(config.connectorUrl).toBe('http://localhost:3100/internal/v1');
      expect(config.connectorServiceToken).toBe('connector-service-token-test');
      expect(config.concurrency).toBe(4);
      expect(config.heartbeatIntervalMs).toBe(5000);
      expect(config.workerInstanceId).toBe('worker-doc-test-1');
      expect(config.imageDigest).toBe('sha256:test-image-digest');
      expect(config.shutdownGraceMs).toBe(10000);
    });

    it('applies standard defaults for optional environment variables', () => {
      const minimalEnv = {
        RUNTIME_URL: 'http://runtime:3000',
        RUNTIME_TOKEN: 'token-abc',
        REDIS_URL: 'redis://redis:6379',
      };
      const config = parseWorkerConfig(minimalEnv);
      expect(config.runtimeUrl).toBe('http://runtime:3000');
      expect(config.runtimeToken).toBe('token-abc');
      expect(config.redisUrl).toBe('redis://redis:6379');
      expect(config.connectorUrl).toBeUndefined();
      expect(config.concurrency).toBe(1);
      expect(config.heartbeatIntervalMs).toBe(10000);
      expect(config.shutdownGraceMs).toBe(15000);
      expect(config.workerInstanceId).toMatch(/^worker-document-core-/);
      expect(config.imageDigest).toBe('sha256:placeholder-document-core-v1');
    });
  });

  describe('2. Validation Failures (Fail-Closed)', () => {
    it('rejects missing RUNTIME_URL', () => {
      const env = { ...validEnv };
      delete env.RUNTIME_URL;
      expect(() => parseWorkerConfig(env)).toThrow(/RUNTIME_URL/);
    });

    it('rejects invalid RUNTIME_URL format', () => {
      const env = { ...validEnv, RUNTIME_URL: 'not-a-valid-url' };
      expect(() => parseWorkerConfig(env)).toThrow(/RUNTIME_URL must be a valid URL/);
    });

    it('requires a separate Connector service identity when Connector is configured', () => {
      const env = { ...validEnv };
      delete env.CONNECTOR_SERVICE_TOKEN;
      expect(() => parseWorkerConfig(env)).toThrow(/CONNECTOR_SERVICE_TOKEN/);
    });

    it('rejects missing RUNTIME_TOKEN', () => {
      const env = { ...validEnv };
      delete env.RUNTIME_TOKEN;
      expect(() => parseWorkerConfig(env)).toThrow(/RUNTIME_TOKEN/);
    });

    it('rejects empty RUNTIME_TOKEN', () => {
      const env = { ...validEnv, RUNTIME_TOKEN: '' };
      expect(() => parseWorkerConfig(env)).toThrow(/RUNTIME_TOKEN/);
    });

    it('rejects missing REDIS_URL', () => {
      const env = { ...validEnv };
      delete env.REDIS_URL;
      expect(() => parseWorkerConfig(env)).toThrow(/REDIS_URL/);
    });

    it('rejects non-positive concurrency', () => {
      const env = { ...validEnv, CONCURRENCY: '0' };
      expect(() => parseWorkerConfig(env)).toThrow(/CONCURRENCY/);
    });

    it('rejects negative shutdown grace period', () => {
      const env = { ...validEnv, SHUTDOWN_GRACE_MS: '-500' };
      expect(() => parseWorkerConfig(env)).toThrow(/SHUTDOWN_GRACE_MS/);
    });
  });

  describe('3. Secret Redaction', () => {
    it('redacts RUNTIME_TOKEN in sanitized config copy', () => {
      const config = parseWorkerConfig(validEnv);
      const redacted = getRedactedConfig(config);

      expect(redacted.runtimeToken).toBe('[REDACTED]');
      expect(redacted.connectorServiceToken).toBe('[REDACTED]');
      expect(JSON.stringify(redacted)).not.toContain('secret-bearer-token-12345');
      expect(JSON.stringify(redacted)).not.toContain('connector-service-token-test');
      expect(redacted.runtimeUrl).toBe(config.runtimeUrl);
      expect(redacted.redisUrl).toBe(config.redisUrl);
    });

    it('validation errors do not leak token values', () => {
      try {
        parseWorkerConfig({ ...validEnv, RUNTIME_URL: 'invalid-url' });
      } catch (err: any) {
        expect(err.message).not.toContain('secret-bearer-token-12345');
      }
    });
  });

  describe('4. Process Lifecycle & Injected Signal Shutdown', () => {
    it('starts worker service and registers signal handlers', async () => {
      let workerStartedWith: any = null;
      let registeredSignals: Record<string, () => Promise<void>> = {};
      const logs: string[] = [];

      const mockWorkerHandle = {
        workerInstanceId: 'inst-123',
        queueName: 'du-business-document-core-1.0.0',
        stop: jest.fn().mockResolvedValue(undefined),
        stopped: false,
      };

      const proc = new DocumentCoreProcess({
        env: validEnv,
        startWorkerFn: async (cfg) => {
          workerStartedWith = cfg;
          return mockWorkerHandle;
        },
        onLog: (_level, msg, meta) => {
          logs.push(JSON.stringify({ msg, meta }));
        },
        registerSignalHandler: (sig, handler) => {
          registeredSignals[sig] = handler;
        },
      });

      const handle = await proc.start();
      expect(handle).toBe(mockWorkerHandle);
      expect(workerStartedWith.runtimeUrl).toBe(validEnv.RUNTIME_URL);
      expect(workerStartedWith.connectorServiceToken).toBe(validEnv.CONNECTOR_SERVICE_TOKEN);
      expect(workerStartedWith.redis.url).toBe(validEnv.REDIS_URL);
      expect(registeredSignals['SIGTERM']).toBeDefined();
      expect(registeredSignals['SIGINT']).toBeDefined();

      // Ensure no raw secret leaked in startup logs
      expect(logs.join('\n')).not.toContain('secret-bearer-token-12345');
      expect(logs.join('\n')).toContain('[REDACTED]');
    });

    it('exits with status 1 on invalid environment configuration', async () => {
      let exitCode: number | null = null;
      const proc = new DocumentCoreProcess({
        env: { RUNTIME_URL: 'invalid' }, // missing token and redis
        onExit: (code) => {
          exitCode = code;
        },
      });

      await expect(proc.start()).rejects.toThrow();
      expect(exitCode).toBe(1);
    });

    it('exits with status 1 on worker startup error', async () => {
      let exitCode: number | null = null;
      const proc = new DocumentCoreProcess({
        env: validEnv,
        startWorkerFn: async () => {
          throw new Error('Connection refused to runtime');
        },
        onExit: (code) => {
          exitCode = code;
        },
      });

      await expect(proc.start()).rejects.toThrow('Connection refused to runtime');
      expect(exitCode).toBe(1);
    });

    it('performs idempotent graceful shutdown on signal invocation', async () => {
      let exitCode: number | null = null;
      const mockStop = jest.fn().mockResolvedValue(undefined);
      let sigtermHandler: (() => Promise<void>) | undefined;

      const proc = new DocumentCoreProcess({
        env: validEnv,
        startWorkerFn: async () => ({
          workerInstanceId: 'inst-1',
          queueName: 'q-1',
          stop: mockStop,
          stopped: false,
        }),
        onExit: (code) => {
          exitCode = code;
        },
        registerSignalHandler: (sig, handler) => {
          if (sig === 'SIGTERM') sigtermHandler = handler;
        },
      });

      await proc.start();
      expect(sigtermHandler).toBeDefined();

      // First signal triggers shutdown and exits with 0
      await sigtermHandler!();
      expect(mockStop).toHaveBeenCalledTimes(1);
      expect(exitCode).toBe(0);

      // Second signal is idempotent no-op
      await sigtermHandler!();
      expect(mockStop).toHaveBeenCalledTimes(1);
    });
  });
});
