'use strict';
// TEMP read-only — verify the loyalty earn+redeem pipeline state. Deleted after.
const { db } = require('../config/db');

function rows(r) { return r && (r.rows || r) || []; }

(async () => {
    try {
        // 1. Migration done? cart.used_cashback present.
        const col = await db('information_schema.columns')
            .where({ table_name: 'cart', column_name: 'used_cashback' }).first();
        console.log('1) cart.used_cashback column :', col ? 'YES (migrated)' : 'NO  (run php yii migrate)');

        // 2. EatNDeal loyalty config.
        const cfg = await db('company_loyalty').where({ company_id: 1 })
            .select('loyalty_status', 'cash_king', 'loyalty_commission', 'use_max_cashback', 'expiry_duration_days').first();
        console.log('2) EatNDeal (company 1) cfg  :', JSON.stringify(cfg));

        // 3. EARN — recent customer_rewards for EatNDeal.
        const earned = await db('customer_rewards')
            .where({ company_id: 1 })
            .orderBy('id', 'desc').limit(8)
            .select('id', 'customer_id', 'entity_type', 'amount', 'used_amount', 'is_redeemable', 'is_expired', 'expired_from', 'related_id', 'expiry_date', 'created_at');
        console.log('3) customer_rewards @ EatNDeal:', earned.length, 'row(s)');
        earned.forEach(r => console.log('   #' + r.id, 'cust', r.customer_id, r.entity_type,
            '£' + r.amount, 'used £' + (r.used_amount || 0),
            'redeemable=' + r.is_redeemable, 'expired=' + r.is_expired + (r.expired_from ? '/from' + r.expired_from : ''),
            'order=' + r.related_id));

        // 4. REDEEM ledger — customer_used_rewards for EatNDeal.
        const used = await db('customer_used_rewards')
            .where({ company_id: 1 })
            .orderBy('id', 'desc').limit(8)
            .select('id', 'customer_id', 'order_id', 'used_amount', 'order_cancelled', 'related_json', 'created_at');
        console.log('4) customer_used_rewards      :', used.length, 'row(s)');
        used.forEach(r => console.log('   #' + r.id, 'cust', r.customer_id, 'order', r.order_id,
            'used £' + r.used_amount, 'cancelled=' + r.order_cancelled, 'detail=' + (r.related_json || '')));

        // 5. ORDERS that used cashback (marketplace).
        const ords = await db('orders')
            .where('company_id', 1).andWhere('used_cashback', '>', 0)
            .orderBy('id', 'desc').limit(8)
            .select('id', 'order_number', 'user_id', 'sub_total', 'used_cashback', 'grand_total', 'created_at');
        console.log('5) orders with used_cashback  :', ords.length, 'row(s)');
        ords.forEach(o => console.log('   order', o.id, o.order_number, 'sub £' + o.sub_total,
            'redeem £' + o.used_cashback, 'paid £' + o.grand_total));

        // 5b. Order-streak progress + product_streak rewards.
        const rule = await db('loyalty_order_cashback_rule').where({ company_id: 1 }).whereNull('deleted_at').orderBy('order_count', 'desc').first();
        console.log('5b) streak rule @ EatNDeal   :', rule ? ('count=' + rule.order_count + ' type=' + rule.type + ' dur=' + rule.duration_type + ' ' + rule.value_type + rule.cashback + ' min=' + rule.min_order_amount) : 'none');
        const prog = await db('loyalty_order_cashback_progress').where({ company_id: 1 }).orderBy('id', 'desc').limit(8)
            .select('customer_id', 'rule_id', 'current_streak', 'reward_ready', 'last_order_date');
        console.log('    progress rows             :', prog.length);
        prog.forEach(p => console.log('      cust', p.customer_id, 'rule', p.rule_id, 'streak=' + p.current_streak, 'ready=' + p.reward_ready, 'last=' + (p.last_order_date ? String(p.last_order_date).slice(0, 10) : '-')));

        // 6. Open carts carrying a pending redeem.
        if (col) {
            const carts = await db('cart')
                .where('used_cashback', '>', 0).andWhere('is_open', 1)
                .select('id', 'user_id', 'company_id', 'sub_total', 'used_cashback', 'grandtotal').limit(8);
            console.log('6) open carts w/ pending redeem:', carts.length, 'row(s)');
            carts.forEach(c => console.log('   cart', c.id, 'cust', c.user_id, 'sub £' + c.sub_total,
                'redeem £' + c.used_cashback, 'total £' + c.grandtotal));
        } else {
            console.log('6) open carts w/ pending redeem: (skipped — column not migrated)');
        }
    } catch (e) {
        console.error('ERR', e && e.message);
    } finally {
        try { await db.destroy(); } catch (e) {}
    }
})();
