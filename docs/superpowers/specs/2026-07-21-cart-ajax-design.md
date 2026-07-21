# Cart page — full AJAX (no page reloads)

Date: 2026-07-21
Status: approved, ready for implementation plan

## Problem

Every write on `/cart` ends in `window.location.reload()` — 14 call sites in
`web/public/js/ui/cart.js` pass `{ reload: true }` to `handleEnvelope`, plus two
more reloads in `web/public/js/ui/checkout-popups.js`.

On a phone each of those is a full round trip: HTML, CSS, JS, images, plus a
scroll jump back to the top. Changing a quantity or applying a coupon feels like
navigating, not like using an app.

The api already returns the complete cart view (`Cart.publicCartView`) in every
write response, so the data needed to update the screen is already on the wire —
only the rendering is missing.

## Approach

**Server-rendered HTML fragments, swapped client-side.**

The cart markup stays in EJS and is rendered by the same templates for both the
first page load and every later update. The alternative — rebuilding the markup
in JS from the JSON — was rejected: it would put the cart's markup in two places
(EJS and JS), and keeping two copies in step is exactly the kind of drift that
has already caused bugs on this page.

## Architecture

### Template split

`web/views/cart/index.ejs` (604 lines) becomes a shell that includes two new
partials. The markup is moved verbatim — no redesign in this change.

```
views/cart/index.ejs              shell + 2 includes
views/partials/cart/main.ejs      left  column: Delivery/Pickup, Cooking, Payment
views/partials/cart/side.ejs      right column: Basket, Promo, Voucher, Loyalty,
                                                Charity, Order total
views/partials/checkout-popups.ejs   unchanged (already a partial)
```

Because the page render and the fragment render include the same files, the two
cannot drift apart.

### Request flow

```
[click]
  → POST /cart/<action>                    (web layer, as today)
  → api call                               (unchanged)
  → on 200: rebuild the page locals, render main + side to strings
  → { status: 200, msg, data: { cart, html: { main, side } } }
  → JS: swap the two regions, restore UI state
```

One round trip per action. No second fetch.

### New endpoint

`GET /cart/fragment` → `{ main, side }` for resyncing the cart at any time
(returning to a backgrounded tab on mobile, recovering from a failed swap).

### Region rules

| Region | When it swaps |
|---|---|
| `main` | every successful action |
| `side` | every successful action |
| popups | only when **no popup is open** — tearing down an open popup would destroy Stripe Elements and in-progress typing |

Popups live outside both columns in the DOM, so a normal swap never touches
Stripe. This rule only covers the case where popup *contents* need refreshing.

### State preserved across a swap

- Scroll position — nothing reloads, so it is preserved for free
- Basket summary disclosure open/closed
- Focused element (restored by `data-action` / field name)

## Validation

### Client-side pre-checks

Run before the request; a failure shows a toast and sends nothing.

| Action | Rule | Message |
|---|---|---|
| Coupon / voucher apply | code non-empty | "Enter a code." |
| Loyalty use | `0 < amount <= available` | "You can use up to £X on this order." |
| Charity custom | `amount > 0` | "Enter a charity amount." |
| Cooking note | trim, cap at 250 | (silent cap; counter already shown) |
| Qty decrease at 1 | confirm removal | "Remove this item?" |
| Set address / card | a selection exists | "Pick an address." / "Choose a card." |
| Checkout | payment chosen, cart not empty | "Choose how you'd like to pay." |

These live in one `validators` map keyed by action, not scattered across call
sites.

### Server-side

Unchanged. The api's Joi schemas and business rules (coupon eligibility, reward
balance, store hours, branch conflict) stay exactly as they are — their messages
now surface in a toast instead of after a reload.

## Error handling

| Response | Behaviour |
|---|---|
| 200 | swap regions, success toast |
| 401 | redirect to `/signin?next=/cart`, except the charity action, which shows "Please sign in to change your charity contribution." |
| 409 `branch.conflict` | existing conflict popup; no swap |
| 422 / other | error toast; **UI left untouched** |

### Concurrency guards

Two failure modes that only appear on slow mobile connections, both currently
unguarded:

1. **Double submit** — the button is disabled for the duration of the request
   and a per-action in-flight lock rejects a second call. Without this, two
   coupon applies can race and the later response can win with stale data.
2. **Stale response** — each request carries a sequence number; a response whose
   sequence is older than the newest issued request is discarded. Without this,
   a slow earlier response can overwrite the result of a newer action.

## Files

New:
- `web/views/partials/cart/main.ejs`
- `web/views/partials/cart/side.ejs`
- `web/public/js/ui/cart-render.js` — region swap, state restore, in-flight and
  stale guards

Changed:
- `web/views/cart/index.ejs` — reduced to a shell
- `web/Controllers/CartController.js` — extract the locals builder so the page
  render and the fragment render share it; render fragments on a 200; add
  `GET /cart/fragment`
- `web/public/js/ui/cart.js` — drop the 14 `{ reload: true }` flags, add the
  validators map, make `handleEnvelope` swap regions
- `web/public/js/ui/checkout-popups.js` — replace its two reloads with a swap

Untouched:
- `api/` — already returns everything needed

## Testing

Verified during implementation:

| Check | Method |
|---|---|
| Partials compile | `ejs.compile()` on all three templates |
| Refactor is behaviour-neutral | render `/cart` before and after the split, diff the HTML — must be byte-identical |
| Fragment endpoint | request it, assert `main` and `side` are both non-empty |
| Validators | unit tests on the pure functions (empty code, over-limit reward, qty 0) |
| Stale guard | issue two overlapping calls, assert the older response is discarded |

Left to the user (cannot be verified here): the 14 actions in a real browser,
the Stripe card popup, and the feel on a phone.

## Risks

Splitting a 604-line template risks dropping a local (`sym`, `selected`,
`promoList`, …) when passing it into a partial, which would render that section
blank. The byte-identical HTML diff above is specifically there to catch it.
