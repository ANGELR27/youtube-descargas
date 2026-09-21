/*
 * Motor de clips v2 — clips verticales con subtítulos automáticos
 * Pipeline: audio 16k → whisper.cpp con marcas por palabra (-ml 1) →
 * oraciones completas → detección de ganchos (palabras clave + puntuación
 * + densidad) con corte en límites de oración → banco de temas de
 * subtítulos (karaoke palabra a palabra) → render ffmpeg 1080x1920.
 * También sugiere títulos y hashtags a partir de la transcripción.
 */
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const BIN_DIR = path.join(__dirname, 'bin');
const WHISPER_DIR = path.join(BIN_DIR, 'whisper');
const MODELO = path.join(BIN_DIR, 'models', 'ggml-small.bin');
const FFMPEG = path.join(BIN_DIR, 'ffmpeg.exe');
const TMP_DIR = path.join(__dirname, 'data', 'clips-tmp');
const CONFIG_FILE = path.join(__dirname, 'data', 'config.json');

// ---------- Banco de temas de subtítulos ----------
// colores en RGB hex; karaoke: la palabra ya dicha toma color "activa"
const TEMAS = {
  tiktok:   { nombre: 'TikTok clásico', fuente: 'Arial',   tamano: 64, color: 'FFFFFF', activa: 'FFE94A', contorno: '101010', grosor: 5, mayusculas: true,  karaoke: true },
  neon:     { nombre: 'Neón',           fuente: 'Arial',   tamano: 66, color: 'FFFFFF', activa: '27F7D5', contorno: '00121A', grosor: 5, mayusculas: true,  karaoke: true },
  fuego:    { nombre: 'Fuego',          fuente: 'Impact',  tamano: 74, color: 'FFFFFF', activa: 'FF3D3D', contorno: '1A0000', grosor: 4, mayusculas: true,  karaoke: true },
  lila:     { nombre: 'Lila',           fuente: 'Arial',   tamano: 62, color: 'FFFFFF', activa: 'B388FF', contorno: '12001F', grosor: 5, mayusculas: true,  karaoke: true },
  hielo:    { nombre: 'Hielo',          fuente: 'Arial',   tamano: 64, color: 'FFFFFF', activa: '7FDFFF', contorno: '0A1A26', grosor: 5, mayusculas: true,  karaoke: true },
  oro:      { nombre: 'Oro',            fuente: 'Arial',   tamano: 64, color: 'FFFFFF', activa: 'FFC93C', contorno: '1A1200', grosor: 5, mayusculas: true,  karaoke: true },
  menta:    { nombre: 'Menta',          fuente: 'Verdana', tamano: 58, color: 'FFFFFF', activa: '5CFFB0', contorno: '00241A', grosor: 4, mayusculas: false, karaoke: true },
  atardecer:{ nombre: 'Atardecer',      fuente: 'Impact',  tamano: 72, color: 'FFFFFF', activa: 'FF9A3D', contorno: '26120A', grosor: 4, mayusculas: true,  karaoke: true },
  rosa:     { nombre: 'Rosa neón',      fuente: 'Arial',   tamano: 64, color: 'FFFFFF', activa: 'FF5CA8', contorno: '26000F', grosor: 5, mayusculas: true,  karaoke: true },
  minimal:  { nombre: 'Minimal',        fuente: 'Verdana', tamano: 54, color: 'FFFFFF', activa: 'FFFFFF', contorno: '202020', grosor: 3, mayusculas: false, karaoke: false },
  contraste:{ nombre: 'Contraste',      fuente: 'Arial',   tamano: 62, color: '0B0B0B', activa: '0B0B0B', contorno: 'FFFFFF', grosor: 5, mayusculas: true,  karaoke: false },
  elegante: { nombre: 'Elegante',       fuente: 'Georgia', tamano: 58, color: 'F5EFE0', activa: 'E8C97A', contorno: '141005', grosor: 3, mayusculas: false, karaoke: true }
};

function cargarConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}
function guardarConfig(cfg) {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); } catch {}
}

