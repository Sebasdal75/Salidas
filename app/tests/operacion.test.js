'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { abrir } = require('../src/db');
const { crearServicio } = require('../src/servicio');
const { crearServidor } = require('../src/servidor');
const { respaldar } = require('../scripts/respaldar');
const { guia } = require('./ayudas');

async function levantar(opciones) {
  const servidor = crearServidor(crearServicio(abrir(':memory:')), opciones);
  await new Promise(r => servidor.listen(0, '127.0.0.1', r));
  return { servidor, base: 'http://127.0.0.1:' + servidor.address().port };
}
const post = (base, ruta, cabeceras, cuerpo) => fetch(base + ruta, { method: 'POST',
  headers: Object.assign({ 'content-type': 'application/json' }, cabeceras), body: JSON.stringify(cuerpo || {}) });

test('EXIGIR_SSO: el nombre escrito en la pantalla ya no vale', async () => {
  const { servidor, base } = await levantar({ exigirSso: true });
  try {
    assert.strictEqual((await post(base, '/api/unidades', { 'x-operador': 'ANA' }, { nombre: 'GLOBAL 1' })).status, 401);
    const ok = await post(base, '/api/unidades', { 'x-ms-client-principal-name': 'ana@empresa.com' }, { nombre: 'GLOBAL 1' });
    assert.strictEqual(ok.status, 200);
  } finally { servidor.close(); }
});

test('la cabecera del inicio de sesión se puede cambiar', async () => {
  const { servidor, base } = await levantar({ exigirSso: true, cabeceraSso: 'X-Forwarded-Email' });
  try {
    assert.strictEqual((await post(base, '/api/unidades', { 'x-ms-client-principal-name': 'a@b.c' }, { nombre: 'G1' })).status, 401);
    const n = await (await post(base, '/api/unidades', { 'x-forwarded-email': 'ana@empresa.com' }, { nombre: 'G1' })).json();
    await post(base, '/api/unidades/' + n.unidad.id + '/escaneo', { 'x-forwarded-email': 'ana@empresa.com' }, { valor: guia(1) });
    const v = await (await fetch(base + '/api/unidades/' + n.unidad.id)).json();
    assert.strictEqual(v.fisico[0].usuario, 'ana@empresa.com');
  } finally { servidor.close(); }
});

test('un nombre mal codificado no tumba el servidor', async () => {
  const { servidor, base } = await levantar();
  try {
    const r = await post(base, '/api/unidades', { 'x-operador': '%E0%A4%A' }, { nombre: 'G2' });
    assert.strictEqual(r.status, 401);
  } finally { servidor.close(); }
});

test('el respaldo es una copia legible, con los datos, y conserva solo los últimos', () => {
  const carpeta = fs.mkdtempSync(path.join(os.tmpdir(), 'wms-resp-'));
  try {
    const ruta = path.join(carpeta, 'wms.sqlite');
    const db = abrir(ruta);
    const s = crearServicio(db);
    const u = s.crearUnidad('GLOBAL 1');
    s.escanear(u.id, { valor: '6100001', usuario: 'ANA' });
    const destinos = path.join(carpeta, 'copias');
    const copia = respaldar(ruta, destinos, 2);
    const leida = abrir(copia);
    assert.strictEqual(crearServicio(leida).obtenerUnidad(u.id).fisico[0].valor, '6100001');
    // La app sigue escribiendo mientras existe el respaldo.
    s.escanear(u.id, { valor: guia(1), usuario: 'ANA' });
    // Tres respaldos más con nombres distintos: solo quedan 2.
    for (const sello of ['20200101-000001', '20200101-000002', '20200101-000003']) {
      fs.copyFileSync(copia, path.join(destinos, 'wms-' + sello + '.sqlite'));
    }
    respaldar(ruta, destinos, 2);
    assert.strictEqual(fs.readdirSync(destinos).filter(f => /^wms-.*\.sqlite$/.test(f)).length, 2);
    assert.throws(() => respaldar(path.join(carpeta, 'no-existe.sqlite'), destinos, 2), /No existe la base/);
    db.close(); leida.close();
  } finally { fs.rmSync(carpeta, { recursive: true, force: true }); }
});

test('DB_JOURNAL solo acepta WAL o DELETE', () => {
  assert.throws(() => abrir(':memory:', { journal: 'OFF' }), /WAL o DELETE/);
  abrir(':memory:', { journal: 'delete' }).close();
});
