# Payment proof: can an agent pay with no buyer present?

Behest's ALLOW path moves money without a tap from the buyer. That depends on PayPal letting a merchant charge a saved PayPal wallet later, with the buyer absent. `scripts/vault-proof.sh` checks this against the PayPal sandbox with plain REST calls, before any app code is involved.

## Results

Sandbox, US accounts, buyer wallet funded by a Visa card. Every charge ran in a separate process with a fresh OAuth token, so none reused the session that saved the wallet.

| Test | Result |
|---|---|
| Save the wallet during a $1 purchase (Orders v2, `store_in_vault`) | Pass: `vault.status` is `VAULTED` |
| Charge $18 to that saved wallet, buyer not present | Pass: capture `COMPLETED` |
| Save the wallet with no purchase (Vault v3 setup token) | Pass: payment token issued |
| Charge $18 to that saved wallet, buyer not present | Pass: capture `COMPLETED` |
| Approve a $60 authorization, then capture $18 and $25 from it later | Pass: both captures `COMPLETED` |
| Charge the saved wallet with a different merchant as payee | Fail: `BILLING_AGREEMENT_NOT_FOUND` |
| Pay that second merchant from Behest's account with Payouts | Pass: payout item `SUCCESS` in about 15 seconds |

What this means for the design:

- **Buyers link their wallet once, with no purchase.** They do it while signing their mandate, using the Vault v3 setup token flow. Agent purchases inside the mandate then charge that saved wallet directly.
- **A saved wallet only pays the merchant that saved it.** So Behest is the merchant of record: the buyer is charged by Behest, and Behest pays the seller with the Payouts API.
- **Disputes arrive on Behest's account.** Behest answers them with the signed mandate and receipt on the seller's behalf.
- **Fallback with no saved wallet:** one approved authorization per seller, captured in parts. It keeps purchases click-free within the authorized amount, limited to a 3-day honor period and 29-day validity.

In production, saving PayPal wallets needs PayPal's approval for reference transactions, and acting as merchant of record needs approval for Payouts and a marketplace setup.

## Sandbox setup

1. **Use US sandbox accounts.** Saving a PayPal wallet is only supported for merchants in certain countries (US, Canada, UK, most of the EU, Australia, Japan, Singapore, Hong Kong, China). A developer account registered elsewhere may get default sandbox accounts from that country.
   - In developer.paypal.com, open Testing Tools, then Sandbox Accounts, and check the Country column.
   - Create a **Business** account in the **United States**. This is Behest.
   - Create a **Personal** account in the **United States**. This is the buyer. Note its email and password.
   - Create a second US **Business** account. This is the seller who receives payouts.
2. **Create the REST app.** In Apps & Credentials, on the Sandbox tab, click Create App and link it to the Behest business account. Copy the client ID and secret.
3. **Turn on saving.** Open the app's page.
   - Under **Features**, then **Payment capabilities**, switch on **Save payment methods**.
   - Under **Features**, then **Payment methods**, switch on **PayPal and Venmo**. This is what allows a PayPal wallet to be saved.
   - Switch on **Transaction search**, which the dashboard uses.
   - If a toggle is missing or greyed out, check that the app is linked to the US business account.
4. **Add credentials** to `.env` at the project root (see `.env.example`), or export them in your shell. Never commit them.

## Run it

Approve links open PayPal: log in as the **Personal** account and pay with the card, which settles instantly. After approving, PayPal redirects to example.com, which is expected. Return to the terminal.

```bash
# Save the wallet during a $1 purchase
scripts/vault-proof.sh 1a-create      # open the link, approve
scripts/vault-proof.sh 1a-capture     # expect vault.status VAULTED
scripts/vault-proof.sh charge 1a      # $18, buyer not present
scripts/vault-proof.sh charge-payee 1a   # $18 with the second business account as payee

# Save the wallet with no purchase
scripts/vault-proof.sh 1b-setup       # open the link, approve
scripts/vault-proof.sh 1b-token
scripts/vault-proof.sh charge 1b

# No saved wallet: one authorization, captured later in parts
scripts/vault-proof.sh 2-create       # $60; open the link, approve
scripts/vault-proof.sh 2-authorize
scripts/vault-proof.sh 2-capture 18.00
scripts/vault-proof.sh 2-capture 25.00

# Pay the seller from Behest's balance
scripts/vault-proof.sh payout 18.00
scripts/vault-proof.sh payout-status
```

Order, token and batch IDs are kept in `.vault-proof/state.json`, which is gitignored. `scripts/vault-proof.sh state` prints them.

## Troubleshooting

- **`vault.status` is `APPROVED` instead of `VAULTED`, or a permission error such as `PERMISSION_DENIED`:** check the two saving toggles and that every sandbox account is in a supported country.
- **A capture comes back `PENDING`:** the buyer paid by bank transfer. Approve with the card instead.
- **Production note:** PayPal requires risk data from its FraudNet library for some saved-wallet transactions. The sandbox doesn't enforce it.
