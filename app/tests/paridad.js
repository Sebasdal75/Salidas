'use strict';
// =========================================================================
// PARIDAD: el motor de la app contra el motor ORIGINAL de la hoja de Google.
//
// Carga los .gs del sistema actual (los que están en la raíz del repositorio)
// en un contexto aislado de Node, como los cargaría Apps Script —un solo
// espacio global para todos los archivos—, les da una hoja simulada y ejecuta
// `actualizarGlobalPreforma`. Después pasa los mismos datos por
// `calcularUnidad` y compara estado y color de cada fila.
//
// Es lo que de verdad responde «¿la app dice lo mismo que la hoja?».
// =========================================================================

const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..', '..');
const ARCHIVOS = ['Codigo.gs', 'House.gs', 'Salidas.gs', 'UnirInventarios.gs', 'Costales.gs',
                  'Pedimentos.gs', 'Comandos.gs', 'PedimentosFinales.gs', 'Registros.gs'];

function hayCodigoOriginal() { return ARCHIVOS.every(a => fs.existsSync(path.join(RAIZ, a))); }

function cargarOriginal() {
  const props = new Map();
  const ctx = {
    console,
    Utilities: { formatDate: () => '12:00:00', base64Encode: (s) => Buffer.from(String(s)).toString('base64'),
                 sleep: () => {} },
    Session: { getScriptTimeZone: () => 'UTC', getActiveUser: () => ({ getEmail: () => '' }),
               getEffectiveUser: () => ({ getEmail: () => '' }) },
    Logger: { log: () => {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (props.has(k) ? props.get(k) : null),
      setProperty: (k, v) => props.set(k, String(v)), deleteProperty: (k) => props.delete(k) }) },
    CacheService: { getScriptCache: () => ({ get: () => null, put: () => {}, remove: () => {} }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => null, flush: () => {} },
    LockService: {}, ScriptApp: {}, DriveApp: {},
  };
  vm.createContext(ctx);
  ARCHIVOS.forEach(a => vm.runInContext(fs.readFileSync(path.join(RAIZ, a), 'utf8'), ctx, { filename: a }));
  return ctx;
}

// Una pestaña simulada: una rejilla de valores y otra de fondos, con lo que
// el motor original le pide (getRange por números o en notación A1).
function hojaSimulada(nombre, filas) {
  const ancho = 19;
  const val = filas.map(f => { const r = new Array(ancho).fill(''); f.forEach((v, c) => { r[c] = v; }); return r; });
  const fondo = val.map(() => new Array(ancho).fill('#ffffff'));
  const asegurar = (n) => { while (val.length < n) { val.push(new Array(ancho).fill('')); fondo.push(new Array(ancho).fill('#ffffff')); } };
  const rango = (f, c, nf, nc) => {
    if (typeof f === 'string') {
      const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(f);
      const col = s => s.split('').reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0);
      return rango(Number(m[2]), col(m[1]), Number(m[4]) - Number(m[2]) + 1, col(m[3]) - col(m[1]) + 1);
    }
    nf = nf || 1; nc = nc || 1;
    asegurar(f - 1 + nf);
    const leer = (g) => { const o = []; for (let i = 0; i < nf; i++) { const r = []; for (let j = 0; j < nc; j++) r.push(g[f - 1 + i][c - 1 + j]); o.push(r); } return o; };
    const escribir = (g) => (v) => { v.forEach((r, i) => r.forEach((x, j) => { g[f - 1 + i][c - 1 + j] = x; })); return api; };
    const api = { getValues: () => leer(val), setValues: escribir(val), getBackgrounds: () => leer(fondo),
      setBackgrounds: escribir(fondo), setFontLines: () => api, setFontColors: () => api, setValue: (x) => escribir(val)([[x]]),
      getValue: () => val[f - 1][c - 1], clearContent: () => { for (let i = 0; i < nf; i++) for (let j = 0; j < nc; j++) val[f - 1 + i][c - 1 + j] = ''; return api; },
      setBackground: (x) => { for (let i = 0; i < nf; i++) for (let j = 0; j < nc; j++) fondo[f - 1 + i][c - 1 + j] = x; return api; },
      setNumberFormat: () => api, setDataValidation: () => api };
    return api;
  };
  const hoja = {
    getName: () => nombre,
    getLastRow: () => { for (let i = val.length - 1; i >= 0; i--) if (val[i].some(x => String(x) !== '')) return i + 1; return 0; },
    getMaxColumns: () => ancho, getMaxRows: () => val.length, getLastColumn: () => ancho,
    insertColumnsAfter: () => {}, insertRowsAfter: () => {},
    getRange: rango,
  };
  return { hoja, val, fondo };
}

// Ejecuta el motor ORIGINAL sobre una unidad. `otras`: [{nombre, valores:[A…]}]
// para el índice de duplicados, como lo arma el caché del sistema actual.
function correrOriginal(ctx, nombre, filas, otras) {
  const { hoja, val, fondo } = hojaSimulada(nombre, filas);
  const map = new Map();
  (otras || []).forEach(o => o.valores.forEach((v, i) => {
    const g = String(v).trim().toUpperCase();
    if (g === '') return;
    if (!map.has(g)) map.set(g, []);
    map.get(g).push({ hoja: ctx.claveHoja(o.nombre), fila: i + 1, isMS: false, isInventario: false });
  }));
  const cacheInfo = { data: [[]], headers: [], map };
  const source = { getSheetByName: () => null, getSheets: () => [hoja], getId: () => 'x' };
  ctx.actualizarGlobalPreforma(hoja, source, cacheInfo, null, true, true, 0, null);
  return { val, fondo };
}

module.exports = { hayCodigoOriginal, cargarOriginal, correrOriginal, hojaSimulada };
