// --- کُد با فرمت: یک حرف A-Z + شش رقم ---
const crypto = require('crypto');

function randomLetterAZ() {
  // 0..25 → A..Z
  return String.fromCharCode(65 + crypto.randomInt(26));
}
function randomDigits(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += crypto.randomInt(10); // 0..9
  return s;
}
function randomCodeAZ6() {
  return randomLetterAZ() + randomDigits(6); // مثال: K482913
}

// تضمین یکتایی روی members.my_code
async function generateUniqueCode() {
  for (let i = 0; i < 6; i++) {
    const c = randomCodeAZ6();
    const { rows } = await pool.query(`SELECT 1 FROM members WHERE my_code = $1`, [c]);
    if (!rows.length) return c;
  }
  // احتمال بسیار کمِ برخورد مکرر: یک بار دیگر با تغییر رقم آخر
  return randomLetterAZ() + randomDigits(7).slice(1);
}
