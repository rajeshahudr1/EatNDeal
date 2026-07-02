'use strict';

/*
 * Controllers/Customer/ChatbotController.js
 *
 * What:  The marketplace help chatbot. One endpoint — POST /customer/chatbot/ask
 *        { message, customer_id?, lat?, lng?, postcode? } — that rule-matches the
 *        question to an INTENT and answers it (in English), mixing FIXED
 *        marketplace knowledge with the customer's REAL data:
 *
 *          Personalised (need a signed-in customer):
 *            • order / "where is my order" / "last order" → last order + live status + items + ETA
 *            • orders / history                          → recent orders summary
 *            • loyalty / points / cashback / wallet       → reward balance (+ per-restaurant)
 *            • offers / deals                             → active offers + new-vs-old eligibility
 *            • referral code                             → the customer's real referral code
 *            • reorder / order again                     → last order + a one-tap Reorder action
 *
 *          Restaurant-specific (resolve a restaurant by NAME in the message):
 *            • "is <name> open" / "<name> delivery fee" → open/closed + hours + delivery fee
 *            • "offers at <name>"                        → that restaurant's live offers
 *
 *          Discover (need the customer's location, not a login):
 *            • restaurants near me                        → how many + how many open + top rated
 *            • cuisines / categories near me              → what food types are available nearby
 *
 *          Fixed marketplace FAQ (no data needed):
 *            • how to order / pay / delivery / pickup / schedule / coupon / cancel /
 *              refund / allergies / cashback / contact / partner / address / refer
 *
 *          Meta:
 *            • help / menu / "what can you do"            → categorised capability list + chips
 *            • greeting / fallback                        → intro + quick-reply chips
 *
 * Why:   "one click answer" for anything marketplace-related. Personalised
 *        intents need a signed-in customer; guests get a sign-in nudge + the FAQ.
 *        Restaurant/near-me need name/location. (Some intent regexes still match
 *        common Hinglish phrasings so those inputs route correctly, but every
 *        reply is in English.)
 * Type:  READ (no writes). The reorder ACTION is executed by the web frontend
 *        hitting the existing /order/:id/reorder route — this endpoint only
 *        returns the order + an `action` descriptor.
 * Used:  api/Routes/index.js — POST /customer/chatbot/ask.
 */

const H           = require('../../Helpers/helper');
const customers   = require('../../Helpers/customerLookup');
const OrderStatus = require('../../Helpers/orderStatus');
const Loyalty     = require('../../Helpers/loyalty');
const Offers      = require('../../Helpers/offers');
const distance    = require('../../Helpers/distance');
const M           = require('../../Helpers/marketplace');
const StoreHours  = require('../../Helpers/storeHours');
const brand       = require('../../brand.config');
const { db }      = require('../../config/db');

const sym = () => (process.env.CURRENCY_SYMBOL || (brand && brand.currencySymbol) || '£');
const SKIP_STATUS = ['1', '2', '9'];   // refund / cancelled / void — not a "real" order
const NEAR_KM     = 10;                 // "near you" radius; widened to 25 if nothing inside 10
const NEAR_KM_MAX = 25;

// Branch columns StoreHours.availabilityForBranch + card assembly need. One
// list so the nearby query and the single-restaurant query stay in sync.
const BRANCH_COLS = [
    'c.id as company_id', 'c.business_name', 'c.business_category',
    'b.id as branch_id',
    'b.direction_latitude as branch_lat', 'b.direction_longitude as branch_lng',
    'b.start_time', 'b.end_time', 'b.open_as_usual', 'b.closed_until',
    'b.closed', 'b.closed_reopen_date', 'b.clossed_repoen_time', 'b.clossed_text',
    'b.closed_for', 'b.closed_for_time',
    'b.show_delivery_option', 'b.show_delivery_option_tab', 'b.delivery_closed_util_date',
    'b.show_pickup_option', 'b.show_pickup_option_tab', 'b.pickup_closed_util_date',
];

const needLogin = () => 'Please sign in first, then I can check that for you.';

