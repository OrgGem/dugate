/** Tracks only child-process effects started by trusted maintenance adapters. */
const activeStops = new Map<() => void, boolean>();

export function registerActiveMaintenanceCommand(stop: () => void): () => void {
  activeStops.set(stop, false);
  return () => { activeStops.delete(stop); };
}

/** Signal exact owned process groups; callers still wait for close and record UNKNOWN. */
export function stopActiveMaintenanceCommands(): number {
  const stops = [...activeStops.entries()].filter(([, alreadySignalled]) => !alreadySignalled);
  for (const [stop] of stops) {
    activeStops.set(stop, true);
    try { stop(); } catch { /* A failed signal does not release the durable owner. */ }
  }
  return stops.length;
}
