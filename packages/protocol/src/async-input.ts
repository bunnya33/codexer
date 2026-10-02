import { z } from 'zod';

export const asyncQuestionsSchema = z.array(z.object({
  title: z.string().min(1).max(8192),
  options: z.array(z.string().min(1).max(8192)).max(20).nullish(),
})).min(1).max(20).refine(questions => questions.every(question => new Set(question.options ?? []).size === (question.options?.length ?? 0)));
