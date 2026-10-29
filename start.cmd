@echo off
rem Double-click, or run from a terminal. Builds and starts the app on
rem http://localhost:3000; start.mjs does the work. Needs Node.js 22 or newer.
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install Node.js 22 from https://nodejs.org and run this again.
  pause
  exit /b 1
)
node "%~dp0start.mjs" %*
pause
