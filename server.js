require('dotenv').config();
const express = require('express');
const path = require('path');
const cron = require('node-cron');
const db = require('./db');
const jasaotp = require('./jasaotp');
const { syncAll, syncBalance } = require('./sync');
const poller = require('./poller');
const { generatePublicId } = require('./idgen');
const { isValidOtp } = require('./otp-utils');
const auth = require('./auth');
const settings = require('./settings');

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.ADMIN_PASSWORD) {
  console.error('[ERROR] ADMIN_PASSWORD belum diisi di file .env');
  process.exit(1);
}

app.use(express.json());

const now = () => Date.now();

function getOrderByPublicId(publicId) {
  return db.prepare('SELECT * FROM orders WHERE public_id = ?').get(publicId);
}

function publicOrder(row) {
  if (!row) return null;
  return {
    order_id: row.public_id,
    number: row.number,
    negara: row.id_negara,
    layanan: row.layanan,
    operator: row.operator,
    otp: row.otp,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// === ROOT & STATIC ===

// Root: redirect ke docs
app.get('/', (req, res) => res.redirect('/docs'));

// API docs (public)
app.get('/docs', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'docs.html'));
});

// === ADMIN AUTH ROUTES ===

app.get('/admin/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin', 'login.html'));
});

app.post('/admin/api/login', (req, res) => {
  const { password } = req.body || {};
  if (!auth.checkAdminPassword(password)) {
    return res.status(401).json({ success: false, message: 'Password salah' });
  }
  const token = auth.createAdminSession();
  res.set(
    'Set-Cookie',
    `admin_token=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${7 * 24 * 60 * 60}`
  );
  res.json({ success: true });
});

app.post('/admin/api/logout', auth.requireAdmin, (req, res) => {
  auth.deleteAdminSession(req.adminToken);
  res.set('Set-Cookie', 'admin_token=; HttpOnly; Path=/; Max-Age=0');
  res.json({ success: true });
});

// Halaman admin
app.get('/admin', auth.requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html'));
});

// === ADMIN API ===

