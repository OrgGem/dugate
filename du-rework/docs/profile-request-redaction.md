# Profile request input redaction

Admin Web: open **Profiles**, load the profile, then configure **Request input redaction** and save its revision. Each rule has a JavaScript regex pattern (without slash delimiters), optional flags `i`, `m`, `s`, `u`, and a replacement. All matches are replaced; default replacement is `[REDACTED]`. Capture groups permit partial masking:

```json
{
  "requestRedaction": [
    { "pattern": "(\\d{3})\\d{4}(\\d{3})", "replacement": "$1****$2" },
    { "pattern": "[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}", "flags": "i" }
  ]
}
```

The configuration is part of `policy` in the existing profile upsert/read contract. Omission preserves previous rules; `[]` explicitly clears them. The existing profile permissions, tenant fencing, revision CAS and audit path apply. Maximum 20 rules, pattern length 512, replacement length 128. Invalid regex syntax or flags return 422 without inserting a revision.

**Operations** displays the server-produced `requestInput` projection. The backend decrypts using the operation tenant and metadata slot, combines pinned and currently active profile rules, then masks string values, numeric matches and object keys recursively. Rules added today protect old operations as well. The response reports `REDACTED`, `NO_RULES` or `HIDDEN`. No rules means input is visible to authorized administrators/operators. Rule removal from a new revision does not remove protection supplied by an operation's pinned revision.

This is a display policy. Stored request input, execution pins and the input consumed by workers remain unchanged. Public API clients retain their existing contract. Original artifact downloads retain their existing authorization and are outside JSON input redaction; regex rules do not rewrite PDF/DOCX/files or their contents.

Regex matching runs in a separate worker thread with a 200ms budget, up to four concurrent evaluations, 256KiB display input/output limit, depth 32 and 10,000 traversal nodes. Missing/corrupt profile policy, decrypt errors, excessive size/depth/concurrency, worker errors or timeout return fully hidden input. Rules run in sequence, with pinned policy before current policy. Replacements are trusted administrator configuration: retaining `$&` or all capture groups can intentionally preserve a match.

All five services use the shared structured logger. It keeps known identifiers/statuses, numeric counts/bytes/durations, flags and registered static event labels. Input/output, prompts, request/response bodies, arbitrary text/objects, dynamic messages, exception messages/stacks and secrets are omitted or replaced. New static log events must be registered in `packages/observability/src/log-events.ts`; otherwise their message is hidden. The Elasticsearch collector applies this projection before disk spooling and again before forwarding. Historical log files are not purged by this change.

Deploy migration `0033_profile_request_redaction.sql` before the new Orchestrator. The Docker Compose migration job performs this ordering automatically; local deployments use the existing migration command. Existing rules start as an empty array. Receipt: [implementation and checks](../coordination/reports/profile-request-redaction-2026-10-05.md).
