'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { abrir } = require('../src/db');
const { crearServicio, ErrorDeUso } = require('../src/servicio');
const R = require('../src/reglas');
const { guia } = require('./ayudas');

function nuevo() {
  const db = abrir(':memory:');
  let t = new Date('2026-10-15T15:00:00Z');
  const s = crearServicio(db, { zona: 'America/Mexico_City', reloj: () => { t = new Date(t.getTime() + 1000); return t; } });
  return { db, s };
}
const G = [guia(1), guia(2), guia(3), guia(4)];
const esc = (s, id, valor, extra) => s.escanear(id, Object.assign({ valor, usuario: 'ANA' }, extra));

test('crear unidades: no se repite el nombre entre las abiertas', () => {
  const { s } = nuevo();
  s.crearUnidad('Global 1 20-AE-3H');
  assert.throws(() => s.crearUnidad('GLOBAL 1 20-ae-3h'), (e) => e instanceof ErrorDeUso && e.codigo === 409);
  assert.throws(() => s.crearUnidad('  '), ErrorDeUso);
  assert.throws(() => s.crearUnidad('global   1 20-ae-3h'), (e) => e.codigo === 409);
  assert.strictEqual(s.listarUnidades().length, 1);
  assert.strictEqual(s.listarUnidades()[0].nombre, 'GLOBAL 1 20-AE-3H');
});

test('escanear: pedimento y guías, con hora y resumen', () => {
  const { s } = nuevo();
  const u = s.crearUnidad('GLOBAL 1');
  esc(s, u.id, '6100001');
  esc(s, u.id, G[0]);
  const r = esc(s, u.id, G[1]);
  assert.strictEqual(r.fila, 3);
  assert.ok(r.estado.indexOf('Bultos: 2 | ✅ Escaneado') !== -1);
  assert.ok(/^\d\d:\d\d:\d\d$/.test(r.hora));
  const vista = s.obtenerUnidad(u.id);
  assert.strictEqual(vista.fisico.length, 3);
  assert.strictEqual(vista.fisico[0].estado, 'Bultos: 2 | ✅ Escaneado');
  assert.strictEqual(vista.totales.bultos, 2);
  assert.strictEqual(vista.fisico[2].usuario, 'ANA');
});

test('el lector manda la guía en minúsculas y con basura: se limpia', () => {
  const { s } = nuevo();
  const u = s.crearUnidad('GLOBAL 1');
  const r = esc(s, u.id, ' ' + G[0].toLowerCase().replace('1z', '1z ') + '\r\n');
  assert.strictEqual(r.valor, G[0]);
});

test('un pedimento incompleto se queda como error amarillo', () => {
  const { s } = nuevo();
  const u = s.crearUnidad('GLOBAL 1');
  const r = esc(s, u.id, '61000');
  assert.strictEqual(r.estado, '🛑 ERROR: Faltan 2 números');
  assert.strictEqual(r.color, R.COLOR.AMARILLO);
  // corregirlo: se reescribe en la misma fila
  const r2 = esc(s, u.id, '6100001', { pos: 0 });
  assert.strictEqual(r2.estado, 'Bultos: 0 | ⚠️ No en preforma');
});

test('duplicado entre dos Globales: aparece en la que ya estaba y se limpia al borrar', () => {
  const { s } = nuevo();
  const a = s.crearUnidad('GLOBAL 1');
  const b = s.crearUnidad('GLOBAL 2');
  esc(s, a.id, '6100001'); esc(s, a.id, G[0]);
  esc(s, b.id, '6100002');
  const r = esc(s, b.id, G[0]);
  assert.strictEqual(r.estado.indexOf('⛔ DUPLICADO (En: GLOBAL 1 Fila 2)'), 0);
  // la unidad de la que ya estaba también se enteró
  assert.ok(s.obtenerUnidad(a.id).fisico[1].estado.indexOf('⛔ DUPLICADO (En: GLOBAL 2 Fila 2)') === 0);
  // se borra la de la segunda: la primera queda limpia al recalcular lo suyo
  esc(s, b.id, '', { pos: 1 });
  s.forzar(a.id);
  assert.ok(s.obtenerUnidad(a.id).fisico[1].estado.indexOf('✅ Guía') === 0);
});

test('borrar y sobrescribir dejan historial', () => {
  const { s } = nuevo();
  const u = s.crearUnidad('GLOBAL 1');
  esc(s, u.id, '6100001'); esc(s, u.id, G[0]);
  esc(s, u.id, G[1], { pos: 1 });
  esc(s, u.id, '', { pos: 1 });
  const h = s.historial(u.id);
  assert.strictEqual(h.length, 2);
  assert.ok(h[1].motivo.indexOf('SOBRESCRITA con «' + G[1] + '»') === 0);
  assert.strictEqual(h[0].motivo, 'BORRADO MANUAL (Celda vaciada)');
  assert.strictEqual(h[0].valor, G[1]);
  assert.strictEqual(h[0].usuario, 'ANA');
  const vista = s.obtenerUnidad(u.id);
  assert.strictEqual(vista.fisico[1].valor, '');
  assert.strictEqual(vista.fisico[1].hora, '');
});

