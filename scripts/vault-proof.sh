#!/usr/bin/env bash
# Sandbox proof that an agent can charge a buyer's PayPal wallet with no buyer present.
# Setup and the pass/fail table live in docs/vault-proof.md.
#
# Env (shell or .env): PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET (sandbox app on a US business account)
#      PAYEE_EMAIL (optional: a second US sandbox business account, for the charge-payee test)
set -euo pipefail

API="https://api-m.sandbox.paypal.com"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Keys can come from the shell or from a gitignored .env at the project root.
if [ -f "$ROOT/.env" ]; then set -a; . "$ROOT/.env"; set +a; fi
STATE_DIR="$ROOT/.vault-proof"
STATE="$STATE_DIR/state.json"
mkdir -p "$STATE_DIR"
[ -f "$STATE" ] || echo '{}' > "$STATE"

die() { echo "FAIL: $*" >&2; exit 1; }
need_env() { [ -n "${PAYPAL_CLIENT_ID:-}" ] && [ -n "${PAYPAL_CLIENT_SECRET:-}" ] || die "set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET"; }
save() { local t; t=$(mktemp); jq --arg k "$1" --arg v "$2" '.[$k]=$v' "$STATE" > "$t" && mv "$t" "$STATE"; }
get() { jq -r --arg k "$1" '.[$k] // empty' "$STATE"; }

# A fresh OAuth token on every call. Each subcommand runs as its own process,
# so the later charges never reuse anything from the session that created the vault.
token() {
  need_env
  curl -sS -u "$PAYPAL_CLIENT_ID:$PAYPAL_CLIENT_SECRET" \
    -d grant_type=client_credentials "$API/v1/oauth2/token" | jq -r '.access_token // empty'
}

