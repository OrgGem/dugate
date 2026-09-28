/**
 * R1-C fake resolver: scripted node:dns/promises answers so DNS-path tests never touch the
 * system resolver. Wire it with jest.mock at the CALLER test file (Node built-in module), e.g.
 *
 *   const mockDns = new DnsScript();
 *   jest.mock('node:dns/promises', () => ({ lookup: (...a: unknown[]) => mockDns.lookup(...a) }));
 *
 * Unscripted lookups throw — a real DNS query in a boundary suite is itself a finding.
 */
export interface DnsAnswerEntry {
  address: string;
  family: 4 | 6;
}

export class DnsScript {
  private readonly queue: DnsAnswerEntry[][] = [];
  private fallback: DnsAnswerEntry[] | undefined;
  readonly hosts: string[] = [];

  private static toEntries(ips: readonly string[]): DnsAnswerEntry[] {
    return ips.map((address) => ({ address, family: (address.includes(':') ? 6 : 4) as 4 | 6 }));
  }

  /** Queue the answer for the next lookup call (FIFO). */
  enqueue(...ips: string[]): this {
    this.queue.push(DnsScript.toEntries(ips));
    return this;
  }

  setDefault(...ips: string[]): this {
    this.fallback = DnsScript.toEntries(ips);
    return this;
  }

  get calls(): number {
    return this.hosts.length;
  }

  reset(): this {
    this.queue.length = 0;
    this.hosts.length = 0;
    this.fallback = undefined;
    return this;
  }

  lookup = async (hostnameOrAddress: unknown, options?: unknown): Promise<unknown> => {
    const host = typeof hostnameOrAddress === 'string'
      ? hostnameOrAddress
      : Buffer.isBuffer(hostnameOrAddress)
        ? hostnameOrAddress.toString('ascii')
        : String(hostnameOrAddress);
    this.hosts.push(host);
    const all = (options as { all?: boolean } | undefined)?.all === true;
    const entries = this.queue.shift() ?? this.fallback;
    if (!entries) {
      throw new Error(`harness dns: unscripted lookup for '${host}' (boundary suites must never hit the system resolver)`);
    }
    if (all) {
      return entries.map((e) => ({ address: e.address, family: e.family }));
    }
    const first = entries[0];
    if (!first) throw new Error(`harness dns: empty answer for '${host}'`);
    return { address: first.address, family: first.family };
  };
}
