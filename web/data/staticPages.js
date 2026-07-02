'use strict';

/**
 * data/staticPages.js
 *
 * What:   Content for every "static" marketing / informational page —
 *         About, Help, Terms, Privacy, Contact, Partner with us, Ride
 *         with us, For business, Careers. One slug → one object with
 *         the title + lede + ordered `sections` array.
 * Why:    Keeps the writing OUT of the EJS templates so non-developers
 *         can update copy without touching markup. Single source of
 *         truth — StaticPageController renders any of the 9 pages from
 *         this file using the same shared view (views/static/page.ejs).
 *
 *         Content sources:
 *           • About / Help / Contact — adapted from the Yii2
 *             eatndealclean webordering views (about_us.php,
 *             allergy_info.php, contact_us.php). Per-restaurant
 *             pieces stripped out; rewritten as PLATFORM-level copy.
 *           • Terms / Privacy — standard legal placeholders. Replace
 *             with copy from your legal team before launch.
 *           • Partner / Ride / Business / Careers — marketing pages
 *             with dummy realistic copy until the real flows land.
 *
 * Section types the shared view (views/static/page.ejs) understands:
 *           text   { heading?, body | bodies[] }
 *           list   { heading?, items[] }
 *           faq    { heading?, items[{q, a}] }
 *           steps  { heading?, items[{title, body, icon}] }
 *           perks  { heading?, items[{icon, title, body}] }   (3-col card row)
 *           cta    { heading, body, button: {label, href} }
 *
 * Used:   require('./data/staticPages') from web/Controllers/StaticPageController.js.
 *
 * Change log:
 *   2026-05-25 — initial. Nine pages, frozen output.
 */

