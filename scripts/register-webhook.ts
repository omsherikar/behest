import { appUrl } from '../lib/app-deps';
import { registerWebhook, webhookUrl } from '../lib/paypal/webhook-registration';

// Registers the sandbox PayPal webhook for the deployment at APP_URL, or updates the one already
// registered for that URL, and prints the PAYPAL_WEBHOOK_ID line to put in the deployment's
// settings. It needs an https APP_URL and the PayPal client id and secret. It prints only the
// webhook id, never the credentials.

async function main() {
  const { id } = await registerWebhook(webhookUrl(appUrl()));
  return id;
}

main().then(
  (id) => console.log(`PAYPAL_WEBHOOK_ID=${id}`),
  (error: unknown) => {
    console.error(`Registering the PayPal webhook failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  },
);
