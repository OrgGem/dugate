/**
 * CFGADM-UI-PORT-P1 - pure helpers over the settings catalog.
 *
 * Kept separate from the screen so the grouping and the honest-disabled reason are
 * unit-testable without rendering React, and so the screen stays a thin caller.
 */
import { SETTINGS_CATALOG, SETTINGS_GROUPS, settingsRowsByGroup, settingsWriteReason, type SettingsCatalogRow, type SettingsGroup } from './catalog';

export { SETTINGS_CATALOG, SETTINGS_GROUPS, settingsRowsByGroup, settingsWriteReason };
export type { SettingsCatalogRow, SettingsGroup };

/** Total rows across the three CFGADM groups (excludes the retire row). */
export function settingsPortedRowCount(): number {
  return SETTINGS_CATALOG.filter((row) => row.disposition === 'port').length;
}

/** Rows that are credentials - the ones that must never render a value. */
export function settingsSecretRows(): SettingsCatalogRow[] {
  return SETTINGS_CATALOG.filter((row) => row.secret);
}

/** True when a group has at least one row (used to decide whether to render it). */
export function settingsGroupHasRows(group: SettingsGroup): boolean {
  return settingsRowsByGroup(group).length > 0;
}
