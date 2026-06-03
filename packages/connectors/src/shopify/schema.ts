import { z } from 'zod';

/**
 * Minimal Shopify Order schema. The real payload has 100+ fields; we only
 * validate what the engine maps to destination connectors today. Adding
 * fields later is non-breaking because zod is permissive about unknown keys
 * by default — but every field we *read* in the worker has to be declared
 * here so the type system catches typos.
 */
export const shopifyOrderSchema = z.object({
  id: z.number(),
  email: z.string().nullable().optional(),
  created_at: z.string(),
  total_price: z.string(), // Shopify returns money as strings, e.g. "10.50"
  currency: z.string(),
  customer: z
    .object({
      id: z.number().optional(),
      email: z.string().nullable().optional(),
      first_name: z.string().nullable().optional(),
      last_name: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  line_items: z.array(
    z.object({
      id: z.number(),
      title: z.string(),
      quantity: z.number(),
      price: z.string(),
      sku: z.string().nullable().optional(),
    }),
  ),
  shipping_address: z
    .object({
      address1: z.string().nullable().optional(),
      city: z.string().nullable().optional(),
      country: z.string().nullable().optional(),
      zip: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
});

export type ShopifyOrder = z.infer<typeof shopifyOrderSchema>;
