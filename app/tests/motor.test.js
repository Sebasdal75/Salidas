'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { calcularUnidad } = require('../src/motor');
const R = require('../src/reglas');
const { guia, col } = require('./ayudas');

const calc = (o) => calcularUnidad(Object.assign({ nombre: 'GLOBAL 1 20-AE-3H', ahora: '10:00:00' }, o));
const G = [guia(1), guia(2), guia(3), guia(4), guia(5)];

test('las guías de prueba son válidas', () => {
  G.forEach(g => assert.ok(R.esGuiaUPSValida(g), g));
});

test('sin preforma: el pedimento resume los bultos y la última guía lleva el resumen', () => {
  const r = calc({ fisico: col('6100001', G[0], G[1]) });
  assert.strictEqual(r.filas[0].estado, 'Bultos: 2 | ✅ Escaneado');
  assert.strictEqual(r.filas[0].colorA, R.COLOR.A_PEDIMENTO);
  assert.strictEqual(r.filas[1].estado, '✅ Guía');
  assert.strictEqual(r.filas[2].estado, '✅ Guía' + R.SEP_RESUMEN + 'Bultos: 2 | ✅ Escaneado');
  assert.strictEqual(r.filas[1].colorA, R.COLOR.A_GUIA);
  assert.strictEqual(r.totales.bultos, 2);
  assert.strictEqual(r.totales.pedimentos, 1);
});

test('con preforma completa: ✅ Ok en cada guía y ✅ COMPLETO en el pedimento', () => {
  const r = calc({ fisico: col('6100001', G[0], G[1]), preforma: col(G[0], G[1], '6100001') });
  assert.strictEqual(r.filas[1].estado, '✅ Ok');
  assert.strictEqual(r.filas[1].color, R.COLOR.OK);
  assert.strictEqual(r.filas[0].estado, 'Bultos: 2 | ✅ COMPLETO');
  assert.strictEqual(r.filas[0].color, R.COLOR.OK);
  assert.strictEqual(r.preforma[2].estado, '2 bultos');
  assert.strictEqual(r.preforma[1].estado, '► Resumen: 2 bultos');
  assert.strictEqual(r.totales.bultosPreforma, 2);
  assert.strictEqual(r.totales.pedimentosPreforma, 1);
});

test('faltan guías: lista cuáles', () => {
  const r = calc({ fisico: col('6100001', G[0]), preforma: col(G[0], G[1], '6100001') });
  assert.strictEqual(r.filas[0].estado, 'Bultos: 1 | ❌ Faltan 1 (' + G[1] + ')');
  assert.strictEqual(r.filas[0].color, R.COLOR.FALTA);
});

test('guía que no está en la preforma ni en otro pedimento: ⚠️ Sobra (Ajena)', () => {
  const r = calc({ fisico: col('6100001', G[0], G[2]), preforma: col(G[0], '6100001') });
  assert.strictEqual(r.filas[2].estado.startsWith('⚠️ Sobra (Ajena)'), true);
  assert.strictEqual(r.filas[0].estado, 'Bultos: 2 | ⚠️ Sobran 1');
});

test('guía escaneada bajo otro pedimento: ❌ Va en, y se avisa también en la preforma', () => {
  const r = calc({
    fisico: col('6100002', G[0]),
    preforma: col(G[0], '6100001', G[1], '6100002'),
  });
  assert.strictEqual(r.filas[1].estado, '❌ Va en: 6100001'.concat(R.SEP_RESUMEN).concat(r.filas[0].estado));
  assert.strictEqual(r.preforma[0].estado.startsWith('⚠️ PEDIMENTOS NO COINCIDEN: se escaneó en 6100002'), true);
});

test('mismos 1Z con otro número de pedimento: se dice UNA vez, no guía por guía', () => {
  const r = calc({
    fisico: col('6100009', G[0], G[1]),
    preforma: col(G[0], G[1], '6100001'),
  });
  assert.ok(r.filas[0].estado.indexOf('PEDIMENTOS NO COINCIDEN') !== -1);
  assert.ok(r.filas[0].estado.indexOf('bajo el pedimento 6100001') !== -1);
});

