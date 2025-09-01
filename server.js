// Membership Club Bot — Code format: ^[A-Z][0-9]{6}$ with reply keyboards
// Stack: Node.js (>=18) + Telegraf + Express + PostgreSQL (Render)

require('dotenv').config();
const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const { Pool } = require('pg');
const crypto = require('crypto');

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
  ADMIN_IDS.split(',').map(s => s.trim()).filter(Boolean)
);

const pool = new Pool({ connectionString: DATABASE_URL });

const CODE_REGEX = /^[A-Z][0-9]{6}$/;

// ----- Code generation -----
function randomLetterAZ() {
  return String.fromCharCode(65 + crypto.randomInt(26)); // A..Z
}
function randomDigits(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += crypto.randomInt(10);
  return s;
}
function randomCodeAZ6() {
  return randomLetterAZ() + randomDigits(6); // e.g., K482913
}
async function generateUniqueCode() {
  for (let i = 0; i < 6; i++) {
    const c = randomCodeAZ6();
    const { rows } = await pool.query(`SELECT 1 FROM members WHERE my_code = $1`, [c]);
    if (!rows.length) return c;
  }
  return randomLetterAZ() + randomDigits(6);
}

function isAdmin(ctx) {
  const id = ctx.from?.id?.toString();
  return ADMIN_SET.has(id);
}

// ----- DB init & backfill -----
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS members (
      tg_id BIGINT PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      last_name TEXT,
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      my_code TEXT UNIQUE
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_members_my_code ON members(my_code);`);

  const { rows: needFix } = await pool.query(`
    SELECT tg_id FROM members
    WHERE my_code IS NULL OR my_code !~ '^[A-Z][0-9]{6}$'
  `);
  if (needFix.length) {
    console.log('Backfilling/upgrading codes to pattern ^[A-Z][0-9]{6}$ ...');
    for (const r of needFix) {
      const code = await generateUniqueCode();
      await pool.query('UPDATE members SET my_code = $1 WHERE tg_id = $2', [code, r.tg_id]);
    }
    console.log('Backfill done for', needFix.length, 'members.');
  }
}

async function ensureCodeFormat(tgId) {
  const q = await pool.query('SELECT my_code FROM members WHERE tg_id = $1', [tgId]);
  if (!q.rows.length) return null;
  const current = q.rows[0].my_code;
  if (current && CODE_REGEX.test(current)) return current;
  const newCode = await generateUniqueCode();
  await pool.query('UPDATE members SET my_code = $1 WHERE tg_id = $2', [newCode, tgId]);
  return newCode;
}

// ----- Helpers for actions (used by commands & buttons) -----
async function handleRegister(ctx) {
  const id = ctx.from.id;
  const exist = await pool.query('SELECT my_code FROM members WHERE tg_id = $1', [id]);
  if (exist.rows.length) {
    const code = await ensureCodeFormat(id);
    return ctx.reply(
      `شما از قبل عضو هستید ✅\nکُد شما: \`${code}\``,
      { parse_mode: 'Markdown', ...memberKeyboard() }
    );
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const code = await generateUniqueCode();
    await client.query(
      `INSERT INTO members (tg_id, username, first_name, last_name, my_code)
       VALUES ($1,$2,$3,$4,$5)`,
      [id, ctx.from.username || null, ctx.from.first_name || null, ctx.from.last_name || null, code]
    );
    await client.query('COMMIT');
    await ctx.reply(
      `🎉 ثبت‌نام شما انجام شد.\nکُد اختصاصی: \`${code}\``,
      { parse_mode: 'Markdown', ...memberKeyboard() }
    );
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Register error:', e);
    await ctx.reply('خطا در ثبت‌نام. لطفاً مجدداً تلاش کنید.');
  } finally {
    client.release();
  }
}

async function handleMyCode(ctx) {
  const id = ctx.from.id;
  const code = await ensureCodeFormat(id);
  if (!code) {
    return ctx.reply('هنوز عضو نشده‌اید. روی «📝 ثبت‌نام» بزنید.', startKeyboard());
  }
  return ctx.reply(`کُد اختصاصی شما: \`${code}\``, { parse_mode: 'Markdown', ...memberKeyboard() });
}

// ----- Keyboards -----
function startKeyboard() {
  return Markup.keyboard([['📝 ثبت‌نام']]).resize();
}
function memberKeyboard() {
  const rows = [['🔑 کُد من']];
  return { ...Markup.keyboard(rows).resize() };
}

const bot = new Telegraf(TOKEN);

// ---------- User commands ----------
bot.start(async (ctx) => {
  const id = ctx.from.id;
  const q = await pool.query('SELECT my_code FROM members WHERE tg_id = $1', [id]);
  if (q.rows.length) {
    const code = await ensureCodeFormat(id);
    return ctx.reply(
      `✅ شما عضو باشگاه هستید.\nکُد اختصاصی شما: \`${code}\``,
      { parse_mode: 'Markdown', ...memberKeyboard() }
    );
  }
  return ctx.reply(
    'سلام! به باشگاه خوش اومدی 🌹\nبرای ادامه یکی از گزینه‌ها رو انتخاب کن:',
    startKeyboard()
  );
});

bot.command('register', handleRegister);
bot.command('mycode', handleMyCode);

// ---------- Buttons (reply keyboard) ----------
bot.hears('📝 ثبت‌نام', handleRegister);
bot.hears('🔑 کُد من', handleMyCode);

// ---------- Admin commands ----------
bot.command('members', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM members');
  await ctx.reply(`تعداد اعضا: ${rows[0].c}`);
});

bot.command('findcode', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const code = ctx.message.text.trim().split(/\s+/)[1]?.toUpperCase();
  if (!code) return ctx.reply('فرمت: /findcode CODE');
  const { rows } = await pool.query(
    `SELECT tg_id, username, first_name, last_name, joined_at
     FROM members WHERE my_code = $1`,
    [code]
  );
  if (!rows.length) return ctx.reply('کاربری با این کُد یافت نشد.');
  const u = rows[0];
  await ctx.reply(
    `Found:
tg_id: ${u.tg_id}
username: ${u.username || '-'}
name: ${(u.first_name || '') + ' ' + (u.last_name || '')}
joined_at: ${new Date(u.joined_at).toISOString()}`
  );
});

// ---------- Webhook ----------
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
