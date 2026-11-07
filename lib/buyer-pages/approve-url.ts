// The approval link of an ASK purchase is shown to the buyer as a link and a QR code, so it must be
// a PayPal page before it is. The link comes from PayPal's answer when the order was created, and
// the stored value is checked again here rather than trusted.

/** PayPal's live and sandbox sites, where a buyer approves an order. */
const PAYPAL_HOSTS = new Set(['paypal.com', 'www.paypal.com', 'sandbox.paypal.com', 'www.sandbox.paypal.com']);

/**
 * The link as it should be opened, when it is an https link to PayPal or its sandbox on the default
 * port with no user name or password. Null for anything else, a missing link included.
 */
export function paypalApproveUrl(raw: string | null): string | null {
  const url = raw ? URL.parse(raw) : null;
  if (!url || url.protocol !== 'https:' || !PAYPAL_HOSTS.has(url.hostname)) return null;
  if (url.username !== '' || url.password !== '' || url.port !== '') return null;
  return url.href;
}
