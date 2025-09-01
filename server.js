// Membership Club Bot — Phase 1 + Phase 2
// Node.js (>=18) + Telegraf + Express + PostgreSQL (Render)

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
  ADMIN_IDS = '',
} = process.env;

if (!TOKEN || !DATABASE_URL) {
  console.error('Missing env vars: TELEGRAM_BOT_TOKEN or DATABASE_URL');
  process.exit(1);
}

const ADMIN_SET = new Set(ADMIN_IDS.split(',').map(s => s.trim()).filter(Boolean));
const pool = new Pool({ connectionString: DATABASE_URL });
const CODE_REGEX = /^[A-Z][0-9]{6}$/;
const awaitingText = new Map(); // برای سؤالات متنی (فعلاً نداریم ولی ساختار هست)

// --- کدسازی ---
function randomLetterAZ() { return String.fromCharCode(65 + crypto.randomInt(26)); }
function randomDigits(n) { return Array.from({length:n}, ()=>crypto.randomInt(10)).join(''); }
function randomCodeAZ6() { return randomLetterAZ() + randomDigits(6); }
async function generateUniqueCode() {
  for (let i=0;i<6;i++){
    const c = randomCodeAZ6();
    const { rows } = await pool.query(`SELECT 1 FROM members WHERE my_code=$1`, [c]);
    if (!rows.length) return c;
  }
  return randomCodeAZ6();
}
function isAdmin(ctx){ return ADMIN_SET.has(String(ctx.from?.id||'')); }

// --- دیتابیس ---
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS members (
      tg_id BIGINT PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      last_name TEXT,
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      my_code TEXT UNIQUE,
      screening_status TEXT NOT NULL DEFAULT 'pending'
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_members_my_code ON members(my_code);`);

  const { rows: needFix } = await pool.query(`
    SELECT tg_id FROM members
    WHERE my_code IS NULL OR my_code !~ '^[A-Z][0-9]{6}$'
  `);
  for (const r of needFix) {
    const code = await generateUniqueCode();
    await pool.query('UPDATE members SET my_code=$1 WHERE tg_id=$2', [code, r.tg_id]);
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS screening_questions (
      id SERIAL PRIMARY KEY,
      q_text TEXT NOT NULL,
      q_type TEXT NOT NULL CHECK (q_type IN ('mcq','text')),
      options TEXT[] DEFAULT NULL,
      correct_index INT DEFAULT NULL
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS screening_sessions (
      id BIGSERIAL PRIMARY KEY,
      tg_id BIGINT NOT NULL REFERENCES members(tg_id),
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ,
      score INT NOT NULL DEFAULT 0,
      result TEXT,
      UNIQUE (tg_id)
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS screening_answers (
      id BIGSERIAL PRIMARY KEY,
      session_id BIGINT NOT NULL REFERENCES screening_sessions(id) ON DELETE CASCADE,
      question_id INT NOT NULL REFERENCES screening_questions(id),
      answer_text TEXT,
      chosen_index INT,
      is_correct BOOLEAN
    );
  `);
}

async function ensureCodeFormat(tgId) {
  const q = await pool.query('SELECT my_code FROM members WHERE tg_id=$1', [tgId]);
  if (!q.rows.length) return null;
  const current = q.rows[0].my_code;
  if (current && CODE_REGEX.test(current)) return current;
  const newCode = await generateUniqueCode();
  await pool.query('UPDATE members SET my_code=$1 WHERE tg_id=$2', [newCode, tgId]);
  return newCode;
}

// --- کیبوردها ---
function startKeyboard(){ return Markup.keyboard([['📝 ثبت‌نام']]).resize(); }
function memberKeyboard(){
  return { ...Markup.keyboard([['🔑 کُد من','🎯 شروع گزینش']]).resize() };
}

