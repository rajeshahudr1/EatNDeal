# Temp-save a new card for one order

Date: 2026-07-22
Status: approved (approach + lifecycle + last4 UI), ready to implement

## Problem

The cart's "New card" path collects the card in a Stripe **Checkout Session
Payment Element** and only confirms it at Place Order. The card data lives in
the mounted element. A cart edit (go back, add an item) swaps the cart regions
and `teardownPaymentElementForSwap()` destroys the element — so the card data is
gone, but the "New card" selection is restored from sessionStorage. Placing the
order then re-mounts an EMPTY element and Stripe rejects it: **"Your card number
is incomplete."**

## Approved solution

When the customer enters a new card, turn it into a **real, temporary saved
PaymentMethod** via a SetupIntent (the exact flow account.js already uses to add
a card), so it survives swaps as a PM id rather than element state. Charge the
order through the existing saved-card route. Detach (remove) the temporary PM
when the order is **placed** or the cart is **cleared**, so it never becomes a
permanent saved card.

Decisions:
- Show the card's **last4** ("Visa •••• 4242") on the tile once entered.
- Detach on **order place OR cart clear**.
- Track the temp PM in the **web session** — no DB schema change.

## Existing pieces to reuse (all proven)

- `POST /payment-method/setup` → SetupIntent client_secret (api PaymentMethodController.setupIntent).
- Client `stripe.confirmCardSetup(clientSecret, { payment_method: { card } })` — account.js:878.
- `POST /cart/pay-saved-card { payment_method_id }` → clones to the connected account + charges (api PaymentController.paySavedCard).
- `POST /payment-method/delete { payment_method_id }` → detach (api PaymentMethodController.remove → payments.detachPaymentMethod).
- `GET /payment-methods` → list saved cards.

## Design

### Client — new-card popup (checkout-popups.js + cart.js)

Replace the Checkout-Session Payment Element in the CART's new-card popup with
the SetupIntent Card Element flow:

1. On opening the new-card form: `POST /payment-method/setup` → client_secret;
   mount a Card Element (reuse account.js's ensureCardElement pattern, or the
   Payment Element in setup mode).
2. "Use this method" → `confirmCardSetup` → returns the new PaymentMethod
   (id + card.last4 + card.brand).
3. Tell the server this PM is the cart's TEMP card:
   `POST /cart/use-temp-card { payment_method_id }`.
   The web layer stores `req.session.tempPaymentMethodId = pmId` and returns the
   card's brand/last4 (looked up via the api).
4. The tile now shows a **saved-card** selection (`card:<pmId>`, label
   "Visa •••• 4242") — identical to a real saved card, so it survives swaps and
   the existing place-order saved-card route charges it unchanged.

Because the tile is now `card:<pmId>` (a saved-card mode), `restorePayMode`,
teardown-on-swap and the "incomplete" failure no longer apply — there is no
mounted element to lose.

### Web layer (web/Controllers/CartController.js + PaymentController.js)

- `POST /cart/use-temp-card` → proxies nothing; records `session.tempPaymentMethodId`, then fetches the PM's brand/last4 from the api (`GET /payment-methods`) to return for the label. (Or the api setup-confirm returns it — simpler to read from the PM list.)
- **Detach on place**: after a successful `/order/place` (both card + cash tails), if `session.tempPaymentMethodId` is set, call `POST /api/v1/customer/payment-method/delete` for it, then clear the session key.
- **Detach on clear**: after a successful `/cart/clear`, same detach + clear.
- Guard: detach is best-effort — a failed detach must not fail the order or the clear.

### Temp vs permanent saved cards

- The temp PM IS attached to the customer, so it would appear in `GET
  /payment-methods`. Filter it OUT of the saved-cards list shown in the cart's
  payment popup while it is the session's temp card, OR mark it with Stripe
  metadata `{ eatndeal_temp: '1' }` (set server-side right after confirm) and
  exclude metadata-temp PMs from the saved list. Decide during implementation;
  metadata is the more robust filter.

## Files

- `web/public/js/ui/checkout-popups.js` — new-card popup → SetupIntent + confirmCardSetup + select as saved card.
- `web/public/js/ui/cart.js` — Stripe Card Element mount for setup mode (reuse/adapt account.js), drop the Checkout-Session path for the cart new-card.
- `web/Controllers/CartController.js` — `useTempCard` handler; detach on place + clear; session tracking.
- `web/index.js` — route for `/cart/use-temp-card`.
- `api/Controllers/Customer/PaymentMethodController.js` — set `{ eatndeal_temp:'1' }` metadata after a cart-setup confirm (new small endpoint or a flag), and exclude temp PMs from `list`.
- Possibly `api/Helpers/payments.js` — a helper to set PM metadata (updatePaymentMethod).

## Testing

- Server helpers load; routes registered.
- Lifecycle unit-checks where possible (session set/clear, detach called).
- **Browser with Stripe test cards is REQUIRED** (4242 4242 4242 4242, and a
  3-D Secure card) — headless testing cannot confirm the confirmCardSetup →
  charge → detach round trip. This must be run by the user.

## Risks

This is charge/detach code. A detach that runs too early (before the charge)
would break payment; the order is: charge (place) → THEN detach. A missed
detach leaves a temp card attached (recoverable — it just lingers as a saved
card; a sweep could clean metadata-temp PMs older than N hours).
