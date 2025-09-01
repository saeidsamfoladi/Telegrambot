// Membership Club Bot - by Telegraf + Express + PostgreSQL
require('dotenv').config();
const express = require('express');
const { Telegraf } = require('telegraf');
const { Pool } = require('pg');

const {
  TELEGRAM_BOT_TOKEN: TOKEN,
  WEBHOOK_SECRET = 'change-me',
  PORT = 10000,
  DATABASE_URL,
  ADMIN_IDS = '', // comma-separated numeric IDs
} = process.env;

if (!TOKEN || !DATABASE_URL) {
  console.error('Missing env vars: TELEGRAM_BOT_TOKEN or DATABASE_URL');
  process.exit(1);
}

const ADMIN_SET = new Set(
  ADMIN_IDS
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

const pool = new Pool({
  connectionString: DATABASE_URL,
  // Render’s internal CA is fine; no ssl needed for "Internal URL".
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS membership_codes (
      code TEXT PRIMARY KEY,
      allowed_uses INT NOT NULL DEFAULT 1,
      used_count INT NOT NULL DEFAULT 0,
      expires_at TIMESTAMPTZ,
      note TEXT,
      created_by BIGINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      active BOOLEAN NOT NULL DEFAULT TRUE
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS members (
      tg_id BIGINT PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      last_name TEXT,
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      code_used TEXT REFERENCES membership_codes(code)
    );
  `);
}

function isAdmin(ctx) {
  const id = ctx.from?.id?.toString();
  return ADMIN_SET.has(id);
}

function genCode(len = 10) {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < len; i++) out += abc[Math.floor(Math.random() * abc.length)];
  return out;
}

const bot = new Telegraf(TOKEN);

// /start
bot.start(async (ctx) => {
  const id = ctx.from.id;
  const { rows } = await pool.query('SELECT tg_id FROM members WHERE tg_id = $1', [id]);
  if (rows.length) {
    await ctx.reply('✅ شما قبلاً عضو باشگاه هستید.\nبرای وضعیت کدها: /help');
  } else {
    await ctx.reply('سلام! برای عضویت، کد عضویت را با دستور زیر ارسال کنید:\n`/register YOURCODE`', { parse_mode: 'Markdown' });
  }
});

// /help
bot.help(async (ctx) => {
  let msg = 'دستورات:\n';
  msg += '/register CODE — ثبت‌نام با کد عضویت\n';
  msg += '/whoami — وضعیت عضویت شما\n';
  if (isAdmin(ctx)) {
    msg += '\nدستورات ادمین:\n';
    msg += '/gencode [uses] [minutes] [note] — ساخت کد تصادفی\n';
    msg += '/codes — نمایش کدهای فعال و ظرفیت باقی‌مانده\n';
    msg += '/revoke CODE — غیرفعال‌سازی کد\n';
    msg += '/members — تعداد اعضا\n';
  }
  await ctx.reply(msg);
});

// /whoami
bot.command('whoami', async (ctx) => {
  const id = ctx.from.id;
  const { rows } = await pool.query('SELECT code_used, joined_at FROM members WHERE tg_id = $1', [id]);
  if (rows.length) {
    const m = rows[0];
    await ctx.reply(`✅ عضو هستید.\nکد ثبت‌نام: ${m.code_used || '-'}\nتاریخ عضویت: ${m.joined_at.toISOString()}`);
  } else {
    await ctx.reply('❌ هنوز عضو نیستید. دستور /register CODE را بفرستید.');
  }
});

// /register CODE
bot.command('register', async (ctx) => {
  const parts = ctx.message.text.trim().split(/\s+/);
  const code = parts[1]?.toUpperCase();
  if (!code) return ctx.reply('فرمت درست: `/register CODE`', { parse_mode: 'Markdown' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const me = await client.query('SELECT tg_id FROM members WHERE tg_id = $1', [ctx.from.id]);
    if (me.rows.length) {
      await client.query('ROLLBACK');
      return ctx.reply('شما قبلاً عضو شده‌اید ✅');
    }

    const q = await client.query(
      `SELECT code, allowed_uses, used_count, expires_at, active
       FROM membership_codes WHERE code = $1 FOR UPDATE`,
      [code]
    );
    if (!q.rows.length) {
      await client.query('ROLLBACK');
      return ctx.reply('کد نامعتبر است ❌');
    }
    const row = q.rows[0];
    if (!row.active) {
      await client.query('ROLLBACK');
      return ctx.reply('این کد غیرفعال شده است ❌');
    }
    if (row.expires_at && new Date(row.expires_at) < new Date()) {
      await client.query('ROLLBACK');
      return ctx.reply('مهلت این کد تمام شده است ⏰');
    }
    if (row.used_count >= row.allowed_uses) {
      await client.query('ROLLBACK');
      return ctx.reply('ظرفیت این کد تکمیل شده است 🚫');
    }

    await client.query(
      `INSERT INTO members (tg_id, username, first_name, last_name, code_used)
       VALUES ($1,$2,$3,$4,$5)`,
      [ctx.from.id, ctx.from.username || null, ctx.from.first_name || null, ctx.from.last_name || null, code]
    );
    await client.query(
      `UPDATE membership_codes SET used_count = used_count + 1 WHERE code = $1`,
      [code]
    );

    await client.query('COMMIT');
    await ctx.reply('ثبت‌نام شما با موفقیت انجام شد 🎉');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Register error:', e);
    await ctx.reply('خطایی رخ داد. دوباره تلاش کنید یا با ادمین تماس بگیرید.');
  } finally {
    client.release();
  }
});

// ADMIN: /gencode [uses] [minutes] [note...]
bot.command('gencode', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const args = ctx.message.text.split(' ').slice(1);
  const uses = Math.max(1, parseInt(args[0] || '1', 10) || 1);
  const mins = Math.max(0, parseInt(args[1] || '0', 10) || 0);
  const note = args.slice(2).join(' ') || null;

  const code = genCode(10);
  const expires_at = mins ? new Date(Date.now() + mins * 60 * 1000) : null;

  await pool.query(
    `INSERT INTO membership_codes(code, allowed_uses, expires_at, note, created_by)
     VALUES($1,$2,$3,$4,$5)`,
    [code, uses, expires_at, note, ctx.from.id]
  );

  await ctx.reply(`کد ساخته شد:
Code: \`${code}\`
Uses: ${uses}
Expires: ${expires_at ? expires_at.toISOString() : 'بدون انقضا'}
Note: ${note || '-'}
`, { parse_mode: 'Markdown' });
});

// ADMIN: /codes
bot.command('codes', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const { rows } = await pool.query(
    `SELECT code, allowed_uses, used_count, expires_at, active, note
     FROM membership_codes
     WHERE active = TRUE
     ORDER BY created_at DESC
     LIMIT 20`
  );
  if (!rows.length) return ctx.reply('هیچ کد فعالی نیست.');
  const lines = rows.map(r => {
    const remain = r.allowed_uses - r.used_count;
    return `• ${r.code} | باقی‌مانده: ${remain} | انقضا: ${r.expires_at ? r.expires_at.toISOString() : '—'} | ${r.note || ''}`;
  });
  await ctx.reply(lines.join('\n'));
});