// --- ثبت‌نام و کُد ---
async function handleRegister(ctx) {
  const id = ctx.from.id;
  const exist = await pool.query('SELECT my_code FROM members WHERE tg_id=$1',[id]);
  if (exist.rows.length) {
    const code = await ensureCodeFormat(id);
    return ctx.reply(`شما از قبل عضو هستید ✅\nکُد: \`${code}\``,{parse_mode:'Markdown',...memberKeyboard()});
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const code = await generateUniqueCode();
    await client.query(
      `INSERT INTO members(tg_id,username,first_name,last_name,my_code)
       VALUES($1,$2,$3,$4,$5)`,
      [id, ctx.from.username||null, ctx.from.first_name||null, ctx.from.last_name||null, code]
    );
    await client.query('COMMIT');
    await ctx.reply(`🎉 ثبت‌نام شد.\nکُد: \`${code}\``,{parse_mode:'Markdown',...memberKeyboard()});
  } catch(e){ await client.query('ROLLBACK'); console.error(e); ctx.reply('خطا در ثبت‌نام.'); }
  finally{ client.release(); }
}
async function handleMyCode(ctx){
  const code = await ensureCodeFormat(ctx.from.id);
  if (!code) return ctx.reply('ابتدا ثبت‌نام کنید.', startKeyboard());
  return ctx.reply(`کُد شما: \`${code}\``,{parse_mode:'Markdown',...memberKeyboard()});
}

// --- گزینش ---
async function getOrCreateSession(tgId){
  let {rows}=await pool.query('SELECT id FROM screening_sessions WHERE tg_id=$1',[tgId]);
  if (rows.length) return rows[0].id;
  ({rows}=await pool.query('INSERT INTO screening_sessions(tg_id) VALUES($1) RETURNING id',[tgId]));
  return rows[0].id;
}
async function nextQuestion(sessionId){
  const {rows:ans}=await pool.query('SELECT question_id FROM screening_answers WHERE session_id=$1',[sessionId]);
  const ansSet=new Set(ans.map(r=>r.question_id));
  const {rows:qs}=await pool.query('SELECT * FROM screening_questions ORDER BY id ASC');
  return qs.find(q=>!ansSet.has(q.id))||null;
}
async function askQuestion(ctx,sessionId,q){
  if (!q){
    const {rows:scoreRows}=await pool.query(`
      SELECT COALESCE(SUM(chosen_index+1),0)::int AS score
      FROM screening_answers WHERE session_id=$1`,[sessionId]);
    const score=scoreRows[0].score;
    const {rows:tot}=await pool.query('SELECT COUNT(*)::int AS c FROM screening_questions');
    const totalQ=tot[0].c;
    let grade,interp;
    if (score>=40){grade='A';interp='ذهنیت و آمادگی عالی';}
    else if (score>=32){grade='B';interp='مناسب، با کمی مربی‌گری بهتر می‌شوی';}
    else if (score>=25){grade='C';interp='قابل رشد؛ نیاز به کار روی صبر و فرصت‌محوری';}
    else {grade='D';interp='فعلاً روی مهارت‌های پایه تمرکز کن';}
    await pool.query('UPDATE screening_sessions SET finished_at=NOW(),score=$1,result=$2 WHERE id=$3',
      [score,grade,sessionId]);
    await pool.query('UPDATE members SET screening_status=$1 WHERE tg_id=$2',[grade,ctx.from.id]);
    return ctx.reply(`نتیجه: ${score}/${totalQ*5} → ${grade}\n${interp}`,memberKeyboard());
  }
  if (q.q_type==='mcq'){
    const buttons=(q.options||[]).map((opt,idx)=>[Markup.button.callback(opt,`ans:${q.id}:${idx}`)]);
    await ctx.reply(q.q_text,Markup.inlineKeyboard(buttons));
  } else {
    awaitingText.set(ctx.from.id,{sessionId,questionId:q.id});
    await ctx.reply(`${q.q_text}\n(پاسخ کوتاه خود را بنویسید)`);
  }
}
async function startScreeningWithCode(ctx){
  const {rows}=await pool.query('SELECT my_code,screening_status FROM members WHERE tg_id=$1',[ctx.from.id]);
  if (!rows.length) return ctx.reply('ابتدا ثبت‌نام کنید.', startKeyboard());
  if (rows[0].screening_status==='passed') return ctx.reply('🎉 قبلاً پذیرفته شده‌اید.', memberKeyboard());
  if (rows[0].screening_status==='failed') return ctx.reply('⚠️ رد شده‌اید. با ادمین هماهنگ کنید.', memberKeyboard());
  await ctx.reply('کُد اختصاصی خود را ارسال کنید (حرف + ۶ رقم).');
}
async function verifyCodeAndBegin(ctx,codeText){
  const {rows}=await pool.query('SELECT my_code FROM members WHERE tg_id=$1',[ctx.from.id]);
  if (!rows.length) return ctx.reply('ابتدا ثبت‌نام کنید.');
  if (rows[0].my_code!==codeText) return ctx.reply('کُد واردشده مطابقت ندارد ❌');
  const {rows:qcount}=await pool.query('SELECT COUNT(*)::int AS c FROM screening_questions');
  if (qcount[0].c===0) return ctx.reply('سؤالی ثبت نشده است.', memberKeyboard());
  const sessionId=await getOrCreateSession(ctx.from.id);
  await askQuestion(ctx,sessionId,await nextQuestion(sessionId));
}