// Default quick-reply chips shown with most answers.
const CHIPS = ['Where is my order?', 'Restaurants near me', 'Offers for me', 'My referral code', 'What can you do?'];

// ── Fixed marketplace FAQ (keyword → answer). First keyword hit wins. ──
// contact / partner pull real values from brand.config (no hardcoded email).
// A few Hinglish keywords are kept so those inputs route correctly (the
// answer is still English).
const FAQ = [
    { kw: ['what is', 'about eatndeal', 'about', 'who are you', 'kya hai'], a: brand.name + ' is a food-delivery marketplace — browse nearby restaurants, order for delivery or pickup, earn cashback, and track your order live. Ask "what can you do?" to see everything.' },
    { kw: ['how do i order', 'how to order', 'place an order', 'order kaise', 'order kese', 'kaha se order', 'kahan se order', 'order kare', 'order karna'], a: 'Set your delivery location, open a restaurant, add items to your basket, then Checkout — pick delivery or pickup, choose a payment method and place the order. You can track it live afterwards.' },
    { kw: ['how do i pay', 'payment method', 'how to pay', 'pay kaise'], a: 'You can pay by card (secure online) or cash on delivery where the restaurant allows it. Any cashback in your wallet can also be redeemed at checkout.' },
    { kw: ['delivery fee', 'delivery charge', 'delivery cost'], a: 'Delivery fees are set per restaurant and shown before you pay — some offer free delivery over a minimum order. Pickup is always free. Tell me a restaurant name to see its exact fee.' },
    { kw: ['pickup', 'collection', 'take away', 'takeaway', 'self pickup'], a: 'Prefer to collect? Choose "Pickup" on the restaurant page — no delivery fee, and you\'ll get a ready time. You can also schedule a pickup slot for later.' },
    { kw: ['coupon', 'voucher', 'promo code', 'discount code', 'apply code'], a: 'Add items to your basket, go to Checkout, and enter your coupon or voucher in the "Apply code" box. Valid codes apply instantly; vouchers and coupons can\'t be combined on the same order.' },
    { kw: ['cancel', 'cancelling', 'cancel order'], a: 'You can cancel from Orders → the order, shortly after placing it (before the restaurant starts preparing). After that, use "Help with this order" and our team will assist.' },
    { kw: ['refund', 'money back'], a: 'For an issue with a specific order (missing items, late, refund), open Orders → the order → "Help with this order", and our team will sort it out.' },
    { kw: ['schedule', 'later', 'pre-order', 'preorder', 'advance order'], a: 'Yes — on the restaurant page choose "Schedule" and pick a time slot within the restaurant\'s opening hours (for delivery or pickup).' },
    { kw: ['allerg'], a: 'Add allergies to your profile and check each dish\'s allergen info. For anything critical, add a note for the restaurant at checkout.' },
    { kw: ['cashback', 'how cashback', 'earn cashback', 'loyalty work', 'how loyalty'], a: 'You earn cashback on eligible orders (a % back into that restaurant\'s wallet). Redeem it at checkout on your next order there. Ask "my loyalty points" to see your balance.' },
    { kw: ['change address', 'update address', 'add address', 'edit address', 'my address'], a: 'Manage your saved addresses from Account → Addresses (or the location selector at the top). Add home/work, set a default, and pick one at checkout.' },
    { kw: ['profile', 'change name', 'update profile', 'my account', 'edit account'], a: 'Update your name, contact and preferences from Account → Profile. Your email is fixed once verified, for security.' },
    { kw: ['refer', 'referral', 'invite', 'invite friend', 'refer a friend'], a: 'Share your referral code from Account — when a friend signs up and orders with it, you both benefit. Ask "my referral code" and I\'ll show yours.' },
    { kw: ['partner', 'list my restaurant', 'add my restaurant', 'become a partner', 'register restaurant', 'join as restaurant'], a: 'Want to list your restaurant on ' + brand.name + '? Visit ' + (brand.websiteUrl ? brand.websiteUrl + '/partner' : 'our Partner page') + ' or email ' + (brand.supportEmail || 'our team') + ' and we\'ll get you set up.' },
    { kw: ['contact', 'support', 'help line', 'helpline', 'reach you', 'talk to', 'customer care', 'email you', 'phone number'], a: contactAnswer() },
];

