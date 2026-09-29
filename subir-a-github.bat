@echo off
chcp 65001 >nul
cd /d "%~dp0"

where git >nul 2>nul
if errorlevel 1 (
  echo No tienes Git instalado. Descargalo de https://git-scm.com/download/win y vuelve a ejecutar esto.
  pause
  exit /b 1
)

if exist release.yml (
  if not exist .github\workflows mkdir .github\workflows
  move /y release.yml .github\workflows\release.yml >nul
)

if not exist .git git init -q -b main

set "GN="
for /f "delims=" %%i in ('git config user.name') do set "GN=%%i"
if not defined GN (
  git config user.name "actuallyniaxx"
  git config user.email "actuallyniaxx@users.noreply.github.com"
)

git add -A
git commit -q -m "Lyricpad 1.0.0: minimal lyrics editor with side-by-side rhymes panel" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git tag v1.0.0 2>nul
git remote remove origin 2>nul
git remote add origin https://github.com/actuallyniaxx/lyricpad.git

echo.
echo Subiendo a GitHub (si te pide iniciar sesion, hazlo en la ventana que se abra)...
git push -u origin main
git push origin v1.0.0
if errorlevel 1 (
  echo.
  echo Algo fallo al subir. Revisa el mensaje de arriba.
  pause
  exit /b 1
)

echo.
echo Listo. En unos minutos tendras el .exe en https://github.com/actuallyniaxx/lyricpad/releases
start "" https://github.com/actuallyniaxx/lyricpad/actions
pause