function whisperExe() {
  for (const e of ['whisper-cli.exe', 'main.exe']) {
    const p = path.join(WHISPER_DIR, e);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function disponible() {
  return !!whisperExe() && fs.existsSync(MODELO) && fs.existsSync(FFMPEG);
}

// ---------- Estado (un procesamiento a la vez) ----------
// { id, archivo, titulo, durClip, cantidad, modo, tema,
//   estado: transcribiendo|sugiriendo|generando|listo|error,
//   fase, progreso, clips, propuestas, palabras, durVideo, error, proceso, cancelPedida }
let trabajo = null;
let seq = 0;

function estadoPublico() {
  if (!trabajo) return null;
  const { proceso, palabras, ...resto } = trabajo;
  return resto;
}

const esActiva = id => !!trabajo && trabajo.id === id;

function aplicar(id, cambios) {
  if (esActiva(id)) Object.assign(trabajo, cambios);
}

function matarArbol(proc) {
  if (!proc || proc.exitCode !== null) return;
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); }
    catch { try { proc.kill(); } catch {} }
  } else {
    proc.kill();
  }
}

function lanzar(cmd, args, onLinea) {
  const proc = spawn(cmd, args, { cwd: BIN_DIR, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const promesa = new Promise(resolve => {
    let salida = '', stderr = '', buffer = '', bufferErr = '';
    const emitir = (canal, d) => {
      const texto = d.toString();
      if (canal === 'out') { salida += texto; buffer += texto; }
      else { stderr += texto; bufferErr += texto; }
      const lineas = (canal === 'out' ? buffer : bufferErr).split('\n');
      if (canal === 'out') buffer = lineas.pop(); else bufferErr = lineas.pop();
      for (const l of lineas) if (onLinea) onLinea(l); // whisper avanza por stderr
    };
    proc.stdout.on('data', d => emitir('out', d));
    proc.stderr.on('data', d => emitir('err', d));
    proc.on('error', e => resolve({ code: -1, salida, stderr: stderr + '\n' + e.message }));
    proc.on('close', code => resolve({ code, salida, stderr }));
  });
  return { proc, promesa };
}

// ---------- Transcripción con marcas por palabra ----------
async function extraerAudio(archivo, wav) {
  return lanzar(FFMPEG, ['-y', '-i', archivo, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav]).promesa;
}

// -ml 1 → un "segmento" por palabra: cada uno con su instante exacto.
// --dtw → alineación precisa de tokens (clave para que el karaoke no se adelante)
async function transcribir(id, wav) {
  const exe = whisperExe();
  const json = wav.replace(/\.wav$/, '.json');
  try { fs.unlinkSync(json); } catch {}

  const onProgreso = linea => {
    const m = (linea || '').match(/(\d{1,3})\s*%/);
    if (m) aplicar(id, { progreso: Math.min(99, parseInt(m[1], 10)) });
  };
  const size = (path.basename(MODELO).match(/ggml-([a-z]+)\.bin/i) || [])[1] || 'small';
  let usoDtw = true;
  let r = await lanzar(exe, [
    '-m', MODELO, '-f', wav, '-oj', '-of', wav.replace(/\.wav$/, ''),
    '-l', 'auto', '-pp', '-ml', '1', '--dtw', size
  ], onProgreso).promesa;

  if (r.code !== 0 && !fs.existsSync(json)) {
    usoDtw = false; // este modelo/build no soporta DTW: modo normal
    r = await lanzar(exe, [
      '-m', MODELO, '-f', wav, '-oj', '-of', wav.replace(/\.wav$/, ''),
      '-l', 'auto', '-pp', '-ml', '1'
    ], onProgreso).promesa;
  }

  for (let i = 0; i < 10 && !fs.existsSync(json); i++) {
    await new Promise(res => setTimeout(res, 500));
  }
  if (r.code !== 0 && !fs.existsSync(json)) {
    throw new Error('La transcripción falló (código ' + r.code + '): ' + (r.stderr || '').split('\n').slice(-3).join(' ').slice(0, 200));
  }
  const data = JSON.parse(fs.readFileSync(json, 'utf8'));
  const brutas = (data.transcription || [])
    .map(t => ({ inicio: (t.offsets?.from || 0) / 1000, fin: (t.offsets?.to || 0) / 1000, texto: (t.text || '').trim() }))
    .filter(p => p.texto && p.fin > p.inicio && !/^[\[\(].*[\]\)]$/.test(p.texto)); // sin "[Aplausos]"

  // whisper suele sueltar la puntuación como token aparte: pegarla a la palabra anterior
  const palabras = [];
  for (const p of brutas) {
    const previa = palabras[palabras.length - 1];
    if (previa && !/[\wáéíóúñü]/i.test(p.texto)) {
      previa.fin = p.fin;
      previa.texto += p.texto;
    } else {
      palabras.push(p);
    }
  }
  return { palabras, dtw: usoDtw };
}

// ---------- Oraciones completas (para cortar limpio) ----------
function aOraciones(palabras) {
  const oraciones = [];
  let act = null;
  for (const p of palabras) {
    if (!act) act = { ini: p.inicio, fin: p.fin, palabras: [] };
    act.palabras.push(p);
    act.fin = p.fin;
    const largo = act.fin - act.ini;
    if ((/[.!?…]["»')]?$/.test(p.texto) && largo > 0.5) || largo > 9) {
      oraciones.push(act);
      act = null;
    }
  }
  if (act) oraciones.push(act);
  return oraciones;
}

// ---------- Puntaje de "gancho" de un texto ----------
const GANCHOS = [
  'nunca', 'siempre', 'secreto', 'nadie', 'todos', 'increible', 'increíble', 'mejor', 'peor',
  'verdad', 'truco', 'error', 'gratis', 'importante', 'ojo', 'mira', 'escucha', 'por eso',
  'resulta', 'sorprendente', 'locura', 'brutal', 'razones', 'claves', 'debes', 'tienes que',
  'secret', 'never', 'always', 'best', 'worst', 'crazy', 'insane', 'truth', 'mistake',
  'nobody', 'everyone', 'money', 'why', 'how'
];

function puntajeGancho(texto) {
  const t = ' ' + texto.toLowerCase() + ' ';
  let p = 0;
  for (const g of GANCHOS) if (t.includes(' ' + g)) p += 3;
  p += (texto.match(/\?/g) || []).length * 4;
  p += (texto.match(/!/g) || []).length * 2;
  p += (texto.match(/\d/g) || []).length;
  return p;
}

// Ventanas puntuadas: gancho + densidad, ajustadas a oraciones completas.
// Devuelve las `maxPropuestas || cantidad` mejores (por puntaje), en orden cronológico.
function proponerMomentos(palabras, durVideo, durClip, cantidad, maxPropuestas) {
  const limite = maxPropuestas || cantidad;
  const oraciones = aOraciones(palabras);
  const durTotal = Math.max(durVideo, palabras.length ? palabras[palabras.length - 1].fin : 0);
  const candidatos = [];
  for (let ini = 0; ini + Math.min(15, durClip) <= durTotal; ini += 3) {
    const fin = Math.min(ini + durClip, durTotal);
    if (fin - ini < Math.min(15, durClip)) break;
    const texto = palabras.filter(p => p.fin > ini && p.inicio < fin).map(p => p.texto).join(' ');
    const densidad = texto.length / (fin - ini);
    candidatos.push({ inicio: ini, fin, puntos: puntajeGancho(texto) * 2 + densidad / 4 });
  }
  if (!candidatos.length) return [{ inicio: 0, fin: Math.min(durClip, durTotal), texto: '(video sin diálogo)' }];

  // ajustar bordes a oraciones completas (tolerancia 3 s por lado)
  const snap = v => {
    const c = [...oraciones].sort((a, b) => Math.abs(a.ini - v) - Math.abs(b.ini - v))[0];
    return c && Math.abs(c.ini - v) <= 3 ? c.ini : v;
  };
  const snapFin = v => {
    const c = [...oraciones].sort((a, b) => Math.abs(a.fin - v) - Math.abs(b.fin - v))[0];
    return c && Math.abs(c.fin - v) <= 3 ? c.fin : v;
  };

  const elegidos = [];
  for (const c of [...candidatos].sort((a, b) => b.puntos - a.puntos)) {
    if (elegidos.length >= limite) break;
    const inicio = snap(c.inicio);
    const fin = Math.min(snapFin(c.fin), durTotal);
    if (fin - inicio < Math.min(10, durClip - 5)) continue;
    if (elegidos.some(e => inicio < e.fin + 2 && fin > e.inicio - 2)) continue;
    const texto = palabras.filter(p => p.fin > inicio && p.inicio < fin).map(p => p.texto).join(' ');
    elegidos.push({ inicio, fin, texto: texto.slice(0, 160) });
  }
  if (!elegidos.length) elegidos.push({ inicio: 0, fin: Math.min(durClip, durTotal), texto: '(sin diálogo)' });
  return elegidos.sort((a, b) => a.inicio - b.inicio);
}

// ---------- Banco de temas: subtítulos ASS con karaoke ----------
function rgbToAss(hex) {
  const r = hex.slice(0, 2), g = hex.slice(2, 4), b = hex.slice(4, 6);
  return `&H00${b}${g}${r}`.toUpperCase();
}

function fmtAss(seg) {
  const h = Math.floor(seg / 3600), m = Math.floor((seg % 3600) / 60), s = Math.max(0, seg % 60);
  return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

// agrupar palabras en frases de pantalla (estilo TikTok: pocas palabras por vez)
function aFrases(palabras, dur, maxPal = 4, maxChars = 26) {
  // encadenar: cada palabra vive hasta la siguiente (máx +0.5s, sin arrastrarse)
  for (let i = 0; i < palabras.length - 1; i++) {
    const sig = palabras[i + 1];
    if (sig.inicio > palabras[i].inicio) palabras[i].fin = Math.min(sig.inicio, palabras[i].fin + 0.5);
  }
  const frases = [];
  let act = null;
  for (const p of palabras) {
    if (!act) act = { ini: p.inicio, fin: p.fin, palabras: [] };
    act.palabras.push(p);
    act.fin = p.fin;
    const chars = act.palabras.reduce((a, w) => a + w.texto.length + 1, 0);
    if (act.palabras.length >= maxPal || chars > maxChars || /[.!?…]["')]?/.test(p.texto)) {
      frases.push(act); act = null;
    }
  }
  if (act) frases.push(act);
  // frases muy cortas se fusionan con la anterior (evita parpadeos)
  for (let i = frases.length - 1; i > 0; i--) {
    if (frases[i].fin - frases[i].ini < 0.35 && frases[i - 1].palabras.length + frases[i].palabras.length <= maxPal + 2) {
      frases[i - 1].palabras.push(...frases[i].palabras);
      frases[i - 1].fin = frases[i].fin;
      frases.splice(i, 1);
    }
  }
  // continuidad: cada frase permanece hasta que empieza la siguiente (huecos cortos)
  for (let i = 0; i < frases.length; i++) {
    const sig = frases[i + 1];
    const hueco = sig ? sig.ini - frases[i].fin : Infinity;
    frases[i].fin = sig && hueco < 1.5 ? sig.ini : Math.min(dur, frases[i].fin + 1.0);
  }
  // recortar lo que quede fuera del clip
  return frases.filter(f => f.ini < dur)
    .map(f => ({ ...f, ini: Math.max(0, f.ini), fin: Math.max(0.2, Math.min(f.fin, dur)) }));
}

function generarAss(palabrasLocal, tema, carpeta, dur) {
  const t = TEMAS[tema] || TEMAS.tiktok;
  const negrita = t.fuente === 'Impact' ? 0 : -1;
  const cabecera = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Sub,${t.fuente},${t.tamano},${rgbToAss(t.activa)},${rgbToAss(t.color)},${rgbToAss(t.contorno)},&H80000000,${negrita},0,0,0,100,100,0,0,1,${t.grosor},2,2,60,60,420,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const texto = w => t.mayusculas ? w.texto.toUpperCase() : w.texto;
  const lineas = [];
  if (t.karaoke) {
    // \k: centisegundos por palabra; lo dicho toma color "activa" (relleno progresivo)
    for (const f of aFrases(palabrasLocal, dur)) {
      const partes = f.palabras.map(w => {
        const cs = Math.max(1, Math.round((w.fin - w.inicio) * 100));
        return `{\\k${cs}}${texto(w)}`;
      });
      lineas.push(`Dialogue: 0,${fmtAss(f.ini)},${fmtAss(f.fin)},Sub,,0,0,0,,${partes.join(' ')}`);
    }
  } else {
    for (const f of aFrases(palabrasLocal, dur, 6, 34)) {
      lineas.push(`Dialogue: 0,${fmtAss(f.ini)},${fmtAss(f.fin)},Sub,,0,0,0,,${f.palabras.map(texto).join(' ')}`);
    }
  }
  const file = path.join(carpeta, 'subs.ass');
  fs.writeFileSync(file, cabecera + lineas.join('\n') + '\n', 'utf8');
  return file;
}

// ---------- Render ----------
async function renderClip(id, fuente, inicio, dur, ass, salida, base, span, numClip, total) {
  const vf = [
    'split[a][b]',
    '[a]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=25:5[bg]',
    '[b]scale=1080:-2[fg]',
    '[bg][fg]overlay=(W-w)/2:(H-h)/2',
    `ass='${ass.replace(/\\/g, '/').replace(/:/, '\\:')}'`
  ].join(',');
  const r = await lanzar(FFMPEG, [
    '-y', '-ss', String(inicio), '-t', String(dur), '-i', fuente,
    '-vf', vf,
    // máxima calidad: CRF 18 (casi sin pérdida), preset slow, audio 256k/48k
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '256k', '-ar', '48000', '-movflags', '+faststart',
    '-progress', 'pipe:1', '-nostats', salida
  ], linea => {
    // out_time_ms es en MICROsegundos (nombre engañoso de ffmpeg)
    const m = (linea || '').match(/out_time_ms=(\d+)/);
    if (m) {
      const segs = parseInt(m[1], 10) / 1e6;
      const p = base + Math.min(1, segs / dur) * span;
      aplicar(id, { progreso: Math.min(99, Math.round(p)) });
    }
    const sp = (linea || '').match(/speed=\s*([\d.]+)x/);
    if (sp) aplicar(id, { fase: `Renderizando clip ${numClip} de ${total}…  ${sp[1]}x` });
  }).promesa;
  if (r.code !== 0 && !fs.existsSync(salida)) {
    throw new Error('El render falló: ' + (r.stderr || '').split('\n').slice(-3).join(' ').slice(0, 200));
  }
}

// ---------- Títulos y hashtags sugeridos ----------
const STOPWORDS = new Set(['de', 'la', 'que', 'el', 'en', 'y', 'a', 'los', 'se', 'del', 'las', 'un', 'por', 'con', 'no', 'una', 'su', 'para', 'es', 'al', 'lo', 'como', 'más', 'mas', 'pero', 'sus', 'le', 'ya', 'o', 'este', 'sí', 'si', 'porque', 'esta', 'entre', 'cuando', 'muy', 'sin', 'sobre', 'también', 'the', 'and', 'you', 'that', 'was', 'for', 'are', 'with', 'this', 'they', 'have', 'from', 'your', 'just', 'about']);

function sugerirTitulos(palabrasSpan) {
  const oraciones = aOraciones(palabrasSpan).map(o => ({
    texto: o.palabras.map(w => w.texto).join(' ').replace(/\s+/g, ' ').trim(),
    puntos: puntajeGancho(o.palabras.map(w => w.texto).join(' '))
  })).filter(o => o.texto.length > 12);

  const limpiar = t => t.replace(/["“”]/g, '').replace(/\s*[.!?…]+$/, '').trim();
  const titulos = [];
  const gancho = [...oraciones].sort((a, b) => b.puntos - a.puntos)[0];
  if (gancho) titulos.push(limpiar(gancho.texto).slice(0, 80));
  const pregunta = oraciones.find(o => /\?/.test(o.texto));
  if (pregunta) titulos.push(limpiar(pregunta.texto).slice(0, 80));
  const arranque = palabrasSpan.slice(0, 7).map(w => w.texto).join(' ').replace(/\s*[.!?…]+.*$/, '');
  if (arranque.length > 10) titulos.push(arranque + '…');

  const claves = {};
  for (const w of palabrasSpan) {
    const k = w.texto.toLowerCase().replace(/[^\wáéíóúñü]+/g, '');
    if (k.length > 4 && !STOPWORDS.has(k) && !/^\d+$/.test(k)) claves[k] = (claves[k] || 0) + 1;
  }
  const hashtags = Object.entries(claves).sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([k]) => '#' + k).concat(['#shorts', '#parati', '#fyp']);
  return { titulos: [...new Set(titulos)].slice(0, 3), hashtags: [...new Set(hashtags)] };
}

function duracionVideo(archivo) {
  return new Promise(resolve => {
    const proc = spawn(FFMPEG, ['-i', archivo]);
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', () => {
      const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+)/);
      resolve(m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : 0);
    });
    proc.on('error', () => resolve(0));
  });
}

// ---------- Orquestador ----------
function iniciar(archivo, titulo, durClip, cantidad, modo, tema) {
  const id = ++seq;
  trabajo = {
    id, archivo, titulo, durClip, cantidad, modo,
    tema: TEMAS[tema] ? tema : 'tiktok',
    estado: 'transcribiendo', fase: 'Extrayendo audio…', progreso: 0,
    clips: [], propuestas: [], palabras: [], durVideo: 0,
    error: null, proceso: null, cancelPedida: false
  };
  console.log(`[clips ${id}] Procesando (${modo}, tema ${trabajo.tema}): ${titulo}`);
  const cfg = cargarConfig();
  cfg.tema = trabajo.tema;
  guardarConfig(cfg);

  (async () => {
    if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
    const wav = path.join(TMP_DIR, `audio-${id}.wav`);
    try {
      let r = await extraerAudio(archivo, wav); // ya es async: devuelve directo
      if (!esActiva(id)) return;
      if (r.code !== 0) {
        console.log(`[clips ${id}] ffmpeg code=${r.code} stderr=${JSON.stringify((r.stderr || '').slice(-250))}`);
        throw new Error('No se pudo extraer el audio del video (código ' + r.code + '). ' + (r.stderr || '').split('\n').slice(-2).join(' ').slice(0, 150));
      }

      aplicar(id, { fase: 'Transcribiendo el video (puede tardar varios minutos)…', progreso: 0 });
      const { palabras, dtw } = await transcribir(id, wav);
      if (!esActiva(id)) return;
      // DTW da marcas precisas; sin DTW la interpolación tiende a adelantarse
      const delay = dtw ? 0.05 : 0.12;
      aplicar(id, { palabras, delay });

      const durVideo = await duracionVideo(archivo);
      aplicar(id, { durVideo: durVideo || (palabras.length ? palabras[palabras.length - 1].fin : 0) });

      if (trabajo.modo === 'manual') {
        aplicar(id, {
          estado: 'sugiriendo', fase: null, progreso: 100,
          propuestas: proponerMomentos(palabras, trabajo.durVideo, durClip, cantidad, 5)
        });
        console.log(`[clips ${id}] Sugerencias listas`);
        return; // espera la selección del usuario
      }

      await renderizarInternamente(id, proponerMomentos(palabras, trabajo.durVideo, durClip, cantidad));
    } catch (e) {
      if (esActiva(id)) aplicar(id, { estado: 'error', error: e.message, fase: null });
      console.log(`[clips ${id}] Error: ${e.message}\n${e.stack && e.stack.split('\n').slice(1, 4).join('\n')}`);
      limpiarTmp(wav);
    }
  })();

  return trabajo;
}

// Renderiza los clips de la selección (auto o manual)
async function renderizarInternamente(id, momentos) {
  const trabajoActual = trabajo;
  const { archivo, durClip, tema, durVideo } = trabajoActual;
  const palabras = trabajoActual.palabras || [];

  aplicar(id, { estado: 'generando', fase: 'Preparando…', progreso: 0 });
  const vid = path.parse(archivo).name.slice(0, 60).replace(/[^\w\s.-]/g, '');
  const carpetaClips = path.join(process.env.USERPROFILE, 'Downloads', 'Clips YouTube', vid);
  if (!fs.existsSync(carpetaClips)) fs.mkdirSync(carpetaClips, { recursive: true });

  const wav = path.join(TMP_DIR, `audio-${id}.wav`);
  const clips = [];
  try {
      for (let i = 0; i < momentos.length; i++) {
        if (!esActiva(id)) return;
        const seg = momentos[i];
        const fin = Math.min(seg.fin || (seg.inicio + durClip), Math.max(durVideo, seg.inicio + 5));
        const dur = Math.max(3, fin - seg.inicio);
        // CRÍTICO: convertir a tiempos LOCALES del clip (si no, los subtítulos
        // solo aparecerían cuando el clip empieza en el segundo 0 del video).
        // delay: DTW es preciso (+0.05s); la interpolación simple se adelanta (+0.12s)
        const delay = trabajo.delay ?? 0.08;
        const delSeg = palabras
          .filter(p => p.fin > seg.inicio && p.inicio < fin)
          .map(p => {
            const ini = Math.max(0, p.inicio - seg.inicio + delay);
            return { texto: p.texto, inicio: ini, fin: Math.max(ini + 0.06, p.fin - seg.inicio + delay) };
          });
        const ass = generarAss(delSeg, tema, TMP_DIR, dur);
        const salida = path.join(carpetaClips, `clip_${i + 1}.mp4`);
        aplicar(id, { fase: `Renderizando clip ${i + 1} de ${momentos.length}…`, progreso: Math.round(i / momentos.length * 100) });
        await renderClip(id, archivo, seg.inicio, dur, ass, salida, i / momentos.length * 100, 100 / momentos.length, i + 1, momentos.length);
        if (!esActiva(id)) return;
        const sugerencias = sugerirTitulos(delSeg);
        clips.push({ archivo: salida, inicio: seg.inicio, texto: delSeg.slice(0, 8).map(w => w.texto).join(' ').slice(0, 120), ...sugerencias });
        aplicar(id, { clips: [...clips] });
      }
    aplicar(id, { estado: 'listo', fase: null, progreso: 100 });
    console.log(`[clips ${id}] Listo: ${clips.length} clips`);
  } catch (e) {
    if (esActiva(id)) aplicar(id, { estado: 'error', error: e.message, fase: null });
    console.log(`[clips ${id}] Error: ${e.message}`);
  } finally {
    limpiarTmp(wav);
  }
}

// El usuario eligió momentos en modo manual (horas de inicio en segundos)
function renderizarSeleccion(id, selecciones) {
  if (!esActiva(id) || trabajo.estado !== 'sugiriendo') return false;
  const momentos = selecciones
    .map(inicio => ({ inicio: Math.max(0, Number(inicio) || 0), fin: 0 }))
    .sort((a, b) => a.inicio - b.inicio);
  renderizarInternamente(id, momentos);
  return true;
}

function cancelar() {
  if (trabajo && ['transcribiendo', 'generando', 'sugiriendo'].includes(trabajo.estado)) {
    if (trabajo.estado === 'sugiriendo') {
      trabajo = null; // solo estaba esperando elección
      return true;
    }
    trabajo.cancelPedida = true;
    matarArbol(trabajo.proceso);
    return true;
  }
  return false;
}

function limpiarTmp(...archivos) {
  for (const f of archivos) {
    try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch {}
    const json = f ? f.replace(/\.wav$/, '.json') : null;
    try { if (json && fs.existsSync(json)) fs.unlinkSync(json); } catch {}
  }
}

module.exports = { disponible, TEMAS, iniciar, renderizarSeleccion, cancelar, estadoPublico };
