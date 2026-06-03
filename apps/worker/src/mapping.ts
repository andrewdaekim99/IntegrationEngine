import type { ShopifyOrder, MockErpOrderInput } from '@integr8/connectors';

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
