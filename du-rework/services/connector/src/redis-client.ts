import Redis, { type RedisOptions } from 'ioredis';
import type { RedisEvalClient } from './quota-redis';

export interface ConnectorRedisOptions extends RedisOptions {
  keyPrefix?: string;
}

export class IoredisEvalClient implements RedisEvalClient {
  public readonly client: Redis;

  public constructor(options: ConnectorRedisOptions = {}) {
    this.client = new Redis(options);
  }

  public async eval(script: string, keyCount: number, ...arguments_: string[]): Promise<unknown> {
    return this.client.eval(script, keyCount, ...arguments_);
  }

  public async ping(): Promise<string> {
    return this.client.ping();
  }

  public async close(): Promise<void> {
    if (this.client.status === 'wait') {
      this.client.disconnect();
      return;
    }
    await this.client.quit();
  }
}
