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
ok("M-S T1 es M-S", esHojaMS("M-S T1"));
ok("'M-s t1' minúsculas es M-S", esHojaMS("M-s t1"));
ok("'Inventario B' es inventario", esHojaInventario("Inventario B"));
ok("INVENTARIO no es principal", !esHojaPrincipal("INVENTARIO 1"));
ok("CACHE_SISTEMA no es principal", !esHojaPrincipal("CACHE_SISTEMA"));
ok("HISTORIAL_BORRADOS no es principal", !esHojaPrincipal("HISTORIAL_BORRADOS"));
ok("MACHO no es principal", !esHojaPrincipal("MACHO"));
ok("GLOBALES sí es principal", esHojaPrincipal("GLOBALES"));
ok("Rezago 2 sí es principal", esHojaPrincipal("Rezago 2"));

console.log("\n=== 1b. MACHO (FEMAD) y plantillas de inventario ===");
ok("MACHO no se escanea", esHojaSistema("MACHO"));
ok("'INVENTARIO MACHO NO BORRAR' es plantilla, no se escanea", esHojaSistema("INVENTARIO MACHO NO BORRAR"));
ok("...y por tanto no es un inventario operativo", !esHojaPrincipal("INVENTARIO MACHO NO BORRAR"));
ok("'INVENTARIO A' sí es inventario operativo", esHojaInventario("INVENTARIO A") && !esHojaSistema("INVENTARIO A"));
ok("CACHE_SISTEMA es interna", esHojaInterna("CACHE_SISTEMA"));
ok("HISTORIAL_BORRADOS es interna", esHojaInterna("HISTORIAL_BORRADOS"));
ok("una plantilla MACHO NO es interna (sí recibe la columna M)", !esHojaInterna("INVENTARIO MACHO NO BORRAR"));
ok("GLOBAL PENDIENTE no es interna ni MACHO",
   !esHojaInterna("GLOBAL PENDIENTE") && !esHojaMacho("GLOBAL PENDIENTE"));

console.log("\n=== 1d. El tipo de M-S lo da la pestaña, no las guías ===");
ok("M-S T1 -> M-S T1", tipoMS("M-S T1") === "M-S T1");
ok("M-S GLOBALES -> M-S GLOBALES", tipoMS("M-S GLOBALES") === "M-S GLOBALES");
ok("M-S A1 -> M-S A1", tipoMS("M-S A1") === "M-S A1");
ok("M-S CUENTAS ESPECIALES -> abreviatura M-S CTAS ESP", tipoMS("M-S CUENTAS ESPECIALES") === "M-S CTAS ESP");
ok("M-S SEGUIMIENTOS -> M-S SEGUIMIENTOS", tipoMS("M-S SEGUIMIENTOS") === "M-S SEGUIMIENTOS");
ok("SIMPLES -> M-S T1", tipoMS("SIMPLES") === "M-S T1");
ok("MULTIPLES -> M-S GLOBALES", tipoMS("MULTIPLES") === "M-S GLOBALES");

console.log("\n=== 1e. Las M-S no reservan columna de preforma ===");
ok("M-S T1 no usa preforma", usaPreforma("M-S T1") === false);
ok("M-S GLOBALES no usa preforma", usaPreforma("M-S GLOBALES") === false);
ok("GLOBAL PENDIENTE sí usa preforma", usaPreforma("GLOBAL PENDIENTE") === true);
ok("REZAGO sí usa preforma", usaPreforma("REZAGO 2") === true);

console.log("\n=== 1c. Red de seguridad de escaneos pendientes ===");
ok("dato sin estado = sin validar", filaSinValidar("1Z999AA10123456784", "") === true);
ok("marcado como pendiente = sin validar", filaSinValidar("1Z999AA10123456784", "⏳ Pendiente (reintenta)") === true);
ok("dato ya validado = no se toca", filaSinValidar("1Z999AA10123456784", "✅ Ok") === false);
ok("fila vacía = no se toca", filaSinValidar("", "") === false);

console.log("\n=== 2. Validación de guías UPS ===");
ok("TEST_guias sin fallos", TEST_guias().length === 0);

