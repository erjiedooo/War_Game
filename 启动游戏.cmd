@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [War_Game] 未找到 Node.js。
  echo 请先安装 Node.js 18 或更高版本，然后重新双击本文件。
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [War_Game] 未找到 npm，请重新安装完整的 Node.js。
  pause
  exit /b 1
)

if not exist "node_modules\express\package.json" (
  echo [War_Game] 首次运行，正在安装依赖...
  call npm install
  if errorlevel 1 (
    echo [War_Game] 依赖安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
)

powershell -NoProfile -Command "try { $r = Invoke-RestMethod -Uri 'http://127.0.0.1:4173/health' -TimeoutSec 2; if ($r.service -eq 'War_Game') { exit 0 } } catch {}; exit 1" >nul 2>nul
if errorlevel 1 (
  start "War_Game 局域网服务器" /min cmd /c "npm start"
)

echo [War_Game] 正在等待服务器启动...
powershell -NoProfile -Command "$ok=$false; 1..20 | ForEach-Object { try { $r=Invoke-RestMethod -Uri 'http://127.0.0.1:4173/health' -TimeoutSec 1; if ($r.service -eq 'War_Game') { $ok=$true; break } } catch {}; Start-Sleep -Milliseconds 300 }; if ($ok) { exit 0 } else { exit 1 }" >nul 2>nul
if errorlevel 1 (
  echo [War_Game] 服务器未能在 4173 端口启动。
  echo 该端口可能已被其他程序占用，请关闭旧的本地服务器后重试。
  pause
  exit /b 1
)

start "" "http://127.0.0.1:4173/"
echo [War_Game] 游戏已经在浏览器中打开。
echo 同一局域网玩家可使用服务器窗口中显示的 LAN 地址加入。
echo 如需停止服务，请关闭标题为“War_Game 局域网服务器”的窗口。
pause
