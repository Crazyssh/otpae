const axios = require('axios');

const API_KEY = process.env.JASAOTP_API_KEY;
const BASE_URL = process.env.JASAOTP_BASE_URL || 'https://api.jasaotp.id/v1';
const MAX_RETRIES = parseInt(process.env.JASAOTP_MAX_RETRIES || '3');
const RETRY_DELAY_MS = parseInt(process.env.JASAOTP_RETRY_DELAY_MS || '1500');

const client = axios.create({
  baseURL: BASE_URL,
  timeout: 30000,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(endpoint, params = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await client.get(`/${endpoint}`, {
        params: { api_key: API_KEY, ...params },
      });
      return response.data;
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      // Retry hanya untuk error sementara: 5xx atau network error
      const shouldRetry =
        attempt < MAX_RETRIES && (!status || (status >= 500 && status <= 599) || status === 429);
      if (!shouldRetry) break;
      // Exponential backoff
      const delay = RETRY_DELAY_MS * Math.pow(2, attempt - 1);
      console.warn(`[JasaOTP] ${endpoint} gagal (status=${status || 'network'}), retry ${attempt}/${MAX_RETRIES - 1} dalam ${delay}ms`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

module.exports = {
  balance: () => call('balance.php'),
  negara: () => call('negara.php'),
  operator: (negara) => call('operator.php', { negara }),
  layanan: (negara) => call('layanan.php', { negara }),
  order: (negara, layanan, operator) => call('order.php', { negara, layanan, operator }),
  sms: (id) => call('sms.php', { id }),
  cancel: (id) => call('cancel.php', { id }),
};