// ADMIN: /revoke CODE
bot.command('revoke', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const code = ctx.message.text.trim().split(/\s+/)[1]?.toUpperCase();
  if (!code) return ctx.reply('فرمت: /revoke CODE');
  const { rowCount } = await pool.query('UPDATE membership_codes SET active = FALSE WHERE code = $1', [code]);
  await ctx.reply(rowCount ? 'کُد غیرفعال شد ✅' : 'چنین کدی پیدا نشد ❌');
});

// ADMIN: /members
bot.command('members', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM members');
  await ctx.reply(`تعداد اعضا: ${rows[0].c}`);
});

// Express + Webhook
const app = express();
app.use(express.json());
const webhookPath = `/webhook/${WEBHOOK_SECRET}`;
app.use(bot.webhookCallback(webhookPath, { secretToken: WEBHOOK_SECRET }));

app.get('/', (_, res) => res.status(200).send('OK'));

app.listen(PORT, async () => {
  await initDb();
  const baseUrl = process.env.APP_URL || process.env.RENDER_EXTERNAL_URL;
  if (!baseUrl) {
    console.log('Service started. Waiting for domain to set webhook...');
    return;
  }
  const url = `${baseUrl}${webhookPath}`;
  try {
    await bot.telegram.setWebhook(url, { secret_token: WEBHOOK_SECRET });
    console.log('Webhook set to:', url);
  } catch (e) {
    console.error('setWebhook failed:', e);
  }
});
