# Deploying Behest

Behest runs on one small virtual machine with Docker Compose: the app (the Next.js server, which also runs the background jobs), Postgres 16, and Caddy, which serves HTTPS. The same steps work on Google Cloud, AWS or any host that runs Docker. The app keeps PayPal in sandbox mode.

## Why a VM

Behest's job worker runs inside the server process: it polls payouts, expires unapproved purchases, processes PayPal webhooks and pulls disputes, so it needs CPU between requests. Cloud Run (by default) and App Runner give a container CPU only while it is serving a request, and Cloud Run scales an idle service to zero, so between requests those jobs would stall. Shopping runs also stream their progress over one long HTTP response. An always-on VM keeps one server process, with its worker, running all the time.

## 1. Create the VM

Either of these is enough:

- **Google Cloud:** a Compute Engine `e2-small` (2 GB) with Debian 12 or Ubuntu 24.04 and a 20 GB disk. Tick "Allow HTTP traffic" and "Allow HTTPS traffic", and reserve a static external IP for it.
- **AWS:** a Lightsail instance with 2 GB of memory and Ubuntu 24.04, with a static IP attached and HTTPS (443) opened under Networking. An EC2 `t3.small` works too, with a security group that opens 22, 80 and 443.

The first image build runs `next build`, which can use more memory than 2 GB holds. Add swap before building:

```sh
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## 2. Install Docker

```sh
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"   # then log out and back in
docker compose version
```

## 3. Point a domain at it

Create an A record for a domain or subdomain, such as `behest.example.com`, with the VM's static IP. Wait until `dig +short behest.example.com` prints that IP: Caddy needs it to get the certificate.

## 4. Fill in `.env.production`

On your own machine, in a checkout of this repository with `npm ci` done, generate the receipt signing key:

```sh
npm run keys   # prints RECEIPT_SIGNING_KEY=... and RECEIPT_KEY_ID=...
```

On the VM:

```sh
git clone <this repository> behest && cd behest
cp .env.production.example .env.production
ln -s .env.production .env   # Compose reads .env for ${DOMAIN} and ${POSTGRES_PASSWORD}
chmod 600 .env.production
```

Then fill in `.env.production`. Every setting is described in the file. In short:

- `DOMAIN` is the domain from step 3, and `APP_URL` is `https://` followed by it.
- `POSTGRES_PASSWORD`, `SESSION_SECRET` and `DEMO_RESET_KEY` are random values; the file says how to generate each.
- `RECEIPT_SIGNING_KEY` and `RECEIPT_KEY_ID` are the two lines `npm run keys` printed.
- `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` come from the PayPal sandbox REST app, and `PAYEE_EMAIL` is the second sandbox business account that receives seller payouts.
- `ANTHROPIC_API_KEY` is the Claude key. `CHANNEL3_API_KEY` and `AG_STUDIO` are optional.
- Leave `PAYPAL_WEBHOOK_ID` empty for now. Step 6 fills it in.

## 5. Start it

```sh
docker compose up -d --build
```

The first build takes several minutes. Compose then starts Postgres, waits until it is ready, starts the app (which applies any pending database migrations before the server starts), and starts Caddy, which gets the HTTPS certificate. Follow along with `docker compose ps` and `docker compose logs -f app caddy`.

## 6. Register the PayPal webhook

PayPal delivers events to `https://<DOMAIN>/api/paypal/webhooks`, and Behest accepts an event only after PayPal confirms it was sent for the webhook id in `PAYPAL_WEBHOOK_ID`. Register the webhook from your own machine, in the checkout from step 4, naming the deployed URL. The script reads `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` from your shell or from `.env`, and a value set in the shell wins:

```sh
APP_URL=https://behest.example.com npm run webhook:register
```

It prints one line, `PAYPAL_WEBHOOK_ID=<id>`, and nothing else. It creates the webhook for that URL, or updates the event types of the one already there, so running it again is safe. It refuses an `APP_URL` that is not https. Put the line in `.env.production` on the VM, then recreate the app so it reads it:

```sh
docker compose up -d
```

## 7. Seed the demo

The image runs the server only, with no `tsx`, so a deployment is seeded through the operator's demo reset rather than `npm run seed`. The reset removes every purchase and mandate and seeds the demo buyer, sellers and catalog again. It needs an operator session, the `DEMO_RESET_KEY` in the `x-demo-reset-key` header, and the body `{"confirm":"reset"}`:

```sh
DOMAIN=behest.example.com
DEMO_RESET_KEY='<the value in .env.production>'
curl -fsS -c cookies.txt -X POST "https://$DOMAIN/api/session" \
  -H 'content-type: application/json' -d '{"persona":"operator"}'
curl -fsS -b cookies.txt -X POST "https://$DOMAIN/api/demo/reset" \
  -H 'content-type: application/json' -H "x-demo-reset-key: $DEMO_RESET_KEY" \
  -d '{"confirm":"reset"}'
rm cookies.txt
```

The reset answers with how many rows it removed and what it seeded. It keeps a linked wallet unless the body also says `"full":true`, and it answers 409 while a purchase that changed in the last 30 minutes is being charged or a job is running.

## 8. Smoke checks

```sh
curl -fsS "https://$DOMAIN/api/health"                         # {"ok":true}
curl -fsS "https://$DOMAIN/.well-known/jwks.json" | jq '.keys | length'   # 1
```

Then make one ALLOW purchase end to end in the sandbox. As the buyer, write a mandate, confirm its readback and link a sandbox PayPal wallet. Ask the shopping agent for something the mandate allows from a demo seller. The decision ledger should show ALLOW, the payment should be captured, the receipt should verify against the key set, and the seller's orders page should show the order and its payout. Accepted webhooks and settled payouts are not logged: `docker compose logs app` shows only the webhooks it rejected or ignored, and failures.

## Running it

- **Update:** `git pull && docker compose up -d --build`. Migrations run on every start.
- **Logs:** `docker compose logs -f app`.
- **Back up the database:** `docker compose exec db pg_dump -U behest behest > behest.sql`.

## Checks for the operator

No page lists the purchase events that ask for an operator, or the jobs that ran out of retries, so read them from the database:

```sh
docker compose exec db psql -U behest behest -c "select purchase_id, kind, data, created_at from purchase_events where kind in ('charge_stale', 'capture_unmatched', 'seller_unreachable', 'seller_ambiguous', 'refund_failed', 'refund_skipped', 'refund_stuck', 'payout_failed', 'payout_after_refund', 'payout_unclaimed_after_refund') order by created_at desc"
docker compose exec db psql -U behest behest -c "select kind, payload, attempts, last_error, run_at from jobs where status = 'dead' order by run_at desc"
```

## Client addresses and Cloudflare

Rate limits key on the client's address. Caddy records the address that connected to it as the right-most `X-Forwarded-For` entry, and `TRUSTED_PROXY_HOPS=1` makes the app read exactly that entry, so a client cannot choose its own address by sending the header itself.

If you put Cloudflare in front, the address Caddy sees is Cloudflare's. Set `TRUST_CLOUDFLARE_HEADERS=1` so the app reads Cloudflare's `cf-connecting-ip` instead, and allow 80 and 443 only from Cloudflare's address ranges in the VM's firewall. Otherwise a client can connect to the VM directly and send that header with any address it likes.
