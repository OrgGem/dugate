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
