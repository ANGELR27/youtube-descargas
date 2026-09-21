# Descargas YouTube 🎬✂️

App local de escritorio para **descargar videos de YouTube pegando el link** y **crear clips verticales con subtítulos automáticos** estilo TikTok/Shorts.

> Interfaz de carrusel 3D con efecto vidrio helado, todo corre en tu PC (nada se sube a la nube).

## Funciones

- **Descargas**: pega el link → analiza (título, miniatura, canal, duración, descripción) → elige MP4 (calidades reales del video, hasta 4K/8K) o MP3 → barra de progreso en tiempo real con velocidad/ETA → cola de descargas múltiples → guardado en tu carpeta Descargas.
- **Creador de clips**: transcribe el video con IA local (whisper.cpp, con alineación DTW por palabra), detecta automáticamente los momentos con más gancho, y renderiza clips verticales 1080×1920 con **subtítulos karaoke palabra a palabra** en 12 temas de colores, con vista previa, modo manual (tú eliges los momentos) y títulos/hashtags sugeridos.
- **Panel de apps** (opcional): puede registrarse en un panel local para abrir varias apps desde un solo lugar.

## Requisitos

- Windows 10/11
- [Node.js](https://nodejs.org/) (cualquier versión reciente)

## Cómo ejecutar

1. Clona o descarga este repo
2. Doble clic en **`Iniciar.bat`**

La primera vez descarga solo lo necesario (~600 MB, una sola vez):

- `yt-dlp.exe` (motor de descarga, se auto-actualiza al arrancar)
- `ffmpeg.exe` (unión de video/audio y renders)
- `whisper.cpp` + modelo `ggml-small` (subtítulos con IA)

Luego abre `http://localhost:3001` en tu navegador.

## Estructura

```
youtube-descargas/
├── server.js        # API: análisis, descargas en cola, clips, historial
├── clips.js         # Motor de clips: transcripción, ganchos, karaoke, render
├── public/          # Interfaz (carrusel 3D + fondos)
├── Iniciar.bat      # Arranque todo-en-uno (descarga binarios si faltan)
├── bin/             # yt-dlp, ffmpeg, whisper, modelo (no incluido en el repo)
└── data/            # Historial y configuración (no incluido en el repo)
```

## Nota legal

Descarga solo contenido propio, con permiso del autor o donde el uso personal esté permitido; hacerlo con otros contenidos va contra los Términos de Servicio de YouTube. Esta herramienta es para uso personal local.