app.get('/admin/api/stats', auth.requireAdmin, (req, res) => {
  const saldo = db.prepare('SELECT saldo FROM saldo WHERE id = 1').get()?.saldo || 0;
  const totalOrders = db.prepare('SELECT COUNT(*) as c FROM orders').get().c;

  // Breakdown by status
  const statusRows = db.prepare(`SELECT status, COUNT(*) as c FROM orders GROUP BY status`).all();
  const byStatus = { pending: 0, received: 0, cancelled: 0, timeout: 0 };
  for (const r of statusRows) byStatus[r.status] = r.c;

  // Success rate
  const finished = byStatus.received + byStatus.cancelled + byStatus.timeout;
  const successRate = finished > 0 ? Math.round((byStatus.received / finished) * 100) : 0;

  // Time-window stats
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const monthAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

  const todayOrders = db.prepare(`SELECT COUNT(*) as c FROM orders WHERE created_at >= ?`).get(dayAgo).c;
  const todayReceived = db.prepare(`SELECT COUNT(*) as c FROM orders WHERE created_at >= ? AND status = 'received'`).get(dayAgo).c;
  const weekOrders = db.prepare(`SELECT COUNT(*) as c FROM orders WHERE created_at >= ?`).get(weekAgo).c;
  const weekReceived = db.prepare(`SELECT COUNT(*) as c FROM orders WHERE created_at >= ? AND status = 'received'`).get(weekAgo).c;
  const monthOrders = db.prepare(`SELECT COUNT(*) as c FROM orders WHERE created_at >= ?`).get(monthAgo).c;
  const monthReceived = db.prepare(`SELECT COUNT(*) as c FROM orders WHERE created_at >= ? AND status = 'received'`).get(monthAgo).c;

  // Daily chart (last 14 days)
  const chartDays = 14;
  const dayMs = 24 * 60 * 60 * 1000;
  const startOfTodayLocal = new Date();
  startOfTodayLocal.setHours(0, 0, 0, 0);
  const startOfToday = startOfTodayLocal.getTime();
  const chart = [];
  for (let i = chartDays - 1; i >= 0; i--) {
    const dayStart = startOfToday - i * dayMs;
    const dayEnd = dayStart + dayMs;
    const total = db.prepare(`SELECT COUNT(*) as c FROM orders WHERE created_at >= ? AND created_at < ?`).get(dayStart, dayEnd).c;
    const received = db.prepare(`SELECT COUNT(*) as c FROM orders WHERE created_at >= ? AND created_at < ? AND status = 'received'`).get(dayStart, dayEnd).c;
    chart.push({
      date: new Date(dayStart).toISOString().slice(0, 10),
      total,
      received,
      failed: total - received,
    });
  }

  // Top layanan
  const topLayanan = db.prepare(`
    SELECT layanan, COUNT(*) as total,
      SUM(CASE WHEN status = 'received' THEN 1 ELSE 0 END) as received
    FROM orders GROUP BY layanan ORDER BY total DESC LIMIT 10
  `).all();

  // Top negara
  const topNegara = db.prepare(`
    SELECT o.id_negara, COALESCE(n.nama_negara, '?') as nama_negara, COUNT(*) as total,
      SUM(CASE WHEN o.status = 'received' THEN 1 ELSE 0 END) as received
    FROM orders o LEFT JOIN negara n ON n.id_negara = o.id_negara
    GROUP BY o.id_negara ORDER BY total DESC LIMIT 10
  `).all();

  const activeKeys = db.prepare(`SELECT COUNT(*) as c FROM api_keys WHERE active = 1`).get().c;
  const syncLog = db.prepare(`SELECT * FROM sync_log ORDER BY id DESC LIMIT 20`).all();

  res.json({
    saldo,
    total_orders: totalOrders,
    by_status: byStatus,
    success_rate: successRate,
    today: { total: todayOrders, received: todayReceived },
    week: { total: weekOrders, received: weekReceived },
    month: { total: monthOrders, received: monthReceived },
    chart,
    top_layanan: topLayanan,
    top_negara: topNegara,
    active_keys: activeKeys,
    sync_log: syncLog,
    // Backward compat
    pending_orders: byStatus.pending,
  });
});

