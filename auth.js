const crypto = require('crypto');
const db = require('./db');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 hari

// === API KEY (untuk web order) ===

function generateApiKey() {
  // Format: sk_<32 hex chars>
  return 'sk_' + crypto.randomBytes(24).toString('hex');
}

function createApiKey(name) {
  const key = generateApiKey();
  const stmt = db.prepare(
    `INSERT INTO api_keys (name, key, active, created_at) VALUES (?, ?, 1, ?)`
  );
  const info = stmt.run(name, key, Date.now());
  return { id: info.lastInsertRowid, name, key };
}

function listApiKeys() {
  return db.prepare(`SELECT id, name, key, active, created_at, last_used_at FROM api_keys ORDER BY id DESC`).all();
}

function revokeApiKey(id) {
  return db.prepare(`UPDATE api_keys SET active = 0 WHERE id = ?`).run(id);
}

function activateApiKey(id) {
  return db.prepare(`UPDATE api_keys SET active = 1 WHERE id = ?`).run(id);
}

function deleteApiKey(id) {
  return db.prepare(`DELETE FROM api_keys WHERE id = ?`).run(id);
}

function findApiKeyByValue(key) {
  return db.prepare(`SELECT * FROM api_keys WHERE key = ? AND active = 1`).get(key);
}

function touchApiKey(id) {
  db.prepare(`UPDATE api_keys SET last_used_at = ? WHERE id = ?`).run(Date.now(), id);
}

// Middleware: cek API key di query atau header
function requireApiKey(req, res, next) {
  const key = req.query.api_key || req.headers['x-api-key'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
  if (!key) {
    return res.status(401).json({ code: 401, success: false, message: 'API key wajib diisi (parameter api_key atau header X-API-Key)' });
  }
  const row = findApiKeyByValue(key);
  if (!row) {
    return res.status(401).json({ code: 401, success: false, message: 'API key tidak valid atau dinonaktifkan' });
  }
  req.apiKey = row;
  touchApiKey(row.id);
  next();
}

// === ADMIN SESSION ===

function createAdminSession() {
  const token = 'adm_' + crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  db.prepare(
    `INSERT INTO admin_sessions (token, created_at, expires_at) VALUES (?, ?, ?)`
  ).run(token, now, now + SESSION_TTL_MS);
  return token;
}

function validateAdminSession(token) {
  if (!token) return false;
  const row = db.prepare(`SELECT * FROM admin_sessions WHERE token = ?`).get(token);
  if (!row) return false;
  if (row.expires_at < Date.now()) {
    db.prepare(`DELETE FROM admin_sessions WHERE token = ?`).run(token);
    return false;
  }
  return true;
}

function deleteAdminSession(token) {
  if (!token) return;
  db.prepare(`DELETE FROM admin_sessions WHERE token = ?`).run(token);
}

function cleanupExpiredSessions() {
  db.prepare(`DELETE FROM admin_sessions WHERE expires_at < ?`).run(Date.now());
}

// Parse cookie sederhana
function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) out[k] = decodeURIComponent(v.join('='));
  }
  return out;
}

// Middleware: cek admin login (untuk halaman + API admin)
function requireAdmin(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies['admin_token'];
  if (!validateAdminSession(token)) {
    if (req.path.startsWith('/admin/api/')) {
      return res.status(401).json({ code: 401, success: false, message: 'Tidak login' });
    }
    return res.redirect('/admin/login');
  }
  req.adminToken = token;
  next();
}

function checkAdminPassword(password) {
  if (!ADMIN_PASSWORD) return false;
  // Constant-time compare
  const a = Buffer.from(password || '');
  const b = Buffer.from(ADMIN_PASSWORD);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = {
  // API key
  createApiKey,
  listApiKeys,
  revokeApiKey,
  activateApiKey,
  deleteApiKey,
  requireApiKey,
  // Admin
  createAdminSession,
  validateAdminSession,
  deleteAdminSession,
  cleanupExpiredSessions,
  requireAdmin,
  checkAdminPassword,
};
