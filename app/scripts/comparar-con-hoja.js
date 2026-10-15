'use strict';
// =========================================================================
// COMPARAR LA APP CONTRA LA HOJA DE GOOGLE
//
// La prueba que de verdad importa antes de usar la app: con las MISMAS guías,
// ¿dice lo mismo que la hoja? No hace falta servidor ni base: se exportan las
// pestañas de las Globales a CSV y esto pasa cada una por el motor de la app.
//
//   node scripts/comparar-con-hoja.js GLOBAL1.csv GLOBAL2.csv … [--salida carpeta]
//
// En Google Sheets: abre la pestaña → Archivo → Descargar → Valores separados
// por comas (.csv). Se descarga SOLO la pestaña abierta: repítelo con cada
// Global. Pásalas todas juntas: los duplicados entre unidades solo se pueden
// comparar si están las dos.
//
// El nombre de la unidad sale del nombre del archivo: «Salidas ESCANEOS UPS -
// GLOBAL 1 20-AE-3H.csv» → «GLOBAL 1 20-AE-3H». Cuenta: el nombre decide reglas
// (REZAGO, A1, TRÁNSITO).
//
// Separa las diferencias en dos montones:
//   · ESPERADAS: lo que la hoja dice por módulos que la app todavía no tiene
//     (M-S, houses, «sin información», costales, retenidas, salidas, confronta).
//   · A REVISAR: todo lo demás. Aquí no debería salir nada; lo que salga es un
//     error de la app (o de la hoja) y hay que mirarlo.
// =========================================================================

const fs = require('node:fs');
const path = require('node:path');
const { calcularUnidad } = require('../src/motor');
const R = require('../src/reglas');

// CSV de Google Sheets (RFC 4180): comas, comillas dobles, saltos de línea dentro
// de una celda entre comillas.
function leerCSV(texto) {
  let t = String(texto);
  if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
  const filas = []; let fila = []; let celda = ''; let comillas = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (comillas) {
      if (c === '"') {
        if (t[i + 1] === '"') { celda += '"'; i++; } else comillas = false;
      } else celda += c;
    } else if (c === '"') comillas = true;
    else if (c === ',') { fila.push(celda); celda = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && t[i + 1] === '\n') i++;
      fila.push(celda); filas.push(fila); fila = []; celda = '';
    } else celda += c;
  }
  if (celda !== '' || fila.length) { fila.push(celda); filas.push(fila); }
  return filas;
}

function nombreDeUnidad(archivo) {
  let base = path.basename(archivo).replace(/\.csv$/i, '');
  const corte = base.lastIndexOf(' - ');
  if (corte !== -1) base = base.slice(corte + 3);
  return R.claveUnidad(base).replace(/\s+/g, ' ');
}

const celda = (filas, i, c) => String(((filas[i] || [])[c]) === undefined ? '' : filas[i][c]).trim();

// Lo que la hoja añade por módulos que la app aún no tiene. Devuelve el texto
// sin esos añadidos y los motivos que se quitaron.
function sinAnadidosDeFase2(texto) {
  let t = String(texto || '');
  const motivos = new Set();
  if (t.indexOf('📦 COSTAL') === 0) { t = t.replace(/^📦 COSTAL(\s*·\s*)?/, ''); motivos.add('costales'); }
  if (/(^|\s·\s)Sin información/.test(t)) { t = t.replace(/\s·\sSin información/g, '').replace(/^Sin información$/, ''); motivos.add('sin información (houses)'); }
  if (/ \(Escaneado en [^)]*\)/.test(t)) { t = t.replace(/ \(Escaneado en [^)]*\)/g, ''); motivos.add('M-S'); }
  if (/ ⚠️ Sin registrar en M-S/.test(t)) { t = t.replace(/ ⚠️ Sin registrar en M-S/g, ''); motivos.add('M-S'); }
  return { texto: t.trim(), motivos };
}