// Statistik per API key
app.get('/admin/api/keys/stats', auth.requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT k.id, k.name, k.active, k.created_at, k.last_used_at,
      COALESCE(s.total, 0) as total_orders,
      COALESCE(s.received, 0) as received,
      COALESCE(s.cancelled, 0) as cancelled,
      COALESCE(s.timeout, 0) as timeout_count,
      COALESCE(s.pending, 0) as pending
    FROM api_keys k
    LEFT JOIN (
      SELECT api_key_id,
        COUNT(*) as total,
        SUM(CASE WHEN status = 'received' THEN 1 ELSE 0 END) as received,
        SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled,
        SUM(CASE WHEN status = 'timeout' THEN 1 ELSE 0 END) as timeout,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending
      FROM orders WHERE api_key_id IS NOT NULL GROUP BY api_key_id
    ) s ON s.api_key_id = k.id
    ORDER BY k.id DESC
  `).all();
  res.json(rows);
});

app.get('/admin/api/keys', auth.requireAdmin, (req, res) => {
  res.json(auth.listApiKeys());
});

app.post('/admin/api/keys', auth.requireAdmin, (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) {
    return res.status(400).json({ success: false, message: 'Nama wajib diisi' });
  }
  const created = auth.createApiKey(name.trim());
  res.json({ success: true, data: created });
});

app.patch('/admin/api/keys/:id', auth.requireAdmin, (req, res) => {
  const { active } = req.body || {};
  if (active) auth.activateApiKey(req.params.id);
  else auth.revokeApiKey(req.params.id);
  res.json({ success: true });
});

app.delete('/admin/api/keys/:id', auth.requireAdmin, (req, res) => {
  auth.deleteApiKey(req.params.id);
  res.json({ success: true });
});

app.get('/admin/api/orders', auth.requireAdmin, (req, res) => {
  const { status } = req.query;
  const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
  let rows;
  if (status) {
    rows = db.prepare(`SELECT * FROM orders WHERE status = ? ORDER BY created_at DESC LIMIT ?`).all(status, limit);
  } else {
    rows = db.prepare(`SELECT * FROM orders ORDER BY created_at DESC LIMIT ?`).all(limit);
  }
  res.json(rows);
});

app.post('/admin/api/orders/:id/cancel', auth.requireAdmin, async (req, res) => {
  const order = getOrderByPublicId(req.params.id);
  if (!order) return res.status(404).json({ success: false, message: 'Order tidak ditemukan' });
  try {
    const result = await jasaotp.cancel(order.upstream_id);
    if (result.success) {
      db.prepare(`UPDATE orders SET status = 'cancelled', updated_at = ? WHERE public_id = ?`).run(now(), req.params.id);
      poller.stopPolling(req.params.id);
      syncBalance().catch(() => {});
    }
    res.json({ success: result.success, message: result.message });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/admin/api/sync', auth.requireAdmin, async (req, res) => {
  try {
    await syncAll();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ===== Settings (JasaOTP API key, dll) =====
app.get('/admin/api/settings', auth.requireAdmin, (req, res) => {
  const key = settings.getJasaOtpKey();
  const baseUrl = settings.getJasaOtpBaseUrl();
  // Mask key biar tidak full kelihatan
  const masked = key
    ? key.length > 10
      ? key.slice(0, 6) + '*'.repeat(Math.max(4, key.length - 10)) + key.slice(-4)
      : '****'
    : '';
  res.json({
    jasaotp_api_key: masked,
    jasaotp_api_key_set: !!key,
    jasaotp_base_url: baseUrl,
  });
});

app.post('/admin/api/settings', auth.requireAdmin, (req, res) => {
  const { jasaotp_api_key, jasaotp_base_url } = req.body || {};
  if (typeof jasaotp_api_key === 'string' && jasaotp_api_key.trim()) {
    settings.set('jasaotp_api_key', jasaotp_api_key.trim());
  }
  if (typeof jasaotp_base_url === 'string' && jasaotp_base_url.trim()) {
    settings.set('jasaotp_base_url', jasaotp_base_url.trim().replace(/\/+$/, ''));
  }
  res.json({ success: true });
});

// Test koneksi ke JasaOTP pake API key yang aktif
app.post('/admin/api/settings/test', auth.requireAdmin, async (req, res) => {
  try {
    const result = await jasaotp.balance();
    if (result?.success) {
      res.json({ success: true, message: 'Koneksi OK', saldo: result.data?.saldo });
    } else {
      res.json({ success: false, message: result?.message || 'JasaOTP balas gagal' });
    }
  } catch (err) {
    res.status(200).json({ success: false, message: err.response?.data?.message || err.message });
  }
});

// Repair order yang status 'received' tapi OTP-nya bukan angka (bug lama)
app.post('/admin/api/orders/repair', auth.requireAdmin, (req, res) => {
  // Cari semua order received yang OTP-nya bukan digit murni
  const bad = db.prepare(`SELECT public_id, otp FROM orders WHERE status = 'received'`).all()
    .filter(r => !isValidOtp(r.otp));
  for (const r of bad) {
    db.prepare(`UPDATE orders SET status = 'pending', otp = NULL, updated_at = ? WHERE public_id = ?`).run(now(), r.public_id);
    poller.startPolling(r.public_id);
  }
  res.json({ success: true, fixed: bad.length });
});

// === V1 PUBLIC API (require API key) ===

const v1 = express.Router();
v1.use(auth.requireApiKey);

// Saldo (dari DB)
v1.get('/balance', (req, res) => {
  const row = db.prepare('SELECT saldo, updated_at FROM saldo WHERE id = 1').get();
  if (!row) return res.status(404).json({ code: 404, success: false, message: 'Saldo belum disinkronkan' });
  res.json({
    code: 200, success: true,
    message: 'Berhasil mengambil saldo dari cache.',
    data: { saldo: row.saldo, updated_at: row.updated_at },
  });
});

v1.get('/negara', (req, res) => {
  const rows = db.prepare('SELECT id_negara, nama_negara FROM negara ORDER BY id_negara').all();
  res.json({ code: 200, success: true, message: 'Berhasil mengambil daftar negara.', data: rows });
});

v1.get('/operator', (req, res) => {
  const { negara } = req.query;
  if (!negara) return res.status(400).json({ code: 400, success: false, message: 'Parameter negara wajib diisi' });
  const rows = db.prepare('SELECT nama_operator FROM operator WHERE id_negara = ?').all(negara);
  res.json({
    code: 200, success: true,
    message: 'Berhasil mendapatkan daftar operator.',
    data: { [negara]: rows.map((r) => r.nama_operator) },
  });
});

v1.get('/layanan', (req, res) => {
  const { negara } = req.query;
  if (!negara) return res.status(400).json({ code: 400, success: false, message: 'Parameter negara wajib diisi' });
  const rows = db.prepare('SELECT kode, nama_layanan, harga, stok FROM layanan WHERE id_negara = ?').all(negara);
  const obj = {};
  for (const r of rows) obj[r.kode] = { harga: r.harga, stok: r.stok, layanan: r.nama_layanan };
  res.json({ code: 200, success: true, message: 'Berhasil mengambil layanan.', data: { [negara]: obj } });
});

v1.get('/order', async (req, res) => {
  const { negara, layanan, operator } = req.query;
  if (!negara || !layanan || !operator) {
    return res.status(400).json({ code: 400, success: false, message: 'Parameter negara, layanan, dan operator wajib diisi' });
  }
  try {
    const result = await jasaotp.order(negara, layanan, operator);
    if (!result.success || !result.data) {
      return res.status(result.code || 400).json(result);
    }
    const upstreamId = result.data.order_id;
    const number = result.data.number;
    const publicId = generatePublicId();

    db.prepare(
      `INSERT INTO orders (public_id, upstream_id, api_key_id, id_negara, layanan, operator, number, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
    ).run(publicId, upstreamId, req.apiKey.id, Number(negara), layanan, operator, number, now(), now());

    poller.startPolling(publicId);
    syncBalance().catch(() => {});

    res.json({
      code: 200, success: true, message: 'Order berhasil.',
      data: { order_id: publicId, number },
    });
  } catch (err) {
    res.status(500).json({ code: 500, success: false, message: err.message });
  }
});