test('hay que decir quién escanea', () => {
  const { s } = nuevo();
  const u = s.crearUnidad('GLOBAL 1');
  assert.throws(() => s.escanear(u.id, { valor: G[0], usuario: '' }), (e) => e.codigo === 401);
});

test('la preforma pegada cuadra contra lo escaneado', () => {
  const { s } = nuevo();
  const u = s.crearUnidad('GLOBAL 1');
  s.pegarPreforma(u.id, [G[0], G[1], '6100001'].join('\n'), 'ANA');
  esc(s, u.id, '6100001'); esc(s, u.id, G[0]);
  let v = s.obtenerUnidad(u.id);
  assert.ok(v.fisico[0].estado.indexOf('❌ Faltan 1 (' + G[1] + ')') !== -1);
  esc(s, u.id, G[1]);
  v = s.obtenerUnidad(u.id);
  assert.ok(v.fisico[0].estado.indexOf('✅ COMPLETO') !== -1);
  assert.strictEqual(v.totales.bultosPreforma, 2);
  assert.strictEqual(v.preforma[2].estado, '2 bultos');
});

test('obtenerUnidad con la misma versión no manda nada', () => {
  const { s } = nuevo();
  const u = s.crearUnidad('GLOBAL 1');
  esc(s, u.id, '6100001');
  const v = s.obtenerUnidad(u.id);
  assert.strictEqual(s.obtenerUnidad(u.id, v.version).sinCambios, true);
  esc(s, u.id, G[0]);
  assert.strictEqual(s.obtenerUnidad(u.id, v.version).sinCambios, undefined);
});

test('una alerta grave aguanta entre escaneos hasta que se edita la fila', () => {
  const { s } = nuevo();
  const a = s.crearUnidad('GLOBAL 1');
  const b = s.crearUnidad('GLOBAL 2');
  esc(s, a.id, '6100001'); esc(s, a.id, G[0]);
  esc(s, b.id, '6100002'); esc(s, b.id, G[0]);      // ⛔ en la de GLOBAL 2
  esc(s, a.id, '', { pos: 1 });                      // se borra el original
  esc(s, b.id, G[1]);                                // otro escaneo en GLOBAL 2
  const fila = s.obtenerUnidad(b.id).fisico[1];
  assert.ok(fila.estado.indexOf('⛔ DUPLICADO') === 0, 'la alerta se cae sola: ' + fila.estado);
  s.forzar(b.id);                                    // Forzar actualización la limpia
  assert.ok(s.obtenerUnidad(b.id).fisico[1].estado.indexOf('✅ Guía') === 0);
});

test('tres operadores a la vez no se pisan: cada escaneo es una transacción', () => {
  const { s } = nuevo();
  const u = s.crearUnidad('GLOBAL 1');
  esc(s, u.id, '6100001');
  const guias = Array.from({ length: 30 }, (_, i) => guia(100 + i));
  guias.forEach((g, i) => s.escanear(u.id, { valor: g, usuario: ['ANA', 'BETO', 'CARLA'][i % 3] }));
  const v = s.obtenerUnidad(u.id);
  assert.strictEqual(v.fisico.length, 31);
  assert.strictEqual(v.totales.bultos, 30);
  assert.deepStrictEqual(v.fisico.map(f => f.fila), Array.from({ length: 31 }, (_, i) => i + 1));
});

test('los tamaños máximos protegen la entrada', () => {
  const { s } = nuevo();
  const u = s.crearUnidad('GLOBAL 1');
  assert.throws(() => esc(s, u.id, 'A'.repeat(201)), ErrorDeUso);
  assert.throws(() => s.crearUnidad('X'.repeat(81)), ErrorDeUso);
  assert.throws(() => s.pegarPreforma(u.id, 'B'.repeat(300), 'ANA'), ErrorDeUso);
  assert.throws(() => s.pegarPreforma(u.id, '\n'.repeat(20001), 'ANA'), ErrorDeUso);
  assert.strictEqual(s.obtenerUnidad(u.id).fisico.length, 0);   // nada se guardó a medias
});

test('el código de barras del pedimento completo (12 datos) no cabe como guía: se rechaza', () => {
  const { s } = nuevo();
  const u = s.crearUnidad('GLOBAL 1');
  const r = esc(s, u.id, '6087\r\n6114956\r\nT1\r\nUPS891122HV8\r\n0000000000000');
  assert.strictEqual(r.estado, '❌ Guía Inválida');   // en las Globales el pedimento se captura con sus 7 dígitos
});
