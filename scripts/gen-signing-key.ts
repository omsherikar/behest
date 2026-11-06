import { generateSigningKey } from '../lib/receipts/keys';

// Prints a fresh Ed25519 signing key and its key id as two lines ready to paste into .env.
// The PEM's newlines are written as literal \n so the key fits on one line. Nothing is
// written to disk: the private key exists only in this output.

async function main() {
  const { pem, kid } = await generateSigningKey();
  console.log(`RECEIPT_SIGNING_KEY="${pem.trim().replaceAll('\n', '\\n')}"`);
  console.log(`RECEIPT_KEY_ID=${kid}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