v1.get('/sms', async (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ code: 400, success: false, message: 'Parameter id wajib diisi' });
  const order = getOrderByPublicId(id);
  if (!order) return res.status(404).json({ code: 404, success: false, message: 'Order tidak ditemukan' });
  if (order.api_key_id && order.api_key_id !== req.apiKey.id) {
    return res.status(403).json({ code: 403, success: false, message: 'Order ini bukan milik API key Anda' });
  }
  if (order.otp) {
    return res.json({ code: 200, success: true, message: 'Berhasil mengambil OTP.', data: { otp: order.otp } });
  }
  // Status terminal (cancelled/timeout) → balas info-nya, tapi tetap HTTP 200
  if (order.status === 'cancelled') {
    return res.json({ code: 200, success: false, message: 'Pesanan dibatalkan.', data: { otp: 'Dibatalkan', status: 'cancelled' } });
  }
  if (order.status === 'timeout') {
    return res.json({ code: 200, success: false, message: 'Pesanan timeout, OTP tidak diterima.', data: { otp: 'Timeout', status: 'timeout' } });
  }
  poller.startPolling(id);
  try {
    const result = await jasaotp.sms(order.upstream_id);
    const otp = result?.data?.otp;
    if (result?.success && isValidOtp(otp)) {
      const otpClean = String(otp).trim();
      db.prepare(`UPDATE orders SET otp = ?, status = 'received', updated_at = ? WHERE public_id = ?`).run(otpClean, now(), id);
      poller.stopPolling(id);
      return res.json({ code: 200, success: true, message: 'Berhasil mengambil OTP.', data: { otp: otpClean } });
    }
    // Pending → MIRROR JasaOTP format persis (code 200, success true, otp "Menunggu")
    return res.json({
      code: 200,
      success: true,
      message: result?.message || 'Masih menunggu kode OTP.',
      data: { otp: 'Menunggu' },
    });
  } catch (err) {
    res.status(500).json({ code: 500, success: false, message: err.message });
  }
});