// Contact answer built from brand.config (email / phone / website).
function contactAnswer() {
    const bits = [];
    if (brand.supportEmail) { bits.push('email ' + brand.supportEmail); }
    if (brand.supportPhone) { bits.push('call ' + brand.supportPhone); }
    let a = 'You can reach us';
    a += bits.length ? ' — ' + bits.join(' or ') + '.' : ' from the Contact page.';
    if (brand.websiteUrl) { a += ' More at ' + brand.websiteUrl + '/contact.'; }
    a += ' For a specific order, open Orders → the order → "Help with this order".';
    return a;
}

// Marketplace-customer guard → the numeric id, or null for a guest.
async function resolveCustomer(customerId) {
    if (!customerId) { return null; }
    const { error } = await customers.loadMarketplaceCustomer(customerId);
    return error ? null : customerId;
}

function ok(res, reply, chips, action) {
    const d = { reply, chips: chips || CHIPS };
    if (action) { d.action = action; }
    return H.successResponse(res, d);
}

// ── Meta: what can you do — categorised capability menu ────────────────
function answerHelp() {
    return 'I can help with lots of things 👇\n' +
        '**📦 My orders** — track my order, order history, reorder\n' +
        '**🎁 Rewards & offers** — cashback balance, offers for me, my referral code\n' +
        '**🍽️ Discover** — restaurants near me, cuisines near me, "is <restaurant> open?"\n' +
        '**❓ How it works** — ordering, payment, delivery, pickup, scheduling, coupons, cancelling\n' +
        '**👤 Account & support** — change address, refer a friend, contact us, become a partner\n' +
        'Just tap a chip or type your question.';
}

// ── Intent: last order + live status ──────────────────────────────────
async function answerOrder(customerId) {
    const o = await db('orders as o')
        .leftJoin('company as c', 'c.id', 'o.company_id')
        .where('o.user_id', customerId).andWhere('o.is_marketplace', 1)
        .orderBy('o.created_at', 'desc')
        .first('o.id', 'o.order_number', 'o.order_status', 'o.serve_type', 'o.grand_total',
               'o.created_at', 'o.updated_at', 'c.business_name');
    if (!o) { return "You don't have any orders yet. Browse restaurants and place your first order — I'll track it here."; }

    const meta = OrderStatus.getStatusMeta(o.order_status, o.serve_type);
    const items = await db('orders_items').where('order_id', o.id).select('product_name', 'product_qty').limit(6);
    const itemLine = items.length
        ? items.map((it) => (Number(it.product_qty) || 1) + '× ' + (it.product_name || 'item')).join(', ')
        : '';
    let eta = 0;
    try { eta = OrderStatus.etaMinutesFromNow(o) || 0; } catch (e) { eta = 0; }

    let reply = 'Your last order from ' + (o.business_name || 'the restaurant') + ' is **' + meta.label + '**';
    if (!meta.terminal && eta > 0) { reply += ' — about ' + eta + ' min to go'; }
    reply += '.';
    if (itemLine) { reply += '\nYou ordered: ' + itemLine + '.'; }
    reply += '\nTotal ' + sym() + Number(o.grand_total || 0).toFixed(2) + ' · #' + (o.order_number || o.id) + '.';
    return reply;
}

