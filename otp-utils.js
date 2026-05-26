/**
 * Validasi apakah string yang dikirim JasaOTP itu OTP beneran
 * atau cuma teks status kayak "Menunggu", "Belum ada OTP", dll.
 *
 * OTP standar dari layanan online umumnya 3-10 digit angka.
 */
function isValidOtp(otp) {
  if (otp == null) return false;
  const s = String(otp).trim();
  if (s.length === 0) return false;
  // Strict: hanya digit, 3-10 karakter
  return /^\d{3,10}$/.test(s);
}

module.exports = { isValidOtp };
