import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verify a Shopify webhook HMAC.
 *
 * Shopify computes HMAC-SHA256 of the **raw** request body using the webhook
 * signing secret, base64-encodes it, and sends it in the `X-Shopify-Hmac-Sha256`
 * header. The verification must be a constant-time compare to avoid leaking
 * timing information about the secret.
 */
export function verifyShopifyHmac(
  rawBody: string,
  signature: string,
  secret: string,
): boolean {
  const computed = createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
  const a = Buffer.from(computed);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Convenience: produce the header value Shopify would send for a body. Test-only. */
export function signShopifyBody(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
}
