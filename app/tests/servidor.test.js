'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { abrir } = require('../src/db');
const { crearServicio } = require('../src/servicio');
const { crearServidor } = require('../src/servidor');
const { guia } = require('./ayudas');

async function levantar() {
  const servidor = crearServidor(crearServicio(abrir(':memory:')));
  await new Promise(r => servidor.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + servidor.address().port;
  const llamar = async (metodo, ruta, cuerpo, operador) => {
    const h = { 'content-type': 'application/json' };
    if (operador !== null) h['x-operador'] = encodeURIComponent(operador === undefined ? 'ANA' : operador);
    const r = await fetch(base + ruta, { method: metodo, headers: h, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
    return { codigo: r.status, datos: await r.json().catch(() => ({})), r };
  };
  return { servidor, base, llamar };
}

test('flujo completo por la API', async () => {
  const { servidor, llamar } = await levantar();
  try {
    const nueva = await llamar('POST', '/api/unidades', { nombre: 'GLOBAL 1 20-AE-3H' });
    assert.strictEqual(nueva.codigo, 200);
    const id = nueva.datos.unidad.id;
    assert.strictEqual((await llamar('POST', '/api/unidades/' + id + '/escaneo', { valor: '6100001' })).codigo, 200);
    const e = await llamar('POST', '/api/unidades/' + id + '/escaneo', { valor: guia(1) });
    assert.strictEqual(e.datos.fila, 2);
    assert.strictEqual(e.datos.totales.bultos, 1);
    const vista = await llamar('GET', '/api/unidades/' + id);
    assert.strictEqual(vista.datos.fisico.length, 2);
    assert.strictEqual((await llamar('GET', '/api/unidades/' + id + '?v=' + vista.datos.version)).datos.sinCambios, true);
    assert.strictEqual((await llamar('GET', '/api/unidades')).datos.unidades[0].bultos, 1);
    assert.strictEqual((await llamar('POST', '/api/unidades/' + id + '/forzar')).codigo, 200);
    const p = await llamar('POST', '/api/unidades/' + id + '/preforma', { texto: guia(1) + '\n6100001' });
    assert.strictEqual(p.datos.renglones, 2);
    assert.strictEqual((await llamar('GET', '/api/unidades/' + id + '/historial')).codigo, 200);
  } finally { servidor.close(); }
});

test('sin decir quién escanea no se puede escribir', async () => {
  const { servidor, llamar } = await levantar();
  try {
    const sin = await llamar('POST', '/api/unidades', { nombre: 'X' }, null);
    assert.strictEqual(sin.codigo, 401);
    const nueva = await llamar('POST', '/api/unidades', { nombre: 'GLOBAL 9' });
    const e = await llamar('POST', '/api/unidades/' + nueva.datos.unidad.id + '/escaneo', { valor: guia(2) }, null);
    assert.strictEqual(e.codigo, 401);
  } finally { servidor.close(); }
});

test('el inicio de sesión de la empresa manda sobre el nombre que escribe la pantalla', async () => {
  const { servidor, base } = await levantar();
  try {
    const h = { 'content-type': 'application/json', 'x-ms-client-principal-name': 'ana@empresa.com', 'x-operador': 'OTRO' };
    const nueva = await (await fetch(base + '/api/unidades', { method: 'POST', headers: h, body: JSON.stringify({ nombre: 'GLOBAL 5' }) })).json();
    await fetch(base + '/api/unidades/' + nueva.unidad.id + '/escaneo', { method: 'POST', headers: h, body: JSON.stringify({ valor: guia(3) }) });
    const v = await (await fetch(base + '/api/unidades/' + nueva.unidad.id)).json();
    assert.strictEqual(v.fisico[0].usuario, 'ana@empresa.com');
  } finally { servidor.close(); }
});

test('errores claros: unidad inexistente, ruta inexistente, envío roto, envío enorme', async () => {
  const { servidor, llamar, base } = await levantar();
  try {
    assert.strictEqual((await llamar('GET', '/api/unidades/999')).codigo, 404);
    assert.strictEqual((await llamar('GET', '/api/nada')).codigo, 404);
    const J = { 'content-type': 'application/json', 'x-operador': 'ANA' };
    const roto = await fetch(base + '/api/unidades', { method: 'POST', headers: J, body: '{no es json' });
    assert.strictEqual(roto.status, 400);
    const enorme = await fetch(base + '/api/unidades', { method: 'POST', headers: J, body: 'x'.repeat(1100000) }).catch(() => ({ status: 413 }));
    assert.ok([413].includes(enorme.status) || enorme.status === undefined);
  } finally { servidor.close(); }
});

test('la pantalla se sirve y no deja salirse de su carpeta', async () => {
  const { servidor, base } = await levantar();
  try {
    const raiz = await fetch(base + '/');
    assert.strictEqual(raiz.status, 200);
    assert.ok((await raiz.text()).indexOf('WMS Salidas') !== -1);
    assert.ok(raiz.headers.get('content-security-policy').indexOf("default-src 'self'") !== -1);
    assert.strictEqual((await fetch(base + '/app.js')).status, 200);
    for (const intento of ['/..%2F..%2Fpackage.json', '/../../package.json', '/%2e%2e/%2e%2e/package.json', '/..\\..\\package.json']) {
      const r = await fetch(base + intento);
      assert.ok(r.status === 403 || r.status === 404, intento + ' → ' + r.status);
      assert.strictEqual((await r.text()).indexOf('wms-salidas-app'), -1, intento + ' entregó un archivo de fuera');
    }
    assert.strictEqual((await fetch(base + '/no-existe.html')).status, 404);
  } finally { servidor.close(); }
});

test('una escritura que no viene como JSON se rechaza (así una página ajena no puede escribir)', async () => {
  const { servidor, base } = await levantar();
  try {
    // Lo que puede mandar un formulario de otro sitio sin permiso previo:
    for (const tipo of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
      const r = await fetch(base + '/api/unidades', {
        method: 'POST', headers: { 'content-type': tipo, 'x-ms-client-principal-name': 'ana@empresa.com' },
        body: JSON.stringify({ nombre: 'GLOBAL 7' }) });
      assert.strictEqual(r.status, 415, tipo);
    }
    const sin = await fetch(base + '/api/unidades', { method: 'POST', headers: { 'x-operador': 'ANA' }, body: '{}' });
    assert.strictEqual(sin.status, 415);
    assert.strictEqual((await (await fetch(base + '/api/unidades')).json()).unidades.length, 0);
  } finally { servidor.close(); }
});
