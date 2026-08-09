// Banco de pruebas de la lógica pura del WMS, ejecutable fuera de Google.
//
//   node tests/harness.js
//
// Solo cubre funciones que NO tocan la API de Sheets: clasificación de hojas,
// validación de guías, aislamiento de duplicados y preservación de horas.
// Todo lo que escribe en el spreadsheet hay que probarlo en el archivo real.

global.Utilities = { formatDate: () => "12:00:00" };
global.Session = {
  getScriptTimeZone: () => "UTC",
  getActiveUser: () => ({ getEmail: () => "op@test.com" }),
  getEffectiveUser: () => ({ getEmail: () => "" })
};
global.Logger = { log: (m) => console.log("  " + m) };
global.PropertiesService = { getScriptProperties: () => ({ getProperty: () => null }) };
global.SpreadsheetApp = { getActiveSpreadsheet: () => null };
global.LockService = {};
global.ScriptApp = {};

const fs = require('fs');
const path = require('path');
eval(fs.readFileSync(path.join(__dirname, '..', 'Codigo.gs'), 'utf8'));

let fallos = 0;
function ok(nombre, cond) {
  if (cond) console.log("  ✅ " + nombre);
  else { console.log("  ❌ " + nombre); fallos++; }
}

console.log("\n=== 1. Clasificación de hojas (insensible a mayúsculas) ===");
ok("M-S T1 es bodega", esHojaBodega("M-S T1"));
ok("'M-s t1' minúsculas es bodega", esHojaBodega("M-s t1"));
ok("'Inventario B' es inventario", esHojaInventario("Inventario B"));
ok("INVENTARIO no es principal", !esHojaPrincipal("INVENTARIO 1"));
ok("CACHE_SISTEMA no es principal", !esHojaPrincipal("CACHE_SISTEMA"));
ok("HISTORIAL_BORRADOS no es principal", !esHojaPrincipal("HISTORIAL_BORRADOS"));
ok("MACHO no es principal", !esHojaPrincipal("MACHO"));
ok("GLOBALES sí es principal", esHojaPrincipal("GLOBALES"));
ok("Rezago 2 sí es principal", esHojaPrincipal("Rezago 2"));

console.log("\n=== 2. Validación de guías UPS ===");
ok("TEST_guias sin fallos", TEST_guias().length === 0);

console.log("\n=== 3. Aislamiento de duplicados ===");
const G = "1Z999AA10123456784";
const cache = {
  map: new Map([[G, [
    { hoja: "GLOBALES",     fila: 10, isBodega: false, isInventario: false },
    { hoja: "M-S T1",       fila: 20, isBodega: true,  isInventario: false },
    { hoja: "INVENTARIO A", fila: 30, isBodega: false, isInventario: true  },
    { hoja: "INVENTARIO A", fila: 55, isBodega: false, isInventario: true  },
    { hoja: "INVENTARIO B", fila: 40, isBodega: false, isInventario: true  }
  ]]]),
  headers: [], data: []
};

let r;
r = verificarDuplicadoConCache(cache, "INVENTARIO A", G, 30);
ok("Inventario detecta otra ubicación IW de SU MISMA hoja", r.encontrado && /fila 55/.test(r.ubicacion));

r = verificarDuplicadoConCache(cache, "INVENTARIO C", G, 5);
ok("Inventario detecta duplicado en otra pestaña de inventario", r.encontrado && /INVENTARIO/.test(r.ubicacion));
ok("Inventario NUNCA reporta GLOBALES ni M-S", !/GLOBALES|M-S/.test(r.ubicacion));

r = verificarDuplicadoConCache(cache, "M-S GLOBALES", G, 7);
ok("Bodega solo choca con otra bodega", r.encontrado && r.ubicacion.indexOf("M-S T1") === 0);

r = verificarDuplicadoConCache(cache, "AGA", G, 7);
ok("Global solo choca con otra global", r.encontrado && r.ubicacion.indexOf("GLOBALES") === 0);

r = verificarDuplicadoConCache(cache, "GLOBALES", G, 10);
ok("Una hoja no se marca a sí misma", !r.encontrado);

const cacheSoloBodega = {
  map: new Map([[G, [{ hoja: "M-S T1", fila: 20, isBodega: true, isInventario: false }]]]),
  headers: [], data: []
};
ok("Guía que pasó por T1 se escanea en Global sin alerta",
   !verificarDuplicadoConCache(cacheSoloBodega, "GLOBALES", G, 3).encontrado);
ok("Inventario ignora que la guía esté en bodega",
   !verificarDuplicadoConCache(cacheSoloBodega, "INVENTARIO A", G, 3).encontrado);

console.log("\n=== 4. calcularDuplicadosExternos (hoja completa) ===");
const datos = [];
for (let i = 0; i < 60; i++) datos.push([""]);
datos[30] = [G];

let dupsInv = calcularDuplicadosExternos(datos, 60, "INVENTARIO A", cache);
ok("fila 30 marcada como duplicada", dupsInv.has(30));
ok("apunta a inventario, no a global/bodega", dupsInv.get(30).isInventario === true);

let dupsGlobal = calcularDuplicadosExternos(datos, 60, "AGA", cache);
ok("en hoja Global apunta a GLOBALES", dupsGlobal.get(30).hoja === "GLOBALES");

ok("inventario no marca nada si la guía solo está en bodega",
   calcularDuplicadosExternos(datos, 60, "INVENTARIO A", cacheSoloBodega).size === 0);

console.log("\n=== 5. horaPreservada ===");
const filas = [
  ["1Z...", "", "", "", "", "", "", "", "", "", "", "09:15:00"],
  ["1Z...", "", "", "", "", "", "", "", "", "", "", ""]
];
ok("conserva la hora original", horaPreservada(filas, 0, 11, "1Z...", "12:00:00") === "09:15:00");
ok("sella hora nueva si estaba vacía", horaPreservada(filas, 1, 11, "1Z...", "12:00:00") === "12:00:00");
ok("celda vacía => sin hora", horaPreservada(filas, 0, 11, "", "12:00:00") === "");

console.log("\n" + (fallos === 0 ? "✅ TODOS LOS TESTS PASARON" : "❌ " + fallos + " FALLOS"));
process.exit(fallos === 0 ? 0 : 1);