// ── Intent: recent orders summary ─────────────────────────────────────
async function answerOrders(customerId) {
    const rows = await db('orders as o')
        .leftJoin('company as c', 'c.id', 'o.company_id')
        .where('o.user_id', customerId).andWhere('o.is_marketplace', 1)
        .orderBy('o.created_at', 'desc').limit(5)
        .select('o.order_status', 'o.serve_type', 'o.grand_total', 'c.business_name');
    if (!rows.length) { return "You haven't placed any orders yet."; }
    const lines = rows.map((r) => {
        const m = OrderStatus.getStatusMeta(r.order_status, r.serve_type);
        return '• ' + (r.business_name || 'Restaurant') + ' — ' + m.label + ' (' + sym() + Number(r.grand_total || 0).toFixed(2) + ')';
    });
    return 'Your recent orders:\n' + lines.join('\n');
}

// ── Intent: reorder — last order + a one-tap Reorder action ───────────
// Returns { reply, orderId } — ask() turns orderId into the action the web
// frontend uses to POST /order/:id/reorder (the real reorder flow).
async function answerReorder(customerId) {
    const o = await db('orders as o').leftJoin('company as c', 'c.id', 'o.company_id')
        .where('o.user_id', customerId).andWhere('o.is_marketplace', 1)
        .orderBy('o.created_at', 'desc')
        .first('o.id', 'o.order_number', 'o.grand_total', 'c.business_name');
    if (!o) { return { reply: "You don't have a past order to reorder yet.", orderId: null }; }
    const items = await db('orders_items').where('order_id', o.id).select('product_name', 'product_qty').limit(6);
    const itemLine = items.length ? items.map((it) => (Number(it.product_qty) || 1) + '× ' + (it.product_name || 'item')).join(', ') : '';
    const shop = o.business_name || 'the restaurant';
    let reply = 'Your last order from ' + shop + (itemLine ? ' (' + itemLine + ')' : '') + ' — ' + sym() + Number(o.grand_total || 0).toFixed(2) + '.';
    reply += '\nTap “Reorder” below to add these to a fresh basket.';
    return { reply, orderId: String(o.id) };
}

// ── Intent: loyalty / cashback balance ────────────────────────────────
async function answerLoyalty(customerId) {
    let cards = [];
    try { cards = await Loyalty.cardsFor(customerId); } catch (e) { cards = []; }
    cards = Array.isArray(cards) ? cards : [];
    const bal = (c) => Number(c.balance != null ? c.balance : (c.available != null ? c.available : 0)) || 0;
    const total = cards.reduce((s, c) => s + bal(c), 0);
    if (total <= 0) { return 'You have no cashback yet. Earn cashback on eligible orders — it goes into that restaurant\'s wallet to redeem next time.'; }
    let reply = 'You have ' + sym() + total.toFixed(2) + ' cashback in total.';
    const withBal = cards.filter((c) => bal(c) > 0).slice(0, 6);
    if (withBal.length) {
        reply += '\n' + withBal.map((c) => '• ' + (c.name || c.restaurant || c.business_name || 'Restaurant') + ': ' + sym() + bal(c).toFixed(2)).join('\n');
        reply += '\nRedeem it at checkout on your next order there.';
    }
    return reply;
}

// ── Intent: offers for me (+ new-vs-old eligibility) ──────────────────
async function answerOffers(customerId) {
    let feed = [];
    try { feed = await Offers.offersFeed(8); } catch (e) { feed = []; }
    feed = Array.isArray(feed) ? feed : [];

    let intro = '';
    if (customerId) {
        const cnt = await db('orders').where({ user_id: customerId, is_marketplace: 1 })
            .whereNotIn('order_status', SKIP_STATUS).count('* as n').first();
        const orders = Number(cnt && cnt.n) || 0;
        intro = orders === 0
            ? "You're a new customer 🎉 — welcome offers and first-order deals apply to you. "
            : ('You\'re a returning customer with ' + orders + ' order' + (orders === 1 ? '' : 's') + '. ');
    }
    if (!feed.length) { return intro + 'No live offers right now — check back soon!'; }
    const lines = feed.slice(0, 6).map((o) => {
        const from = (o.restaurant && (o.restaurant.name)) ? ' — ' + o.restaurant.name : '';
        const terms = o.details ? ' (' + o.details + ')' : '';
        return '• ' + (o.title || 'Offer') + from + terms;
    });
    return intro + 'Here are offers you can use:\n' + lines.join('\n');
}

