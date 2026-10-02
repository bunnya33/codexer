import { z } from "zod";

const questionSchema = z.object({
  id: z.string().min(1).max(200),
  header: z.string().max(1000).optional(),
  question: z.string().min(1).max(8192),
  isOther: z.boolean().optional().default(true),
  isSecret: z.boolean().optional().default(false),
  options: z.array(z.object({ label: z.string().min(1).max(8192), description: z.string().max(8192).optional().default("") })).max(20).nullish().transform(value => value ?? []),
});
export type InputQuestion = z.infer<typeof questionSchema>;

export function inputQuestions(details: Record<string, unknown>): InputQuestion[] {
  const parsed = z.array(questionSchema).min(1).max(20).safeParse(details.questions);
  if (!parsed.success || new Set(parsed.data.map(question => question.id)).size !== parsed.data.length || parsed.data.some(question => new Set(question.options.map(option => option.label)).size !== question.options.length)) return [];
  return parsed.data;
}
