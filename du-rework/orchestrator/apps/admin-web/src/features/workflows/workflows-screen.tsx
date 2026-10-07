import { AlertBanner } from '@/components/ui/state-panel';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * Workflows screen — CFGADM-09. Per Δ-DEV-03, the workflows route is user-gated
 * and ships disabled with an honest reason until it is unblocked.
 */
export function WorkflowsScreen() {
  return (
    <div className="space-y-4">
      <AlertBanner variant="warning" title="Workflows route is disabled">
        The workflows administration route is currently disabled by deployment policy
        (Δ-DEV-03). It will be enabled once the workflows backend is available for this
        deployment. No workflows data is read or mutated in this state.
      </AlertBanner>
      <Card>
        <CardHeader>
          <CardTitle>Workflows</CardTitle>
          <CardDescription>
            List, import, mappings, and schemaSlug management will appear here when
            enabled. The UI remains fail-closed and shows this reason instead of faking
            data.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            There are no workflows available in this preview mode.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}