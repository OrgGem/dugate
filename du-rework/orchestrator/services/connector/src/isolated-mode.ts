/** Resolve the narrowly supported source-off restore rehearsal mode. */
export function connectorIsolatedRestoreModeFromEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const raw = env['CONNECTOR_ISOLATED_RUNTIME_MODE']?.trim();
  if (raw === undefined || raw === '') return false;
  if (raw !== 'restore-rehearsal') {
    throw new Error('CONNECTOR_ISOLATED_RUNTIME_MODE must be restore-rehearsal when set.');
  }
  return true;
}