// ── Intent: my referral code ──────────────────────────────────────────
async function answerReferral(customerId) {
    const row = await db('customer').where({ id: customerId }).first('referral_code');
    const code = row && row.referral_code ? String(row.referral_code).trim() : '';
    if (!code) { return "You don't have a referral code on your account yet."; }
    return 'Your referral code is **' + code + '**. Share it — when a friend signs up and orders with it, you both benefit!';
}

// ── Discover: nearby marketplace restaurants (needs lat/lng) ──────────
async function loadNearby(lat, lng) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) { return null; }
    const rows = await db('company as c')
        .innerJoin('branch as b', 'b.company_id', 'c.id')
        .modify((qb) => { M.eligibleCompanyScope(qb, 'c'); M.eligibleBranchScope(qb, 'b'); })
        .whereNotNull('b.direction_latitude').whereNotNull('b.direction_longitude')
        .select(BRANCH_COLS.concat([M.avgRatingSubq(db, 'c')]))
        .limit(2000);

    const byCompany = new Map();
    for (const r of rows) {
        const km = distance.kmBetween(lat, lng, Number(r.branch_lat), Number(r.branch_lng));
        if (km == null || !Number.isFinite(km)) { continue; }
        const prev = byCompany.get(r.company_id);
        if (!prev || km < prev.km) { byCompany.set(r.company_id, Object.assign({}, r, { km })); }
    }
    let list = Array.from(byCompany.values()).sort((a, b) => a.km - b.km);
    let radius = NEAR_KM;
    let near = list.filter((r) => r.km <= radius);
    if (!near.length) { radius = NEAR_KM_MAX; near = list.filter((r) => r.km <= radius); }
    return { near, radius };
}

async function answerNearby(lat, lng) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return 'Set your delivery location first (top of the app), then I can show you the restaurants around you.';
    }
    const res = await loadNearby(lat, lng);
    const near = (res && res.near) || [];
    if (!near.length) { return "I couldn't find any restaurants near your location yet — try a different address, we're adding more all the time."; }

    let openCount = 0;
    try {
        const verdicts = await StoreHours.availabilityForBranches(near);
        near.forEach((r) => { const v = verdicts.get(String(r.branch_id)); if (v && v.isOpen) { openCount += 1; } });
    } catch (e) { openCount = -1; }

    let reply = 'There ' + (near.length === 1 ? 'is 1 restaurant' : 'are ' + near.length + ' restaurants') +
                ' near you (within ' + res.radius + ' km)';
    if (openCount >= 0) { reply += ' — ' + openCount + ' open right now'; }
    reply += '.';

    const top = near.slice().sort((a, b) => (Number(b.avg_rating) || 0) - (Number(a.avg_rating) || 0) || a.km - b.km).slice(0, 5);
    reply += '\nTop picks:\n' + top.map((r) => {
        const rating = Number(r.avg_rating) ? ' ★' + Number(r.avg_rating).toFixed(1) : '';
        return '• ' + (r.business_name || 'Restaurant') + rating + ' · ' + r.km.toFixed(1) + ' km';
    }).join('\n');
    reply += '\nOpen the home page to browse them all.';
    return reply;
}

// ── Discover: cuisines / categories available near me ─────────────────
async function answerCuisines(lat, lng) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return 'Set your delivery location first, then I can tell you which cuisines are available near you.';
    }
    const res = await loadNearby(lat, lng);
    const near = (res && res.near) || [];
    if (!near.length) { return "I couldn't find restaurants near you yet, so I can't list cuisines — try a different address."; }

    const counts = new Map();
    near.forEach((r) => {
        M.cuisinesFor(r).forEach((c) => {
            const key = String(c).trim();
            if (!key || key.toLowerCase() === 'restaurant') { return; }
            counts.set(key, (counts.get(key) || 0) + 1);
        });
    });
    const ranked = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8);
    if (!ranked.length) { return 'There ' + (near.length === 1 ? 'is 1 restaurant' : 'are ' + near.length + ' restaurants') + ' near you — open the home page to browse them by cuisine.'; }
    return 'Cuisines available near you:\n' + ranked.map((e) => '• ' + e[0] + ' (' + e[1] + ')').join('\n') +
           '\nTap a cuisine on the home page to filter.';
}

