# Workflow import and Admin Workbench

The Admin Workbench covers two operator jobs: editing a versioned legacy workflow and safely exercising an admitted endpoint or prompt workflow. It uses the existing Profile and workflow revision APIs; drafts remain local until an explicit save or publish action.

## Import and edit a workflow

The workflow import preview accepts canonical JSON and the supported legacy Workflow Builder XML dialect. Both formats are limited to 512 KiB and pass through the same workflow-schema parser and binding checks. XML accepts a `<workflow>` root with optional `<input>`, one `<nodes>`, one `<flow>`, and optional `<output>` sections. Nodes retain the supported workflow node properties, connector mappings, nested parallel branches, input declarations, and override fields represented by the canonical schema. Unknown XML elements and attributes are rejected rather than dropped. DTDs and entity declarations are rejected; only predefined and numeric character references are expanded.

Preview checks the immutable schema shape, node IDs and flow, input/output references, cross-branch and future references, and egress URL requirements. It reports connector names and egress origins for operator review. A preview does not publish or execute the imported workflow. The operator can continue editing in the revision editor, validate, review the diff, then publish against the expected revision. A conflict leaves the local draft intact so the operator can reload and reconcile it. Existing schema slugs and immutable revision history remain the identity and concurrency boundary.

## Endpoint workbench

Choose an active Profile revision and an action, then fill ordinary scalar inputs from its admitted input schema. Enums, booleans, numbers, and text use typed controls. Locked or managed values are visible and disabled; they are omitted from the request. Object and array values use a bounded JSON control, with a separate advanced JSON view for full payloads. Validation feedback is connected to each field and checks required values, types, enum values, and supported bounds before submission.

For local assigned USER sessions, the page discovers only enabled endpoints assigned to the current local user and lists safe API-key addresses scoped to that same Profile. It never receives key material. The server rechecks the current local identity version, Profile assignment, key assignment, endpoint enablement, tenant, and expected revision at write or test time. Assigned Profile edits update only allowed parameter and connection override values through a narrow revision-checked command; policy, credentials, API keys, and connector bindings remain server-managed.

Endpoint testing uses the existing admitted operation path, the selected current API key reference, and the real six-action execution surface. The UI warns that the selected provider action can incur cost, requires an explicit confirmation, and uses an idempotency key. Result output and artifact download follow the real operation response. The cURL sample is a redacted template containing an environment-variable placeholder; no key value is copied into the page.

## Prompt Wizard

The Wizard proposes a prompt from an actual selected Profile, assigned API key, and pinned `ext-prompt-wizard` connector revision. Its request is bounded and admitted like other business operations. A proposal is displayed with placeholder checks and a before/after diff. “Accept proposal to local draft” only updates the page draft; it does not save or publish. The operator can review it in the Profile editor and explicitly save or publish against the expected revision. A stale revision is reported and the local text is retained for reconciliation.

## Verification boundaries

Owner checks validate bounded XML conversion and rejection cases, the assignment/API-key scope, recipe pin behavior, ordinary schema-driven fields, lock omission, and the explicit local-draft handoff. These checks do not claim a live provider charge or replace final browser verification against a freshly built Admin Web bundle. No external provider call is made by import preview or source-only checks.
