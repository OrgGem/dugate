import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { AlertBanner } from '@/components/ui/state-panel';
import {
  SETTINGS_GROUPS,
  settingsRowsByGroup,
  settingsWriteReason,
  type SettingsCatalogRow,
} from './state';

interface CatalogRow {
  setting: string;
  source: string;
  managedBy: string;
  effective: string;
}

/**
 * Settings / Deployment (AWEB-07) - informational catalog only.
 * No deployment adapter exists yet, so there is no Save button anywhere on
 * this screen: every row is `requires deployment action` and points at the
 * env/compose surface (DEP owner).
 *
 * CFGADM-UI-PORT-P1 adds the three CFGADM groups below (01 AI defaults, 02
 * prompt defaults, 03/04 storage + retention) as the SAME honest shape:
 * the legacy key, its logical replacement, its owner - and a write control that
 * stays disabled with a specific reason, because there is no settings wire and no
 * writer action in this tree. Nothing here pretends a value was stored.
 */
const CATALOG: CatalogRow[] = [
  { setting: 'Orchestrator Portal mount (DU_ADMIN_WEB)', source: 'environment', managedBy: 'DEP / deployment compose', effective: 'flag (default off)' },
  { setting: 'Orchestrator Backend port/host (ADMIN_SHELL_PORT/HOST)', source: 'environment', managedBy: 'DEP / deployment compose', effective: 'boot-time' },
  { setting: 'Auth mode (DU_ADMIN_AUTH_MODE, LOCAL-00)', source: 'environment', managedBy: 'LOCAL-03 (not mounted)', effective: 'not managed' },
  { setting: 'Tenant admin tokens (tenantAdminTokens)', source: 'environment', managedBy: 'DEP + AWEB-02b wiring', effective: 'boot-time' },
  { setting: 'Connector composition (connectorBaseUrls / credentialWorkflow)', source: 'environment', managedBy: 'PAR-03/14 (F3)', effective: 'not managed' },
  { setting: 'Error metadata encryption (ENCRYPTION_KEY)', source: 'environment', managedBy: 'ENC / deployment secret', effective: 'boot-time, fail-closed' },
];

function SettingsRow({ row }: { row: SettingsCatalogRow }) {
  const reason = settingsWriteReason(row);
  return (
    <div
      className='flex flex-wrap items-center gap-3 border-t border-[var(--border-subtle)]/60 pt-3 first:border-t-0 first:pt-0'
      data-legacy-key={row.legacyKey}
    >
      <div className='min-w-0 flex-1'>
        <div className='flex flex-wrap items-center gap-2'>
          <span className='text-sm font-medium'>{row.label}</span>
          {row.secret ? (
            <Badge variant='warning'>secret</Badge>
          ) : null}
          {row.disposition === 'retire' ? <Badge variant='neutral'>retire</Badge> : null}
        </div>
        <p className='text-xs text-[var(--text-sub)] min-w-0 break-words'>
          <code>{row.legacyKey}</code> → {row.replacement}
        </p>
        <p className='text-xs text-[var(--text-muted)]'>
          {row.scope} · owner {row.owner}
        </p>
      </div>
      <Button
        size='sm'
        variant='outline'
        disabled
        title={reason}
        data-write-reason={row.legacyKey}
      >
        {row.disposition === 'retire' ? 'Retire' : row.secret ? 'Replace secret' : 'Apply'}
      </Button>
    </div>
  );
}

export function SettingsScreen() {
  return (
    <section aria-labelledby='settings-title' className='flex flex-col gap-5 min-w-0'>
      <div className='flex flex-wrap items-center gap-3'>
        <h1 id='settings-title' className='text-lg font-semibold'>
          Settings &amp; Deployment
        </h1>
        <Badge variant='warning' dot>
          requires deployment action
        </Badge>
      </div>

      <AlertBanner variant='info' title='No settings wire on this build'>
        This build has no settings wire at all: there is no Settings DTO in the contracts package and no
        writer action to call. The three groups below are therefore a catalog of the legacy key, its
        logical replacement and its owner - every write control is disabled with its reason, and no value
        is read into the browser or faked as saved.
      </AlertBanner>

      {SETTINGS_GROUPS.map((group) => (
        <Card key={group.id}>
          <CardHeader>
            <CardTitle>{group.title}</CardTitle>
            <CardDescription>{group.blurb}</CardDescription>
          </CardHeader>
          <CardContent className='flex flex-col gap-3'>
            {settingsRowsByGroup(group.id).map((row) => (
              <SettingsRow key={row.legacyKey} row={row} />
            ))}
          </CardContent>
        </Card>
      ))}

      <Card>
        <CardHeader>
          <CardTitle>Deployment catalog</CardTitle>
          <CardDescription>Source / managed-by / effective — recorded from the current deployment surface, not from a stored revision.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className='overflow-x-auto'>
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wider text-[var(--text-sub)]">
                  <th className="px-3 py-2">Setting</th>
                  <th className="px-3 py-2">Source</th>
                  <th className="px-3 py-2">Managed by</th>
                  <th className="px-3 py-2">Effective</th>
                </tr>
              </thead>
              <tbody>
                {CATALOG.map((row) => (
                  <tr key={row.setting} className="border-t border-[var(--border-subtle)]">
                    <td className="px-3 py-2 text-xs break-words">{row.setting}</td>
                    <td className="px-3 py-2 text-xs">{row.source}</td>
                    <td className="px-3 py-2 text-xs text-[var(--text-muted)]">{row.managedBy}</td>
                    <td className="px-3 py-2 text-xs">
                      <Badge variant={row.effective === 'not managed' ? 'warning' : 'neutral'}>{row.effective}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>How to deploy a change</CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="list-decimal pl-5 text-sm text-[var(--text-muted)] space-y-1">
            <li>Edit the deployment env/compose file (e.g. <code>du-rework/.env.live</code> + <code>docker-compose.yml</code>).</li>
            <li>Restart the orchestrator service (and worker when relevant) so boot-time config is re-read.</li>
            <li>Reload this page: the row's <em>effective</em> column reflects the new boot state; no revision is stored.</li>
          </ol>
        </CardContent>
      </Card>
    </section>
  );
}
