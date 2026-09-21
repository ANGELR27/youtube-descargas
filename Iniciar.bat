@echo off
title Descargas YouTube
cd /d "%~dp0"

rem Primera vez: descargar el motor de descarga (yt-dlp)
if not exist "bin\yt-dlp.exe" (
  echo Primera vez: descargando yt-dlp, espera un momento...
  if not exist "bin" mkdir "bin"
  powershell -NoProfile -Command "Invoke-WebRequest -Uri 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe' -OutFile 'bin\yt-dlp.exe'"
)

rem Primera vez: descargar ffmpeg (necesario para 1080p y MP3)
if not exist "bin\ffmpeg.exe" (
  echo Primera vez: descargando ffmpeg, espera un momento...
  if not exist "bin" mkdir "bin"
  powershell -NoProfile -Command "Invoke-WebRequest -Uri 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' -OutFile 'bin\ffmpeg.zip'; Expand-Archive -Force 'bin\ffmpeg.zip' 'bin\ffmpeg_tmp'; Copy-Item 'bin\ffmpeg_tmp\*\bin\ffmpeg.exe' 'bin\'; Copy-Item 'bin\ffmpeg_tmp\*\bin\ffprobe.exe' 'bin\'; Remove-Item -Recurse -Force 'bin\ffmpeg_tmp'; Remove-Item -Force 'bin\ffmpeg.zip'"
)

rem Primera vez: descargar el motor de clips (whisper) y su modelo de subtítulos
if not exist "bin\whisper\main.exe" (
  echo Primera vez: descargando motor de clips...
  if not exist "bin\whisper" mkdir "bin\whisper"
  if not exist "bin\models" mkdir "bin\models"
  powershell -NoProfile -Command "Invoke-WebRequest -Uri 'https://github.com/ggml-org/whisper.cpp/releases/download/b5130/whisper-blas-bin-x64.zip' -OutFile 'bin\whisper.zip'; Expand-Archive -Force 'bin\whisper.zip' 'bin\whisper_tmp'; Copy-Item 'bin\whisper_tmp\Release\*' 'bin\whisper\'; Remove-Item -Recurse -Force 'bin\whisper_tmp'; Remove-Item -Force 'bin\whisper.zip'"
)
if not exist "bin\models\ggml-small.bin" (
  echo Primera vez: descargando modelo de subtitulos automaticos (466 MB, una sola vez)...
  if not exist "bin\models" mkdir "bin\models"
  powershell -NoProfile -Command "Invoke-WebRequest -Uri 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin' -OutFile 'bin\models\ggml-small.bin'"
)

if not exist node_modules (
  echo Primera vez: instalando componentes...
  call npm install --no-audit --no-fund
)

echo.
echo  ============================================
echo   Descargas YouTube - abriendo en tu navegador
echo   NO cierres esta ventana mientras descargas.
echo  ============================================
echo.

start "" cmd /c "timeout /t 2 /nobreak >nul & start "" http://localhost:3001"
node server.js
pause
