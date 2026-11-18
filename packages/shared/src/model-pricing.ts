import { z } from 'zod';
import defaults from '../../../apps/relay/protocol/default-model-pricing.json';

export const MAX_MODEL_RATES = 250;
export const MAX_PRICING_FILE_BYTES = 128 * 1024;
export const MAX_MODEL_RATE = 1_000_000;
const rate = z.number().nonnegative().max(MAX_MODEL_RATE);

export const modelRateSchema = z.object({
  id: z.string().max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]*$/),
  input: rate,
  cachedInput: rate.nullable(),
  output: rate,
}).strict();

export const modelPricingSchema = z.object({
  version: z.literal(1),
  currency: z.literal('USD'),
  unit: z.literal('perMillionTokens'),
  asOf: z.iso.date(),
  source: z.string().max(512).regex(/^https:\/\/[a-zA-Z0-9.-]+(?::[0-9]{1,5})?(?:[/?#][^\s\\]*)?$/).nullable(),
  models: z.array(modelRateSchema).max(MAX_MODEL_RATES),
}).strict().superRefine(({ models }, ctx) => {
  const seen = new Set<string>();
  models.forEach(({ id }, index) => {
    if (seen.has(id)) ctx.addIssue({ code: 'custom', path: ['models', index, 'id'], message: `模型 ID 重复：${id}` });
    seen.add(id);
  });
});

export const versionedModelPricingSchema = z.object({
  revision: z.string().regex(/^(default|saved)-[a-f0-9]{64}$/),
  catalog: modelPricingSchema,
}).strict();
export type ModelRate = z.infer<typeof modelRateSchema>;
export type ModelPricing = z.infer<typeof modelPricingSchema>;
export type VersionedModelPricing = z.infer<typeof versionedModelPricingSchema>;
export const defaultModelPricing = modelPricingSchema.parse(defaults);
