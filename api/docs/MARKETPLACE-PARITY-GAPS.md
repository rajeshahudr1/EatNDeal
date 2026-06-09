# Marketplace ⇄ Legacy POS — Feature Parity Gap List

Consolidated from a 4-domain deep audit (product/menu, cart/pricing, order/fulfilment,
account/loyalty) of the legacy Yii2 `eatndealclean` vs the Node marketplace.
Status reflects what the marketplace ACTUALLY has as of this audit (loyalty earn +
redeem + availability were built recently; some audit agents saw a stale snapshot).

Legend: ❌ missing · 🟡 partial · ✅ done

---

## ✅ Already done (don't re-build)
- Availability: per-day/per-service open-closed + hours + close-precedence (permanent/closed-for/closed-until/holiday/per-service) + order gating + pre-order 15-min slots + delivery/pickup ETA (base + value/volume advance). [[reference-store-hours-availability]]
- Loyalty EARN: cash_king (cash-only), product_streak, stamp `cashback`, product_cashback, special_offer — all master-gated (loyalty_rules.status). [[project-loyalty-phase1]]
- Loyalty REDEEM: consumeForRedeem (FIFO, wired in orderPlace) + maxRedeemable + balance + wallet cards.
- Reviews: star + text + food photo (review_rating). Addresses: full CRUD (labels, default, lat/lng, instructions). Profile: about-you + gender/dob + avatar. Auth: OTP + social. Payment cards (Stripe), card surcharge, bag charge, delivery zones, charity, auto-discount, coupon/voucher (basic, mutually exclusive), serve-type switch, modifiers (incl. nested), favourites.

---

## 🔴 HIGH — customer-facing / revenue blockers

| # | Gap | Status | Legacy table/evidence |
|---|-----|--------|----------------------|
| 1 | **Meal deals / combos / set menus** | ❌ | product_meal_deals_group(_options) |
| 2 | **Required-modifier validation** (cart accepts incomplete option groups) | 🟡 | modifier_group.min_limit/max_limit |
| 3 | **Product schedule** (breakfast-only / weekend-only items) | ❌ | product_schedule, category_schedule |
| 4 | **Order notifications** SMS/email/push on status change | ❌ | order_notification_details, epos_customer_notifications |
| 5 | **Customer cancel + refund** (full/partial) + re-credit loyalty/voucher on cancel | ❌ (reverseForOrder built, unwired) | order_cancel, order_refund_details, customer_used_rewards |
| 6 | **Referral system** (code generate/share, referrer+referee cashback on 1st order) | ❌ | customer.referral_code/referred_by, loyalty_referral_cashback_rule |
| 7 | **Tips / driver tip** at checkout (quick-tip tiers) | ❌ | quick_tips_configurator |
| 8 | **Invoice / receipt** (PDF + email) | ❌ | orders.invoice_id |
| 9 | **Driver assignment + delivery tracking** (+ 3rd-party delivery) | ❌ | driver, order_delivery_details, delivery_platform |
| 10 | **Live stock / 86'ing** (only manual sold-out flag now) | 🟡 | product_store_inventory, product_sold_out |

---

## 🟡 MEDIUM — feature parity

| Gap | Status | Legacy |
|-----|--------|--------|
| **BOGOF** (buy-X-get-Y, product/category) | ❌ | loyalty_bogof_rule/buy |
| **Product / category discounts** (flat/%) | ❌ | products.discount_type/value |
| **First-order coupons + per-customer usage limits** | ❌ | coupon.coupon_type, coupon_required_items |
| **Flat service charge** (online/offline, ≠ card surcharge) | ❌ | branch.service_charge_*_order |
| **Membership tiers** (free delivery by tier, tier cashback) | ❌ | loyalty_membership_tier |
| **Event cashback** (birthday/anniversary) | ❌ | loyalty_event_cashback_rule |
| **Smart campaign** (win-back / top-spender / most-referrals) | ❌ | loyalty_smart_campaign |
| **Review cashback** (screenshot + admin approve/reject) | ❌ | customer_review, loyalty_review_cashback_rule |
| **Reorder / order-again** | ❌ | (copy cart from order) |
| **Dine-in / table service** (table, merge, course) | ❌ | orders.table_id/merge_table_id |
| **Price by serve-type** (delivery vs collection price) | ❌ | product_price_list.served_type |
| **Allergens / dietary tags / ingredients** | 🟡 (veg only) | product_allergy_details, allergy, product_tag |
| **VAT / tax breakdown** (tax=0 everywhere now) | ❌ | cart.tax, product_tax |
| **Third-party commission %** | ❌ | orders.third_party_discount |
| **Gift cards / vouchers redemption** | ❌ | customer_voucher |
| **Wallet / store credit** | ❌ | — |
| **Min/max qty per product** | ❌ | products.min_qty_for_order |
| **Composite / build-your-own** (pizza/salad builder) | ❌ | product_composite_inventory(_details) |
| **Product variants** (size as first-class, not modifier) | ❌ | product_variants_group(_options) |
| **Loyalty extras**: reverseForOrder wiring to cancel · reward expiry notification · collection_cashback | 🟡/❌ | customer_rewards.notify_date, company_loyalty.collection_cashback |
| **Auto-reject timeout** (merchant must accept in X min) | ❌ | — |
| **"Running late" / live ETA update** | 🟡 | orders.delivery_estimated_time |
| **Order history filters** (status/date) + post-delivery review prompt | 🟡 | orders, review_rating |
| **Password login + email verify** (OTP-only now) | ❌ | customer.password/verify_email_token |
| **Marketing opt-out enforcement** (prefs stored, not enforced) | 🟡 | customer_profile.marketing_preferences |
| **Payment retry / failed-capture reconciliation** | 🟡 | orders_payments |

---

## 🟢 LOW — polish / config / edge

Category sort order (category_sorting_order) · product display order (product_display_order) ·
category-level offer highlight · product gallery carousel (multi-image fetched, 1 shown) ·
product-level tax · kitchen-notes prompt on product detail (works in cart) · service products ·
barcode/SKU lookup · age-restricted items · KOT / kitchen print · thermal label print ·
order complaint reporting (epos_complaints) · order status-history audit log · live driver map ·
admin review reply (field exists) · review reporting/moderation · 2FA · abandoned-cart re-engagement ·
surge/busy pricing · packaging surcharge · preferred/default saved card.

---

## Notes
- Marketplace is **global-customer** (company_id NULL) but loyalty stays **per-company** (customer_rewards.company_id) = per-restaurant cards. Intentional.
- Highest implementation cost outside loyalty = the **notification engine** (queue + SMS/email/push provider + opt-in rules) — it underpins gaps #4, expiry notify, birthday, order-status.
- Several "missing" loyalty items (referral/event/smart/tiers/review/bogof) are **master-gated OFF** for EatNDeal in loyalty_rules — the earn engine pattern is established, so adding each is incremental.
