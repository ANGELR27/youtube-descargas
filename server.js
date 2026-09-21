/*
 * Descargas YouTube — descarga pegando el link (uso personal)
 * Servidor local: analiza la URL con yt-dlp, descarga en MP4 (varias calidades)
 * o MP3 a la carpeta Descargas de Windows, con cola de descargas múltiples
 * e historial persistente que alimenta el carrusel de la interfaz.
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const clips = require('./clips');

const ROOT = __dirname;
const BIN_DIR = path.join(ROOT, 'bin');
const DATA_DIR = path.join(ROOT, 'data');
const HISTORIAL_FILE = path.join(DATA_DIR, 'historial.json');
const YTDLP = path.join(BIN_DIR, 'yt-dlp.exe');
const DESCARGAS_DIR = path.join(process.env.USERPROFILE, 'Downloads');
const PORT = 3001;
const MAX_HISTORIAL = 50;

// Reintento con cookies del navegador cuando YouTube pide verificación
const NAVEGADORES = ['chrome', 'edge', 'firefox'];
const ERROR_AUTH = /sign in to confirm|cookies|inicia sesi|log in|age-?restricted|restringida|private video|not a bot|\bbot\b/i;
const MINUTOS_SIN_AVANCE = 5; // watchdog: abortar si no hay progreso

// Fases de posproceso de yt-dlp/ffmpeg (se muestran en la card)
const FASES = {
  ExtractAudio: 'Convirtiendo a MP3…',
  Merger: 'Uniendo video + audio…',
  VideoRemuxer: 'Preparando MP4…',
  Metadata: 'Escribiendo metadatos…',
  EmbedThumbnail: 'Insertando portada…',
  FixupM3u8: 'Corrigiendo transmisión…'
};

if (!fs.existsSync(YTDLP)) {
  console.error('Falta bin\\yt-dlp.exe. Ejecuta Iniciar.bat para descargarlo.');
  process.exit(1);
}
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const app = express();
app.use(express.json());
app.use(express.static(path.join(ROOT, 'public')));

// ---------- Utilidades ----------
function esUrlYouTube(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    return ['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'youtube-nocookie.com'].includes(host);
  } catch { return false; }
}

function idDesdeUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes('youtu.be')) return u.pathname.slice(1).split('/')[0] || null;
    return u.searchParams.get('v') || u.pathname.split('/').pop() || null;
  } catch { return null; }
}

function limpiarError(msg) {
  const linea = msg.split('\n').find(l => l.startsWith('ERROR:')) || msg.split('\n')[0] || 'Error desconocido';
  return linea.replace(/^ERROR:\s*/, '').replace(/\s*\[youtube\].*$/, '').trim() || 'Error desconocido';
}

// Las miniaturas firmadas de YouTube expiran: usar la URL estable sin parámetros
function miniaturaEstable(urlVideo) {
  const vid = idDesdeUrl(urlVideo);
  return vid ? `https://i.ytimg.com/vi/${vid}/hqdefault.jpg` : null;
}