// ¿Por qué podría ser distinta esta fila sin que sea un error de la app?
function motivoEsperado(hoja, app, ctx) {
  const h = String(hoja || ''), a = String(app || '');
  const cab = R.cabezaEstado(h);
  if (cab === '⏳ Pendiente (reintenta)') return 'la hoja la dejó pendiente';
  if (cab.startsWith('🛑 RETENIDA')) return 'retenidas (FEMAD)';
  if (cab.startsWith('⛔ YA SALIÓ') || cab.startsWith('🛑 PEDIMENTO YA USADO')) return 'salidas de otros días';
  if (cab.startsWith('➡ Salió en') || cab.toUpperCase().startsWith('➡ MOVIDO A')) return 'M-S';
  if (cab.startsWith('❌ Esa referencia va en el pedimento') || cab.startsWith('⏳ FALTA EL PEDIMENTO')) return 'confronta de referencias';
  // Lo que dice de las M-S no se puede comparar sin ellas: la hoja sabe qué
  // pasó por cada M-S y la app todavía no.
  if (h.indexOf('M-S') !== -1 || a.indexOf('M-S') !== -1) return 'M-S';
  // Duplicado con una pestaña que no se pasó: la app no puede verla.
  const m = /\(En: (.+?) Fila \d+\)/.exec(h);
  if (m && !ctx.unidades.has(R.claveUnidad(m[1]))) return 'duplicado con una pestaña que no se exportó (' + m[1] + ')';
  // Sin columna O, una lista esperada en la hoja solo pudo venir de las M-S.
  if (ctx.sinPreforma && /✅ Ok|❌ Faltan|⚠️ Sobra|❌ Va en|✅ COMPLETO|🌟/.test(h) &&
      /✅ Guía|✅ Escaneado|No en preforma|✅ A1 COMPLETO|⚠️ Ajena|Recuperado/.test(a)) {
    return 'lista esperada que viene de las M-S';
  }
  return '';
}

function compararUnidad(archivo, filas, otras, unidades) {
  const nombre = nombreDeUnidad(archivo);
  const n = filas.length;
  const fisico = [], preforma = [];
  for (let i = 0; i < n; i++) {
    fisico.push({ valor: celda(filas, i, 0) });
    preforma.push({ valor: celda(filas, i, 14), letra: celda(filas, i, 13) });
  }
  // `forzar`: cálculo limpio, sin heredar alertas de la hoja (si no, la
  // comparación se daría la razón sola).
  // `exigirMS` como en la hoja: las Globales piden registro en M-S.
  const res = calcularUnidad({ nombre, fisico, preforma, otras, ahora: '00:00:00', forzar: true, exigirMS: true });
  const sinPreforma = preforma.every(p => p.valor === '');
  const ctx = { unidades, sinPreforma };

  const iguales = { fisico: 0, preforma: 0 };
  const esperadas = new Map();
  const revisar = [];
  const anotar = (col, i, valor, hoja, app) => {
    const limpia = sinAnadidosDeFase2(hoja);
    if (limpia.texto === app) {
      if (limpia.motivos.size === 0) iguales[col]++;
      else limpia.motivos.forEach(mo => esperadas.set(mo, (esperadas.get(mo) || 0) + 1));
      return;
    }
    const motivo = motivoEsperado(hoja, app, ctx) || [...limpia.motivos][0] || '';
    if (motivo) { esperadas.set(motivo, (esperadas.get(motivo) || 0) + 1); return; }
    revisar.push({ columna: col === 'fisico' ? 'A/B' : 'O/P', fila: i + 1, valor, hoja, app });
  };
  for (let i = 0; i < n; i++) {
    const vA = fisico[i].valor;
    if (vA !== '' || celda(filas, i, 1) !== '') anotar('fisico', i, vA, celda(filas, i, 1), res.filas[i].estado);
    const vO = preforma[i].valor;
    if (vO !== '' || celda(filas, i, 15) !== '') anotar('preforma', i, vO, celda(filas, i, 15), res.preforma[i].estado);
  }
  const totalHoja = /(\d+)/.exec(celda(filas, 0, 3));
  return { nombre, filas: n, iguales, esperadas, revisar, totales: res.totales,
           bultosHoja: totalHoja ? Number(totalHoja[1]) : null };
}

