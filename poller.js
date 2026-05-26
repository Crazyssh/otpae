const EventEmitter = require('events');
const db = require('./db');
const jasaotp = require('./jasaotp');
const { isValidOtp } = require('./otp-utils');

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

const activePollers = new Map(); // public_id -> intervalId

const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '5000');
// Default 30 menit, lebih lama dari JasaOTP biar kita gak lebih dulu nyerah
const POLL_TIMEOUT_MS = parseInt(process.env.POLL_TIMEOUT_MS || '1800000');

/**
 * Cek apakah response JasaOTP nunjukin order udah expired/timeout di sana.
 * Kalau iya, kita stop polling karena gak ada gunanya nunggu lagi.
 */
function isUpstreamTerminal(result) {
  if (!result) return false;
  const msg = String(result.message || '').toLowerCase();
  const otp = String(result?.data?.otp || '').toLowerCase();
  // Tanda-tanda upstream udah berakhir
  return (
    msg.includes('expired') ||
    msg.includes('kadaluarsa') ||
    msg.includes('timeout') ||
    msg.includes('habis') ||
    msg.includes('dibatalkan') ||
    msg.includes('tidak ditemukan') ||
    otp.includes('timeout') ||
    otp.includes('expired') ||
    otp.includes('dibatalkan') ||
    result.code === 404
  );
}

function startPolling(publicId) {
  if (activePollers.has(publicId)) return;

  const order = db
    .prepare('SELECT upstream_id, status FROM orders WHERE public_id = ?')
    .get(publicId);
  if (!order) return;
  if (order.status === 'received' || order.status === 'cancelled' || order.status === 'timeout') return;

  const startedAt = Date.now();
  console.log(`[POLLER] Start polling ${publicId} (upstream=${order.upstream_id})`);

  const tick = async () => {
    try {
      // Hard timeout safety: stop kalau lewat dari MAX biar gak ngepoll selamanya
      if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
        stopPolling(publicId);
        db.prepare(
          `UPDATE orders SET status = 'timeout', updated_at = ? WHERE public_id = ? AND status = 'pending'`
        ).run(Date.now(), publicId);
        emitter.emit(publicId, { type: 'timeout', public_id: publicId });
        console.log(`[POLLER] Hard timeout ${publicId} setelah ${POLL_TIMEOUT_MS / 1000}s`);
        return;
      }

      const result = await jasaotp.sms(order.upstream_id);
      const otp = result?.data?.otp;

      if (result?.success && isValidOtp(otp)) {
        const otpClean = String(otp).trim();
        db.prepare(
          `UPDATE orders SET otp = ?, status = 'received', updated_at = ? WHERE public_id = ?`
        ).run(otpClean, Date.now(), publicId);

        emitter.emit(publicId, { type: 'otp', public_id: publicId, otp: otpClean });
        stopPolling(publicId);
        console.log(`[POLLER] OTP diterima ${publicId}: ${otpClean}`);
        return;
      }

      // Kalau JasaOTP bilang udah expired/cancelled di sana, stop polling
      if (isUpstreamTerminal(result)) {
        stopPolling(publicId);
        db.prepare(
          `UPDATE orders SET status = 'timeout', updated_at = ? WHERE public_id = ? AND status = 'pending'`
        ).run(Date.now(), publicId);
        emitter.emit(publicId, { type: 'timeout', public_id: publicId });
        console.log(`[POLLER] Upstream terminal ${publicId}: ${result?.message}`);
        return;
      }
      // Selain itu (otp "Menunggu", null, dll) → tetap pending, lanjut polling
    } catch (err) {
      console.error(`[POLLER] Error ${publicId}:`, err.message);
    }
  };

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

function subscribe(publicId, callback) {
  emitter.on(publicId, callback);
  return () => emitter.off(publicId, callback);
}

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
