const EventEmitter = require('events');
const db = require('./db');
const jasaotp = require('./jasaotp');

const emitter = new EventEmitter();
emitter.setMaxListeners(0); // unlimited subscribers

const activePollers = new Map(); // public_id -> intervalId

const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '5000');
const POLL_TIMEOUT_MS = parseInt(process.env.POLL_TIMEOUT_MS || '300000'); // 5 menit

/**
 * Mulai polling OTP ke JasaOTP buat order tertentu.
 * Otomatis stop kalau OTP udah masuk, error fatal, atau timeout.
 */
function startPolling(publicId) {
  if (activePollers.has(publicId)) return;

  const order = db
    .prepare('SELECT upstream_id, status FROM orders WHERE public_id = ?')
    .get(publicId);
  if (!order) return;
  if (order.status === 'received' || order.status === 'cancelled') return;

  const startedAt = Date.now();
  console.log(`[POLLER] Mulai polling order ${publicId} (upstream=${order.upstream_id})`);

  const tick = async () => {
    try {
      // Cek timeout
      if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
        stopPolling(publicId);
        db.prepare(
          `UPDATE orders SET status = 'timeout', updated_at = ? WHERE public_id = ? AND status = 'pending'`
        ).run(Date.now(), publicId);
        emitter.emit(publicId, { type: 'timeout', public_id: publicId });
        return;
      }

      const result = await jasaotp.sms(order.upstream_id);

      if (result.success && result.data?.otp) {
        const otp = result.data.otp;
        db.prepare(
          `UPDATE orders SET otp = ?, status = 'received', updated_at = ? WHERE public_id = ?`
        ).run(otp, Date.now(), publicId);

        emitter.emit(publicId, { type: 'otp', public_id: publicId, otp });
        stopPolling(publicId);
        console.log(`[POLLER] OTP diterima order ${publicId}: ${otp}`);
      }
    } catch (err) {
      // Lanjut polling walau ada error sementara
      console.error(`[POLLER] Error polling ${publicId}:`, err.message);
    }
  };

  // Tick langsung sekali, lalu interval
  tick();
  const intervalId = setInterval(tick, POLL_INTERVAL_MS);
  activePollers.set(publicId, intervalId);
}

function stopPolling(publicId) {
  const intervalId = activePollers.get(publicId);
  if (intervalId) {
    clearInterval(intervalId);
    activePollers.delete(publicId);
  }
}

/**
 * Subscribe ke event order tertentu (buat SSE).
 */
function subscribe(publicId, callback) {
  emitter.on(publicId, callback);
  return () => emitter.off(publicId, callback);
}

/**
 * Resume polling untuk semua order yg masih pending pas server restart.
 */
function resumePending() {
  const pending = db
    .prepare(`SELECT public_id FROM orders WHERE status = 'pending'`)
    .all();
  for (const row of pending) startPolling(row.public_id);
  if (pending.length > 0) {
    console.log(`[POLLER] Resume ${pending.length} order pending`);
  }
}

module.exports = { startPolling, stopPolling, subscribe, resumePending };
