'use strict';
// La herramienta que compara la app contra CSV exportados de la hoja.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const C = require('../scripts/comparar-con-hoja');
const P = require('./paridad');
const { guia } = require('./ayudas');

const aCSV = (filas) => filas.map(r => {
  const out = []; for (let c = 0; c < 19; c++) out.push('"' + String(r[c] === undefined ? '' : r[c]).replace(/"/g, '""') + '"');
  return out.join(',');
}).join('\r\n') + '\r\n';

test('lee el CSV de Google: comillas, comas y saltos de línea dentro de una celda', () => {
  const f = C.leerCSV('﻿a,"b, c","d ""e""",\r\n"x\ny",2\n');
  assert.deepStrictEqual(f, [['a', 'b, c', 'd "e"', ''], ['x\ny', '2']]);
  assert.strictEqual(C.nombreDeUnidad('/x/Salidas ESCANEOS UPS - global 1  20-ae-3h.csv'), 'GLOBAL 1 20-AE-3H');
});

test('lo que la hoja añade por módulos que la app no tiene se reconoce como esperado', () => {
  assert.deepStrictEqual(C.sinAnadidosDeFase2('📦 COSTAL · ✅ Guía · Sin información').texto, '✅ Guía');
  assert.strictEqual(C.sinAnadidosDeFase2('✅ Ok (Escaneado en M-S T1)').texto, '✅ Ok');
  const ctx = { unidades: new Set(['GLOBAL 1']), sinPreforma: true };
  assert.strictEqual(C.motivoEsperado('🛑 RETENIDA (FEMAD)', '✅ Guía', ctx), 'retenidas (FEMAD)');
  assert.ok(C.motivoEsperado('⛔ DUPLICADO (En: GLOBAL 7 Fila 3)', '✅ Guía', ctx).indexOf('GLOBAL 7') !== -1);
  assert.strictEqual(C.motivoEsperado('✅ Ok', '✅ Guía', ctx), 'lista esperada que viene de las M-S');
  assert.strictEqual(C.motivoEsperado('❌ Guía Inválida', '✅ Guía', ctx), '');
});

test('contra CSV hechos por el motor de la hoja: nada que revisar; una celda alterada, se señala',
  { skip: !P.hayCodigoOriginal() }, () => {
  const ctx = P.cargarOriginal();
  const G = Array.from({ length: 8 }, (_, i) => guia(i + 1));
  const u1 = [['6100001'], [G[0]], [G[1]], [G[1]], ['ABC'], ['6100002'], [G[2]], [G[5]]];
  u1[0][14] = G[0]; u1[1][14] = G[3]; u1[2][14] = '6100001';
  const u2 = [['6100003'], [G[5]], [G[6]], ['6100002']];
  const o1 = P.correrOriginal(ctx, 'GLOBAL 1 20-AE-3H', u1, [{ nombre: 'GLOBAL 2', valores: u2.map(r => r[0]) }]);
  const o2 = P.correrOriginal(ctx, 'GLOBAL 2', u2, [{ nombre: 'GLOBAL 1 20-AE-3H', valores: u1.map(r => r[0]) }]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wms-cmp-'));
  try {
    const a1 = path.join(dir, 'Salidas ESCANEOS UPS - GLOBAL 1 20-AE-3H.csv');
    const a2 = path.join(dir, 'Salidas ESCANEOS UPS - GLOBAL 2.csv');
    fs.writeFileSync(a1, aCSV(o1.val)); fs.writeFileSync(a2, aCSV(o2.val));
    let r = C.comparar([a1, a2]);
    assert.deepStrictEqual(r.map(x => x.revisar), [[], []], C.informe(r));
    assert.ok(r[0].iguales.fisico > 0);
    assert.strictEqual(r[0].bultosHoja, r[0].totales.bultos);
    assert.ok(r[0].esperadas.has('M-S'));          // la hoja pide M-S
    // Ahora alguien «arregla» una celda a mano: la comparación tiene que verlo.
    const alterada = o1.val.map(f => f.slice());
    alterada[4][1] = '✅ Guía';
    fs.writeFileSync(a1, aCSV(alterada));
    r = C.comparar([a1, a2]);
    assert.strictEqual(r[0].revisar.length, 1);
    assert.strictEqual(r[0].revisar[0].fila, 5);
    assert.strictEqual(r[0].revisar[0].app, '❌ Guía Inválida');
    assert.ok(C.informe(r).indexOf('1 diferencia(s) a revisar') !== -1);
    assert.ok(C.csvDe(r).indexOf('"GLOBAL 1 20-AE-3H","A/B","5","ABC"') !== -1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