function textoDuracion(seg) {
  if (!seg && seg !== 0) return null;
  const h = Math.floor(seg / 3600), m = Math.floor((seg % 3600) / 60), s = seg % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

// Descripción limpia y recortada para mostrar en la card
function limpiarDescripcion(d) {
  if (!d) return null;
  const t = String(d).replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > 300 ? t.slice(0, 300).replace(/\s+\S*$/, '') + '…' : t;
}

// ---------- Historial persistente ----------
function cargarHistorial() {
  try { return JSON.parse(fs.readFileSync(HISTORIAL_FILE, 'utf8')); }
  catch { return []; }
}
let historial = cargarHistorial();
// Reparaciones al arrancar: descargas interrumpidas y miniaturas estables
for (const h of historial) {
  if (h.estado === 'en_cola' || h.estado === 'descargando') {
    h.estado = 'error';
    h.error = 'Interrumpida al cerrar la app.';
    h.fase = null; h.velocidad = null; h.eta = null;
  }
  if (!h.miniatura) h.miniatura = miniaturaEstable(h.url);
  else if (/sqp=|rs=|[?&]sig=/.test(h.miniatura)) {
    const m = h.miniatura.match(/i\.ytimg\.com\/vi\/([^/]+)\//);
    if (m) h.miniatura = `https://i.ytimg.com/vi/${m[1]}/hqdefault.jpg`;
  }
}
function guardarHistorial() {
  if (historial.length > MAX_HISTORIAL) historial = historial.slice(0, MAX_HISTORIAL);
  try { fs.writeFileSync(HISTORIAL_FILE, JSON.stringify(historial, null, 2)); } catch {}
}

// ---------- Cola de descargas ----------
let activa = null; // descarga en curso
let cola = [];     // pendientes, en orden de llegada
let seq = Date.now();

const esActiva = id => !!activa && activa.id === id;

// Aplica cambios al objeto vivo (activa o en cola) y a su entrada del historial
function aplicarDescarga(id, cambios) {
  const enCola = cola.find(c => c.id === id);
  if (enCola) Object.assign(enCola, cambios);
  if (esActiva(id)) Object.assign(activa, cambios);
  const h = historial.find(x => x.id === id);
  if (h) Object.assign(h, cambios);
}

function estadoPublico() {
  const limpiar = d => {
    const { proceso, ultimoAvance, sinAvance, cancelPedida, ...resto } = d;
    return resto;
  };
  return {
    activa: activa ? limpiar(activa) : null,
    cola: cola.map(c => c.id),
    historial: historial.map(h => ({ ...h, archivoOk: h.archivo ? fs.existsSync(h.archivo) : false }))
  };
}

// Mata el proceso y todo su árbol: en Windows yt-dlp puede tener hijos
// de ffmpeg, y kill() del padre los deja vivos (siguen escribiendo archivos)
function matarArbol(proc) {
  if (!proc || proc.exitCode !== null) return;
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); }
    catch { try { proc.kill(); } catch {} }
  } else {
    proc.kill();
  }
}

// Borra los temporales de un video: .part a medias, fragmentos .fNNN del
// merge, temporales y miniaturas huérfanas (--embed-thumbnail las baja aparte)
function limpiarTemporales(url) {
  const vid = idDesdeUrl(url);
  if (!vid) return;
  try {
    for (const f of fs.readdirSync(DESCARGAS_DIR)) {
      const esTemp = f.endsWith('.part') || /\.f\d+\./.test(f) || /\.temp-/.test(f)
        || /\.(webp|jpe?g|png)$/i.test(f);
      if (esTemp && f.includes(`[${vid}]`)) {
        try { fs.unlinkSync(path.join(DESCARGAS_DIR, f)); } catch {}
      }
    }
  } catch {}
}

// Lanza yt-dlp: emite cada línea de salida por onLinea y resuelve { code, salida, stderr }
function lanzarProceso(args, onLinea) {
  const proc = spawn(YTDLP, args, { cwd: BIN_DIR });
  const promesa = new Promise(resolve => {
    let salida = '', stderr = '', buffer = '';
    proc.stdout.on('data', d => {
      const texto = d.toString();
      salida += texto; buffer += texto;
      const lineas = buffer.split('\n');
      buffer = lineas.pop();
      for (const l of lineas) if (onLinea) onLinea(l);
    });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', e => resolve({ code: -1, salida, stderr: stderr + '\n' + e.message }));
    proc.on('close', code => resolve({ code, salida, stderr }));
  });
  return { proc, promesa };
}

