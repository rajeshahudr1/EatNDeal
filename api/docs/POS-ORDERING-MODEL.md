# EatNDeal POS / Ordering data model (wtw_eatndeal)

Reverse-engineered from the live DB so the new marketplace API can read the
**same** option model the legacy Yii2 POS uses and place orders into the same
tables. Row counts are from the live DB at time of writing.

## 1. Option SOURCE model — what drives the "choose options" UI (per product)

A product can expose up to FOUR kinds of selectable groups:

### A. Variants — sizes / portions (attached directly to the product)
- `product_variants_group` (6) — one group per product, e.g. "Select size".
  - `product_id` → products.id
  - `group_name`, `group_type`
  - `min_selection`, `max_selection` — selection limits (max 1 ⇒ single/radio)
  - `checkbox_type` — UI hint (radio vs checkbox)
  - `enable_quantity` — per-option qty picker
  - `dependent_group` / `dependent_enable` / `dependent_items` — conditional groups
  - `inclusive_on_off` / `inclusive_value` — included free amount
- `product_variants_group_options` (16)
  - `group_id` → product_variants_group.id
  - `option_name`, `price_tax_included` / `price_tax_excluded`, `is_default`
  - `quantity`, `option_quantity`, `image`, `color`, `ordering`
- `product_variants_topping_options` (4) — toppings available **within** a variant group
  - `product_id`, `variants_group_id` → product_variants_group.id, `topping_id` → product_topping_options.id, `price_tax_*`

### B. Modifiers — sauces / add-ons (reusable, company-level, linked to products)
- `modifier_group` (283) — company-level reusable group, e.g. "Choose your sauce".
  - `group_name`, `modifier_type`, `company_id`
  - `is_quantity_picker` — per-option qty
  - `has_modifier_limit` + `min_limit` + `max_limit` — selection limits (max 1 ⇒ single)
- `modifier_group_options` (1591)
  - `modifier_group_id` → modifier_group.id
  - `option_name`, `price_tax_include` / `price_tax_excluded`, `is_default`, `max_quantity`, `sequence`
- `modifier_group_products` (431) — **junction**: assigns a group to a product
  - `modifier_group_id` → modifier_group.id, `product_id` → products.id, `sequence`

### C. Meal deals — combos (each option is itself a product)
- `product_meal_deals_group` (4)
  - `product_id` → products.id, `group_name`, `min_selection`, `max_selection`, `enable_price`, `price_tax_*`
- `product_meal_deals_group_options` (11)
  - `group_id` → product_meal_deals_group.id
  - `assign_product_id` → products.id (the chosen item is another product), `price_tax_*`

### D. Toppings master
- `product_topping_options` (0) — `id`, `option_name`. Referenced by
  `product_variants_topping_options.topping_id` and the topping detail tables.

**Selection rules (required / single / multi):**
- required ⇔ `min_selection`/`min_limit` ≥ 1.
- single (radio) ⇔ `max_selection`/`max_limit` == 1 (or `checkbox_type == 'radio'`).
- multi (checkbox) ⇔ max == 0 (unlimited) or > 1.
- per-option quantity ⇔ `enable_quantity` / `is_quantity_picker`.

**Pricing:** option price = `price_tax_included` (customer-facing) → fallback
`price_tax_excluded` / `price_tax_include`. Line total = (product base price +
Σ selected option prices) × qty.

## 2. CART — the in-progress basket (mirror of the order)

```
cart (927)                         one basket (customer / branch / status)
 └─ cart_details (1798)            one row per PRODUCT line in the basket
      │  cart_id → cart.id
      │  product_id, product_name, product_price, product_qty, product_net_price,
      │  remark (item note), category_id, discount_type/value, is_free_item
      ├─ cart_sub_details (815)    selected MODIFIER / VARIANT options for the line
      │     cart_details_id → cart_details.id
      │     modifier_id, modifier_option_id, variant_qty, variant_price,
      │     variant_type (1 = modifier, 2 = variant), variant_name
      ├─ cart_meal_details (36)    selected MEAL-DEAL options for the line
      │     cart_details_id → cart_details.id
      │     meal_group_id → product_meal_deals_group.id,
      │     meal_group_product_id, meal_qty, meal_price, meal_group_price
      └─ cart_topping (0)          selected toppings for the line
 └─ cart_delivery_details (156)    delivery address / fee for the basket
 └─ cart_payment (858)             payment rows
```

## 3. ORDER — the placed order (cart is copied into these on checkout)

```
orders (678)                        the order header (totals, customer, branch, status)
 └─ orders_items (1302)            one row per PRODUCT line
      │  order_id → orders.id
      │  product_id, product_name, product_price, product_net_price, product_qty,
      │  sub_total, discount, tax_value, remark (item note),
      │  bogo_buy_qty/bogo_get_qty, is_free_item
      ├─ orders_items_sub (585)    selected MODIFIER / VARIANT options
      │     orders_items_id → orders_items.id
      │     modifier_id, modifier_option_id, modifier_name, modifier_option_name,
      │     variant_qty, type (1 = modifier, 2 = variant), amount (option price)
      ├─ orders_items_topping_detail (0)  selected toppings
      │     orders_items_id → orders_items.id
      │     variants_group_id, topping_option_id, option_name
      └─ order_set_item_detail (24)  selected MEAL-DEAL / set options
            orders_items_id → orders_items.id
            group_id → product_meal_deals_group.id, group_name,
            group_product_id, group_option_name, qty
 └─ orders_payments (657)          payment rows
 └─ order_delivery_details (141)   delivery address / fee
```

## 4. Discounts / coupons (line + order level)
- `discounts` (14) + `discount_days` / `discount_postcode` — restaurant discounts.
- `coupons` (17) + `coupon_days` / `coupon_required_items` /
  `coupon_required_item_modifiers` / `coupon_free_items` — promo codes.

## 5. How a customer selection maps SOURCE → ORDER

| User picks            | Read from (source)                              | Stored on order in                         |
|-----------------------|-------------------------------------------------|--------------------------------------------|
| Size (e.g. Large)     | product_variants_group(_options)                | orders_items_sub (type=2, amount)          |
| Sauce / add-on        | modifier_group(_options) via modifier_group_products | orders_items_sub (type=1, amount)     |
| Topping               | product_variants_topping_options / product_topping_options | orders_items_topping_detail          |
| Meal-deal item        | product_meal_deals_group(_options)              | order_set_item_detail (group_product_id)   |
| Quantity / note       | —                                               | orders_items.product_qty / .remark         |

## 6. New marketplace API status
- `GET /api/v1/marketplace/product?id=` already returns **variant groups** +
  **modifier groups** unified as `groups[]` (single/multi, min/max, options+price).
  TODO to fully match the rich product page: also surface **meal-deal groups**
  and option subtitles, and (separately) a **cart** API that writes
  cart / cart_details / cart_sub_details / cart_meal_details, then a checkout
  that copies them into orders / orders_items / orders_items_sub / etc.