const pages = {

    // ── About ────────────────────────────────────────────────────
    about: {
        slug:  'about',
        title: 'About EatNDeal',
        lede:  'Delicious food delivered. We connect you with the best local restaurants — fast, friendly, fair.',
        sections: [
            {
                type: 'text',
                heading: 'Discover the magic of flavours',
                body: 'EatNDeal is the UK\'s growing marketplace for everyday cravings and special occasions. Whether you\'re after a quick lunch, a takeaway feast, or a healthy bowl after the gym, we put the best independent restaurants and trusted favourites in one place — your area, your taste, your time.',
            },
            {
                type: 'perks',
                heading: 'Why EatNDeal',
                items: [
                    { icon: '🍽',  title: 'Curated restaurants',  body: 'Hand-picked partners and rigorous quality checks — only places we\'d order from ourselves.' },
                    { icon: '⚡',  title: 'Fast, tracked delivery', body: 'Real-time tracking from kitchen to doorstep, with delivery partners who care about your food.' },
                    { icon: '🎁', title: 'Rewards every order',  body: 'Earn loyalty points on every order and redeem for member-only deals.' },
                ],
            },
            {
                type: 'text',
                heading: 'Built for restaurants, too',
                body: 'We started EatNDeal because local restaurants deserve fair fees, real support, and a marketplace that puts their food first. Today thousands of kitchens use EatNDeal to reach new customers without giving up their margins.',
            },
            {
                type: 'cta',
                heading: 'Hungry? Or running a restaurant?',
                body: 'Order now in two taps, or partner with us to bring your kitchen online.',
                button: { label: 'Find food near you', href: '/' },
            },
        ],
    },

    // ── Help centre ──────────────────────────────────────────────
    help: {
        slug:  'help',
        title: 'Help centre',
        lede:  'Answers to common questions about ordering, delivery, allergies and payments.',
        sections: [
            {
                type: 'faq',
                heading: 'Ordering',
                items: [
                    { q: 'How do I place an order?',          a: 'Set your delivery location, pick a restaurant, add items to your cart, and check out. You don\'t need an account to browse — only to place the order.' },
                    { q: 'Can I schedule an order for later?', a: 'Yes. At checkout, choose "Schedule for later" and pick the date and time you\'d like your food to arrive. Available at supported restaurants.' },
                    { q: 'How do I track my order?',          a: 'Once placed, your order shows up under Orders with a live timeline — Placed, Accepted, then Out for delivery (delivery) or Ready to collect (pickup), and finally Completed. You\'ll also get push notifications at each step.' },
                ],
            },
            {
                type: 'faq',
                heading: 'Food allergies',
                items: [
                    // Sourced from the Yii allergy_info.php — adapted for marketplace tone.
                    { q: 'What if I have a food allergy?', a: 'Leave a note at checkout AND contact the restaurant directly to confirm. We strongly recommend confirming any allergy requests on the phone before placing the order — your health is the priority.' },
                    { q: 'How accurate is the allergen information?', a: 'Restaurants supply the ingredient and allergen information shown on EatNDeal. We don\'t change it. If anything looks unclear, please contact the restaurant directly to confirm before ordering.' },
                    { q: 'I added an allergy to my profile — does that warn the restaurant?', a: 'It warns YOU on items that may contain your allergens, but does not automatically inform the restaurant. Always include the allergy in your checkout note AND call the restaurant if it\'s critical.' },
                ],
            },
            {
                type: 'faq',
                heading: 'Payments & refunds',
                items: [
                    { q: 'What payment methods do you accept?', a: 'Visa, Mastercard, American Express, Apple Pay, Google Pay, and cash on delivery at participating restaurants.' },
                    { q: 'I want a refund — what do I do?', a: 'Open the order from Orders and tap "Help with this order". Most refund decisions arrive within 24 hours; missing-item refunds are usually instant.' },
                    { q: 'Are there delivery fees?', a: 'Fees vary by restaurant and distance. The final delivery fee is always shown clearly before you place the order.' },
                ],
            },
            {
                type: 'cta',
                heading: 'Still need help?',
                body:    'Our support team is here every day.',
                button:  { label: 'Contact us', href: '/contact' },
            },
        ],
    },

    // ── Terms of Service (placeholder) ───────────────────────────
    terms: {
        slug:  'terms',
        title: 'Terms of Service',
        lede:  'Last updated: 25 May 2026. Please read these terms carefully before using EatNDeal.',
        sections: [
            {
                type: 'text',
                heading: '1. Acceptance of terms',
                body: 'By using EatNDeal (the "Service"), you agree to be bound by these Terms of Service. If you do not agree, please do not use the Service. We may update these terms from time to time; continued use after a change means you accept the updated terms.',
            },
            {
                type: 'text',
                heading: '2. Eligibility',
                body: 'You must be at least 18 years old to place an order on EatNDeal. By using the Service you confirm you are old enough to enter into a binding contract under UK law.',
            },
            {
                type: 'text',
                heading: '3. Orders',
                body: 'When you place an order, you enter into a contract with the restaurant that prepares your food. EatNDeal acts as an intermediary that collects payment and arranges delivery. We are not the manufacturer or supplier of the food.',
            },
            {
                type: 'text',
                heading: '4. Pricing & promotions',
                body: 'Prices shown include applicable taxes unless stated otherwise. Promotional codes and discounts are subject to specific terms — minimum order, expiry date, single-use vs reusable — listed alongside each promotion.',
            },
            {
                type: 'text',
                heading: '5. Cancellations & refunds',
                body: 'Once a restaurant has accepted your order it cannot be cancelled. For other issues (missing items, incorrect order, food quality) please contact us within 48 hours of delivery and we will work with the restaurant to resolve it.',
            },
            {
                type: 'text',
                heading: '6. Limitation of liability',
                body: 'EatNDeal\'s liability is limited to the amount paid for the relevant order. We are not liable for any indirect or consequential losses arising from your use of the Service.',
            },
            {
                type: 'text',
                heading: '7. Governing law',
                body: 'These Terms are governed by the laws of England and Wales. Any dispute will be subject to the exclusive jurisdiction of the courts of England and Wales.',
            },
            {
                type: 'cta',
                heading: 'Questions about these Terms?',
                body:    'Email our team and we\'ll be happy to help.',
                button:  { label: 'Contact us', href: '/contact' },
            },
        ],
    },

    // ── Privacy Policy (placeholder) ─────────────────────────────
    privacy: {
        slug:  'privacy',
        title: 'Privacy Policy',
        lede:  'Last updated: 25 May 2026. We respect your privacy. This page explains what data we collect and how we use it.',
        sections: [
            {
                type: 'text',
                heading: 'What we collect',
                bodies: [
                    'Account details — name, email, phone number when you sign in.',
                    'Order details — restaurants, items, delivery address, and payment confirmation.',
                    'Location — your delivery area, used only to show restaurants that deliver to you.',
                    'Device & usage — basic device info and how you interact with EatNDeal, to keep the service fast and secure.',
                ],
            },
            {
                type: 'text',
                heading: 'How we use your data',
                bodies: [
                    'To process your orders and deliver your food.',
                    'To contact you about your order or important account changes.',
                    'To improve EatNDeal — anonymous usage analytics only.',
                    'To prevent fraud and keep the platform secure.',
                ],
            },
            {
                type: 'text',
                heading: 'Who we share it with',
                body:    'Restaurants you order from (so they can prepare your order), the rider delivering it (so they can find you), and trusted service providers (payment processor, SMS / email vendors, mapping). We never sell your data.',
            },
            {
                type: 'text',
                heading: 'Your rights',
                body:    'Under UK GDPR you have the right to access, correct, or delete your personal data, and to opt out of marketing. Email our support team to exercise any of these rights.',
            },
            {
                type: 'text',
                heading: 'Cookies',
                body:    'EatNDeal uses essential cookies for sign-in and security. We do not use third-party advertising cookies on our site.',
            },
            {
                type: 'cta',
                heading: 'Privacy questions?',
                body:    'Email our data protection team and we will respond within 30 days.',
                button:  { label: 'Contact us', href: '/contact' },
            },
        ],
    },

    // ── Contact us ───────────────────────────────────────────────
    contact: {
        slug:  'contact',
        title: 'Contact us',
        lede:  'We\'re here to help. Reach us by email, phone, or the form below — we usually reply within 24 hours.',
        sections: [
            {
                type: 'perks',
                items: [
                    { icon: '📧', title: 'Email',  body: 'bookings@eatsndeals.co.uk — general support, partnerships, press.' },
                    { icon: '📱', title: 'Phone',  body: 'Available Mon – Sun, 9 AM to 11 PM UK time. Number shown after sign-in.' },
                    { icon: '🏢', title: 'HQ',     body: '5 Eat Lane, Manchester, M1 4WP, United Kingdom.' },
                ],
            },
            {
                type: 'text',
                heading: 'Order-specific issues',
                body:    'If you have an issue with a SPECIFIC order (missing items, late delivery, refund request) the fastest route is through the Orders page on your account — every order has a "Help with this order" button that routes to the right team.',
            },
            {
                type: 'form',
                heading: 'Send us a message',
                body:    'Fill in the form and we\'ll get back to you within 24 hours.',
            },
            {
                type: 'cta',
                heading: 'Restaurant partner?',
                body:    'Partnership enquiries go through our restaurant team.',
                button:  { label: 'Partner with us', href: '/partner' },
            },
        ],
    },

    // ── Partner with us (restaurants) ────────────────────────────
    partner: {
        slug:  'partner',
        title: 'Partner with EatNDeal',
        lede:  'Grow your restaurant with the UK\'s fairest food marketplace. Lower fees, better support, more orders.',
        sections: [
            {
                type: 'perks',
                heading: 'Why partner with us',
                items: [
                    { icon: '💰', title: 'Fair commission', body: 'Transparent rates with no hidden fees — see exactly what you keep on every order.' },
                    { icon: '📱', title: 'Easy POS',         body: 'Live order dashboard, instant menu updates, kitchen receipts that print automatically.' },
                    { icon: '🤝', title: 'Real support',     body: 'A real account manager — not a chatbot. Onboarding in 48 hours, weekly performance reviews.' },
                ],
            },
            {
                type: 'steps',
                heading: 'How it works',
                items: [
                    { icon: '📝', title: 'Apply',  body: 'Tell us about your restaurant — opening times, cuisines, average order size.' },
                    { icon: '✅', title: 'Get approved', body: 'We do a quick quality check (menu, food hygiene rating, photos) — usually under 48 hours.' },
                    { icon: '🚀', title: 'Go live', body: 'You\'re live on EatNDeal. Receive your first order on day one, get paid weekly.' },
                ],
            },
            {
                type: 'form',
                heading: 'List your restaurant',
                body:    'Fill in your details and our team will get back to you within one working day.',
            },
        ],
    },

    // ── Ride with us (delivery partners) ─────────────────────────
    ride: {
        slug:  'ride',
        title: 'Ride with EatNDeal',
        lede:  'Be your own boss. Choose your hours. Earn what you ride for — with the support of a team that has your back.',
        sections: [
            {
                type: 'perks',
                heading: 'Why ride with us',
                items: [
                    { icon: '⏰', title: 'Flexible hours',   body: 'Ride when you want — log in for an hour or a full shift, no minimum commitment.' },
                    { icon: '💷', title: 'Transparent pay', body: 'See every delivery\'s pay BEFORE you accept. Tips go 100% to you.' },
                    { icon: '🛡',  title: 'Insurance + kit', body: 'In-app insurance during shifts, plus a discount on jackets and bike kit.' },
                ],
            },
            {
                type: 'list',
                heading: 'What you\'ll need',
                items: [
                    'A right to work in the UK',
                    'A smartphone (Android 8+ or iOS 14+)',
                    'A bicycle, e-bike, scooter, motorbike, or car',
                    'A valid driving license + insurance for motorised vehicles',
                ],
            },
            {
                type: 'cta',
                heading: 'Start earning this week',
                body:    'Sign up takes 5 minutes. We\'ll get back to you within 48 hours.',
                button:  { label: 'Apply to ride', href: '/contact' },
            },
        ],
    },

    // ── For business (corporate orders) ──────────────────────────
    business: {
        slug:  'business',
        title: 'EatNDeal for business',
        lede:  'Feed your team, treat your clients, run an event — one account, monthly invoicing, a real account manager.',
        sections: [
            {
                type: 'perks',
                heading: 'Built for teams',
                items: [
                    { icon: '🍱', title: 'Group orders', body: 'Everyone picks their own meal, you pay one bill. Set per-person spend caps.' },
                    { icon: '📊', title: 'Monthly invoice', body: 'No more receipt-chasing. Get one VAT invoice every month with full per-team breakdowns.' },
                    { icon: '👤', title: 'Account manager', body: 'A real person who knows your team — restaurant favourites, delivery times, allergens.' },
                ],
            },
            {
                type: 'text',
                heading: 'Used by',
                body:    'Tech teams running lunch programmes. Agencies hosting client dinners. Hospitals catering staff shifts. Schools running staff-meal benefits. Coworking spaces stocking event days.',
            },
            {
                type: 'cta',
                heading: 'Talk to our business team',
                body:    'Get a custom quote in 24 hours.',
                button:  { label: 'Request a quote', href: '/contact' },
            },
        ],
    },

    // ── Careers ──────────────────────────────────────────────────
    careers: {
        slug:  'careers',
        title: 'Careers at EatNDeal',
        lede:  'We\'re hiring for engineering, ops, support, and growth. Help us build the UK\'s fairest food marketplace.',
        sections: [
            {
                type: 'perks',
                heading: 'What we offer',
                items: [
                    { icon: '🏠', title: 'Hybrid working',  body: 'Two days a week in our Manchester HQ. The rest? Wherever you do your best work.' },
                    { icon: '📚', title: 'Learning budget', body: '£1,500/year for books, courses, and conferences. No questions asked.' },
                    { icon: '🍕', title: 'Free EatNDeal credit', body: '£100/month on any restaurant in the marketplace. We eat what we ship.' },
                ],
            },
            {
                type: 'list',
                heading: 'Current openings',
                items: [
                    'Senior Backend Engineer — Node.js / Postgres — Manchester (hybrid)',
                    'Mobile Engineer — Flutter — Manchester (hybrid)',
                    'Customer Support Specialist — full-time — remote (UK)',
                    'Restaurant Partnerships Manager — London (hybrid)',
                    'Growth Marketing Lead — Manchester (hybrid)',
                ],
            },
            {
                type: 'cta',
                heading: 'Don\'t see your role?',
                body:    'We\'re always interested in great people. Tell us what you\'d like to build.',
                button:  { label: 'Say hello', href: '/contact' },
            },
        ],
    },
};

// Freeze so accidental edits at runtime throw instead of silently mutating
// shared content state.
Object.keys(pages).forEach(function (k) { Object.freeze(pages[k]); });

module.exports = Object.freeze(pages);
