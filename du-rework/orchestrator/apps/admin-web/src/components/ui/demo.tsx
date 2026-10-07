import * as React from 'react';
import {
  AlertTriangle,
  Check,
  Key,
  Moon,
  Plus,
  Search,
  Sun,
  Trash2,
} from 'lucide-react';
import { Button } from './button';
import { Input } from './input';
import { FormField } from './field';
import { NativeSelect } from './select';
import { Badge } from './badge';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from './card';
import {
  TableContainer,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  TableEmpty,
} from './table';
import { TabsRoot, TabsList, TabsTab, TabsPanel } from './tabs';
import { Modal, ConfirmDialog } from './dialog';
import {
  LoadingState,
  EmptyState,
  ErrorState,
  DeniedState,
  AlertBanner,
  Skeleton,
} from './state-panel';
import { FIXTURE_PROFILES, FIXTURE_LONG_TEXT } from './fixtures';

/**
 * Interactive Component Foundation Demo & Verification Suite.
 * Exercises all primitives in light/dark mode, 320px reflow, keyboard focus, and 5 screen states.
 */
export function ComponentDemo() {
  const [theme, setTheme] = React.useState<'light' | 'dark'>('light');
  const [isModalOpen, setIsModalOpen] = React.useState(false);
  const [isConfirmOpen, setIsConfirmOpen] = React.useState(false);
  const [isConfirmLoading, setIsConfirmLoading] = React.useState(false);
  const [inputVal, setInputVal] = React.useState('');
  const [stateTab, setStateTab] = React.useState<'ready' | 'loading' | 'empty' | 'error' | 'denied'>('ready');
  const [isTableEmpty, setIsTableEmpty] = React.useState(false);

  const toggleTheme = () => {
    const next = theme === 'light' ? 'dark' : 'light';
    setTheme(next);
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-theme', next);
      if (next === 'dark') {
        document.documentElement.classList.add('dark');
      } else {
        document.documentElement.classList.remove('dark');
      }
    }
  };

  const handleConfirmAction = () => {
    setIsConfirmLoading(true);
    setTimeout(() => {
      setIsConfirmLoading(false);
      setIsConfirmOpen(false);
    }, 1000);
  };

  return (
    <div className="space-y-8 w-full max-w-full overflow-hidden p-2 sm:p-4">
      {/* Header bar with Theme Toggle */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[var(--border-subtle)] pb-4">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-[var(--text-main)]">
            AWEB-03a Primitives & Token Showcase
          </h2>
          <p className="text-xs text-[var(--text-sub)]">
            Base UI primitives styled with strict token hierarchy (tokens.css). No inline colors.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={toggleTheme}
            leftIcon={theme === 'light' ? <Moon className="size-4" /> : <Sun className="size-4" />}
          >
            Toggle {theme === 'light' ? 'Dark' : 'Light'} Mode
          </Button>
        </div>
      </div>

      {/* 1. Buttons Section */}
      <Card>
        <CardHeader>
          <CardTitle>1. Buttons (Base UI + Token Styling)</CardTitle>
          <CardDescription>
            Variants, sizes, loading states (Loader2), and accessible focus rings.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary">Primary Action</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="outline">Outline</Button>
            <Button variant="destructive" leftIcon={<Trash2 className="size-4" />}>
              Destructive
            </Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="link">Link Style</Button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm">Small (sm)</Button>
            <Button size="md">Medium (md)</Button>
            <Button size="lg">Large (lg)</Button>
            <Button size="icon" aria-label="Add item">
              <Plus className="size-4" />
            </Button>
            <Button isLoading>Saving...</Button>
            <Button disabled>Disabled</Button>
          </div>
        </CardContent>
        <CardFooter>
          <span className="text-xs text-[var(--text-sub)]">
            Buttons adhere to action tokens (--cf-blue) and focus ring (--focus-ring).
          </span>
        </CardFooter>
      </Card>

      {/* 2. Form Controls (Input, Select, Field, Validation) */}
      <Card>
        <CardHeader>
          <CardTitle>2. Inputs & Form Fields</CardTitle>
          <CardDescription>
            Accessible labels, required flags, description, error messages, and icon adornments.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <FormField
            label="API Key Description"
            description="Give this key a recognizable label."
            required
          >
            <Input
              placeholder="e.g. Production Read-only Worker"
              value={inputVal}
              onChange={(e) => setInputVal(e.target.value)}
              leftIcon={<Key className="size-4" />}
            />
          </FormField>

          <FormField
            label="Search Filter"
            description="With clear right icon adornment."
          >
            <Input placeholder="Search endpoints or keys..." rightIcon={<Search className="size-4" />} />
          </FormField>

          <FormField
            label="Input with Error State"
            error="Revision conflict (409): Value was modified by another session."
            required
          >
            <Input
              defaultValue="stale_revision_payload"
              isError
              aria-describedby="conflict-err"
            />
          </FormField>

          <FormField label="Service Type (Select)" description="NativeSelect styled wrapper">
            <NativeSelect defaultValue="extract">
              <option value="extract">extract — Document Parsing & Ingestion</option>
              <option value="analyze">analyze — Table & Entity Understanding</option>
              <option value="transform">transform — Format Conversion (Markdown)</option>
              <option value="compare">compare — Semantic Document Diffing</option>
            </NativeSelect>
          </FormField>
        </CardContent>
      </Card>

      {/* 3. Badges & Status Indicators */}
      <Card>
        <CardHeader>
          <CardTitle>3. Status Badges</CardTitle>
          <CardDescription>
            Consistent badge palette mapped to --badge-* tokens with status dots.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2">
          <Badge variant="success" dot>
            Active / Ready
          </Badge>
          <Badge variant="info" dot>
            OIDC Session
          </Badge>
          <Badge variant="warning" dot>
            Draft (Revision 4)
          </Badge>
          <Badge variant="danger" dot>
            Failed / 409 Conflict
          </Badge>
          <Badge variant="neutral">Neutral / Idle</Badge>
          <Badge variant="success" icon={<Check className="size-3.5" />}>
            Verified
          </Badge>
          <Badge variant="danger" icon={<AlertTriangle className="size-3.5" />}>
            Locked Field
          </Badge>
        </CardContent>
      </Card>

      {/* 4. Dialogs & Modals */}
      <Card>
        <CardHeader>
          <CardTitle>4. Accessible Dialogs & Modals (Focus Trap, Esc Key)</CardTitle>
          <CardDescription>
            Base UI Dialog with focus trap, backdrop dimming, Esc dismissal, and focus restoration.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          <Button onClick={() => setIsModalOpen(true)}>Open Standard Modal</Button>
          <Button variant="destructive" onClick={() => setIsConfirmOpen(true)}>
            Open ConfirmDialog
          </Button>

          {/* Standard Modal */}
          <Modal
            open={isModalOpen}
            onOpenChange={setIsModalOpen}
            title="Edit Profile Settings"
            description="Manage parameters, concurrency, and locked fields."
            footer={
              <>
                <Button variant="secondary" onClick={() => setIsModalOpen(false)}>
                  Cancel
                </Button>
                <Button onClick={() => setIsModalOpen(false)}>Save Changes</Button>
              </>
            }
          >
            <div className="space-y-4 py-2">
              <FormField label="Endpoint Slug" required>
                <Input defaultValue="extract/pdf-table-parser" />
              </FormField>
              <FormField
                label="Timeout (seconds)"
                description="Maximum allowable duration before operation fail-closed."
              >
                <Input type="number" defaultValue="180" />
              </FormField>
              <AlertBanner variant="info" title="Locked Fields Notice">
                Field <code>apiKeyId</code> is locked. Re-submitting this field will return 400.
              </AlertBanner>
            </div>
          </Modal>

          {/* Confirm Dialog */}
          <ConfirmDialog
            open={isConfirmOpen}
            onOpenChange={setIsConfirmOpen}
            title="Revoke API Key"
            description="Are you sure you want to revoke this API key? This action is immediate and cannot be undone."
            confirmText="Revoke Key"
            variant="destructive"
            isLoading={isConfirmLoading}
            onConfirm={handleConfirmAction}
          />
        </CardContent>
      </Card>

      {/* 5. Responsive Data Table & Reflow 320px */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle>5. Responsive Table & Long Text Reflow (320px Safe)</CardTitle>
              <CardDescription>
                Container scrolls horizontally on small viewports without breaking page layout. Text wraps cleanly.
              </CardDescription>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsTableEmpty(!isTableEmpty)}
            >
              Toggle Empty: {isTableEmpty ? 'Showing Empty' : 'Showing Rows'}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <TableContainer>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-48">Profile / ID</TableHead>
                  <TableHead>Service</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Priority</TableHead>
                  <TableHead className="min-w-64">Description (Long Text Test)</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isTableEmpty ? (
                  <TableEmpty colSpan={6} message="No profiles matching criteria found for this tenant." />
                ) : (
                  FIXTURE_PROFILES.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="font-mono text-xs font-semibold">
                        <div className="truncate max-w-44" title={row.id}>
                          {row.id}
                        </div>
                        <div className="text-[11px] text-[var(--text-sub)] font-normal truncate max-w-44">
                          Rev #{row.revision}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="info">{row.service}</Badge>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            row.status === 'active'
                              ? 'success'
                              : row.status === 'draft'
                              ? 'warning'
                              : 'neutral'
                          }
                          dot
                        >
                          {row.status}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <span className="text-xs font-semibold">{row.priority}</span>
                      </TableCell>
                      <TableCell className="text-xs text-[var(--text-muted)] leading-relaxed">
                        {row.description}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button variant="ghost" size="sm">
                          Edit
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </TableContainer>

          <div className="p-3 rounded-[var(--radius-sm)] bg-[var(--bg-subtle)] border border-[var(--border-subtle)] text-xs space-y-1 overflow-hidden">
            <strong className="text-[var(--text-main)] block">Extra Long URL Word-Break Test (320px):</strong>
            <p className="font-mono text-[var(--text-sub)] break-all">{FIXTURE_LONG_TEXT.extraLong}</p>
          </div>
        </CardContent>
      </Card>

      {/* 6. Tabs Primitive */}
      <Card>
        <CardHeader>
          <CardTitle>6. Accessible Tabs (Roving Tabindex)</CardTitle>
          <CardDescription>
            Base UI Tabs supporting keyboard arrow navigation and panel activation.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <TabsRoot defaultValue="general">
            <TabsList>
              <TabsTab value="general">General Configuration</TabsTab>
              <TabsTab value="parameters">Parameters & Locks</TabsTab>
              <TabsTab value="security">Vault & Encryption</TabsTab>
            </TabsList>
            <TabsPanel value="general">
              <div className="p-4 rounded-[var(--radius-sm)] bg-[var(--bg-subtle)] text-xs space-y-2">
                <strong>General Parameters:</strong> Priority is mapped to BullMQ queue levels (20=LOW, 10=MEDIUM, 1=HIGH).
              </div>
            </TabsPanel>
            <TabsPanel value="parameters">
              <div className="p-4 rounded-[var(--radius-sm)] bg-[var(--bg-subtle)] text-xs space-y-2">
                <strong>Locked Parameters:</strong> Enforced by admission seam in submission.ts.
              </div>
            </TabsPanel>
            <TabsPanel value="security">
              <div className="p-4 rounded-[var(--radius-sm)] bg-[var(--bg-subtle)] text-xs space-y-2">
                <strong>Security:</strong> Profile credentials encrypted using AES-256-GCM in PostgreSQL.
              </div>
            </TabsPanel>
          </TabsRoot>
        </CardContent>
      </Card>

      {/* 7. The 5 Screen States (Contract §3) */}
      <Card>
        <CardHeader>
          <CardTitle>7. Five Screen States (Contract §3 State Contract)</CardTitle>
          <CardDescription>
            Interactive preview of all 5 standard states: ready, loading, empty, error, and denied.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {(['ready', 'loading', 'empty', 'error', 'denied'] as const).map((s) => (
              <Button
                key={s}
                variant={stateTab === s ? 'primary' : 'outline'}
                size="sm"
                onClick={() => setStateTab(s)}
              >
                State: {s}
              </Button>
            ))}
          </div>

          <div className="p-2 border border-[var(--border-subtle)] rounded-[var(--radius-md)] bg-[var(--bg-canvas)]">
            {stateTab === 'ready' && (
              <div className="p-6 text-center space-y-2 bg-[var(--bg-card)] rounded-[var(--radius-sm)]">
                <Check className="size-8 mx-auto text-[var(--badge-success-dot)]" />
                <h4 className="text-base font-semibold text-[var(--text-main)]">Ready State</h4>
                <p className="text-xs text-[var(--text-sub)]">
                  Data loaded successfully with valid revision and tenant credentials.
                </p>
              </div>
            )}

            {stateTab === 'loading' && (
              <div className="space-y-3 p-4 bg-[var(--bg-card)] rounded-[var(--radius-sm)]">
                <LoadingState
                  title="Fetching Orchestrator Profiles..."
                  description="Synchronizing active bindings from postgres at revision 7."
                />
                <div className="space-y-2">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-4 w-1/2" />
                  <Skeleton className="h-4 w-5/6" />
                </div>
              </div>
            )}

            {stateTab === 'empty' && (
              <EmptyState
                title="No Profiles Configured"
                description="This tenant currently has no custom profiles. You can create one or import default templates."
                actionText="Create Initial Profile"
                onAction={() => alert('Action clicked')}
              />
            )}

            {stateTab === 'error' && (
              <ErrorState
                title="Revision Conflict Error"
                statusCode={409}
                description="The profile has been modified by another admin session since you loaded this page. Please review conflicting fields."
                onRetry={() => alert('Retrying load...')}
              />
            )}

            {stateTab === 'denied' && (
              <DeniedState
                title="403 Forbidden: Tenant Boundary Enforced"
                description="Operator session does not have permission to view or mutate Profile records belonging to tenant 'tenant-enterprise-beta'."
                tenantId="tenant-enterprise-beta"
                requiredRole="platform:admin"
              />
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