test('duplicado en el mismo pedimento: gris y discreto, no bloquea', () => {
  const r = calc({ fisico: col('6100001', G[0], G[0]) });
  assert.strictEqual(r.filas[2].estado.startsWith('🔄 Duplicado local'), true);
  assert.strictEqual(r.filas[2].color, R.COLOR.GRIS);
  assert.strictEqual(r.filas[0].estado, 'Bultos: 1 | ✅ Escaneado');   // cuenta una
  assert.strictEqual(r.totales.bultos, 1);
});

test('duplicado en otro pedimento: ⛔ naranja, la primera también se marca', () => {
  const r = calc({ fisico: col('6100001', G[0], '6100002', G[0]) });
  assert.strictEqual(r.filas[3].estado.startsWith('⛔ DUPLICADO (ya en Ped: 6100001, fila 2)'), true);
  // es la última de su bloque: conserva el resumen colgado
  assert.strictEqual(R.cabezaEstado(r.filas[1].estado), '⚠️ DUPLICADO (repetida en la fila 4)');
  assert.strictEqual(r.filas[1].colorA, R.COLOR.A_DUPLICADO);
  assert.strictEqual(r.filas[3].colorA, R.COLOR.A_DUPLICADO);
  assert.ok(r.filas[0].estado.indexOf('con alerta') !== -1 || r.filas[2].estado.indexOf('con alerta') !== -1);
});

test('duplicado con otra Global: ⛔ con la unidad y la fila', () => {
  const otras = { guias: new Map([[G[0], [{ hoja: 'GLOBAL 2 11-BB-2C', fila: 7 }]]]), pedimentos: new Map() };
  const r = calc({ fisico: col('6100001', G[0], G[1]), otras });
  assert.strictEqual(r.filas[1].estado, '⛔ DUPLICADO (En: GLOBAL 2 11-BB-2C Fila 7)');
  assert.strictEqual(r.filas[1].color, R.COLOR.NARANJA);
  assert.strictEqual(r.totales.bultos, 2);
});

test('pedimento repetido en la misma unidad: 🛑 en las dos filas', () => {
  const r = calc({ fisico: col('6100001', G[0], '6100001', G[1]) });
  assert.strictEqual(r.filas[0].estado, '🛑 PEDIMENTO REPETIDO (también en la fila 3)');
  assert.strictEqual(r.filas[2].estado, '🛑 PEDIMENTO REPETIDO (también en la fila 1)');
  assert.strictEqual(r.filas[0].colorA, R.COLOR.A_DUPLICADO);
});

test('pedimento repetido en otra Global', () => {
  const otras = { guias: new Map(), pedimentos: new Map([['6100001', [{ hoja: 'GLOBAL 2', fila: 3 }]]]) };
  const r = calc({ fisico: col('6100001', G[0]), otras });
  assert.strictEqual(r.filas[0].estado, '🛑 PEDIMENTO REPETIDO (En: GLOBAL 2 Fila 3)');
});

test('guía inválida y dos pegadas', () => {
  const r = calc({ fisico: col('6100001', 'ABC', G[0] + G[1]) });
  assert.strictEqual(r.filas[1].estado, '❌ Guía Inválida');
  assert.strictEqual(r.filas[2].estado, '❌ DOS PEGADAS: ' + G[0] + ' + ' + G[1]);
  assert.strictEqual(r.filas[1].colorA, R.COLOR.A_DUPLICADO);
  assert.ok(r.filas[0].estado.indexOf('2 con alerta') !== -1);
});

test('un pedimento incompleto escaneado se queda como error y no cuenta', () => {
  const r = calc({ fisico: [{ valor: '6100001' }, { valor: '12345', estado: '🛑 ERROR: Faltan 2 números' }] });
  assert.strictEqual(r.filas[1].estado, '🛑 ERROR: Faltan 2 números');
  assert.strictEqual(r.filas[1].color, R.COLOR.AMARILLO);
});

test('la hora se sella una vez y se conserva; una fila vacía no lleva hora', () => {
  const r1 = calc({ fisico: col('6100001', G[0]), ahora: '10:00:00' });
  assert.strictEqual(r1.filas[1].hora, '10:00:00');
  const r2 = calc({ fisico: [{ valor: '6100001', hora: '09:00:00' }, { valor: G[0], hora: '09:01:00' }, { valor: '' }], ahora: '11:00:00' });
  assert.strictEqual(r2.filas[1].hora, '09:01:00');
  assert.strictEqual(r2.filas[2].hora, '');
});

