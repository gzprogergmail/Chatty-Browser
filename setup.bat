@echo off
echo Installing Self-Contained Browser Agent...
echo.

echo Step 1: Installing Node.js dependencies...
call npm install
if errorlevel 1 (
    echo Failed to install dependencies
    exit /b 1
)
echo.

echo Step 2: Installing Playwright browsers...
call npx playwright install chromium
if errorlevel 1 (
    echo Failed to install Playwright browsers
    exit /b 1
)
echo.

echo Step 3: Building TypeScript project...
call npm run build
if errorlevel 1 (
    echo Failed to build project
    exit /b 1
)
echo.

echo ========================================
echo Setup complete!
echo ========================================
echo.
echo To run the agent:
echo   npm start
echo.
echo Or in development mode:
echo   npm run dev
echo.
pause
