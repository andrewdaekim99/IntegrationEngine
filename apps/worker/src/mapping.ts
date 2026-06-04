import type {
  ShopifyOrder,
  MockErpOrderInput,
  StripePaymentIntentInput,
} from '@integr8/connectors';

/**
 * Phase 3 hard-coded mapping. Phase 6 replaces this with an AI-proposed,
 * human-approved `MappingConfig` row, but the *shape* (ShopifyOrder → MockErpOrderInput)
 * is the contract the mapping config has to honor — so this function is also the
 * documentation for what the AI is allowed to produce.
 */
export function mapShopifyOrderToMockErp(order: ShopifyOrder): MockErpOrderInput {
  const nameParts = [order.customer?.first_name, order.customer?.last_name]
    .filter((s): s is string => typeof s === 'string' && s.length > 0);
  return {
    externalRef: `shopify-${order.id}`,
    customer: {
      email: order.email ?? order.customer?.email ?? null,
      name: nameParts.length > 0 ? nameParts.join(' ') : null,
    },
    items: order.line_items.map((li) => ({
      sku: li.sku ?? null,
      quantity: li.quantity,
      price: li.price,
    })),
    totalAmount: order.total_price,
    currency: order.currency,
  };
}

/**
 * Phase 7 hard-coded Shopify → Stripe PaymentIntent mapping. Same contract as
 * the MockErp version — a MappingConfig for (shopify, stripe) replaces this at
 * runtime, but if none is approved this is what gets delivered.
 *
 * Currency is lowercased; amount is converted from a Shopify-style decimal
 * string ("29.50") to Stripe's smallest-unit integer (2950 cents).
 */
export function mapShopifyOrderToStripe(order: ShopifyOrder): StripePaymentIntentInput {
  const customerEmail = order.email ?? order.customer?.email ?? '';
  const nameParts = [order.customer?.first_name, order.customer?.last_name].filter(
    (s): s is string => typeof s === 'string' && s.length > 0,
  );
  const metadata: Record<string, string> = {
    source_system: 'shopify',
    source_order_id: String(order.id),
  };
  if (customerEmail) metadata.customer_email = customerEmail;
  if (nameParts.length > 0) metadata.customer_name = nameParts.join(' ');
  return {
    amount: shopifyAmountToCents(order.total_price),
    currency: order.currency.toLowerCase(),
    description: `Shopify order ${order.id}`,
    metadata,
  };
}

function shopifyAmountToCents(decimalString: string): number {
  const n = Number(decimalString);
  if (!Number.isFinite(n)) {
    throw new Error(`mapShopifyOrderToStripe: invalid amount ${JSON.stringify(decimalString)}`);
  }
  return Math.round(n * 100);
}