test('una alerta grave no se cae sola… salvo si se edita la fila o se fuerza', () => {
  // Antes decía ⛔ por una Global que ya no tiene la guía.
  const antes = [{ valor: '6100001' }, { valor: G[0], estado: '⛔ DUPLICADO (En: GLOBAL 2 Fila 7)' }];
  assert.strictEqual(R.cabezaEstado(calc({ fisico: antes }).filas[1].estado), '⛔ DUPLICADO (En: GLOBAL 2 Fila 7)');
  assert.strictEqual(calc({ fisico: antes }).filas[1].color, R.COLOR.NARANJA);
  assert.strictEqual(R.cabezaEstado(calc({ fisico: antes, filasEditadas: new Set([1]) }).filas[1].estado), '✅ Guía');
  assert.strictEqual(R.cabezaEstado(calc({ fisico: antes, forzar: true }).filas[1].estado), '✅ Guía');
});

test('borrar la celda limpia la fila entera', () => {
  const r = calc({ fisico: [{ valor: '6100001' }, { valor: '', estado: '⛔ DUPLICADO (En: X Fila 1)', hora: '09:00:00' }] });
  assert.strictEqual(r.filas[1].estado, '');
  assert.strictEqual(r.filas[1].hora, '');
});

test('pedimento sin preforma en una A1 dice «A1 COMPLETO»', () => {
  const r = calc({ nombre: 'A1 76-AZ-8E', fisico: col('6100001', G[0]) });
  assert.strictEqual(r.filas[0].estado, 'Bultos: 1 | ✅ A1 COMPLETO');
});

test('preforma: pedimento repetido y guía repetida', () => {
  const r = calc({ fisico: [], preforma: col(G[0], '6100001', G[1], '6100001', G[0], '6100002') });
  assert.strictEqual(r.preforma[3].estado.startsWith('⚠️ PEDIMENTO REPETIDO'), true);
  assert.ok(r.preforma.some(p => p.estado.indexOf('GUÍA REPETIDA') !== -1));
  assert.strictEqual(r.preforma[3].colorO, R.COLOR.A_DUPLICADO);
});

test('guías de la preforma sin pedimento debajo, solo se avisa de las escaneadas', () => {
  const r = calc({ fisico: col('6100001', G[0]), preforma: col(G[0], G[1]) });
  assert.strictEqual(r.preforma[0].estado, '⚠️ SIN PEDIMENTO: falta ponerlo DEBAJO, en la O');
  assert.strictEqual(r.preforma[1].estado, '► Resumen: 2 bultos');   // solo el resumen, sin aviso
});

test('rezago: recuperado, ajena y completo', () => {
  const r = calc({
    nombre: 'REZAGO',
    fisico: col('6100001', G[0], G[2]),
    preforma: col('6100001', G[0], G[1]),
  });
  assert.strictEqual(r.filas[1].estado, '✅ Recuperado (Ped: 6100001)');
  assert.strictEqual(r.filas[2].estado, '⚠️ Ajena (No es de rezago)');
  assert.strictEqual(r.preforma[0].estado, '⏳ Faltan 1 (' + G[1] + ')');
  const completo = calc({ nombre: 'REZAGO', fisico: col(G[0], G[1]), preforma: col('6100001', G[0], G[1]) });
  assert.strictEqual(completo.preforma[0].estado, '✅ REZAGO COMPLETO');
  assert.ok(completo.filas[0].estado.indexOf('🌟 COMPLETO') !== -1);
  assert.strictEqual(completo.totales.pedimentos, 1);
  assert.strictEqual(completo.totales.etiquetaPedimentos, 'Pedimentos (Completos)');
});

test('los ganchos de la fase 2 entran sin romper nada: retenida manda sobre todo', () => {
  const hooks = { retenida: (v) => (v === G[0] ? '🛑 RETENIDA (FEMAD)' : '') };
  const r = calc({ fisico: col('6100001', G[0], G[1]), hooks });
  assert.strictEqual(r.filas[1].estado, '🛑 RETENIDA (FEMAD)');
  assert.strictEqual(r.filas[1].color, R.COLOR.ROJO);
});

test('el pedimento «ya usado otro día» no pisa un 🛑 de hoy', () => {
  const hooks = { pedimentoUsado: (p) => '🛑 PEDIMENTO YA USADO el 10/10' };
  const r = calc({ fisico: col('6100001', G[0], '6100001'), hooks });
  assert.ok(r.filas[0].estado.startsWith('🛑 PEDIMENTO REPETIDO'));
});
