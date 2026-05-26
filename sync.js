require('dotenv').config();
const db = require('./db');
const jasaotp = require('./jasaotp');

const now = () => Date.now();

function logSync(jenis, sukses, pesan = '') {
  db.prepare(
    'INSERT INTO sync_log (jenis, sukses, pesan, created_at) VALUES (?, ?, ?, ?)'
  ).run(jenis, sukses ? 1 : 0, pesan, now());
}

function tx(fn) {
  db.exec('BEGIN');
  try {
    fn();
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

async function syncBalance() {
  try {
    const res = await jasaotp.balance();
    if (res.success && res.data) {
      db.prepare(
        `INSERT INTO saldo (id, saldo, updated_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET saldo = excluded.saldo, updated_at = excluded.updated_at`
      ).run(res.data.saldo, now());
      logSync('balance', true);
      console.log(`[OK] Saldo disinkronkan: ${res.data.saldo}`);
    }
  } catch (err) {
    logSync('balance', false, err.message);
    console.error('[ERR] Sync saldo:', err.message);
  }
}

async function syncNegara() {
  try {
    const res = await jasaotp.negara();
    if (res.success && Array.isArray(res.data)) {
      const stmt = db.prepare(
        `INSERT INTO negara (id_negara, nama_negara, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(id_negara) DO UPDATE SET nama_negara = excluded.nama_negara, updated_at = excluded.updated_at`
      );
      tx(() => {
        for (const row of res.data) stmt.run(row.id_negara, row.nama_negara, now());
      });
      logSync('negara', true);
      console.log(`[OK] ${res.data.length} negara disinkronkan`);
      return res.data;
    }
  } catch (err) {
    logSync('negara', false, err.message);
    console.error('[ERR] Sync negara:', err.message);
  }
  return [];
}

async function syncOperator(idNegara) {
  try {
    const res = await jasaotp.operator(idNegara);
    if (res.success && res.data) {
      const list = res.data[idNegara] || res.data[String(idNegara)] || [];
      const stmt = db.prepare(
        `INSERT INTO operator (id_negara, nama_operator, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(id_negara, nama_operator) DO UPDATE SET updated_at = excluded.updated_at`
      );
      tx(() => {
        for (const op of list) stmt.run(idNegara, op, now());
      });
      console.log(`[OK] Negara ${idNegara}: ${list.length} operator`);
    }
  } catch (err) {
    console.error(`[ERR] Sync operator negara ${idNegara}:`, err.message);
  }
}

async function syncLayanan(idNegara) {
  try {
    const res = await jasaotp.layanan(idNegara);
    // Response format bisa: { "6": { "wa": {...} } } atau { data: { "6": {...} } }
    const data = res[idNegara] || res[String(idNegara)] || res.data?.[idNegara] || {};
    const entries = Object.entries(data);
    if (entries.length === 0) return;

    const stmt = db.prepare(
      `INSERT INTO layanan (id_negara, kode, nama_layanan, harga, stok, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id_negara, kode) DO UPDATE SET
         nama_layanan = excluded.nama_layanan,
         harga = excluded.harga,
         stok = excluded.stok,
         updated_at = excluded.updated_at`
    );
    tx(() => {
      for (const [kode, info] of entries) {
        stmt.run(
          idNegara,
          kode,
          info.layanan || null,
          info.harga || 0,
          info.stok || 0,
          now()
        );
      }
    });
    console.log(`[OK] Negara ${idNegara}: ${entries.length} layanan`);
  } catch (err) {
    console.error(`[ERR] Sync layanan negara ${idNegara}:`, err.message);
  }
}

async function syncAll() {
  console.log('=== Mulai sync ===');
  await syncBalance();
  const negaraList = await syncNegara();

  for (const n of negaraList) {
    await syncOperator(n.id_negara);
    await syncLayanan(n.id_negara);
  }
  logSync('all', true, `${negaraList.length} negara`);
  console.log('=== Sync selesai ===');
}

if (require.main === module) {
  syncAll().then(() => process.exit(0));
}

module.exports = { syncAll, syncBalance, syncNegara, syncOperator, syncLayanan };