// Procesa una línea de progreso de yt-dlp: %, tamaño, velocidad, ETA y fases
function procesarLinea(id, linea) {
  if (!esActiva(id)) return;
  activa.ultimoAvance = Date.now();

  const m = linea.match(/\[download\]\s+([\d.]+)%(?:\s+of\s+~?\s*([\d.]+\S*))?(?:\s+at\s+([\d.]+\S*\/s))?(?:\s+ETA\s+(\S+))?/);
  if (m) {
    aplicarDescarga(id, {
      progreso: Math.min(100, parseFloat(m[1])),
      tamanno: m[2] || null,
      velocidad: m[3] || null,
      eta: m[4] || null,
      fase: null
    });
  }

  const f = linea.match(/^\[(\w+)\]/);
  if (f && FASES[f[1]]) aplicarDescarga(id, { fase: FASES[f[1]], progreso: 100, velocidad: null, eta: null });

  const l = linea.trim();
  // "--print after_move:%(height)s" imprime la altura real descargada
  if (/^\d{3,4}$/.test(l)) aplicarDescarga(id, { alturaReal: parseInt(l, 10) });
  // "--print after_move:filepath" imprime la ruta final; se ignoran los
  // intermedios del merge (.fNNN / .temp) y se queda el último (el definitivo)
  if (l && !/\.f\d+\./.test(l) && !/\.temp-/.test(l) && !l.endsWith('.part')
      && fs.existsSync(l) && path.dirname(l) === DESCARGAS_DIR) {
    aplicarDescarga(id, { archivo: l });
  }
}

// Cierra una descarga con su estado final y persiste
function terminarDescarga(id, estado, extra) {
  const cambios = { estado, fase: null, velocidad: null, eta: null, ...(extra || {}) };
  if (estado === 'listo') cambios.progreso = 100;
  aplicarDescarga(id, cambios);
  guardarHistorial();
  console.log(`[${id}] ${estado}${extra && extra.error ? ': ' + extra.error : ''}`);
}

// Toma la siguiente de la cola (si el carril está libre)
function procesarCola() {
  if (activa || !cola.length) return;
  const item = cola.shift();
  iniciarDescarga(item);
}