// ── Restaurant-by-name resolution + restaurant-specific answers ───────
// Loads all eligible marketplace companies (id + name) and picks the best
// match for the free-text message: a full-name substring wins; otherwise a
// strong token overlap (≥60% of the name's words, at least one distinctive).
async function findCompanyByName(text) {
    const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\s]+/g, ' ').replace(/\s+/g, ' ').trim();
    const m = norm(text);
    if (m.length < 3) { return null; }
    const rows = await db('company as c')
        .innerJoin('branch as b', 'b.company_id', 'c.id')
        .modify((qb) => { M.eligibleCompanyScope(qb, 'c'); M.eligibleBranchScope(qb, 'b'); })
        .distinct('c.id as company_id', 'c.business_name');
    const msgTokens = new Set(m.split(' ').filter(Boolean));
    let best = null, bestScore = 0, bestLen = 0;
    for (const r of rows) {
        const nm = norm(r.business_name);
        if (!nm) { continue; }
        let score = 0;
        if (m.indexOf(nm) !== -1) {
            score = 1;   // the whole restaurant name appears in the message
        } else {
            const nmTokens = nm.split(' ').filter(Boolean);
            if (!nmTokens.length) { continue; }
            const hit = nmTokens.filter((tk) => tk.length >= 3 && msgTokens.has(tk)).length;
            const cover = hit / nmTokens.length;
            const distinctive = nmTokens.some((tk) => tk.length >= 4 && msgTokens.has(tk));
            if (cover >= 0.6 && distinctive) { score = 0.5 + cover * 0.4; }
        }
        if (score > 0 && (score > bestScore || (score === bestScore && nm.length > bestLen))) {
            best = r; bestScore = score; bestLen = nm.length;
        }
    }
    return best;
}

async function loadCompanyBranch(companyId) {
    return db('company as c')
        .innerJoin('branch as b', 'b.company_id', 'c.id')
        .where('c.id', companyId)
        .modify((qb) => { M.eligibleCompanyScope(qb, 'c'); M.eligibleBranchScope(qb, 'b'); })
        .orderBy('b.id', 'asc')
        .first(BRANCH_COLS);
}

// Delivery-fee line for a company + the customer's postcode (asks for a
// postcode when we don't have one, since fees are zone-based).
async function deliveryLine(companyId, postcode) {
    if (!postcode) {
        return 'For the exact delivery fee, set your delivery postcode at the top — fees vary by area.';
    }
    const zones = await db('store_delivery_charge_setup').where('company_id', companyId).andWhere('status', 1)
        .select('postcode', 'charge', 'minimum_order', 'free_delivery_above');
    const zone = M.matchDeliveryZone(postcode, zones);
    if (!zone) {
        return "Sorry, this restaurant doesn't deliver to your postcode — pickup may still be available.";
    }
    const fee = Number(zone.charge) || 0;
    const min = Number(zone.minimum_order) || 0;
    const free = zone.free_delivery_above != null ? Number(zone.free_delivery_above) : null;
    let s = 'Delivery fee: ' + sym() + fee.toFixed(2);
    if (min > 0)          { s += ' · min order ' + sym() + min.toFixed(2); }
    if (free && free > 0) { s += ' · free over ' + sym() + free.toFixed(2); }
    return s + '.';
}

