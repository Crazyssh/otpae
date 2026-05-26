const crypto = require('crypto');
const db = require('./db');

const checkStmt = db.prepare('SELECT 1 FROM orders WHERE public_id = ?');

/**
 * Generate public order ID yang unik (10 digit angka).
 * Web order cuma ngeliat ID ini, gak tau ID asli di JasaOTP.
 */
function generatePublicId() {
  for (let i = 0; i < 10; i++) {
    // Random 10 digit number (1000000000 - 9999999999)
    const id = String(crypto.randomInt(1_000_000_000, 9_999_999_999));
    if (!checkStmt.get(id)) return id;
  }
  // Fallback: pake timestamp + random
  return `${Date.now()}${crypto.randomInt(100, 999)}`;
}

module.exports = { generatePublicId };
