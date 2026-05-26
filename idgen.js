const crypto = require('crypto');
const db = require('./db');

const checkStmt = db.prepare('SELECT 1 FROM orders WHERE public_id = ?');

/**
 * Generate public order ID 8 digit (mengikuti format JasaOTP).
 * Range: 10000000 - 99999999 (90 juta kombinasi).
 */
function generatePublicId() {
  for (let i = 0; i < 20; i++) {
    const id = String(crypto.randomInt(10_000_000, 100_000_000));
    if (!checkStmt.get(id)) return id;
  }
  // Fallback super langka: pake timestamp + random
  return `${Date.now() % 100_000_000}${crypto.randomInt(10, 99)}`;
}

module.exports = { generatePublicId };