// Ejecuta una descarga con reintentos y vigilancia de cuelgues
function iniciarDescarga(item) {
  const id = item.id;
  activa = item;
  item.ultimoAvance = Date.now();
  aplicarDescarga(id, { estado: 'descargando', fase: null, error: null });
  guardarHistorial();
  console.log(`[${id}] Descargando (${item.modo} ${item.calidad}): ${item.url}`);

  const args = [
    '--newline', '--progress', '--no-warnings', '--no-playlist',
    '--windows-filenames', '--trim-filenames', '150',
    '--retries', '10', '--fragment-retries', '10', '--extractor-retries', '3',
    '--embed-metadata', '--embed-thumbnail',
    '--print', 'after_move:filepath',
    '--print', 'after_move:%(height)s',
    '--ffmpeg-location', BIN_DIR,
    '-o', path.join(DESCARGAS_DIR, '%(title)s [%(id)s].%(ext)s'),
    item.url
  ];
  if (item.modo === 'audio') {
    args.splice(args.length - 1, 0, '-f', 'bestaudio/best', '-x', '--audio-format', 'mp3', '--audio-quality', '0');
  } else {
    // Máxima calidad real: el mejor video disponible en la altura elegida
    // (sin limitar códec, así 4K/8K VP9/AV1 no quedan fuera)
    const h = item.calidad === 'mejor' ? '' : `[height<=${item.calidad}]`;
    args.splice(args.length - 1, 0,
      '-f', `bestvideo${h}+bestaudio/best${h}`, '--merge-output-format', 'mp4');
  }

  // Watchdog: si no hay progreso durante minutos, abortar con error claro
  const watchdog = setInterval(() => {
    if (!esActiva(id)) return clearInterval(watchdog);
    if (Date.now() - activa.ultimoAvance > MINUTOS_SIN_AVANCE * 60000) {
      activa.sinAvance = true;
      matarArbol(activa.proceso);
    }
  }, 30000);

  (async () => {
    let intento = 0;
    while (esActiva(id)) {
      // si YouTube pide verificación, reintentar con las cookies del navegador
      const extras = intento === 0 ? [] : ['--cookies-from-browser', NAVEGADORES[intento - 1]];
      if (intento > 0) {
        aplicarDescarga(id, { fase: `Verificando con cookies de ${NAVEGADORES[intento - 1]}…`, velocidad: null, eta: null });
        console.log(`[${id}] Reintento con cookies de ${NAVEGADORES[intento - 1]}`);
      }

      const { proc, promesa } = lanzarProceso([...args, ...extras], l => procesarLinea(id, l));
      if (esActiva(id)) activa.proceso = proc;
      const r = await promesa;
      if (esActiva(id)) activa.proceso = null;

      if (r.code === 0) {
        terminarDescarga(id, 'listo');
        clearInterval(watchdog);
        activa = null;
        return procesarCola();
      }

      // taskkill /F termina con código 1: distinguir cancelación pedida
      // (usuario o watchdog) de un error real de yt-dlp
      if (r.code === null || (esActiva(id) && (activa.cancelPedida || activa.sinAvance))) {
        if (esActiva(id) && activa.sinAvance) {
          terminarDescarga(id, 'error', { error: `La descarga se detuvo sin progreso por ${MINUTOS_SIN_AVANCE} minutos.` });
        } else {
          terminarDescarga(id, 'cancelado');
        }
        limpiarTemporales(item.url);
        clearInterval(watchdog);
        activa = null;
        return procesarCola();
      }

      if (r.code === -1) {
        terminarDescarga(id, 'error', { error: limpiarError(r.stderr || 'No se pudo iniciar yt-dlp.') });
        limpiarTemporales(item.url);
        clearInterval(watchdog);
        activa = null;
        return procesarCola();
      }

      const msgErr = limpiarError(r.stderr || r.salida || 'yt-dlp terminó con código ' + r.code);
      if (intento < NAVEGADORES.length && ERROR_AUTH.test(msgErr)) { intento++; continue; }
      if (intento > 0) {
        // el intento con cookies falló por otra razón (p.ej. Chrome cifrando):
        // el problema real sigue siendo la verificación de YouTube
        terminarDescarga(id, 'error', { error: `YouTube pidió verificación y el respaldo con cookies del navegador falló (${msgErr}). Prueba de nuevo en unos minutos.` });
        limpiarTemporales(item.url);
        clearInterval(watchdog);
        activa = null;
        return procesarCola();
      }
      terminarDescarga(id, 'error', { error: msgErr });
      limpiarTemporales(item.url);
      clearInterval(watchdog);
      activa = null;
      return procesarCola();
    }
  })();
}

// ---------- API ----------
// Fondos de la interfaz (imágenes sueltas en public/fondos; se agregan solas)
app.get('/api/fondos', (req, res) => {
  const dir = path.join(ROOT, 'public', 'fondos');
  let archivos = [];
  try {
    archivos = fs.readdirSync(dir).filter(f => /\.(jpe?g|png|webp|gif)$/i.test(f)).sort();
  } catch {}
  res.json(archivos);
});

