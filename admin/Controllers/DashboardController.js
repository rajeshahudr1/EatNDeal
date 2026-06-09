'use strict';

/*
 * Controllers/DashboardController.js
 *
 * What:  Renders the admin landing page shown right after a successful
 *        login. For now it is a welcome shell with the Loyalty-management
 *        quick-action tiles from the mockup (Cashback Rules, Tier Config,
 *        Challenges, Review Claims, Segments). Each tile links to a screen
 *        that gets wired up in a later phase.
 * Why:   Gives the login flow a real destination and lays down the admin
 *        shell (sidebar + topbar) that every management screen will reuse.
 * Type:  READ.
 * Used:  app.get('/', requireAdmin, DashboardController.index) in index.js.
 *
 * Change log:
 *   2026-06-09 — initial stub landing.
 */

/**
 * index
 *
 * What:  Renders the dashboard inside the admin shell layout.
 * Type:  READ.
 */
function index(req, res) {
    res.render('dashboard/index', {
        page_title:  'Dashboard',
        _layoutFile: '../_layout',
        active_nav:  'dashboard',
    });
}

module.exports = { index };
