@echo off
echo Starting Hotel Accounting App...

REM Start Server
start "Hotel Backend" cmd /k "cd server && npm run dev"

REM Start Client
start "Hotel Frontend" cmd /k "cd client && npm run dev"

echo Application starting...
echo Backend: http://localhost:3010
echo Frontend: http://localhost:5180
pause


cd .gemini\antigravity\hotel-accounting-automation

.\start_app.bat