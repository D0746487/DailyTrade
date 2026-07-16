@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 台股交易模擬器啟動中... http://localhost:8800
start "" http://localhost:8800
python server.py
pause
