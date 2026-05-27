'use strict';

/**
 * knexfile.js
 *
 * What:   Knex connection profile for the EatNDeal API.
 * Why:    Knex needs a config file to connect; we use it for query building
 *         (NOT for running migrations — see warning below).
 * Type:   READ (config only)
 * Inputs: process.env.DB_HOST / DB_PORT / DB_DATABASE / DB_USERNAME / DB_PASSWORD
 * Output: Knex configuration object (one per APP_ENV).
 * Used:   require('../knexfile') from api/config/db.js to create the
 *         shared Knex instance the whole app uses.
 *
 *   ⚠️  DO NOT run `knex migrate:latest` against this DB without explicit
 *       user approval. The target database (wtw_eatndeal) is LIVE — it is
 *       shared with the Yii2 eatndealclean POS + webordering system and
 *       holds real customer and order data. Schema changes here break the
 *       existing apps. See EatNDeal/CODING-CONVENTIONS.md + EXISTING-CODEBASE.md.
 *
 * Change log:
 *   2026-05-25 — initial scaffold pointing at the existing wtw_eatndeal DB.
 */

require('dotenv').config();

// Connection details for the existing live PostgreSQL database. These match
// the DSN used by common/config/main-local.php in the Yii2 eatndealclean app.
const connection = {
    host:     String(process.env.DB_HOST     || '127.0.0.1'),
    port:     parseInt(process.env.DB_PORT, 10) || 5432,
    database: String(process.env.DB_DATABASE || 'wtw_eatndeal'),
    user:     String(process.env.DB_USERNAME || 'postgres'),
    password: String(process.env.DB_PASSWORD || ''),
};

// Shared base config — same pool settings, same UTC timezone, same migration
// folder. Production overlays SSL + a slightly larger pool ceiling.
//
// Migrations note: schema changes for this project are written as Yii2
// PHP migrations in
//   D:\Database Path\MySql\install\www\eatndealclean\console\migrations\
// and run with `php yii migrate` from the Yii project. Knex here is
// used ONLY as a query builder — we don't run JS migrations. The
// `migrations` block below stays only so Knex's CLI doesn't complain
// if someone accidentally runs `knex migrate:make`; the directory
// points at an empty local folder so nothing weird happens.
const base = {
    client: 'pg',
    connection,
    migrations: {
        directory: __dirname + '/db/migrations',
        tableName: 'eatndeal_marketplace_migrations',
    },
    seeds: {
        directory: __dirname + '/db/seeds',
    },
    pool: {
        min: 2,
        max: 10,
        // Force every connection into UTC so timestamps written by this API
        // line up with timestamps already in the table (the Yii2 system also
        // writes UTC). All formatting back to Europe/London happens on the
        // client / view layer, NOT in the DB.
        afterCreate: (conn, done) => {
            conn.query("SET timezone = 'UTC';", (err) => done(err, conn));
        },
    },
};

module.exports = {
    development: base,
    production: {
        ...base,
        connection: { ...connection, ssl: { rejectUnauthorized: false } },
        pool:       { ...base.pool, min: 2, max: 20 },
    },
};