// "is <name> open" / "<name> delivery fee" — open/closed (+ delivery fee).
async function answerRestaurant(match, msg, postcode) {
    const branch = await loadCompanyBranch(match.company_id);
    if (!branch) { return "I couldn't find that restaurant right now."; }
    const name = branch.business_name || match.business_name || 'the restaurant';
    const avail = await StoreHours.availabilityForBranch(branch);
    const status = avail ? avail.status : 'open';

    let reply;
    if (status === 'open') {
        reply = name + ' is **open** right now.';
    } else if (status === 'preorder') {
        reply = name + ' is closed now but taking **pre-orders**.';
    } else {
        reply = name + ' is **closed** right now.';
        if (avail && avail.reopenAt) { reply += ' Opens at ' + avail.reopenAt + '.'; }
    }
    if (avail && avail.hours) { reply += '\nToday: ' + avail.hours + '.'; }

    if (/(delivery fee|delivery charge|delivery cost|delivery charges|delivery kitna|kitna.*delivery)/.test(msg)) {
        reply += '\n' + await deliveryLine(branch.company_id, postcode);
    }
    return reply;
}

// "offers at <name>" — that restaurant's live offers.
async function answerRestaurantOffers(match) {
    const branch = await loadCompanyBranch(match.company_id);
    if (!branch) { return "I couldn't find that restaurant."; }
    const name = branch.business_name || match.business_name || 'this restaurant';
    const offers = await Offers.offersForRestaurant(branch.company_id, branch.branch_id);
    if (!offers.hasAny) {
        return 'No live offers at ' + name + ' right now — check back soon!';
    }
    const lines = [];
    offers.banners.slice(0, 4).forEach((b) => lines.push('• ' + b.title + (b.details ? ' — ' + b.details : '')));
    offers.coupons.slice(0, 4).forEach((c) => {
        const val = c.type === 1 ? (c.value + '% off') : (sym() + Number(c.value).toFixed(2) + ' off');
        const min = c.minOrder > 0 ? ' over ' + sym() + Number(c.minOrder).toFixed(2) : '';
        lines.push('• Code ' + c.code + ': ' + val + min + (c.freeDelivery ? ' + free delivery' : ''));
    });
    offers.discounts.slice(0, 3).forEach((d) => {
        if (d.value == null) { return; }
        const val = d.type === 1 ? (d.value + '% off') : (sym() + Number(d.value).toFixed(2) + ' off');
        const min = d.minOrder > 0 ? ' over ' + sym() + Number(d.minOrder).toFixed(2) : '';
        lines.push('• ' + val + min + (d.product ? ' on ' + d.product : ''));
    });
    return 'Offers at ' + name + ':\n' + lines.join('\n');
}

function answerFaq(msg) {
    for (const f of FAQ) {
        if (f.kw.some((k) => msg.indexOf(k) !== -1)) { return f.a; }
    }
    return null;
}

