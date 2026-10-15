'use strict';
// La app contra el motor ORIGINAL de la hoja, con miles de casos al azar.
// Ver tests/paridad.js. Si los .gs no están (la app copiada sola), se salta.
const test = require('node:test');
const assert = require('node:assert');
const P = require('./paridad');
const { calcularUnidad } = require('../src/motor');
const { guia } = require('./ayudas');

// Azar con semilla: si algo falla, el mismo número reproduce el caso.
function azar(semilla) {
  let s = semilla >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function escenario(rnd) {
  const elegir = (l) => l[Math.floor(rnd() * l.length)];
  const guias = Array.from({ length: 12 }, (_, i) => guia(1 + Math.floor(rnd() * 40)));
  const peds = ['6100001', '6100002', '6100003', '6100004'];
  const raros = ['ABC', '12345', 'SIN PEDIMENTO', 'COSTALES', 'H6620215136', guias[0] + guias[1], '1Z999AA10000000010'];
  const n = 3 + Math.floor(rnd() * 22);
  const a = [];
  for (let i = 0; i < n; i++) {
    const x = rnd();
    a.push(x < .18 ? elegir(peds) : x < .82 ? elegir(guias) : x < .9 ? elegir(raros) : '');
  }
  // La lista esperada: a veces nada, a veces bloques con el pedimento debajo.
  const o = [];
  if (rnd() < .6) {
    const bloques = 1 + Math.floor(rnd() * 3);
    for (let b = 0; b < bloques; b++) {
      const k = 1 + Math.floor(rnd() * 4);
      for (let j = 0; j < k; j++) o.push(elegir(guias));
      if (rnd() < .9) o.push(elegir(peds));
    }
    if (rnd() < .2) o.push(elegir(raros));
  }
  const letras = o.map(() => (rnd() < .3 ? elegir(['a', 'b', 'c']) : ''));
  const otra = rnd() < .5 ? [elegir(guias), elegir(peds), elegir(guias)] : [];
  const nombre = elegir(['GLOBAL 1 20-AE-3H', 'A1 76-AZ-8E', 'REZAGO', 'REZAGO MS', 'TRANSITO DE ARRIBO', 'AGA 3']);
  return { nombre, a, o, letras, otra };
}

// Los errores de captura los escribe el escaneo ANTES del motor; aquí igual.
function estadoInicial(v) {
  const t = String(v);
  if (!/^\d{1,6}$/.test(t)) return '';
  const f = 7 - t.length;
  return '🛑 ERROR: Faltan ' + f + ' ' + (f === 1 ? 'número' : 'números');
}

const CASOS = Number(process.env.PARIDAD_CASOS) || 2000;

test('la app dice lo mismo que el motor de la hoja (' + CASOS + ' casos al azar)', { skip: !P.hayCodigoOriginal() }, () => {
  const ctx = P.cargarOriginal();
  const fallos = [];
  const vistos = new Set();
  for (let semilla = 1; semilla <= CASOS && fallos.length < 5; semilla++) {
    const e = escenario(azar(semilla));
    const n = Math.max(e.a.length, e.o.length);
    const filas = [];
    for (let i = 0; i < n; i++) {
      const r = [];
      r[0] = e.a[i] || ''; r[1] = estadoInicial(r[0]);
      r[13] = e.letras[i] || ''; r[14] = e.o[i] || ''; r[15] = estadoInicial(r[14]);
      filas.push(r);
    }
    const orig = P.correrOriginal(ctx, e.nombre, filas, [{ nombre: 'GLOBAL 2', valores: e.otra }]);

    const otras = { guias: new Map(), pedimentos: new Map() };
    e.otra.forEach((v, i) => {
      const m = /^\d{7}$/.test(v) ? otras.pedimentos : otras.guias;
      if (!m.has(v)) m.set(v, []);
      m.get(v).push({ hoja: 'GLOBAL 2', fila: i + 1 });
    });
    const app = calcularUnidad({
      nombre: e.nombre, forzar: true, exigirMS: true, otras,
      fisico: filas.map(r => ({ valor: r[0], estado: r[1] })),
      preforma: filas.map(r => ({ valor: r[14], estado: r[15], letra: r[13] })),
    });

    for (let i = 0; i < n; i++) { vistos.add(String(orig.val[i][1])); vistos.add(String(orig.val[i][15])); }
    const malo = (que, i, hoja, laApp) => fallos.push({ semilla, nombre: e.nombre, que, fila: i + 1,
      valor: que.startsWith('O') ? filas[i][14] : filas[i][0], hoja, app: laApp });
    for (let i = 0; i < n; i++) {
      if (String(orig.val[i][1]) !== app.filas[i].estado) malo('B estado', i, orig.val[i][1], app.filas[i].estado);
      else if (filas[i][0] !== '' && String(orig.fondo[i][1]).toLowerCase() !== app.filas[i].color.toLowerCase()) malo('B color', i, orig.fondo[i][1], app.filas[i].color);
      else if (String(orig.fondo[i][0]).toLowerCase() !== app.filas[i].colorA.toLowerCase()) malo('A color', i, orig.fondo[i][0], app.filas[i].colorA);
      if (String(orig.val[i][15]) !== app.preforma[i].estado) malo('O/P estado', i, orig.val[i][15], app.preforma[i].estado);
      else if (filas[i][14] !== '' && String(orig.fondo[i][15]).toLowerCase() !== app.preforma[i].color.toLowerCase()) malo('O/P color', i, orig.fondo[i][15], app.preforma[i].color);
    }
    const totB = /(\d+)/.exec(orig.val[0][3]), totP = /(\d+)/.exec(orig.val[1][3]);
    if (totB && Number(totB[1]) !== app.totales.bultos) malo('total bultos', 0, orig.val[0][3], app.totales.bultos);
    if (totP && Number(totP[1]) !== app.totales.pedimentos) malo('total pedimentos', 1, orig.val[1][3], app.totales.pedimentos);
  }
  assert.deepStrictEqual(fallos, [], JSON.stringify(fallos, null, 1));

  // Y que los casos al azar de verdad pasan por todos los mensajes importantes:
  // una paridad que solo ve «✅ Guía» no demuestra nada.
  // («✅ A1 COMPLETO» no está: en la hoja solo sale si todas las guías pasaron
  // por una M-S, y aquí no hay M-S hasta la fase 2. Lo cubre motor.test.js.)
  const todos = Array.from(vistos).join('\n');
  const deben = ['✅ Ok', '❌ Faltan', '⚠️ Sobran', '⚠️ Sobra (Ajena)', '❌ Va en:', '⛔ DUPLICADO (En:',
    '⛔ DUPLICADO (ya en Ped:', '⚠️ DUPLICADO (repetida', '🔄 Duplicado local', '🛑 PEDIMENTO REPETIDO (también',
    '🛑 PEDIMENTO REPETIDO (En:', '❌ Guía Inválida', '❌ DOS PEGADAS', '🛑 ERROR: Faltan', '✅ Recuperado',
    '⚠️ Ajena (No es de rezago)', '✅ COMPLETO', 'PEDIMENTOS NO COINCIDEN', '⚠️ PEDIMENTO REPETIDO',
    'GUÍA REPETIDA', '⚠️ SIN PEDIMENTO', '✅ REZAGO COMPLETO', '⏳ Faltan', 'con alerta', '► Resumen:',
    'Sin registrar en M-S', '✅ Guía', '✅ Escaneado', '⚠️ No en preforma'];
  const faltan = deben.filter(t => todos.indexOf(t) === -1);
  assert.deepStrictEqual(faltan, [], 'mensajes que los casos al azar nunca produjeron');
});
