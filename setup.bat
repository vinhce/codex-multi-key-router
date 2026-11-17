@echo off
setlocal enabledelayedexpansion
title Codex Multi-API Key Router Setup

echo ========================================================
echo   Codex Multi-API Key Router - Automated Installer
echo ========================================================
echo.

:: 1. Check Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not found on your system!
    echo Please download and install Node.js from https://nodejs.org/ (v18 or higher).
    echo.
    pause
    exit /b 1
)

for /f "tokens=*" %%i in ('node -v') do set NODE_VER=%%i
echo [OK] Node.js detected: %NODE_VER%

:: 2. Target Directory
set "TARGET_DIR=%USERPROFILE%\.codex\router"
if not exist "%TARGET_DIR%" (
    echo [*] Creating router directory: "%TARGET_DIR%"
    mkdir "%TARGET_DIR%"
)

:: 3. Copy files
echo [*] Copying proxy.js to "%TARGET_DIR%"...
copy /Y "%~dp0proxy.js" "%TARGET_DIR%\proxy.js" >nul

if not exist "%TARGET_DIR%\keys.json" (
    echo [*] Initializing keys.json from template...
    copy /Y "%~dp0keys.example.json" "%TARGET_DIR%\keys.json" >nul
    echo [!] NOTE: Remember to edit "%TARGET_DIR%\keys.json" to add your API keys!
) else (
    echo [OK] Existing keys.json preserved.
)

:: 4. Done
echo.
echo ========================================================
echo   Setup Completed Successfully!
echo ========================================================
echo.
echo Next steps:
echo 1. Add your API keys to:
echo    %TARGET_DIR%\keys.json
echo.
echo 2. Enable MCP integration in %%USERPROFILE%%\.codex\config.toml:
echo.
echo    [mcp_servers.router]
echo    command = "node"
echo    args = ["%TARGET_DIR:\=\\%\\proxy.js"]
echo.
echo 3. Configure OpenAI base_url in %%USERPROFILE%%\.codex\config.toml:
echo.
echo    [model_providers.OpenAI]
echo    name = "OpenAI"
echo    base_url = "http://127.0.0.1:5050/v1"
echo    model_catalog_url = "http://127.0.0.1:5050/v1/models"
echo    wire_api = "responses"
echo    requires_openai_auth = false
echo.
echo See README.md or README.vi.md for complete configuration details.
echo.
pause
