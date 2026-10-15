'use strict';
// Respaldo de la base, SEGURO aunque la app esté escribiendo (VACUUM INTO crea
// una copia consistente). No hace falta tener instalado sqlite3.
//
//   node scripts/respaldar.js [carpeta-destino]
//
// Lee DB_PATH como la app. Deja wms-AAAAMMDD-HHMMSSmmm.sqlite en la carpeta
// (por defecto ./respaldos junto a la base) y conserva los últimos
// RESPALDOS_CONSERVAR (30) archivos.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function respaldar(rutaBase, carpeta, conservar) {
  if (!fs.existsSync(rutaBase)) throw new Error('No existe la base: ' + rutaBase);
  fs.mkdirSync(carpeta, { recursive: true });
  const sello = new Date().toISOString().replace(/[-:.]/g, '').replace('T', '-').slice(0, 18);
  const destino = path.join(carpeta, 'wms-' + sello + '.sqlite');
  if (fs.existsSync(destino)) throw new Error('Ya existe ' + destino + ': vuelve a intentarlo.');
  const db = new DatabaseSync(rutaBase, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec("VACUUM INTO '" + destino.replace(/'/g, "''") + "'");
  } finally { db.close(); }
  // Comprobar que la copia abre y tiene datos legibles: un respaldo que no se
  // puede leer no es un respaldo.
  const copia = new DatabaseSync(destino, { readOnly: true });
  try {
    const r = copia.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get();
    if (!r || r.n < 1) throw new Error('La copia no tiene tablas.');
  } finally { copia.close(); }
  const viejos = fs.readdirSync(carpeta).filter(f => /^wms-\d{8}-\d{6,9}\.sqlite$/.test(f)).sort();
  while (viejos.length > conservar) fs.unlinkSync(path.join(carpeta, viejos.shift()));
  return destino;
}

if (require.main === module) {
  const base = process.env.DB_PATH || path.join(__dirname, '..', 'datos', 'wms.sqlite');
  const carpeta = process.argv[2] || path.join(path.dirname(base), 'respaldos');
  try {
    console.log('Respaldo listo: ' + respaldar(base, carpeta, Number(process.env.RESPALDOS_CONSERVAR) || 30));
  } catch (e) { console.error('No se pudo respaldar: ' + e.message); process.exit(1); }
}
module.exports = { respaldar };