call() { # method path [json]
  local tok; tok=$(token); [ -n "$tok" ] || die "could not get an access token (check client id/secret)"
  local args=(-sS -X "$1" "$API$2" -H "Authorization: Bearer $tok" -H "Content-Type: application/json" -H "PayPal-Request-Id: $(uuidgen)")
  [ $# -ge 3 ] && args+=(-d "$3")
  curl "${args[@]}"
}

approve_link() { jq -r '.links[]? | select(.rel=="payer-action" or .rel=="approve") | .href' | head -1; }

ctx='{"return_url":"https://example.com/approved","cancel_url":"https://example.com/cancelled","user_action":"CONTINUE","brand_name":"Vault proof"}'

capture_if_needed() { # order-json -> final order json
  local o="$1" id st; id=$(jq -r .id <<<"$o"); st=$(jq -r .status <<<"$o")
  if [ "$st" = "APPROVED" ] || [ "$st" = "CREATED" ]; then call POST "/v2/checkout/orders/$id/capture" '{}'; else echo "$o"; fi
}

report_charge() { # final order json, label
  local o="$1"
  echo "$o" | jq '{order_id:.id, status, capture_status:.purchase_units[0].payments.captures[0].status, capture_id:.purchase_units[0].payments.captures[0].id, payee:.purchase_units[0].payee, error:.name, details:.details}'
  [ "$(jq -r '.purchase_units[0].payments.captures[0].status // empty' <<<"$o")" = "COMPLETED" ] \
    && echo "PASS: $2 captured with no buyer present" || echo "FAIL: $2 did not capture (see above)"
}

charge() { # vault_id amount [payee_email]
  local vid="$1" amt="$2" payee="${3:-}" pu
  pu=$(jq -n --arg a "$amt" --arg p "$payee" '[{amount:{currency_code:"USD",value:$a}, description:"Agent purchase, buyer not present"} + (if $p=="" then {} else {payee:{email_address:$p}} end)]')
  local body; body=$(jq -n --arg v "$vid" --argjson pu "$pu" '{intent:"CAPTURE", purchase_units:$pu, payment_source:{paypal:{vault_id:$v}}}')
  capture_if_needed "$(call POST /v2/checkout/orders "$body")"
}

case "${1:-help}" in
  # Tier 1a: save the wallet during a first purchase (Orders v2, store_in_vault)
  1a-create)
    body=$(jq -n --argjson c "$ctx" '{intent:"CAPTURE", purchase_units:[{amount:{currency_code:"USD",value:"1.00"}, description:"First purchase, saves wallet"}], payment_source:{paypal:{attributes:{vault:{store_in_vault:"ON_SUCCESS", usage_type:"MERCHANT", customer_type:"CONSUMER"}}, experience_context:$c}}}')
    o=$(call POST /v2/checkout/orders "$body"); echo "$o" | jq '{id,status,error:.name,details:.details}'
    id=$(jq -r '.id // empty' <<<"$o"); [ -n "$id" ] || die "order not created"
    save order_1a "$id"
    echo; echo "Open this link, log in as the US sandbox PERSONAL account, approve, then run: $0 1a-capture"
    approve_link <<<"$o" ;;
  1a-capture)
    id=$(get order_1a); [ -n "$id" ] || die "run 1a-create first"
    o=$(call POST "/v2/checkout/orders/$id/capture" '{}')
    echo "$o" | jq '{status, capture:.purchase_units[0].payments.captures[0].status, vault:.payment_source.paypal.attributes.vault, error:.name, details:.details}'
    vid=$(jq -r '.payment_source.paypal.attributes.vault.id // empty' <<<"$o")
    vst=$(jq -r '.payment_source.paypal.attributes.vault.status // empty' <<<"$o")
    [ -n "$vid" ] && [ "$vst" = "VAULTED" ] || die "no vault id (vault.status='$vst'). Check the Save payment methods and PayPal and Venmo toggles, and that both sandbox accounts are US."
    save vault_1a "$vid"; echo "PASS: wallet vaulted, vault_id=$vid. Now run: $0 charge 1a" ;;

  # Tier 1b: save the wallet with no purchase (Vault v3 setup token). Fits the product:
  # the buyer links their wallet once, when they sign the mandate.
  1b-setup)
    body=$(jq -n --argjson c "$ctx" '{payment_source:{paypal:{description:"Let my shopping agent pay within my mandate", usage_pattern:"IMMEDIATE", usage_type:"MERCHANT", customer_type:"CONSUMER", permit_multiple_payment_tokens:false, experience_context:($c|del(.user_action))}}}')
    o=$(call POST /v3/vault/setup-tokens "$body"); echo "$o" | jq '{id,status,customer,error:.name,details:.details}'
    id=$(jq -r '.id // empty' <<<"$o"); [ -n "$id" ] || die "setup token not created"
    save setup_1b "$id"
    echo; echo "Open this link, approve as the US sandbox PERSONAL account, then run: $0 1b-token"
    approve_link <<<"$o" ;;
  1b-token)
    id=$(get setup_1b); [ -n "$id" ] || die "run 1b-setup first"
    o=$(call POST /v3/vault/payment-tokens "$(jq -n --arg i "$id" '{payment_source:{token:{id:$i,type:"SETUP_TOKEN"}}}')")
    echo "$o" | jq '{id, customer, error:.name, details:.details}'
    vid=$(jq -r '.id // empty' <<<"$o"); [ -n "$vid" ] || die "no payment token"
    save vault_1b "$vid"; echo "PASS: payment token $vid. Now run: $0 charge 1b" ;;

  # The real test. Run it as a separate command, ideally minutes or hours after the vault step.
  charge)
    vid=$(get "vault_${2:-1a}"); [ -n "$vid" ] || die "no vault id for ${2:-1a}"
    report_charge "$(charge "$vid" "${3:-18.00}")" "charge to the app owner" ;;
  charge-payee)
    [ -n "${PAYEE_EMAIL:-}" ] || die "set PAYEE_EMAIL to a second US sandbox business account"
    vid=$(get "vault_${2:-1a}"); [ -n "$vid" ] || die "no vault id for ${2:-1a}"
    report_charge "$(charge "$vid" "${3:-18.00}" "$PAYEE_EMAIL")" "charge to a different merchant ($PAYEE_EMAIL)" ;;

  # Tier 2: no vault at all. The buyer approves one authorization for the budget,
  # and purchases are captured against it later without them.
  2-create)
    body=$(jq -n --argjson c "$ctx" '{intent:"AUTHORIZE", purchase_units:[{amount:{currency_code:"USD",value:"60.00"}, description:"Monthly agent budget"}], payment_source:{paypal:{experience_context:$c}}}')
    o=$(call POST /v2/checkout/orders "$body"); echo "$o" | jq '{id,status,error:.name}'
    id=$(jq -r '.id // empty' <<<"$o"); [ -n "$id" ] || die "order not created"
    save order_2 "$id"
    echo; echo "Approve as the PERSONAL account, then run: $0 2-authorize"
    approve_link <<<"$o" ;;
  2-authorize)
    id=$(get order_2); [ -n "$id" ] || die "run 2-create first"
    o=$(call POST "/v2/checkout/orders/$id/authorize" '{}')
    aid=$(jq -r '.purchase_units[0].payments.authorizations[0].id // empty' <<<"$o")
    echo "$o" | jq '{status, auth:.purchase_units[0].payments.authorizations[0] | {id,status,amount,expiration_time}, error:.name, details:.details}'
    [ -n "$aid" ] || die "no authorization"
    save auth_2 "$aid"; echo "PASS: authorized. Now run: $0 2-capture 18.00, then $0 2-capture 25.00" ;;
  2-capture)
    aid=$(get auth_2); [ -n "$aid" ] || die "run 2-authorize first"
    o=$(call POST "/v2/payments/authorizations/$aid/capture" "$(jq -n --arg a "${2:-18.00}" '{amount:{currency_code:"USD",value:$a}, final_capture:false}')")
    echo "$o" | jq '{id,status,amount,error:.name,details:.details}'
    [ "$(jq -r '.status // empty' <<<"$o")" = "COMPLETED" ] && echo "PASS: partial capture of ${2:-18.00} with no buyer present" || echo "FAIL: partial capture" ;;

  # Marketplace route: the saved wallet pays Behest, then Behest pays the seller with Payouts.
  payout)
    [ -n "${PAYEE_EMAIL:-}" ] || die "set PAYEE_EMAIL to a second US sandbox business account"
    body=$(jq -n --arg e "$PAYEE_EMAIL" --arg a "${2:-18.00}" --arg b "proof-$(uuidgen)" '{sender_batch_header:{sender_batch_id:$b, email_subject:"Agent order payout"}, items:[{recipient_type:"EMAIL", amount:{value:$a, currency:"USD"}, receiver:$e, note:"Agent order payout", sender_item_id:"order-1"}]}')
    o=$(call POST /v1/payments/payouts "$body"); echo "$o" | jq '{batch:.batch_header.payout_batch_id, status:.batch_header.batch_status, error:.name, details:.details}'
    b=$(jq -r '.batch_header.payout_batch_id // empty' <<<"$o"); [ -n "$b" ] || die "payout not accepted"
    save payout_batch "$b"; echo "Accepted. Sandbox payouts settle in a few minutes. Check with: $0 payout-status" ;;
  payout-status)
    b=$(get payout_batch); [ -n "$b" ] || die "run payout first"
    call GET "/v1/payments/payouts/$b" | jq '{batch_status:.batch_header.batch_status, item_status:.items[0].transaction_status, errors:.items[0].errors}' ;;

  state) cat "$STATE" ;;
  *) sed -n '2,6p' "$0"; echo; echo "Order: 1a-create, 1a-capture, charge 1a, charge-payee 1a, 1b-setup, 1b-token, charge 1b, 2-create, 2-authorize, 2-capture 18.00, 2-capture 25.00, payout 18.00, payout-status" ;;
esac