// --- Bot ---
const bot=new Telegraf(TOKEN);
bot.start(async ctx=>{
  const q=await pool.query('SELECT my_code FROM members WHERE tg_id=$1',[ctx.from.id]);
  if (q.rows.length){
    const code=await ensureCodeFormat(ctx.from.id);
    return ctx.reply(`✅ عضو هستید.\nکُد: \`${code}\``,{parse_mode:'Markdown',...memberKeyboard()});
  }
  return ctx.reply('سلام! به باشگاه خوش اومدی 🌹', startKeyboard());
});
bot.command('register',handleRegister);
bot.command('mycode',handleMyCode);
bot.hears('📝 ثبت‌نام',handleRegister);
bot.hears('🔑 کُد من',handleMyCode);
bot.hears('🎯 شروع گزینش',startScreeningWithCode);
bot.hears(CODE_REGEX,async ctx=>{
  if (awaitingText.has(ctx.from.id)) return;
  await verifyCodeAndBegin(ctx,ctx.message.text.trim().toUpperCase());
});
bot.on('callback_query',async ctx=>{
  try{
    const d=ctx.callbackQuery.data||'';
    if (!d.startsWith('ans:')) return ctx.answerCbQuery();
    const [,qidStr,idxStr]=d.split(':');const qid=+qidStr;const chosen=+idxStr;
    const sessionId=await getOrCreateSession(ctx.from.id);
    await pool.query(
      `INSERT INTO screening_answers(session_id,question_id,chosen_index,is_correct)
       VALUES($1,$2,$3,NULL) ON CONFLICT DO NOTHING`,
      [sessionId,qid,chosen]
    );
    await ctx.answerCbQuery('✔️ پاسخ ثبت شد');
    await askQuestion(ctx,sessionId,await nextQuestion(sessionId));
  }catch(e){console.error(e);ctx.answerCbQuery('خطا');}
});
bot.on('text',async ctx=>{
  const st=awaitingText.get(ctx.from.id);
  if (!st) return;
  awaitingText.delete(ctx.from.id);
  await pool.query(
    `INSERT INTO screening_answers(session_id,question_id,answer_text,is_correct)
     VALUES($1,$2,$3,NULL)`,[st.sessionId,st.questionId,ctx.message.text.slice(0,2000)]
  );
  await askQuestion(ctx,st.sessionId,await nextQuestion(st.sessionId));
});

// --- Admin ---
bot.command('members',async ctx=>{
  if (!isAdmin(ctx)) return;
  const {rows}=await pool.query('SELECT COUNT(*)::int AS c FROM members');
  ctx.reply(`تعداد اعضا: ${rows[0].c}`);
});
bot.command('findcode',async ctx=>{
  if (!isAdmin(ctx)) return;
  const code=ctx.message.text.split(/\s+/)[1]?.toUpperCase();
  if (!code) return ctx.reply('فرمت: /findcode CODE');
  const {rows}=await pool.query(
    `SELECT tg_id,username,first_name,last_name,joined_at,screening_status
     FROM members WHERE my_code=$1`,[code]);
  if (!rows.length) return ctx.reply('یافت نشد.');
  const u=rows[0];
  ctx.reply(`tg_id:${u.tg_id}\nusername:${u.username}\nname:${u.first_name||''} ${u.last_name||''}\nstatus:${u.screening_status}`);
});

// --- Webhook ---
const app=express();
app.use(express.json());
const webhookPath=`/webhook/${WEBHOOK_SECRET}`;
app.use(bot.webhookCallback(webhookPath,{secretToken:WEBHOOK_SECRET}));
app.get('/',(_,res)=>res.send('OK'));
app.listen(PORT,async()=>{
  await initDb();
  const baseUrl=process.env.APP_URL||process.env.RENDER_EXTERNAL_URL;
  if (!baseUrl) return console.log('Waiting for domain...');
  const url=`${baseUrl}${webhookPath}`;
  try{ await bot.telegram.setWebhook(url,{secret_token:WEBHOOK_SECRET}); console.log('Webhook set:',url);}
  catch(e){console.error('setWebhook failed:',e);}
});