/** ask — POST /customer/chatbot/ask { message, customer_id?, lat?, lng?, postcode? } */
async function ask(req, res) {
    try {
        const body = req.body || {};
        const raw = String(body.message || '').trim();
        const msg = raw.toLowerCase();
        const customerId = await resolveCustomer(body.customer_id);
        const lat = body.lat != null && body.lat !== '' ? Number(body.lat) : NaN;
        const lng = body.lng != null && body.lng !== '' ? Number(body.lng) : NaN;
        const postcode = String(body.postcode || '').trim();

        if (!raw) { return ok(res, 'Hi! I\'m the ' + brand.name + ' assistant. Ask me about your orders, cashback, offers, restaurants near you, or how things work.'); }

        // Greeting.
        if (/^(hi|hello|hey|hii+|yo|namaste|salaam)\b/.test(msg)) {
            return ok(res, 'Hi! 👋 I can help with your orders, cashback, offers, and finding restaurants near you — or how ' + brand.name + ' works. Ask "what can you do?" to see everything.');
        }
        // Capability menu / help.
        if (/(what can you do|help menu|\bmenu\b|options|what.*(ask|help)|kya kar sakte|kya kar sakta|kya help)/.test(msg)) {
            return ok(res, answerHelp());
        }
        // "How to cancel" is an FAQ, NOT the order-status intent (which also
        // matches "my order"). Answer the how-to before status routing.
        if (/\bcancel/.test(msg)) {
            return ok(res, answerFaq(msg) || 'You can cancel from Orders → the order shortly after placing it; after that use "Help with this order".');
        }
        // "How do I apply a coupon" is an FAQ, NOT the offers feed.
        if (/(how|apply|enter|use|redeem|add).*(coupon|voucher|promo|code)/.test(msg)) {
            return ok(res, answerFaq(msg) || 'Enter your code in the "Apply code" box at Checkout — it applies instantly.');
        }
        // "How/where do I order" (incl. Hinglish "kaha se order kare") is an FAQ,
        // NOT the order-status intent — its "kaha.*order" pattern would grab it.
        if (/(kaha se order|kahan se order|order (?:kaise|kese|kare|karna|karu|krna))/.test(msg)) {
            return ok(res, answerFaq(msg) || answerHelp());
        }
        // My referral code (personalised).
        if (/(referral|invite code|refer code|my code|share code)/.test(msg)) {
            return ok(res, customerId ? await answerReferral(customerId) : needLogin());
        }
        // Reorder / order again — must beat the order-status intent.
        if (/(reorder|re-order|order again|repeat.*order|same order)/.test(msg)) {
            if (!customerId) { return ok(res, needLogin()); }
            const r = await answerReorder(customerId);
            const action = r.orderId ? { kind: 'reorder', orderId: r.orderId, label: 'Reorder' } : null;
            return ok(res, r.reply, CHIPS, action);
        }
        // Restaurant-specific: is <name> open / <name> delivery fee. Only when
        // the message carries such a keyword AND a restaurant name resolves. Skip
        // when it's clearly about the user's OWN order(s) ("are my orders open?").
        if (/(open|closed|delivery fee|delivery charge|delivery cost|delivery kitna|kitna.*delivery)/.test(msg)
            && !/my orders?\b/.test(msg)) {
            const company = await findCompanyByName(msg);
            if (company) { return ok(res, await answerRestaurant(company, msg, postcode)); }
            // no restaurant resolved → fall through to FAQ/fallback
        }
        // Order status / last order / track.
        if (/(where.*(order|delivery)|track|last order|my order\b|order status|kaha.*order)/.test(msg)) {
            return ok(res, customerId ? await answerOrder(customerId) : needLogin());
        }
        // Orders history.
        if (/(my orders|order history|previous order|how many order|orders.*(list|history))/.test(msg)) {
            return ok(res, customerId ? await answerOrders(customerId) : needLogin());
        }
        // Loyalty / cashback / wallet.
        if (/(point|cashback|reward|wallet|loyalty|balance)/.test(msg)) {
            return ok(res, customerId ? await answerLoyalty(customerId) : needLogin());
        }
        // Cuisines / categories near me (check before "restaurants near me").
        if (/(cuisine|categor|what food|type of food|kind of food|food near)/.test(msg)) {
            return ok(res, await answerCuisines(lat, lng));
        }
        // Restaurants near me / around me / nearby.
        if (/(restaurant|place|shop|outlet).*(near|around|close|nearby|by me)|near ?me|nearby|around me|kitne restaurant|paas.*restaurant/.test(msg)) {
            return ok(res, await answerNearby(lat, lng));
        }
        // Offers / deals. "offers at <restaurant>" → that restaurant; else feed.
        if (/\b(offers?|deals?|discounts?|coupons?|vouchers?|promo)\b/.test(msg)) {
            const company = await findCompanyByName(msg);
            if (company) { return ok(res, await answerRestaurantOffers(company)); }
            return ok(res, await answerOffers(customerId));
        }
        // Fixed FAQ.
        const faq = answerFaq(msg);
        if (faq) { return ok(res, faq); }

        // Fallback.
        return ok(res, 'I\'m not sure about that yet — tap "What can you do?" to see everything, or ask about your orders, cashback, offers, or restaurants near you.');
    } catch (err) {
        H.log.error('chatbot.ask', err && err.message);
        return H.errorResponse(res, 'Sorry, something went wrong. Please try again.', 500);
    }
}

module.exports = { ask };
