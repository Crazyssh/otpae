const db = require('./db');

// Tabel counter (atomic counter buat sequential ID)
db.exec(`CREATE TABLE IF NOT EXISTS counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);`);

// Seed counter sekali aja: dari MAX public_id 8-digit yang udah ada
// (kalau belum ada order, mulai dari 0 → ID pertama jadi 00000001)
const exists = db.prepare(`SELECT 1 FROM counters WHERE name = 'order_id'`).get();
if (!exists) {
  const row = db.prepare(
    `SELECT MAX(CAST(public_id AS INTEGER)) as m FROM orders WHERE CAST(public_id AS INTEGER) <= 99999999`
  ).get();
  const start = row?.m || 0;
  db.prepare(`INSERT INTO counters (name, value) VALUES ('order_id', ?)`).run(start);
  console.log(`[INIT] Order counter seeded at ${start}`);
}

const incrementStmt = db.prepare(
  `UPDATE counters SET value = value + 1 WHERE name = 'order_id' RETURNING value`
);

const checkStmt = db.prepare('SELECT 1 FROM orders WHERE public_id = ?');

/**
 * Generate next sequential public order ID, zero-padded ke 8 digit.
 * 00000001, 00000002, ..., 99999999
 *
 * Atomik via SQLite UPDATE...RETURNING.
 * Kalau (sangat jarang) ID hasil ke-collision sama order lama, lanjut increment.
 */
function generatePublicId() {
  for (let i = 0; i < 100; i++) {
    const r = incrementStmt.get();
    const num = r.value;
    if (num > 99_999_999) {
      throw new Error('Counter order_id sudah lebih dari 99999999. Reset diperlukan.');
    }
    const id = String(num).padStart(8, '0');
    if (!checkStmt.get(id)) return id;
    // Sangat jarang: ada order existing dengan ID 8-digit yang sama.
    // Loop lagi (counter sudah di-increment, jadi next call dapet angka berikutnya).
  }
  throw new Error('Gagal generate public_id setelah 100 percobaan');
}

module.exports = { generatePublicId };