v1.get('/sms/stream', (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ code: 400, success: false, message: 'Parameter id wajib diisi' });
  const order = getOrderByPublicId(id);
  if (!order) return res.status(404).json({ code: 404, success: false, message: 'Order tidak ditemukan' });
  if (order.api_key_id && order.api_key_id !== req.apiKey.id) {
    return res.status(403).json({ code: 403, success: false, message: 'Order ini bukan milik API key Anda' });
  }

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  if (order.otp) {
    send('otp', { order_id: id, otp: order.otp });
    return res.end();
  }

  send('connected', { order_id: id, status: order.status });
  poller.startPolling(id);

  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);

  const unsubscribe = poller.subscribe(id, (payload) => {
    send(payload.type, payload);
    if (payload.type === 'otp' || payload.type === 'timeout') {
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    }
  });

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

v1.get('/cancel', async (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ code: 400, success: false, message: 'Parameter id wajib diisi' });
  const order = getOrderByPublicId(id);
  if (!order) return res.status(404).json({ code: 404, success: false, message: 'Order tidak ditemukan' });
  if (order.api_key_id && order.api_key_id !== req.apiKey.id) {
    return res.status(403).json({ code: 403, success: false, message: 'Order ini bukan milik API key Anda' });
  }
  try {
    const result = await jasaotp.cancel(order.upstream_id);
    if (result.success) {
      db.prepare(`UPDATE orders SET status = 'cancelled', updated_at = ? WHERE public_id = ?`).run(now(), id);
      poller.stopPolling(id);
      syncBalance().catch(() => {});
    }
    if (result.data?.order_id) result.data.order_id = id;
    res.status(result.code || 200).json(result);
  } catch (err) {
    res.status(500).json({ code: 500, success: false, message: err.message });
  }
});

v1.get('/orders', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 500);
  const rows = db
    .prepare(`SELECT * FROM orders WHERE api_key_id = ? ORDER BY created_at DESC LIMIT ?`)
    .all(req.apiKey.id, limit);
  res.json({ code: 200, success: true, data: rows.map(publicOrder) });
});

v1.get('/orders/:id', (req, res) => {
  const row = getOrderByPublicId(req.params.id);
  if (!row) return res.status(404).json({ code: 404, success: false, message: 'Order tidak ditemukan' });
  if (row.api_key_id && row.api_key_id !== req.apiKey.id) {
    return res.status(403).json({ code: 403, success: false, message: 'Order ini bukan milik API key Anda' });
  }
  res.json({ code: 200, success: true, data: publicOrder(row) });
});

app.use('/v1', v1);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ code: 404, success: false, message: 'Endpoint tidak ditemukan' });
});

// Cron jobs
cron.schedule('0 * * * *', () => {
  console.log('[CRON] Auto sync per jam dimulai');
  syncAll().catch((e) => console.error('[CRON] Error:', e.message));
});
cron.schedule('*/5 * * * *', () => {
  syncBalance().catch(() => {});
});
cron.schedule('0 0 * * *', () => {
  auth.cleanupExpiredSessions();
});

app.listen(PORT, async () => {
  console.log(`[OK] OTP Proxy API jalan di http://localhost:${PORT}`);
  console.log(`     Docs:  http://localhost:${PORT}/docs`);
  console.log(`     Admin: http://localhost:${PORT}/admin`);

  const negaraCount = db.prepare('SELECT COUNT(*) as c FROM negara').get().c;
  if (negaraCount === 0) {
    console.log('[INFO] DB masih kosong, melakukan sync awal...');
    syncAll().catch((e) => console.error('[INIT SYNC ERROR]', e.message));
  }
  poller.resumePending();
});