// Analiza el link: título, canal, duración, miniatura, descripción y calidades
app.post('/api/analizar', async (req, res) => {
  const url = (req.body.url || '').trim();
  if (!esUrlYouTube(url)) return res.status(400).json({ error: 'Ese enlace no parece de YouTube.' });

  let info = null, ultimoError = 'No se pudo analizar el video.', errAuth = null;
  for (let i = 0; i <= NAVEGADORES.length && !info; i++) {
    const extras = i === 0 ? [] : ['--cookies-from-browser', NAVEGADORES[i - 1]];
    const r = await lanzarProceso(['-J', '--no-warnings', '--no-playlist', ...extras, url]).promesa;
    if (r.code === 0) {
      try { info = JSON.parse(r.salida.split('\n')[0] || r.salida); }
      catch { ultimoError = 'YouTube devolvió una respuesta no válida.'; }
    } else {
      ultimoError = limpiarError(r.stderr || r.salida || 'Error desconocido');
      // solo reintentar con cookies si el error es de verificación/edad/restricción
      if (ERROR_AUTH.test(ultimoError)) errAuth = ultimoError;
      else break;
    }
  }
  if (!info) {
    // si el problema real era la verificación y las cookies fallaron, decirlo claro
    if (errAuth && ultimoError !== errAuth) {
      ultimoError = `${errAuth} (el respaldo con cookies del navegador falló: ${ultimoError})`;
    }
    return res.status(500).json({ error: ultimoError });
  }

  // Calidades reales disponibles (resoluciones con pista de video)
  const calidades = [...new Set(
    (info.formats || [])
      .filter(f => f.vcodec && f.vcodec !== 'none' && f.height)
      .map(f => f.height)
  )].sort((a, b) => b - a);

  res.json({
    titulo: info.title,
    canal: info.uploader || info.channel,
    duracion: textoDuracion(info.duration),
    miniatura: miniaturaEstable(url) || info.thumbnail,
    descripcion: limpiarDescripcion(info.description),
    calidades,
    esLive: !!info.is_live
  });
});

// Encola la descarga (video MP4 o audio MP3); se procesa por orden de llegada
app.post('/api/descargar', (req, res) => {
  const url = (req.body.url || '').trim();
  const modo = req.body.modo === 'audio' ? 'audio' : 'video';
  const cal = String(req.body.calidad || 'mejor');
  const calidad = cal === 'mejor' || /^\d{3,4}$/.test(cal) ? cal : 'mejor';

  if (!esUrlYouTube(url)) return res.status(400).json({ error: 'Ese enlace no parece de YouTube.' });
  const repetida = d => d.url === url && d.modo === modo && d.calidad === calidad;
  if ((activa && repetida(activa)) || cola.some(repetida)) {
    return res.status(409).json({ error: 'Esa misma descarga ya está en la cola.' });
  }

  const item = {
    id: ++seq, url, modo, calidad,
    estado: 'en_cola', progreso: 0,
    titulo: req.body.titulo || null,
    canal: req.body.canal || null,
    duracion: req.body.duracion || null,
    miniatura: req.body.miniatura || null,
    descripcion: req.body.descripcion || null,
    archivo: null, error: null, alturaReal: null,
    velocidad: null, tamanno: null, eta: null, fase: null,
    ultimoAvance: Date.now(), sinAvance: false, cancelPedida: false,
    proceso: null
  };
  const { proceso, ...entrada } = item;
  historial.unshift({ ...entrada });
  guardarHistorial();
  cola.push(item);
  console.log(`[${item.id}] En cola (${modo} ${calidad}): ${url}`);

  res.json({ ok: true, id: item.id, posicion: cola.length + (activa ? 1 : 0) });
  procesarCola();
});

// Progreso de la descarga activa + cola + historial (la página consulta seguido)
app.get('/api/estado', (req, res) => res.json(estadoPublico()));

// Cancela la descarga activa o quita una pendiente de la cola
app.post('/api/cancelar', (req, res) => {
  const id = Number(req.body.id || 0);
  if (esActiva(id) || (!id && activa)) {
    activa.cancelPedida = true;
    matarArbol(activa.proceso);
    return res.json({ ok: true });
  }
  const i = cola.findIndex(c => c.id === id);
  if (i >= 0) {
    cola.splice(i, 1);
    aplicarDescarga(id, { estado: 'cancelado', fase: null, velocidad: null, eta: null });
    guardarHistorial();
    return res.json({ ok: true });
  }
  res.status(400).json({ error: 'No hay descarga en curso.' });
});

// ---------- Clips con subtítulos automáticos ----------
// Lista el banco de temas de subtítulos (y el preferido guardado)
app.get('/api/clips/temas', (req, res) => {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'config.json'), 'utf8')); } catch {}
  res.json({ temas: clips.TEMAS, preferido: cfg.tema || 'tiktok' });
});

