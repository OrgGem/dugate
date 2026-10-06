// VENDORED from @du/contracts @ b088eececcb5f3df0b4edbe073a29401dafda624 (worktree 2026-10-05)
// source: packages/contracts/src/request-redaction.ts (lines=13) sha256=39AAC7F386092C03B4E55B030BD92D007A7D369CBD6F9BE8E9534B95B6CFD952
// why: transitive dep of profile-policy.ts (RequestRedactionRulesSchema)

import { z } from 'zod';

export const RequestRedactionRuleSchema = z.object({
  pattern: z.string().min(1).max(512),
  flags: z.string().max(4).regex(/^(?!.*(.).*\1)[imsu]*$/).optional(),
  replacement: z.string().max(128).optional(),
}).strict().superRefine((rule, ctx) => {
  try { new RegExp(rule.pattern, 'g' + (rule.flags ?? '')); }
  catch { ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['pattern'], message: 'Invalid regular expression' }); }
});

export const RequestRedactionRulesSchema = z.array(RequestRedactionRuleSchema).max(20);
export type RequestRedactionRule = z.infer<typeof RequestRedactionRuleSchema>;
