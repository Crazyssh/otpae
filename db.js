const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const dbPath = path.join(__dirname, 'data.db');
const db = new DatabaseSync(dbPath);

db.exec('PRAGMA journal_mode = WAL;');

// Inisialisasi tabel
db.exec(`
  CREATE TABLE IF NOT EXISTS negara (
    id_negara INTEGER PRIMARY KEY,
    nama_negara TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS operator (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    id_negara INTEGER NOT NULL,
    nama_operator TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(id_negara, nama_operator)
  );

  CREATE TABLE IF NOT EXISTS layanan (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    id_negara INTEGER NOT NULL,
    kode TEXT NOT NULL,
    nama_layanan TEXT,
    harga INTEGER,
    stok INTEGER,
    updated_at INTEGER NOT NULL,
    UNIQUE(id_negara, kode)
  );

  CREATE TABLE IF NOT EXISTS orders (
    public_id TEXT PRIMARY KEY,
    upstream_id INTEGER NOT NULL UNIQUE,
    api_key_id INTEGER,
    id_negara INTEGER,
    layanan TEXT,
    operator TEXT,
    number TEXT,
    otp TEXT,
    status TEXT DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS saldo (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    saldo INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    jenis TEXT NOT NULL,
    sukses INTEGER NOT NULL,
    pesan TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    key TEXT UNIQUE NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS admin_sessions (
    token TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
`);

// Migrasi otomatis: tambah kolom api_key_id ke orders kalau belum ada
try {
  const cols = db.prepare("PRAGMA table_info(orders)").all();
  if (!cols.some((c) => c.name === 'public_id')) {
    db.exec(`
      DROP TABLE IF EXISTS orders;
      CREATE TABLE orders (
        public_id TEXT PRIMARY KEY,
        upstream_id INTEGER NOT NULL UNIQUE,
        api_key_id INTEGER,
        id_negara INTEGER,
        layanan TEXT,
        operator TEXT,
        number TEXT,
        otp TEXT,
        status TEXT DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  } else if (!cols.some((c) => c.name === 'api_key_id')) {
    db.exec(`ALTER TABLE orders ADD COLUMN api_key_id INTEGER;`);
  }
} catch (e) {
  console.error('[DB MIGRATION ERROR]', e.message);
}

module.exports = db;
