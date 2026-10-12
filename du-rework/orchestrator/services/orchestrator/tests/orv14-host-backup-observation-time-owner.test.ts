import { collectFreshBackupObservationBatch } from '../src/modules/maintenance/backup-fence';

describe('ORV14 backup observation time boundary', () => {
  it('samples the freshness reference after asynchronous real-time observations complete', async () => {
    let clock = new Date('2026-10-12T04:00:00.000Z');
    const batch = await collectFreshBackupObservationBatch({
      collect: async () => {
        await new Promise((resolve) => setTimeout(resolve, 2));
        clock = new Date('2026-10-12T04:00:00.025Z');
        return { observedAt: clock.toISOString(), workObservedAt: clock.toISOString() };
      },
      observedAt: (value) => [value.observedAt, value.workObservedAt],
      now: () => clock,
      freshnessMs: 1_000,
    });

    expect(batch.value.observedAt).toBe(batch.sampledAt.toISOString());
  });

  it('rejects timestamps that are stale or future relative to the post-collection clock', async () => {
    const now = () => new Date('2026-10-12T04:00:01.000Z');
    const collect = (observedAt: string) => collectFreshBackupObservationBatch({
      collect: async () => ({ observedAt }),
      observedAt: (value) => [value.observedAt],
      now,
      freshnessMs: 1_000,
    });

    await expect(collect('2026-10-12T03:59:58.999Z')).rejects.toThrow('BACKUP_EFFECT_FENCE_UNAVAILABLE');
    await expect(collect('2026-10-12T04:00:01.001Z')).rejects.toThrow('BACKUP_EFFECT_FENCE_UNAVAILABLE');
  });
});