// Procesa un video ya descargado: modo "auto" (elige y renderiza) o
// "manual" (transcribe y propone momentos para que el usuario elija)
app.post('/api/clips/procesar', (req, res) => {
  const archivo = path.normalize((req.body.archivo || '').trim());
  const titulo = (req.body.titulo || 'Video').trim();
  const durClip = [30, 45, 60].includes(Number(req.body.durClip)) ? Number(req.body.durClip) : 45;
  const cantidad = Math.max(1, Math.min(3, Number(req.body.cantidad) || 2));
  const modo = req.body.modo === 'manual' ? 'manual' : 'auto';
  const tema = String(req.body.tema || '');

  if (!clips.disponible()) {
    return res.status(400).json({ error: 'El motor de clips no está instalado. Ejecuta Iniciar.bat para descargarlo.' });
  }
  if (!archivo || !fs.existsSync(archivo) || path.dirname(archivo) !== DESCARGAS_DIR
      || !archivo.toLowerCase().endsWith('.mp4')) {
    return res.status(400).json({ error: 'No se encontró el video para procesar.' });
  }
  const t = clips.estadoPublico();
  if (t && ['transcribiendo', 'generando', 'sugiriendo'].includes(t.estado)) {
    return res.status(409).json({ error: 'Ya hay un proceso de clips en curso. Espera o cancélalo.' });
  }
  clips.iniciar(archivo, titulo, durClip, cantidad, modo, tema);
  res.json({ ok: true });
});

// Modo manual: renderiza los momentos elegidos por el usuario
app.post('/api/clips/renderizar', (req, res) => {
  const t = clips.estadoPublico();
  if (!t || t.estado !== 'sugiriendo') return res.status(400).json({ error: 'No hay sugerencias pendientes.' });
  const selecciones = (Array.isArray(req.body.selecciones) ? req.body.selecciones : [])
    .map(Number).filter(n => n >= 0).slice(0, 3);
  if (!selecciones.length) return res.status(400).json({ error: 'No elegiste ningún momento.' });
  if (clips.renderizarSeleccion(t.id, selecciones)) return res.json({ ok: true });
  res.status(400).json({ error: 'No se pudo iniciar el render.' });
});

// Sirve archivos de video de la carpeta Descargas (solo mp4, solo allí)
app.get('/api/archivo', (req, res) => {
  const archivo = path.normalize(String(req.query.ruta || ''));
  if (!archivo.startsWith(DESCARGAS_DIR) || !archivo.toLowerCase().endsWith('.mp4') || !fs.existsSync(archivo)) {
    return res.status(404).end();
  }
  res.sendFile(archivo);
});

app.get('/api/clips/estado', (req, res) => res.json({ trabajo: clips.estadoPublico() }));

app.post('/api/clips/cancelar', (req, res) => {
  if (clips.cancelar()) return res.json({ ok: true });
  res.status(400).json({ error: 'No hay procesamiento en curso.' });
});

// Abre el Explorador de Windows con el archivo seleccionado (o la carpeta Descargas)
app.post('/api/abrir-carpeta', (req, res) => {
  const archivo = (req.body.archivo || '').trim();
  if (archivo && fs.existsSync(archivo) && path.dirname(archivo) === DESCARGAS_DIR) {
    spawn('explorer.exe', ['/select,', archivo], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('explorer.exe', [DESCARGAS_DIR], { detached: true, stdio: 'ignore' }).unref();
  }
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Descargas YouTube corriendo en http://localhost:${PORT}`);
  console.log(`Carpeta de destino: ${DESCARGAS_DIR}`);
  // Mantener yt-dlp al día en segundo plano (YouTube cambia seguido)
  spawn(YTDLP, ['-U'], { cwd: BIN_DIR, detached: true, stdio: 'ignore' }).unref();
});
