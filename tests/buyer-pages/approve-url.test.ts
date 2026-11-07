import { describe, expect, it } from 'vitest';
import { paypalApproveUrl } from '@/lib/buyer-pages/approve-url';

describe('paypalApproveUrl', () => {
  it('passes an https link on PayPal or its sandbox, as the link to open', () => {
    for (const url of [
      'https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T',
      'https://sandbox.paypal.com/checkoutnow?token=5O190127TN364715T',
      'https://www.paypal.com/checkoutnow?token=5O190127TN364715T',
      'https://paypal.com/checkoutnow?token=5O190127TN364715T',
    ]) {
      expect(paypalApproveUrl(url)).toBe(url);
    }
    expect(paypalApproveUrl('https://WWW.PayPal.com:443/checkoutnow?token=A')).toBe('https://www.paypal.com/checkoutnow?token=A');
  });

  it('refuses a link that is missing, is not https or is not a web link', () => {
    for (const url of [
      null,
      '',
      'not a link',
      '/checkoutnow?token=A',
      'http://www.paypal.com/checkoutnow?token=A',
      'javascript:alert(document.cookie)',
      'data:text/html,<script>alert(1)</script>',
      'ftp://www.paypal.com/checkoutnow',
    ]) {
      expect(paypalApproveUrl(url)).toBeNull();
    }
  });

  it('refuses a host that only looks like PayPal', () => {
    for (const url of [
      'https://paypal.com.evil.example/checkoutnow?token=A',
      'https://evilpaypal.com/checkoutnow?token=A',
      'https://www.paypal.co/checkoutnow?token=A',
      'https://www.paypal.com@evil.example/checkoutnow?token=A',
      'https://evil.example/https://www.paypal.com/checkoutnow',
      'https://api.sandbox.paypal.com/v2/checkout/orders/A',
      'https://www.paypal.com./checkoutnow?token=A',
      'https://www.xn--pypal-4ve.com/checkoutnow?token=A',
    ]) {
      expect(paypalApproveUrl(url)).toBeNull();
    }
  });

  it('refuses a PayPal link that carries a user name, a password or another port', () => {
    expect(paypalApproveUrl('https://priya@www.paypal.com/checkoutnow?token=A')).toBeNull();
    expect(paypalApproveUrl('https://priya:secret@www.paypal.com/checkoutnow?token=A')).toBeNull();
    expect(paypalApproveUrl('https://www.paypal.com:8443/checkoutnow?token=A')).toBeNull();
  });
});
