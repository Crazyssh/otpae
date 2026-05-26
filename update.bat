@echo off
REM Pull update terbaru dari GitHub & restart PM2
echo === Update OTPae ===
git pull
if %errorlevel% neq 0 goto :err

echo === Install dependency baru (kalau ada) ===
call npm install --omit=dev
if %errorlevel% neq 0 goto :err

echo === Restart server ===
pm2 restart otp-proxy
echo === Done ===
exit /b 0

:err
echo ERROR: Update gagal
exit /b 1
