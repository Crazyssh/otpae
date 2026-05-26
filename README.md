# OTP Proxy API + Database + SSE

Web service yang nyembunyiin API JasaOTP di belakang. Web order cuma berinteraksi sama API bang, gak pernah liat ID asli di JasaOTP.

## Fitur Utama

- **ID Mapping** — order_id yang dikasih ke web order beda dari ID JasaOTP. Web order gak bisa langsung akses JasaOTP.
- **Background Polling** — pas order dibuat, server otomatis polling OTP ke JasaOTP. Web order gak perlu polling sendiri.
- **SSE (Server-Sent Events)** — web order tinggal buka 1 koneksi, dapet OTP real-time pas masuk.
- **Database lokal (SQLite)** — semua data (negara, operator, layanan, order, OTP) disimpen sendiri.
- **Auto resume** — kalau server restart, polling untuk order yg masih pending dilanjut.

## Arsitektur

```
                          ┌─────────────────┐
                          │    Web Bang     │
                          │                 │
[Web Order] ─SSE/HTTP→    │  ┌──────────┐   │  ←HTTP polling─→ [JasaOTP]
                          │  │ SQLite   │   │
                          │  └──────────┘   │
                          └─────────────────┘

ID JasaOTP (1728868)  ←─ MAPPING ─→  ID Bang (5849273011)
                                     ↑
                          web order cuma liat ini
```

## Setup

```
npm install
copy .env.example .env
```

Edit `.env`, isi `JASAOTP_API_KEY`. Lalu:

```
npm start
```

Server jalan di `http://localhost:3000`. Saat pertama jalan, otomatis sync data dari JasaOTP.

## Endpoint

### Cek data dari DB (cepet)

| Method | Endpoint | Query |
|--------|----------|-------|
| GET | `/v1/balance` | - |
| GET | `/v1/negara` | - |
| GET | `/v1/operator` | `negara` |
| GET | `/v1/layanan` | `negara` |

### Operasi order

| Method | Endpoint | Query | Keterangan |
|--------|----------|-------|------------|
| GET | `/v1/order` | `negara`, `layanan`, `operator` | Bikin order, return `order_id` versi web bang |
| GET | `/v1/sms` | `id` | Cek OTP (pake order_id versi web bang) |
| GET | `/v1/sms/stream` | `id` | **SSE** — real-time OTP |
| GET | `/v1/cancel` | `id` | Batalin order |

### History (dari DB)

| Method | Endpoint | Query |
|--------|----------|-------|
| GET | `/v1/orders` | `limit` (opsional, max 500) |
| GET | `/v1/orders/:id` | - |
| POST | `/v1/sync` | - (manual sync) |

## Contoh Alur Pemakaian

### 1. Buat Order

```
GET /v1/order?negara=6&layanan=wa&operator=any
```

Response:
```json
{
  "code": 200,
  "success": true,
  "message": "Order berhasil.",
  "data": {
    "order_id": "5849273011",
    "number": "+6282272111384"
  }
}
```

`5849273011` itu ID versi web bang. ID asli JasaOTP (misal `1728868`) cuma kesimpen di DB, gak pernah di-expose.

### 2A. Subscribe SSE (recommended)

```js
const es = new EventSource('http://server-bang.com/v1/sms/stream?id=5849273011');

es.addEventListener('connected', e => console.log('Standby:', JSON.parse(e.data)));
es.addEventListener('otp', e => {
  const { otp } = JSON.parse(e.data);
  console.log('OTP masuk:', otp);
  es.close();
});
es.addEventListener('timeout', () => {
  console.log('Timeout 5 menit');
  es.close();
});
```

Web order gak perlu polling. Server bang yang ngerjain di background.

### 2B. Atau Polling Biasa

```
GET /v1/sms?id=5849273011
```

Kalau OTP belum masuk, response 202 dengan status pending. Web order ulangin tiap beberapa detik.

### 2C. Atau Cek dari DB

```
GET /v1/orders/5849273011
```

Kalau OTP udah masuk, akan ada di field `otp`.

### 3. Cancel kalau perlu

```
GET /v1/cancel?id=5849273011
```

## Status Order

- `pending` — masih nunggu OTP
- `received` — OTP udah masuk
- `cancelled` — di-cancel manual
- `timeout` — gak masuk dalam 5 menit (bisa diatur di `.env`)

## Auto Sync ke JasaOTP

- Saldo: tiap **5 menit**
- Negara/operator/layanan: tiap **1 jam**
- Sync awal otomatis pas server pertama jalan & DB kosong
