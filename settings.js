const db = require('./db');

const cache = new Map();

function get(key, fallback = null) {
  if (cache.has(key)) return cache.get(key);
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  const val = row ? row.value : fallback;
  cache.set(key, val);
  return val;
}

function set(key, value) {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, value == null ? null : String(value), Date.now());
  cache.set(key, value == null ? null : String(value));
}

function clearCache() {
  cache.clear();
}

// Helper khusus untuk JasaOTP API key (with .env fallback)
function getJasaOtpKey() {
  return get('jasaotp_api_key', process.env.JASAOTP_API_KEY || '');
}

function getJasaOtpBaseUrl() {
  return get('jasaotp_base_url', process.env.JASAOTP_BASE_URL || 'https://api.jasaotp.id/v1');
}

module.exports = { get, set, clearCache, getJasaOtpKey, getJasaOtpBaseUrl };