console.log("\n=== 3. Aislamiento de duplicados ===");
const G = "1Z999AA10123456784";
const cache = {
  map: new Map([[G, [
    { hoja: "GLOBALES",     fila: 10, isMS: false, isInventario: false },
    { hoja: "M-S T1",       fila: 20, isMS: true,  isInventario: false },
    { hoja: "INVENTARIO A", fila: 30, isMS: false, isInventario: true  },
    { hoja: "INVENTARIO A", fila: 55, isMS: false, isInventario: true  },
    { hoja: "INVENTARIO B", fila: 40, isMS: false, isInventario: true  }
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
ok("M-S solo choca con otra M-S", r.encontrado && r.ubicacion.indexOf("M-S T1") === 0);

r = verificarDuplicadoConCache(cache, "AGA", G, 7);
ok("Global solo choca con otra global", r.encontrado && r.ubicacion.indexOf("GLOBALES") === 0);

r = verificarDuplicadoConCache(cache, "GLOBALES", G, 10);
ok("Una hoja no se marca a sí misma", !r.encontrado);

const cacheSoloBodega = {
  map: new Map([[G, [{ hoja: "M-S T1", fila: 20, isMS: true, isInventario: false }]]]),
  headers: [], data: []
};
ok("Guía que pasó por T1 se escanea en Global sin alerta",
   !verificarDuplicadoConCache(cacheSoloBodega, "GLOBALES", G, 3).encontrado);
ok("Inventario ignora que la guía esté en M-S",
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

ok("inventario no marca nada si la guía solo está en M-S",
   calcularDuplicadosExternos(datos, 60, "INVENTARIO A", cacheSoloBodega).size === 0);

console.log("\n=== 5. horaPreservada ===");
const filas = [
  ["1Z...", "", "", "", "", "", "", "", "", "", "", "09:15:00"],
  ["1Z...", "", "", "", "", "", "", "", "", "", "", ""]
];
ok("conserva la hora original", horaPreservada(filas, 0, 11, "1Z...", "12:00:00") === "09:15:00");
ok("sella hora nueva si estaba vacía", horaPreservada(filas, 1, 11, "1Z...", "12:00:00") === "12:00:00");
ok("celda vacía => sin hora", horaPreservada(filas, 0, 11, "", "12:00:00") === "");

// La hora va atada a la columna A, no al estado de B.
// 1) B cambia pero A sigue igual: la hora NO se mueve.
const filaConHora = [["1Z999", "estado viejo", "", "", "", "", "", "", "", "", "", "09:15:00"]];
ok("B cambia y A sigue: la hora queda fija",
   horaPreservada(filaConHora, 0, 11, "1Z999", "12:00:00") === "09:15:00");
// 2) A se borra: la hora se limpia (aunque hubiera hora previa).
const filaBorrada = [["", "✅ Ok", "", "", "", "", "", "", "", "", "", "09:15:00"]];
ok("A borrada: la hora se limpia",
   horaPreservada(filaBorrada, 0, 11, "", "12:00:00") === "");
// 3) A con dato y sin hora previa: se sella al momento del escaneo.
const filaNueva = [["1Z888", "", "", "", "", "", "", "", "", "", "", ""]];
ok("A nueva sin hora: se sella ahora",
   horaPreservada(filaNueva, 0, 11, "1Z888", "12:00:00") === "12:00:00");

console.log("\n=== 5b. Registro M-S: todo destino jala de todas las M-S ===");
// Caché con dos pedimentos, cada uno registrado en una M-S distinta.
function cacheMS() {
  const headers = ["M-S T1_FISICO", "M-S A1_FISICO", "M-S CUENTAS ESPECIALES_FISICO"];
  const data = [headers,
    ["6000001", "", ""],
    ["1ZT1AAA", "", ""],
    ["", "6000002", ""],
    ["", "1ZA1BBB", ""],
    ["", "", "6000003"],
    ["", "", "1ZCEXXX"]];
  return { headers, data, map: new Map() };
}
function reg(destino) {
  let r = obtenerRegistroMSDesdeCache(cacheMS(), destino);
  return r.registroMS;
}
let rGlobal = reg("GLOBAL PENDIENTE");
ok("Global ve el pedimento de M-S T1", rGlobal.has("6000001") && rGlobal.get("6000001").has("1ZT1AAA"));
ok("Global ve el pedimento de M-S A1", rGlobal.has("6000002") && rGlobal.get("6000002").has("1ZA1BBB"));
ok("Global ve el pedimento de M-S CTAS ESP", rGlobal.has("6000003"));
let rA1 = reg("A1");
ok("Destino A1 ve M-S T1 y M-S A1", rA1.has("6000001") && rA1.has("6000002"));
let rT1 = reg("T1");
ok("Destino T1 ve M-S A1 y CTAS ESP también", rT1.has("6000002") && rT1.has("6000003"));
// Origen (texto "Escaneado en") correcto
let rg = obtenerRegistroMSDesdeCache(cacheMS(), "GLOBAL PENDIENTE");
ok("origen de 1ZT1AAA = M-S T1", rg.guiasOrigen.get("1ZT1AAA") === "M-S T1");
ok("origen de 1ZCEXXX = M-S CTAS ESP (solo etiqueta)", rg.guiasOrigen.get("1ZCEXXX") === "M-S CTAS ESP");
// Una M-S no se jala a sí misma
let rSelf = obtenerRegistroMSDesdeCache(cacheMS(), "M-S T1");
ok("M-S T1 como destino no se jala a sí misma", !rSelf.registroMS.has("6000001"));

console.log("\n=== 5c. Agrupar no pierde filas ni toca la columna M ===");
// Réplica de la lógica de agrupación de agruparPorPedimento sobre 12 columnas.
function agrupaSim(filas) {
  const COLS = 12;
  let agrupacion = new Map(), pedActual = "SIN PEDIMENTO";
  filas.forEach(fila => {
    let valA = String(fila[0]).trim().toUpperCase();
    if (valA === "") return;
    if (/^\d{7}$/.test(valA)) {
      pedActual = valA;
      if (!agrupacion.has(pedActual)) agrupacion.set(pedActual, { cabecera: fila, guias: [] });
      else agrupacion.get(pedActual).cabecera = fila;
    } else {
      if (!agrupacion.has(pedActual)) agrupacion.set(pedActual, { cabecera: [pedActual].concat(Array(COLS-1).fill("")), guias: [] });
      agrupacion.get(pedActual).guias.push(fila);
    }
  });
  let out = [];
  agrupacion.forEach((b, ped) => { if (ped === "SIN PEDIMENTO") return; out.push(b.cabecera); b.guias.forEach(g => out.push(g)); });
  return out;
}
function f(a, b) { return [a, b].concat(Array(10).fill("")); }

// Una guía ya salida NO debe desaparecer al agrupar.
const entrada = [
  f("6000001", "Bultos: 2"),
  f("1ZAAA", "✅ Guía"),
  f("1ZBBB", "➡ Salió en GLOBAL PENDIENTE"),
  f("6000002", "Bultos: 1"),
  f("1ZCCC", "➡ Salió en GLOBAL PENDIENTE")
];
const salida = agrupaSim(entrada);
const guiasEntrada = entrada.map(r => r[0]).filter(v => v !== "").sort();
const guiasSalida  = salida.map(r => r[0]).filter(v => v !== "").sort();
ok("agrupar conserva TODAS las filas (nada se borra)",
   JSON.stringify(guiasEntrada) === JSON.stringify(guiasSalida));
ok("la guía ya salida sigue presente", guiasSalida.indexOf("1ZBBB") !== -1);
ok("cada bloque queda bajo su pedimento",
   salida[0][0] === "6000001" && salida[3][0] === "6000002");
// El bloque movido abarca 12 columnas: nunca llega a M (13) ni N (14).
ok("solo se mueven 12 columnas (M y N intactas)", salida[0].length === 12);

console.log("\n=== 6. Guías cortas / no-1Z (>7 caracteres) ===");
["1234567890", "12345678", "AB1234567", "9988776655", "XY-4477881"].forEach(g =>
  ok("acepta guía corta " + g, esGuiaUPSValida(g) === true));
ok("7 dígitos sigue siendo pedimento, no guía", esGuiaUPSValida("1234567") === false);
ok("6 dígitos no es guía válida", esGuiaUPSValida("123456") === false);

console.log("\n=== 7. Marcadores estructurales no son guías ===");
["SIN PEDIMENTO", "⚠️ SIN PEDIMENTO", "COSTALES", "FIN"].forEach(m =>
  ok("'" + m + "' no cuenta como guía", esGuiaUPSValida(m) === false));
ok("'SIN PEDIMENTO' abre bloque", esCabeceraBloque("SIN PEDIMENTO") === true);
ok("un pedimento abre bloque", esCabeceraBloque("6100166") === true);
ok("una guía NO abre bloque", esCabeceraBloque("1Z999AA10123456784") === false);
ok("una guía corta NO abre bloque", esCabeceraBloque("1234567890") === false);

// El marcador no debe entrar al índice de duplicados entre pestañas.
const cacheMarcador = {
  map: new Map([["SIN PEDIMENTO", [
    { hoja: "GLOBAL PENDIENTE", fila: 5,  isMS: false, isInventario: false },
    { hoja: "AGA",              fila: 12, isMS: false, isInventario: false }
  ]]]),
  headers: [], data: []
};
const datosMarcador = [];
for (let i = 0; i < 20; i++) datosMarcador.push([""]);
datosMarcador[5] = ["SIN PEDIMENTO"];
ok("'SIN PEDIMENTO' no se marca duplicado entre pestañas",
   calcularDuplicadosExternos(datosMarcador, 20, "GLOBAL PENDIENTE", cacheMarcador).size === 0);

console.log("\n=== 8. HISTORIAL_BORRADOS respeta el layout existente ===");
// Layout real del archivo de producción: USUARIO es la columna B, no la H.
function hojaFalsa(titulos) {
  const escrito = [];
  return {
    escrito,
    getLastColumn: () => titulos.length,
    getLastRow: () => 1,
    getMaxRows: () => 100,
    getMaxColumns: () => titulos.length,
    insertColumnsAfter() {},
    insertRowsAfter() {},
    setFrozenRows() {},
    getRange(fila, col, nf, nc) {
      return {
        getValues: () => (fila === 1 ? [titulos.slice(col - 1, col - 1 + nc)] : []),
        setValues(v) { escrito.push({ fila, col, v }); return this; },
        setFontWeight() { return this; },
        setBackground() { return this; }
      };
    }
  };
}

const titulosReales = ["FECHA Y HORA", "USUARIO", "PESTAÑA", "FILA", "COLUMNA",
                       "GUÍA/PEDIMENTO BORRADO", "ESTADO ANTERIOR", "MOTIVO"];
const hoja = hojaFalsa(titulosReales);
registrarEnHistorialLote({ getSheetByName: () => hoja },
  [eventoHistorial("GLOBAL PENDIENTE", 23, "Físico (Col A)", "1ZRR24456799402079", "✅ Ok", "BORRADO MANUAL (Celda vaciada)")]);

const fila = hoja.escrito[hoja.escrito.length - 1].v[0];
ok("USUARIO cae en la columna B", String(fila[1]).indexOf("@") !== -1 || fila[1] === "(sin trigger avanzado)");
ok("PESTAÑA cae en la columna C", fila[2] === "GLOBAL PENDIENTE");
ok("FILA cae en la columna D", fila[3] === 23);
ok("GUÍA cae en la columna F", fila[5] === "1ZRR24456799402079");
ok("MOTIVO cae en la columna H", String(fila[7]).indexOf("BORRADO MANUAL") === 0);

// Hoja antigua sin columna USUARIO: debe añadirla al final sin descuadrar el resto.
const hojaVieja = hojaFalsa(["FECHA Y HORA", "PESTAÑA", "FILA", "COLUMNA",
                             "GUÍA/PEDIMENTO BORRADO", "ESTADO ANTERIOR", "MOTIVO"]);
registrarEnHistorialLote({ getSheetByName: () => hojaVieja },
  [eventoHistorial("M-S T1", 5, "Físico (Col A)", "1Z123", "✅ Guía", "PRUEBA")]);
const filaVieja = hojaVieja.escrito[hojaVieja.escrito.length - 1].v[0];
ok("hoja sin USUARIO: PESTAÑA sigue en columna B", filaVieja[1] === "M-S T1");
ok("hoja sin USUARIO: se añade al final", filaVieja.length === 8);

console.log("\n" + (fallos === 0 ? "✅ TODOS LOS TESTS PASARON" : "❌ " + fallos + " FALLOS"));
process.exit(fallos === 0 ? 0 : 1);
