@echo off
setlocal
cd /d "%~dp0.."
if not exist "bridge\lark-bridge.mjs" (
  echo 未找到 bridge\lark-bridge.mjs，请在 PageStudy 项目目录运行。
  pause
  exit /b 1
)
where lark-cli.cmd >nul 2>nul
if errorlevel 1 (
  echo 未找到 lark-cli.cmd。请先安装并登录飞书 CLI。
  echo 参考 README 的“飞书桥接”章节。
  pause
  exit /b 1
)
node bridge\lark-bridge.mjs
if errorlevel 1 pause
