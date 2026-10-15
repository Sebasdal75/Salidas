'use strict';
// =========================================================================
// BASE DE DATOS
//
// SQLite (incluido en Node, sin instalar nada) para desarrollo y para una
// instalación pequeña en un solo servidor. El esquema es SQL estándar y todo
// el acceso pasa por este archivo, así que pasarlo a PostgreSQL o a SQL Server
// (Azure SQL) es cambiar ESTE archivo; el resto de la app no sabe qué base hay.
// Ver docs/APP-ARQUITECTURA.md, apartado «Base de datos».
// =========================================================================

const { DatabaseSync } = require('node:sqlite');

const ESQUEMA = `
CREATE TABLE IF NOT EXISTS unidades (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre    TEXT NOT NULL,
  clave     TEXT NOT NULL,                       -- nombre en mayúsculas, para comparar
  tipo      TEXT NOT NULL DEFAULT 'GLOBAL',      -- GLOBAL hoy; M-S e inventarios en la fase 2
  estado    TEXT NOT NULL DEFAULT 'abierta',     -- abierta | cerrada
  version   INTEGER NOT NULL DEFAULT 0,          -- sube con cada cambio: así las pantallas saben si refrescar
  creada    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_unidades_clave ON unidades(clave) WHERE estado = 'abierta';

-- Cada renglón de la hoja: lista 'fisico' = lo escaneado (columna A),
-- lista 'preforma' = lo esperado (columna O). pos = renglón - 1.
CREATE TABLE IF NOT EXISTS filas (
  unidad_id INTEGER NOT NULL REFERENCES unidades(id) ON DELETE CASCADE,
  lista     TEXT NOT NULL,
  pos       INTEGER NOT NULL,
  valor     TEXT NOT NULL DEFAULT '',
  estado    TEXT NOT NULL DEFAULT '',
  color     TEXT NOT NULL DEFAULT '#FFFFFF',
  color_a   TEXT NOT NULL DEFAULT '#ffffff',     -- color de la celda del valor
  hora      TEXT NOT NULL DEFAULT '',
  usuario   TEXT NOT NULL DEFAULT '',
  letra     TEXT NOT NULL DEFAULT '',            -- columna N: color del bloque de la preforma
  PRIMARY KEY (unidad_id, lista, pos)
);
CREATE INDEX IF NOT EXISTS ix_filas_valor ON filas(lista, valor);

-- Lo que se borra o se sobrescribe (HISTORIAL_BORRADOS).
CREATE TABLE IF NOT EXISTS historial (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  fecha     TEXT NOT NULL,
  usuario   TEXT NOT NULL,
  unidad    TEXT NOT NULL,
  lista     TEXT NOT NULL,
  fila      INTEGER NOT NULL,
  valor     TEXT NOT NULL,
  estado    TEXT NOT NULL,
  motivo    TEXT NOT NULL
);
`;

// `journal`: 'WAL' (por defecto, lo más rápido) o 'DELETE'. En un disco de red
// (Azure Files, una carpeta compartida) el modo WAL NO es confiable; ahí hay que
// usar 'DELETE', o mejor una base en red. Ver docs/APP-INSTALACION.md.
function abrir(ruta, opciones) {
  const journal = String((opciones && opciones.journal) || 'WAL').toUpperCase();
  if (journal !== 'WAL' && journal !== 'DELETE') throw new Error('DB_JOURNAL debe ser WAL o DELETE.');
  const db = new DatabaseSync(ruta || ':memory:');
  db.exec('PRAGMA journal_mode = ' + journal);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(ESQUEMA);
  return db;
}

// Una transacción: o entra todo o no entra nada. Es lo que en la hoja hacía el
// lock del documento: dos escaneos nunca se pisan.
function transaccion(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (e) { /* ya estaba deshecha */ }
    throw err;
  }
}

module.exports = { abrir, transaccion };
