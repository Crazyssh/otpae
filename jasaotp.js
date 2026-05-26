const axios = require('axios');

const API_KEY = process.env.JASAOTP_API_KEY;
const BASE_URL = process.env.JASAOTP_BASE_URL || 'https://api.jasaotp.id/v1';

const client = axios.create({
  baseURL: BASE_URL,
  timeout: 30000,
});

async function call(endpoint, params = {}) {
  const response = await client.get(`/${endpoint}`, {
    params: { api_key: API_KEY, ...params },
  });
  return response.data;
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