// Lo que hay en las OTRAS unidades, como lo arma el servidor.
function contextoSin(propio, todas) {
  const guias = new Map(), pedimentos = new Map();
  todas.forEach(u => {
    if (u.nombre === propio) return;
    u.filas.forEach((f, i) => {
      const v = String((f || [])[0] || '').trim().toUpperCase();
      if (v === '' || R.esMarcadorEstructural(v)) return;
      const mapa = R.esPedimento(v) ? pedimentos : guias;
      if (!mapa.has(v)) mapa.set(v, []);
      mapa.get(v).push({ hoja: u.nombre, fila: i + 1 });
    });
  });
  return { guias, pedimentos };
}

function comparar(archivos) {
  const todas = archivos.map(a => ({ archivo: a, nombre: nombreDeUnidad(a), filas: leerCSV(fs.readFileSync(a, 'utf8')) }));
  const unidades = new Set(todas.map(u => u.nombre));
  return todas.map(u => compararUnidad(u.archivo, u.filas, contextoSin(u.nombre, todas), unidades));
}

function informe(resultados) {
  const L = [];
  let totalRevisar = 0;
  resultados.forEach(r => {
    totalRevisar += r.revisar.length;
    L.push('');
    L.push('══ ' + r.nombre + ' ══ (' + r.filas + ' renglones)');
    L.push('   Iguales: ' + r.iguales.fisico + ' escaneos y ' + r.iguales.preforma + ' de la lista esperada');
    if (r.bultosHoja !== null) {
      L.push('   Total bultos: hoja ' + r.bultosHoja + ' · app ' + r.totales.bultos +
             (r.bultosHoja === r.totales.bultos ? '  ✅' : '  ❗ distinto'));
    }
    if (r.esperadas.size) {
      L.push('   Distintas, pero ESPERADAS (módulos que la app aún no tiene):');
      r.esperadas.forEach((n, motivo) => L.push('      · ' + motivo + ': ' + n));
    }
    if (r.revisar.length === 0) L.push('   A revisar: ninguna ✅');
    else {
      L.push('   A REVISAR: ' + r.revisar.length);
      r.revisar.slice(0, 40).forEach(d => {
        L.push('      Fila ' + d.fila + ' (' + d.columna + ') ' + d.valor);
        L.push('         hoja: ' + (d.hoja || '(vacío)'));
        L.push('         app:  ' + (d.app || '(vacío)'));
      });
      if (r.revisar.length > 40) L.push('      … y ' + (r.revisar.length - 40) + ' más (ver el CSV con --salida)');
    }
  });
  L.push('');
  L.push(totalRevisar === 0 ? 'RESULTADO: la app dice lo mismo que la hoja en todo lo que ya cubre. ✅'
                            : 'RESULTADO: ' + totalRevisar + ' diferencia(s) a revisar.');
  return L.join('\n');
}

function csvDe(resultados) {
  const q = v => '"' + String(v === undefined || v === null ? '' : v).replace(/"/g, '""') + '"';
  const L = ['unidad,columna,fila,valor,hoja,app'];
  resultados.forEach(r => r.revisar.forEach(d => L.push([r.nombre, d.columna, d.fila, d.valor, d.hoja, d.app].map(q).join(','))));
  return L.join('\n') + '\n';
}

if (require.main === module) {
  const args = process.argv.slice(2);
  let salida = null;
  const archivos = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--salida') salida = args[++i];
    else archivos.push(args[i]);
  }
  if (archivos.length === 0) {
    console.log('Uso: node scripts/comparar-con-hoja.js GLOBAL1.csv GLOBAL2.csv … [--salida carpeta]');
    process.exit(1);
  }
  const faltan = archivos.filter(a => !fs.existsSync(a));
  if (faltan.length) { console.error('No encuentro: ' + faltan.join(', ')); process.exit(1); }
  const resultados = comparar(archivos);
  console.log(informe(resultados));
  if (salida) {
    fs.mkdirSync(salida, { recursive: true });
    const destino = path.join(salida, 'diferencias.csv');
    fs.writeFileSync(destino, csvDe(resultados));
    console.log('Diferencias a revisar en: ' + destino);
  }
  process.exit(resultados.some(r => r.revisar.length) ? 2 : 0);
}

module.exports = { leerCSV, nombreDeUnidad, sinAnadidosDeFase2, motivoEsperado, comparar, informe, csvDe };
