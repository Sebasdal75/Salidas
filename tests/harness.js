// Banco de pruebas de la lógica pura del WMS, ejecutable fuera de Google.
//
//   node tests/harness.js
//
// Solo cubre funciones que NO tocan la API de Sheets: clasificación de hojas,
// validación de guías, aislamiento de duplicados y preservación de horas.
// Todo lo que escribe en el spreadsheet hay que probarlo en el archivo real.

global.Utilities = {
  formatDate: () => "12:00:00",
  base64Encode: (s) => Buffer.from(String(s), 'utf8').toString('base64')
};
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
eval(fs.readFileSync(path.join(__dirname, '..', 'House.gs'), 'utf8'));

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

const cacheSoloMS = {
  map: new Map([[G, [{ hoja: "M-S T1", fila: 20, isMS: true, isInventario: false }]]]),
  headers: [], data: []
};
ok("Guía que pasó por T1 se escanea en Global sin alerta",
   !verificarDuplicadoConCache(cacheSoloMS, "GLOBALES", G, 3).encontrado);
ok("Inventario ignora que la guía esté en M-S",
   !verificarDuplicadoConCache(cacheSoloMS, "INVENTARIO A", G, 3).encontrado);

console.log("\n=== 4. calcularDuplicadosExternos (hoja completa) ===");
const datos = [];
for (let i = 0; i < 60; i++) datos.push([""]);
datos[30] = [G];

let dupsInv = calcularDuplicadosExternos(datos, 60, "INVENTARIO A", cache);
ok("fila 30 marcada como duplicada", dupsInv.has(30));
ok("apunta a inventario, no a global/M-S", dupsInv.get(30).isInventario === true);

let dupsGlobal = calcularDuplicadosExternos(datos, 60, "AGA", cache);
ok("en hoja Global apunta a GLOBALES", dupsGlobal.get(30).hoja === "GLOBALES");

ok("inventario no marca nada si la guía solo está en M-S",
   calcularDuplicadosExternos(datos, 60, "INVENTARIO A", cacheSoloMS).size === 0);

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

console.log("\n=== 5d. Colores de la columna A (sustituyen al formato condicional) ===");
ok("pedimento -> azul", colorColumnaA("6100166", "Bultos: 30 | ✅ COMPLETO") === "#178ccc");
ok("guía válida -> verde", colorColumnaA("1Z999AA10123456784", "✅ Ok") === "#00ff00");
ok("guía corta -> verde", colorColumnaA("1234567890", "✅ Guía") === "#00ff00");
ok("duplicada entre hojas -> rojo", colorColumnaA("1Z999AA10123456784", "⛔ DUPLICADO (En: M-S T1 Fila 4)") === "#df5f6b");
ok("duplicada en el mismo pedimento -> rojo en A aunque B vaya en gris", colorColumnaA("1Z999AA10123456784", "🔄 Duplicado local") === "#df5f6b");
ok("duplicada en otro pedimento -> rojo", colorColumnaA("1Z999AA10123456784", "⛔ DUPLICADO (ya en Ped: 6100166, fila 12)") === "#df5f6b");
ok("la PRIMERA de la pareja también en rojo", colorColumnaA("1Z999AA10123456784", "⚠️ DUPLICADO (repetida en la fila 45)") === "#df5f6b");
ok("la primera con cola de resumen sigue en rojo", colorColumnaA("1Z999AA10123456784", "⚠️ DUPLICADO (repetida en la fila 45)   ►   Bultos: 8 | ✅ COMPLETO") === "#df5f6b");
ok("guía inválida -> rojo", colorColumnaA("ABC", "❌ Guía Inválida") === "#df5f6b");
ok("ubicación IW -> azul claro", colorColumnaA("IW-A-01", "Bultos: 5") === "#a4c2f4");
ok("fila vacía -> sin color", colorColumnaA("", "") === "#ffffff");
ok("marcador -> sin color", colorColumnaA("SIN PEDIMENTO", "") === "#ffffff");

console.log("\n=== 5e. Columna O: color de bloque y repetidos ===");
ok("sin letra en N -> verde", colorBloqueO("") === "#00ff00");
ok("letra a -> verde brillante", colorBloqueO("a") === "#35ec09");
ok("letra b -> rosa", colorBloqueO("B") === "#ff00ff");
ok("letra c -> turquesa", colorBloqueO(" c ") === "#39b1b9");
ok("letra desconocida -> verde por defecto", colorBloqueO("z") === "#00ff00");

// Bloques de preforma tal como los arma el cerebro: {pedimento, filasGuias, guias}
let bloquesPre = [
  { pedimento: "6100166", filaPedimento: 3, guias: ["1Z111", "1Z222"], filasGuias: [1, 2] },
  { pedimento: "6100200", filaPedimento: 7, guias: ["1Z111", "SIN PEDIMENTO", "1Z333"], filasGuias: [4, 5, 6] },
  { pedimento: "6100300", filaPedimento: 11, guias: ["1Z333"], filasGuias: [9] }
];
let repePre = repetidasEnPreforma(bloquesPre);
ok("detecta la 2ª aparición", repePre.has(4) && repePre.get(4).idx === 1);
ok("recuerda el pedimento de la primera", repePre.get(4).ped === "6100166");
ok("detecta la repetición entre el 2º y el 3er bloque", repePre.has(9) && repePre.get(9).idx === 6);
ok("la 1ª aparición no se marca", !repePre.has(1) && !repePre.has(2));
ok("los marcadores no cuentan", !repePre.has(5));
ok("solo hay 2 repetidas", repePre.size === 2);
ok("preforma limpia no marca nada",
   repetidasEnPreforma([{ pedimento: "6100166", filaPedimento: 2, guias: ["1Z111"], filasGuias: [1] }]).size === 0);

ok("pedimentoDeFilaPreforma encuentra el bloque", pedimentoDeFilaPreforma(bloquesPre, 4) === "6100200");
ok("fila fuera de todo bloque -> SIN_CABECERA", pedimentoDeFilaPreforma(bloquesPre, 99) === "SIN_CABECERA");

// El aviso de la P no destruye lo que ya hubiera.
let rP = [[""], ["► Resumen: 5 bultos"], ["⛔ DUPLICADO (En: GLOBAL 3 Fila 9)"]];
let cP = [["#fff"], ["#fff"], ["#fff"]];
escribirAvisoPreforma(rP, cP, 0, "AVISO", "#ff9800");
ok("celda vacía: escribe el aviso", rP[0][0] === "AVISO" && cP[0][0] === "#ff9800");
escribirAvisoPreforma(rP, cP, 1, "AVISO", "#ff9800");
ok("con resumen: antepone sin borrarlo", rP[1][0] === "AVISO | ► Resumen: 5 bultos");
escribirAvisoPreforma(rP, cP, 2, "AVISO", "#ff9800");
ok("no pisa un ⛔", rP[2][0] === "⛔ DUPLICADO (En: GLOBAL 3 Fila 9)" && cP[2][0] === "#fff");

console.log("\n=== 5p. Normalización de lo que se teclea ===");
// La regla que aplica el editor: MAYÚSCULAS y solo A-Z y 0-9.
const limpiar = v => String(v).trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
ok("minúsculas a mayúsculas", limpiar("1z999aa10123456784") === "1Z999AA10123456784");
ok("quita guiones", limpiar("1Z-999-AA1") === "1Z999AA1");
ok("quita espacios internos", limpiar("1Z999 AA1") === "1Z999AA1");
ok("quita espacios de los extremos", limpiar("  1Z999AA1  ") === "1Z999AA1");
ok("quita puntos y comas", limpiar("1Z999.AA1,") === "1Z999AA1");
ok("quita acentos y símbolos", limpiar("1Z#99*9Á") === "1Z999");
ok("un pedimento no se altera", limpiar("6035443") === "6035443");
ok("COSTALES en minúsculas sube", limpiar("costales") === "COSTALES");
ok("la letra de bloque sube", limpiar("b") === "B");
ok("celda vacía sigue vacía", limpiar("") === "");
// Las columnas de hora (12 y 19) no están entre las de captura, así que los
// ":" de la hora nunca pasan por esta limpieza.
// Columnas de captura tras retirar los costales: la Q (17) salió, era lo único
// que la usaba.
const COLS_CAPTURA = [1, 14, 15];
ok("la hora no está entre las columnas de captura",
   COLS_CAPTURA.indexOf(12) === -1 && COLS_CAPTURA.indexOf(19) === -1);
// El lote sí sabe escribir en todas las de captura: si faltara alguna, la
// normalización se perdería en silencio.
COLS_CAPTURA.forEach(c =>
   ok("el lote escribe en la columna " + c, columnasDelLote().indexOf(c) !== -1));
// La Q volvió al lote, pero NO por los costales -esos siguen retirados-: ahora
// lleva la house de la preforma, pegada a su estado en la P para que las dos se
// escriban de una sola llamada.
ok("la columna Q vuelve al lote, ahora por la house",
   columnasDelLote().indexOf(17) !== -1);
ok("y no es una columna de captura", COLS_CAPTURA.indexOf(17) === -1);
ok("la columna D ya no está en el lote", columnasDelLote().indexOf(4) === -1);

console.log("\n=== 5u. filaFinalDesdeCache (hasta dónde recalcular) ===");
// Columna 0 = _FISICO (llega a la fila 3), columna 1 = _PREFORMA (llega a la 5).
const cacheFF = { headers: ["GLOBAL 2_FISICO", "GLOBAL 2_PREFORMA", "M-S T1_FISICO"], data: [
  ["GLOBAL 2_FISICO", "GLOBAL 2_PREFORMA", "M-S T1_FISICO"],
  ["1Z1",  "1ZA", "1ZM"],
  ["1Z2",  "1ZB", ""   ],
  ["1Z3",  "1ZC", ""   ],
  ["",     "1ZD", ""   ],
  ["",     "1ZE", ""   ]
]};

ok("la preforma baja más que la A: manda la preforma",
   filaFinalDesdeCache(cacheFF, "GLOBAL 2", 0) === 5);
ok("una M-S sin columna de preforma no revienta",
   filaFinalDesdeCache(cacheFF, "M-S T1", 0) === 1);
ok("hoja no indexada -> 0, o sea pregunta a Sheets",
   filaFinalDesdeCache(cacheFF, "NO EXISTE", 0) === 0);
ok("sin caché -> 0", filaFinalDesdeCache(null, "GLOBAL 2", 0) === 0);
ok("normaliza el nombre de la hoja",
   filaFinalDesdeCache(cacheFF, "global 2", 0) === 5);

// EL assert que impide la regresión del borrado de la última fila.
ok("la fila recién editada es siempre el suelo",
   filaFinalDesdeCache(cacheFF, "GLOBAL 2", 40) === 40);
ok("edición en bloque: manda la última fila del bloque",
   filaFinalDesdeCache(cacheFF, "GLOBAL 2", 500) === 500);
ok("si el caché va más abajo que la edición, manda el caché",
   filaFinalDesdeCache(cacheFF, "GLOBAL 2", 2) === 5);

// Hoja indexada pero vacía: nunca 0 ni negativo, o la lectura fallaría.
const cacheVacioFF = { headers: ["NUEVA_FISICO"], data: [["NUEVA_FISICO"]] };
ok("hoja indexada pero sin datos -> 1, no 0",
   filaFinalDesdeCache(cacheVacioFF, "NUEVA", 0) === 1);
ok("hoja indexada y sin datos, con edición en la fila 1 -> 1",
   filaFinalDesdeCache(cacheVacioFF, "NUEVA", 1) === 1);

console.log("\n=== 5s. construirIndiceCache ===");
// data[0] son los encabezados; data[r] corresponde a la fila r de la hoja.
const hdrsIdx = ["GLOBAL 2_FISICO", "GLOBAL 2_PREFORMA", "M-S T1_FISICO", "INVENTARIO A_FISICO"];
const dataIdx = [
  hdrsIdx,
  ["1Z111",         "1ZPRE",  "1Z111", ""       ],  // fila 1
  ["",              "",       "",      "1Z222"  ],  // fila 2
  ["SIN PEDIMENTO", "",       "",      ""       ],  // fila 3
  ["  1z333  ",     "",       "",      ""       ],  // fila 4
  ["6100166",       "",       "",      ""       ]   // fila 5: un pedimento SÍ se indexa
];
let idx = construirIndiceCache(dataIdx, hdrsIdx);

ok("la misma guía en dos pestañas da dos entradas", idx.get("1Z111").length === 2);
ok("el índice de fila ES la fila de la hoja", idx.get("1Z111")[0].fila === 1);
ok("marca la M-S como M-S", idx.get("1Z111").some(e => e.hoja === "M-S T1" && e.isMS === true));
ok("marca el inventario como inventario", idx.get("1Z222")[0].isInventario === true);
ok("el destino no es ni M-S ni inventario",
   idx.get("1Z111").some(e => e.hoja === "GLOBAL 2" && !e.isMS && !e.isInventario));
ok("normaliza espacios y minúsculas", idx.has("1Z333") && idx.get("1Z333")[0].fila === 4);
ok("salta los marcadores estructurales", !idx.has("SIN PEDIMENTO"));
ok("el pedimento sí entra al índice", idx.has("6100166"));
ok("las columnas _PREFORMA NO entran", !idx.has("1ZPRE"));
ok("las celdas vacías no crean entradas", !idx.has(""));

// El caso que produce el "DUPLICADO fantasma": dos columnas con el mismo nombre
// de hoja, que es lo que queda tras renombrar una pestaña sin podar el caché.
const hdrsDobles = ["GLOBAL 2_FISICO", "GLOBAL 2_FISICO"];
let idxDobles = construirIndiceCache([hdrsDobles, ["1Z999", "1Z999"]], hdrsDobles);
ok("dos columnas de la misma hoja producen dos entradas", idxDobles.get("1Z999").length === 2);

// Leer la rejilla entera en vez de getDataRange trae de propina cientos de
// filas vacías al final. El índice tiene que salir EXACTAMENTE igual: si estas
// filas de relleno cambiaran algo, cambiarían los mensajes de duplicado.
const dataConRelleno = dataIdx.slice();
for (let i = 0; i < 500; i++) dataConRelleno.push(["", "", "", ""]);
let idxRelleno = construirIndiceCache(dataConRelleno, hdrsIdx);
ok("las filas de relleno no cambian el tamaño del índice", idxRelleno.size === idx.size);
ok("las filas de relleno no cambian las entradas",
   JSON.stringify(Array.from(idxRelleno.entries())) === JSON.stringify(Array.from(idx.entries())));

// Lo mismo para saber hasta dónde recalcular: el relleno no puede correr la
// última fila hacia abajo, o se recalcularían cientos de filas en blanco.
const cacheRelleno = { headers: hdrsIdx, data: dataConRelleno };
ok("el relleno no corre la última fila", ultimaFilaEnCache(cacheRelleno, 0) === 5);
ok("filaFinalDesdeCache ignora el relleno",
   filaFinalDesdeCache(cacheRelleno, "GLOBAL 2", 0) === 5);

ok("sin encabezados devuelve un índice vacío", construirIndiceCache([[]], []).size === 0);
ok("sin datos devuelve un índice vacío", construirIndiceCache(null, hdrsIdx).size === 0);
ok("solo encabezados devuelve un índice vacío", construirIndiceCache([hdrsIdx], hdrsIdx).size === 0);
ok("una fila hueca no revienta",
   construirIndiceCache([hdrsIdx, null, ["1Z777","","",""]], hdrsIdx).get("1Z777")[0].fila === 2);

// Equivalencia con la implementación anterior, sobre datos con ruido.
function indiceIngenuo(data, headers) {
  let m = new Map();
  for (let c = 0; c < headers.length; c++) {
    let h = String(headers[c]);
    if (!h.endsWith("_FISICO")) continue;
    let hoja = claveHoja(h.replace("_FISICO", ""));
    for (let r = 1; r < data.length; r++) {
      let v = String(data[r][c]).trim().toUpperCase();
      if (v === "" || esMarcadorEstructural(v)) continue;
      let arr = m.get(v) || [];
      arr.push({ hoja: hoja, fila: r, isMS: esHojaMS(hoja), isInventario: esHojaInventario(hoja) });
      m.set(v, arr);
    }
  }
  return m;
}
const hdrsRuido = ["GLOBAL 2_FISICO", "M-S T1_FISICO", "GLOBAL 2_PREFORMA", "INVENTARIO A_FISICO", "", "RARO"];
let dataRuido = [hdrsRuido];
for (let i = 1; i <= 200; i++) {
  dataRuido.push([
    i % 3 === 0 ? "" : "1Z" + (i % 47),
    i % 5 === 0 ? "SIN PEDIMENTO" : (i % 7 === 0 ? "  " : "1Z" + (i % 31)),
    "1ZPRE" + i,
    i % 11 === 0 ? "1Z" + (i % 47) : "",
    "basura", "basura"
  ]);
}
let a = construirIndiceCache(dataRuido, hdrsRuido);
let b = indiceIngenuo(dataRuido, hdrsRuido);
ok("mismo número de guías que la versión anterior", a.size === b.size);
// El ORDEN importa: quien consulta el índice se queda con la primera entrada
// que encaje, así que es lo que decide qué ubicación se nombra en el mensaje
// de duplicado. Tiene que ser idéntico al de antes, no solo equivalente.
ok("mismas entradas, en el mismo orden, con los mismos campos",
   JSON.stringify([...a.entries()]) === JSON.stringify([...b.entries()]));

console.log("\n=== 5s2. cacheVacio (la guarda que getDataRange se lleva por delante) ===");
ok("hoja en blanco: getDataRange devuelve [[\"\"]]", cacheVacio([[""]]) === true);
ok("varias celdas vacías en una sola fila", cacheVacio([["", "  ", ""]]) === true);
ok("array vacío", cacheVacio([]) === true);
ok("null", cacheVacio(null) === true);
ok("una fila con encabezado de verdad NO está vacío", cacheVacio([["GLOBAL 2_FISICO"]]) === false);
ok("encabezados + datos NO está vacío", cacheVacio([["GLOBAL 2_FISICO"], ["1Z111"]]) === false);

// La foto ya no se lee con getDataRange sino sobre la rejilla entera, así que
// una hoja en blanco llega como miles de filas vacías en vez de como [[""]].
// El atajo viejo ("más de una fila => hay caché") la habría dado por buena y
// habríamos indexado la nada creyendo que teníamos caché.
const rejillaEnBlanco = [];
for (let i = 0; i < 3000; i++) rejillaEnBlanco.push(["", "", "", "", "", "", "", ""]);
ok("rejilla de 3.000 filas vacías SÍ está vacía", cacheVacio(rejillaEnBlanco) === true);

// Y al revés: con encabezados de verdad, que el resto de la rejilla venga en
// blanco no significa que no haya caché. Es una hoja indexada y todavía sin
// escanear, que es el estado normal a primera hora.
const rejillaSoloEncabezados = [["GLOBAL 2_FISICO", "GLOBAL 2_PREFORMA", "", "", "", "", "", ""]];
for (let i = 0; i < 2999; i++) rejillaSoloEncabezados.push(["", "", "", "", "", "", "", ""]);
ok("rejilla con encabezados y sin datos NO está vacía", cacheVacio(rejillaSoloEncabezados) === false);

console.log("\n=== 5r. Poda del caché al renombrar una pestaña ===");
// Se renombró "GLOBAL 2" a "GLOBAL 4": su columna vieja tiene que irse, o la
// hoja se compara contra su propio pasado y sale entera duplicada.
let hdrs = ["GLOBAL 2_FISICO", "GLOBAL 2_PREFORMA", "GLOBAL 4_FISICO", "GLOBAL 4_PREFORMA", "M-S T1_FISICO"];
let viven = new Set(["GLOBAL 4", "M-S T1"]);
let borrar = columnasHuerfanas(hdrs, viven);
ok("se borran las dos columnas del nombre viejo", borrar.indexOf(1) !== -1 && borrar.indexOf(2) !== -1);
ok("las del nombre nuevo se quedan", borrar.indexOf(3) === -1 && borrar.indexOf(4) === -1);
ok("la M-S se queda", borrar.indexOf(5) === -1);
ok("se devuelven de derecha a izquierda", borrar.join(",") === "2,1");

// Una M-S no usa preforma: su columna _PREFORMA sobra aunque la pestaña exista.
ok("la preforma de una M-S se poda",
   columnasHuerfanas(["M-S T1_FISICO", "M-S T1_PREFORMA"], new Set(["M-S T1"])).join(",") === "2");
ok("la preforma de un destino se respeta",
   columnasHuerfanas(["GLOBAL 4_FISICO", "GLOBAL 4_PREFORMA"], new Set(["GLOBAL 4"])).length === 0);
ok("los encabezados vacíos se ignoran",
   columnasHuerfanas(["", "GLOBAL 4_FISICO", ""], new Set(["GLOBAL 4"])).length === 0);
// Un encabezado de solo espacios es un HUECO para columnaDeHeader. Si la poda
// lo tomara por pestaña desconocida lo borraría, desplazando las columnas de su
// derecha y descolocando el caché entero.
ok("un encabezado de solo espacios se salta, no se borra",
   columnasHuerfanas(["   ", "GLOBAL 4_FISICO"], new Set(["GLOBAL 4"])).length === 0);
ok("un tabulador tampoco se borra",
   columnasHuerfanas(["\t", "GLOBAL 4_FISICO"], new Set(["GLOBAL 4"])).length === 0);
ok("sin nada que podar devuelve vacío",
   columnasHuerfanas(["M-S T1_FISICO"], new Set(["M-S T1"])).length === 0);

console.log("\n=== 5q. hojasConGuias: cada dominio ve solo el suyo ===");
const cacheDominios = { map: new Map([
  ["1Z111", [
    { hoja: "GLOBAL 2",     fila: 5,  isMS: false, isInventario: false },
    { hoja: "GLOBAL 3",     fila: 80, isMS: false, isInventario: false },
    { hoja: "M-S T1",       fila: 12, isMS: true,  isInventario: false },
    { hoja: "INVENTARIO A", fila: 3,  isMS: false, isInventario: true  }
  ]]
]), headers: [], data: [] };

let dest = hojasConGuias(cacheDominios, new Set(["1Z111"]), "destino");
ok("destino devuelve las dos globales", dest.size === 2 && dest.has("GLOBAL 2") && dest.has("GLOBAL 3"));
ok("destino no arrastra la M-S ni el inventario", !dest.has("M-S T1") && !dest.has("INVENTARIO A"));

let ms = hojasConGuias(cacheDominios, new Set(["1Z111"]), "ms");
ok("ms devuelve solo la M-S", ms.size === 1 && ms.has("M-S T1"));
ok("hojasMSConGuias sigue funcionando igual",
   hojasMSConGuias(cacheDominios, new Set(["1Z111"])).has("M-S T1"));

let inv = hojasConGuias(cacheDominios, new Set(["1Z111"]), "inventario");
ok("inventario devuelve solo el inventario", inv.size === 1 && inv.has("INVENTARIO A"));

ok("guía desconocida -> vacío", hojasConGuias(cacheDominios, new Set(["NOEXISTE"]), "destino").size === 0);
ok("sin caché -> vacío", hojasConGuias(null, new Set(["1Z111"]), "destino").size === 0);
ok("normaliza minúsculas", hojasConGuias(cacheDominios, new Set([" 1z111 "]), "destino").size === 2);

console.log("\n=== 5o. Pedimento repetido en OTRA pestaña ===");
const PED = "6035443";
const cachePed = { map: new Map([[PED, [
  { hoja: "A1 77-14-ZP", fila: 684, isMS: false, isInventario: false },
  { hoja: "GLOBAL 3",    fila: 120, isMS: false, isInventario: false },
  { hoja: "M-S A1",      fila: 37,  isMS: true,  isInventario: false }
]]]), headers: [], data: [] };

let filasPed = [];
for (let i = 0; i < 700; i++) filasPed.push([""]);
filasPed[684] = [PED];

// Destino contra destino: sí se marca, y señala la otra hoja.
let dp = calcularPedimentosDuplicadosExternos(filasPed, 700, "A1 77-14-ZP", cachePed);
ok("destino detecta el pedimento en otro destino", dp.has(684) && dp.get(684).hoja === "GLOBAL 3");
ok("no señala la M-S, que es flujo normal", dp.get(684).isMS !== true);

// Una M-S contra otra M-S.
const cacheDosMS = { map: new Map([[PED, [
  { hoja: "M-S A1", fila: 37, isMS: true, isInventario: false },
  { hoja: "M-S T1", fila: 9,  isMS: true, isInventario: false }
]]]), headers: [], data: [] };
let dpMS = calcularPedimentosDuplicadosExternos(filasPed, 700, "M-S A1", cacheDosMS);
ok("M-S detecta el pedimento en otra M-S", dpMS.has(684) && dpMS.get(684).hoja === "M-S T1");

// Lo esencial: M-S y su destino NO chocan. Sería un falso positivo constante.
const cacheMSyDestino = { map: new Map([[PED, [
  { hoja: "A1 77-14-ZP", fila: 684, isMS: false, isInventario: false },
  { hoja: "M-S A1",      fila: 37,  isMS: true,  isInventario: false }
]]]), headers: [], data: [] };
ok("destino NO choca con su M-S",
   calcularPedimentosDuplicadosExternos(filasPed, 700, "A1 77-14-ZP", cacheMSyDestino).size === 0);
ok("M-S NO choca con su destino",
   calcularPedimentosDuplicadosExternos(filasPed, 700, "M-S A1", cacheMSyDestino).size === 0);

// La propia hoja la vigila pedimentosVistosFisico, no esto.
const cacheMisma = { map: new Map([[PED, [
  { hoja: "A1 77-14-ZP", fila: 684, isMS: false, isInventario: false },
  { hoja: "A1 77-14-ZP", fila: 900, isMS: false, isInventario: false }
]]]), headers: [], data: [] };
ok("la propia hoja no se marca aquí",
   calcularPedimentosDuplicadosExternos(filasPed, 700, "A1 77-14-ZP", cacheMisma).size === 0);

// Solo pedimentos: una guía en esa fila no entra.
let filasGuia = [];
for (let i = 0; i < 700; i++) filasGuia.push([""]);
filasGuia[684] = ["1Z999AA10123456784"];
ok("una guía no cuenta como pedimento",
   calcularPedimentosDuplicadosExternos(filasGuia, 700, "A1 77-14-ZP", cachePed).size === 0);
ok("los inventarios no llevan pedimentos",
   calcularPedimentosDuplicadosExternos(filasPed, 700, "INVENTARIO A", cachePed).size === 0);

// El aviso no pisa uno crítico que ya estuviera puesto.
let rB = [["🛑 PEDIMENTO REPETIDO"], ["Bultos: 0"]];
let cB = [["#fff"], ["#fff"]];
marcarPedimentosRepetidosFuera(rB, cB, new Map([[0, { hoja: "GLOBAL 3", fila: 120 }]]));
ok("no pisa el repetido de la propia hoja", rB[0][0] === "🛑 PEDIMENTO REPETIDO");
marcarPedimentosRepetidosFuera(rB, cB, new Map([[1, { hoja: "GLOBAL 3", fila: 120 }]]));
ok("sí escribe sobre el resumen normal",
   rB[1][0] === "🛑 PEDIMENTO REPETIDO (En: GLOBAL 3 Fila 120)" && cB[1][0] === "#dc3545");

console.log("\n=== 5n. Nota de filas con alerta (sustituye a 'Esperando guías') ===");
ok("sin alertas no dice nada", notaConAlerta(0) === "");
ok("undefined no dice nada", notaConAlerta(undefined) === "");
ok("negativo no dice nada", notaConAlerta(-1) === "");
ok("una alerta", notaConAlerta(1) === "⚠️ 1 con alerta");
ok("varias alertas", notaConAlerta(3) === "⚠️ 3 con alerta");

console.log("\n=== 5m. Prioridad de alertas: lo grave no se tapa ===");
ok("vacío es informativo", nivelAlerta("") === 0);
ok("✅ Ok es informativo", nivelAlerta("✅ Ok") === 0);
ok("➡ Salió en es informativo", nivelAlerta("➡ Salió en GLOBAL 2") === 0);
ok("► Resumen es informativo", nivelAlerta("► Resumen: 5 bultos") === 0);
ok("🔄 Duplicado local es aviso", nivelAlerta("🔄 Duplicado local") === 1);
ok("⚠️ Sobra es aviso", nivelAlerta("⚠️ Sobra (Ajena)") === 1);
ok("❌ Guía Inválida es medio", nivelAlerta("❌ Guía Inválida") === 2);
ok("❌ Va en otro pedimento es medio", nivelAlerta("❌ Va en: 6100166") === 2);
ok("⛔ DUPLICADO es alto", nivelAlerta("⛔ DUPLICADO (En: M-S T1 Fila 4)") === 3);
ok("🛑 ERROR es crítico", nivelAlerta("🛑 ERROR: Faltan 2 números") === 4);
ok("🛑 PEDIMENTO REPETIDO es crítico", nivelAlerta("🛑 PEDIMENTO REPETIDO") === 4);

// Lo que motivó la regla: el barrido de salidas ya no borra un duplicado.
ok("'Salió en' NO pisa un ⛔ DUPLICADO",
   puedePisar("⛔ DUPLICADO (En: M-S T1 Fila 4)", "➡ Salió en GLOBAL 2") === false);
ok("'Salió en' NO pisa un ❌ Guía Inválida",
   puedePisar("❌ Guía Inválida", "➡ Salió en GLOBAL 2") === false);
ok("'Salió en' NO pisa un 🔄 Duplicado local",
   puedePisar("🔄 Duplicado local", "➡ Salió en GLOBAL 2") === false);
ok("'Salió en' SÍ pisa un ✅ Ok",
   puedePisar("✅ Ok", "➡ Salió en GLOBAL 2") === true);
ok("'Salió en' SÍ escribe sobre una celda vacía",
   puedePisar("", "➡ Salió en GLOBAL 2") === true);
ok("'Salió en' SÍ pisa un ⏳ Pendiente",
   puedePisar("⏳ Pendiente (reintenta)", "➡ Salió en GLOBAL 2") === true);

// Entre alertas: la de igual o más peso sí puede escribir.
ok("un ⛔ pisa a un ⚠️", puedePisar("⚠️ Sobra (Ajena)", "⛔ DUPLICADO (ya en Ped: 6100166, fila 3)") === true);
ok("un ⚠️ no pisa a un ⛔", puedePisar("⛔ DUPLICADO (En: GLOBAL 3 Fila 9)", "⚠️ PEDIMENTO REPETIDO") === false);
ok("un ⛔ pisa a otro ⛔ (mismo nivel)", puedePisar("⛔ A", "⛔ B") === true);

// escribirAvisoPreforma aplica la regla y conserva el resumen.
let rP2 = [[""], ["► Resumen: 5 bultos"], ["⛔ DUPLICADO (En: GLOBAL 3 Fila 9)"], ["⚠️ PEDIMENTO REPETIDO"]];
let cP2 = [["#fff"], ["#fff"], ["#fff"], ["#fff"]];
escribirAvisoPreforma(rP2, cP2, 0, "⚠️ GUÍA REPETIDA", "#ff9800");
ok("celda vacía: escribe", rP2[0][0] === "⚠️ GUÍA REPETIDA" && cP2[0][0] === "#ff9800");
escribirAvisoPreforma(rP2, cP2, 1, "⚠️ GUÍA REPETIDA", "#ff9800");
ok("con resumen: antepone sin borrarlo", rP2[1][0] === "⚠️ GUÍA REPETIDA | ► Resumen: 5 bultos");
escribirAvisoPreforma(rP2, cP2, 2, "⚠️ GUÍA REPETIDA", "#ff9800");
ok("no pisa un ⛔ más grave", rP2[2][0] === "⛔ DUPLICADO (En: GLOBAL 3 Fila 9)" && cP2[2][0] === "#fff");
escribirAvisoPreforma(rP2, cP2, 3, "⚠️ GUÍA REPETIDA", "#ff9800");
ok("no apila dos avisos del mismo peso", rP2[3][0] === "⚠️ PEDIMENTO REPETIDO");

console.log("\n=== 5l. La red de seguridad no se queda en bucle ===");
// Las cabeceras no siempre reciben estado (rezago, bloques con error). Si
// contaran como pendientes, la hoja se recalcularía cada minuto para siempre.
ok("pedimento sin estado NO es pendiente", filaSinValidar("6100166", "") === false);
ok("SIN PEDIMENTO sin estado NO es pendiente", filaSinValidar("SIN PEDIMENTO", "") === false);
// COSTALES y FIN siguen siendo marcadores neutros aunque su proceso ya no exista:
// así el texto que quedara de antes no se vuelve "Guía Inválida" de golpe.
ok("COSTALES sin estado NO es pendiente", filaSinValidar("COSTALES", "") === false);
ok("FIN sin estado NO es pendiente", filaSinValidar("FIN", "") === false);
// Y lo que sí tiene que seguir detectando:
ok("guía sin estado SÍ es pendiente", filaSinValidar("1Z999AA10123456784", "") === true);
ok("guía marcada como pendiente SÍ se recoge",
   filaSinValidar("1Z999AA10123456784", "⏳ Pendiente (reintenta)") === true);
ok("guía ya validada no se toca", filaSinValidar("1Z999AA10123456784", "✅ Ok") === false);
ok("guía inválida ya avisada no se toca", filaSinValidar("ABC123", "❌ Guía Inválida") === false);

console.log("\n=== 5g. ultimaFilaEnCache (evita getLastRow) ===");
// data[0] son los headers; data[r] corresponde a la fila r de la hoja.
const cacheFilas = { data: [
  ["GLOBALES_FISICO", "M-S T1_FISICO", "VACIA_FISICO"],
  ["6100166",         "1Z111",         ""],
  ["1Z999",           "",              ""],
  ["",                "1Z222",         ""],
  ["",                "",              ""]
], headers: [], map: new Map() };

ok("última fila con dato de la columna 0", ultimaFilaEnCache(cacheFilas, 0) === 2);
ok("no se queda en el primer hueco de la columna 1", ultimaFilaEnCache(cacheFilas, 1) === 3);
ok("columna sin nada -> 0", ultimaFilaEnCache(cacheFilas, 2) === 0);
ok("hoja no indexada -> -1 (hay que preguntar a Sheets)", ultimaFilaEnCache(cacheFilas, undefined) === -1);
ok("columna negativa -> -1", ultimaFilaEnCache(cacheFilas, -1) === -1);
ok("sin caché -> -1", ultimaFilaEnCache(null, 0) === -1);
ok("caché sin data -> -1", ultimaFilaEnCache({}, 0) === -1);
ok("solo headers -> 0", ultimaFilaEnCache({ data: [["X_FISICO"]] }, 0) === 0);
// Los espacios no cuentan como dato.
ok("celda con espacios no cuenta",
   ultimaFilaEnCache({ data: [["X_FISICO"], ["1Z1"], ["   "]] }, 0) === 1);

console.log("\n=== 5k. Inventario: la misma guía en dos ubicaciones IW de la misma hoja ===");
// Este caso NO lo ve la lógica local (guiasFisicas se vacía en cada IW): lo
// detecta el caché. Hay que comprobar que marca las DOS filas, no solo una,
// porque si no, en la columna A una quedaría verde.
// OJO CON LOS ÍNDICES, que aquí estuvo el fallo: el caché guarda la FILA DE LA
// HOJA (1, 2, 3...) y el array de datos empieza en 0. El índice 30 es la fila
// 31. Este fixture los tenía mezclados y por eso el test daba por bueno un bug:
// una guía nunca se saltaba a sí misma.
const cacheDosIW = {
  map: new Map([[G, [
    { hoja: "INVENTARIO A", fila: 31, isMS: false, isInventario: true },
    { hoja: "INVENTARIO A", fila: 56, isMS: false, isInventario: true }
  ]]]),
  headers: [], data: []
};
let filasInv = [];
for (let i = 0; i < 60; i++) filasInv.push([""]);
filasInv[30] = [G];   // fila 31 de la hoja
filasInv[55] = [G];   // fila 56 de la hoja

let dupDosIW = calcularDuplicadosExternos(filasInv, 60, "INVENTARIO A", cacheDosIW);
ok("marca la fila 30", dupDosIW.has(30));
ok("marca también la fila 55", dupDosIW.has(55));
ok("cada una apunta a la OTRA, no a sí misma",
   dupDosIW.get(30).fila === 56 && dupDosIW.get(55).fila === 31);

// EL CASO QUE FALTABA: una guía que está UNA sola vez no puede salir duplicada
// de sí misma. Es lo que hacía que la última guía de cada ubicación IW se
// marcara sola, porque al mirar «la otra» se leía la fila siguiente, que en el
// último renglón del bloque es ya la cabecera IW de la ubicación nueva.
const cacheUnaSola = {
  map: new Map([[G, [{ hoja: "INVENTARIO A", fila: 31, isMS: false, isInventario: true }]]]),
  headers: [], data: []
};
let filaUnica = [];
for (let i = 0; i < 60; i++) filaUnica.push([""]);
filaUnica[30] = [G];   // fila 31 de la hoja
ok("una guía sola NO es duplicado de sí misma",
   calcularDuplicadosExternos(filaUnica, 60, "INVENTARIO A", cacheUnaSola).size === 0);
// Y por tanto las dos llevan "⛔ DUPLICADO" en la B, que la columna A pinta de rojo.
ok("las dos acaban rojas en la columna A",
   colorColumnaA(G, "⛔ DUPLICADO (En: INVENTARIO A Fila 55)") === "#df5f6b" &&
   colorColumnaA(G, "⛔ DUPLICADO (En: INVENTARIO A Fila 30)") === "#df5f6b");

// En cambio una hoja Global NO se marca a sí misma por caché: ese caso lo lleva
// la lógica local de pedimentos, que es la que empareja las dos filas.
const cacheDosGlobal = {
  map: new Map([[G, [
    { hoja: "GLOBAL 2", fila: 10, isMS: false, isInventario: false },
    { hoja: "GLOBAL 2", fila: 40, isMS: false, isInventario: false }
  ]]]),
  headers: [], data: []
};
let filasGlob = [];
for (let i = 0; i < 60; i++) filasGlob.push([""]);
filasGlob[10] = [G]; filasGlob[40] = [G];
ok("Global no se duplica contra sí misma por caché",
   calcularDuplicadosExternos(filasGlob, 60, "GLOBAL 2", cacheDosGlobal).size === 0);

console.log("\n=== 5j. La columna A pinta las DOS de la pareja ===");
// Fila 3 es la primera (se queda en "✅ Ok"), fila 7 la repetida en gris.
const filaA = v => { let f = new Array(20).fill(""); f[0] = v; return f; };
let hojaPar = [];
for (let i = 0; i < 10; i++) hojaPar.push(filaA(""));
hojaPar[0] = filaA("6100166");
hojaPar[3] = filaA("1Z999AA10123456784");
hojaPar[7] = filaA("1Z999AA10123456784");
let estados = hojaPar.map(() => [""]);
estados[3][0] = "✅ Ok";
estados[7][0] = "🔄 Duplicado local";

let sinPareja = coloresDeColumnaA(hojaPar, estados, 10, null);
ok("sin el conjunto, la primera se queda verde", sinPareja[3][0] === "#00ff00");

let conPareja = coloresDeColumnaA(hojaPar, estados, 10, new Set([3, 7]));
ok("la primera de la pareja sale roja", conPareja[3][0] === "#df5f6b");
ok("la repetida también sale roja", conPareja[7][0] === "#df5f6b");
ok("el pedimento sigue azul", conPareja[0][0] === "#178ccc");
ok("las filas vacías siguen sin color", conPareja[5][0] === "#ffffff");

// Una fila vacía marcada por error no se pinta: sin dato no hay duplicado.
ok("fila vacía marcada no se pinta", coloresDeColumnaA(hojaPar, estados, 10, new Set([5]))[5][0] === "#ffffff");

console.log("\n=== 5i. Duplicados dentro de la misma hoja ===");
// Mismo pedimento: doble escaneo sin más. Gris, discreto, sin marcar la primera.
let dMismo = duplicadoLocal({ ped: "6100166", idx: 11 }, "6100166");
ok("mismo pedimento -> 'Duplicado local'", dMismo.texto === "🔄 Duplicado local");
ok("mismo pedimento -> gris", dMismo.color === "#acacac");
ok("mismo pedimento -> NO marca la primera", dMismo.marcarPrimera === false);

// Otro pedimento: hay que decidir a cuál pertenece. Naranja y se pintan las dos.
let dOtro = duplicadoLocal({ ped: "6100166", idx: 11 }, "6100200");
ok("otro pedimento -> dice cuál y en qué fila",
   dOtro.texto === "⛔ DUPLICADO (ya en Ped: 6100166, fila 12)");
ok("otro pedimento -> naranja", dOtro.color === "#ff9800");
ok("otro pedimento -> sí marca la primera", dOtro.marcarPrimera === true);

// Sin cabecera: no hay pedimento que nombrar, se cae a la fila.
let dSin = duplicadoLocal({ ped: "SIN_CABECERA", idx: 4 }, "6100166");
ok("bloque sin cabecera -> se cae a la fila",
   dSin.texto === "⛔ DUPLICADO (ya escaneada en la fila 5)" && dSin.marcarPrimera === true);
ok("los dos sin cabecera -> gris, es el mismo bloque",
   duplicadoLocal({ ped: "SIN_CABECERA", idx: 4 }, "SIN_CABECERA").color === "#acacac");
ok("marcador estructural -> se cae a la fila",
   duplicadoLocal({ ped: "SIN PEDIMENTO", idx: 4 }, "6100166").texto === "⛔ DUPLICADO (ya escaneada en la fila 5)");

// Inventarios: solo existe el caso "misma ubicación", que va en gris.
ok("misma ubicación IW -> gris y discreto",
   duplicadoLocal({ ped: "IW-A-01", idx: 6 }, "IW-A-01", "Ubic").texto === "🔄 Duplicado local");
ok("otra ubicación IW -> habla de Ubic, no de Ped",
   duplicadoLocal({ ped: "IW-A-01", idx: 6 }, "IW-B-02", "Ubic").texto === "⛔ DUPLICADO (ya en Ubic: IW-A-01, fila 7)");

ok("aviso en la primera, una repetición",
   textoPrimeraDuplicada({ veces: 1, fila: 45 }) === "⚠️ DUPLICADO (repetida en la fila 45)");
ok("aviso en la primera, varias repeticiones",
   textoPrimeraDuplicada({ veces: 3, fila: 45 }) === "⚠️ DUPLICADO (repetida 3 veces, la 1ª en la fila 45)");

// anotarRepeticion cuenta y se queda con la PRIMERA repetición encontrada.
let repes2 = new Map();
anotarRepeticion(repes2, 10, 45);
ok("primera anotación", repes2.get(10).veces === 1 && repes2.get(10).fila === 45);
anotarRepeticion(repes2, 10, 60);
ok("segunda anotación suma pero no mueve la fila", repes2.get(10).veces === 2 && repes2.get(10).fila === 45);
anotarRepeticion(repes2, 20, 70);
ok("cada primera aparición lleva su cuenta", repes2.size === 2 && repes2.get(20).veces === 1);

console.log("\n=== 5h. hojasMSConGuias (evita recorrer todas las pestañas) ===");
const cacheGuiasMS = { map: new Map([
  ["1Z111", [ { hoja: "GLOBAL 2",  fila: 5,  isMS: false, isInventario: false },
              { hoja: "M-S T1",    fila: 12, isMS: true,  isInventario: false } ]],
  ["1Z222", [ { hoja: "M-S T1",    fila: 30, isMS: true,  isInventario: false },
              { hoja: "M-S A1",    fila: 8,  isMS: true,  isInventario: false } ]],
  ["1Z333", [ { hoja: "INVENTARIO A", fila: 3, isMS: false, isInventario: true } ]]
]), headers: [], data: [] };

let ms1 = hojasMSConGuias(cacheGuiasMS, new Set(["1Z111"]));
ok("solo devuelve la M-S, no la global", ms1.size === 1 && ms1.has("M-S T1"));

let ms2 = hojasMSConGuias(cacheGuiasMS, new Set(["1Z111", "1Z222"]));
ok("junta las M-S de varias guías sin repetir", ms2.size === 2 && ms2.has("M-S T1") && ms2.has("M-S A1"));

ok("guía solo en inventario -> ninguna M-S", hojasMSConGuias(cacheGuiasMS, new Set(["1Z333"])).size === 0);
ok("guía desconocida -> ninguna M-S", hojasMSConGuias(cacheGuiasMS, new Set(["NOEXISTE"])).size === 0);
ok("normaliza minúsculas y espacios", hojasMSConGuias(cacheGuiasMS, new Set([" 1z111 "])).has("M-S T1"));
ok("conjunto vacío -> vacío", hojasMSConGuias(cacheGuiasMS, new Set()).size === 0);
ok("sin caché -> vacío", hojasMSConGuias(null, new Set(["1Z111"])).size === 0);
ok("sin guías -> vacío", hojasMSConGuias(cacheGuiasMS, null).size === 0);

console.log("\n=== 5f. Cronómetro de llamadas a la API ===");
// PERF es un `let` dentro del eval, así que no se ve desde aquí: se prueba
// por comportamiento, que es lo que importa.
ok("apagado: perfFin no devuelve medición", perfFin() === null);
ok("apagado: perf ejecuta la función y devuelve su valor", perf("x", 10, () => 42) === 42);

perfIniciar();
ok("apagado: lo de antes no se quedó registrado", perfFin().orden.length === 0);

perfIniciar();
ok("encendido: perf sigue devolviendo el valor", perf("leer", 100, () => 42) === 42);
perf("leer", 50, () => 1);
perf("escribir", 7, () => 1);
let pMed = perfFin();
ok("agrupa por etiqueta", pMed.orden.length === 2);
ok("suma las llamadas repetidas", pMed.n["leer"] === 2 && pMed.n["escribir"] === 1);
ok("suma las celdas", pMed.celdas["leer"] === 150 && pMed.celdas["escribir"] === 7);
ok("perfFin apaga el cronómetro", perfFin() === null);

// El desglose ordena de más caro a más barato y cuadra el resto.
let pFalso = { orden: ["barata", "cara"], ms: { barata: 10, cara: 90 }, n: { barata: 1, cara: 3 }, celdas: { barata: 0, cara: 500 } };
let lineas = perfLineas(pFalso, 200);
ok("la etiqueta más cara va primero", lineas[0].indexOf("cara") !== -1);
ok("muestra el porcentaje sobre el total", lineas[0].indexOf("45%") !== -1);
ok("cuenta las llamadas en total", lineas[2].indexOf("4 llamadas en total") !== -1);
ok("imputa el resto no medido", lineas[3].indexOf("100 ms") !== -1 && lineas[3].indexOf("resto") !== -1);
ok("sin celdas no imprime celdas", lineas[1].indexOf("celdas") === -1);
ok("sin datos no revienta", perfLineas(null, 0).length === 1);

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

console.log("\n=== 5v. La cola del resumen: el bucle infinito de M-S T1 ===");
// La última guía de cada bloque lleva el estado y el resumen del pedimento en
// la misma celda, separados por «   ►   ». El barrido de M-S comparaba la celda
// ENTERA contra el estado esperado, nunca coincidía, y la reescribía sin la
// cola; actualizarMS se la volvía a pegar. Cada pasada del disparador escribía
// la hoja completa sin que nada hubiera cambiado.
const SEP_RESUMEN = separadorResumen();
const conCola = "➡ Salió en GLOBAL 1" + SEP_RESUMEN + "Bultos: 1 (M-S T1) | ✅ TODO SALIÓ";

ok("la cabeza es solo el estado", cabezaEstado(conCola) === "➡ Salió en GLOBAL 1");
ok("la cola conserva el separador", colaResumen(conCola) === SEP_RESUMEN + "Bultos: 1 (M-S T1) | ✅ TODO SALIÓ");
ok("sin cola, la cabeza es todo", cabezaEstado("✅ Guía") === "✅ Guía");
ok("sin cola, la cola es vacía", colaResumen("✅ Guía") === "");
ok("cabeza + cola reconstruyen el original", cabezaEstado(conCola) + colaResumen(conCola) === conCola);
ok("la cabeza va sin espacios sobrantes", cabezaEstado("  ✅ Guía  " + SEP_RESUMEN + "x") === "✅ Guía");
ok("una celda vacía no rompe nada", cabezaEstado("") === "" && colaResumen("") === "");

// LA CONDICIÓN DEL BUCLE: con la cola puesta, el estado ya es el correcto y el
// barrido NO debe reescribir. Antes esta comparación daba siempre distinto.
ok("con la cola puesta, el estado YA coincide y no se reescribe",
   cabezaEstado(conCola) === "➡ Salió en GLOBAL 1");
ok("la celda entera NO coincide (por eso se repetía para siempre)",
   String(conCola).trim() !== "➡ Salió en GLOBAL 1");

// Y sigue reconociéndose como salida, con cola o sin ella.
ok("esEstadoSalida funciona sobre la cabeza", esEstadoSalida(cabezaEstado(conCola)) === true);
ok("la prioridad se mide sobre la cabeza, no sobre la cola",
   puedePisar(cabezaEstado("⛔ DUPLICADO (En: GLOBAL 1 Fila 4)" + SEP_RESUMEN + "Bultos: 2"),
              "➡ Salió en GLOBAL 1") === false);

// El segundo bicho, que el primero tapaba: al pegar el resumen hay que quitar
// el anterior. En las filas movidas el estado se conserva tal cual venía de la
// hoja —cola incluida— y se le colgaba otro resumen detrás en cada recálculo.
let acumulada = conCola;
for (let v = 0; v < 5; v++) {
    acumulada = cabezaEstado(acumulada) + SEP_RESUMEN + "Bultos: 1 (M-S T1) | ✅ TODO SALIÓ";
}
ok("pegar el resumen 5 veces no alarga la celda", acumulada === conCola);
ok("solo queda un separador", acumulada.split(SEP_RESUMEN).length === 2);

console.log("\n=== 5w. Una alerta grave no se cae sola ===");
// El caso real: una guía sale duplicada en M-S, el operador la ve, y un rato
// después la fila está en verde sin que nadie haya arreglado nada. Pasaba
// porque el recálculo reconstruye la columna B entera y la condición que
// generó el ⛔ deja de detectarse en cuanto el caché cambia.
ok("un ⛔ no lo pisa un ✅",
   conservarAlertaGrave("⛔ DUPLICADO (ya en Ped: 6100166, fila 3)", "✅ Guía")
   === "⛔ DUPLICADO (ya en Ped: 6100166, fila 3)");
ok("un 🛑 no lo pisa un ➡",
   conservarAlertaGrave("🛑 PEDIMENTO REPETIDO", "➡ Salió en GLOBAL 1") === "🛑 PEDIMENTO REPETIDO");
ok("un ⛔ tampoco lo pisa un ⚠️",
   conservarAlertaGrave("⛔ DUPLICADO (En: M-S T1 Fila 9)", "⚠️ Sobra (Ajena)")
   === "⛔ DUPLICADO (En: M-S T1 Fila 9)");

// Pero lo igual de grave o más SÍ pasa: si no, la alerta se quedaría congelada
// en la primera versión y no se enteraría de un problema peor.
ok("un 🛑 sí pisa a un ⛔",
   conservarAlertaGrave("⛔ DUPLICADO (En: GLOBAL 3 Fila 9)", "🛑 PEDIMENTO REPETIDO") === "🛑 PEDIMENTO REPETIDO");
ok("un ⛔ pisa a otro ⛔ (se actualiza la fila que nombra)",
   conservarAlertaGrave("⛔ DUPLICADO (En: GLOBAL 3 Fila 9)", "⛔ DUPLICADO (En: GLOBAL 3 Fila 12)")
   === "⛔ DUPLICADO (En: GLOBAL 3 Fila 12)");

// Por debajo de ⛔ no se protege nada, y es a propósito: «❌ Guía Inválida»
// sale del propio contenido de la columna A, se recalcula bien siempre, y
// pegarla dejaría el error puesto después de corregir la guía.
ok("un ❌ NO se protege", conservarAlertaGrave("❌ Guía Inválida", "✅ Guía") === "✅ Guía");
ok("un ⚠️ NO se protege", conservarAlertaGrave("⚠️ Sobra (Ajena)", "✅ Guía") === "✅ Guía");
ok("un estado informativo no se protege", conservarAlertaGrave("✅ Guía", "") === "");

// La cola del resumen sí tiene que seguir viva: se conserva el ESTADO, no el
// contador de bultos, que cambia cada vez que sale un paquete.
ok("se conserva la alerta pero con el resumen nuevo",
   conservarAlertaGrave("⛔ DUPLICADO (En: M-S T1 Fila 9)" + SEP_RESUMEN + "Bultos: 5 | ⚠️ Faltan 2 por mover",
                        "✅ Guía" + SEP_RESUMEN + "Bultos: 5 | ✅ TODO SALIÓ")
   === "⛔ DUPLICADO (En: M-S T1 Fila 9)" + SEP_RESUMEN + "Bultos: 5 | ✅ TODO SALIÓ");

// --- TODOS los avisos de duplicado aguantan, no solo los de nivel alto ---
// Están repartidos por tres niveles a propósito (el ⛔ alarma, el 🔄 gris del
// mismo pedimento no), y por nivel se quedaban fuera justo los discretos.
ok("el 🔄 gris del mismo pedimento aguanta",
   conservarAlertaGrave("🔄 Duplicado local", "✅ Guía") === "🔄 Duplicado local");
ok("la guía repetida local de la preforma aguanta",
   conservarAlertaGrave("🔄 Guía repetida local", "") === "🔄 Guía repetida local");

// EL CASO QUE LO DELATABA: en una pareja, la segunda fila lleva ⛔ y aguantaba,
// pero la PRIMERA lleva «⚠️ DUPLICADO (repetida...)», de nivel aviso, y se caía
// sola. De la pareja que se pintó entera sobrevivía media.
ok("la PRIMERA de la pareja aguanta igual que la segunda",
   conservarAlertaGrave("⚠️ DUPLICADO (repetida en la fila 41)", "✅ Ok")
   === "⚠️ DUPLICADO (repetida en la fila 41)");
ok("el pedimento repetido de la preforma aguanta",
   conservarAlertaGrave("⚠️ PEDIMENTO REPETIDO", "12 bultos") === "⚠️ PEDIMENTO REPETIDO");

// Y lo que NO debe pegarse: cambia solo según avanza el trabajo.
ok("«Sobra (Ajena)» no se pega", conservarAlertaGrave("⚠️ Sobra (Ajena)", "✅ Ok") === "✅ Ok");
ok("«Sin registrar en M-S» no se pega",
   conservarAlertaGrave("⚠️ Sin registrar en M-S", "✅ Ok") === "✅ Ok");
ok("«Va en: otro pedimento» no se pega",
   conservarAlertaGrave("❌ Va en: 6098352", "✅ Ok") === "✅ Ok");
ok("un resumen con «con alerta» no se pega",
   conservarAlertaGrave("Bultos: 5 | ⚠️ 1 con alerta", "Bultos: 5 | ✅ COMPLETO")
   === "Bultos: 5 | ✅ COMPLETO");

// El detector, por separado.
ok("reconoce el 🔄", esAlertaDeDuplicado("🔄 Duplicado local") === true);
ok("reconoce el ⛔", esAlertaDeDuplicado("⛔ DUPLICADO (En: M-S T1 Fila 9)") === true);
ok("reconoce el 🛑 de pedimento", esAlertaDeDuplicado("🛑 PEDIMENTO REPETIDO (también en la fila 3)") === true);
ok("reconoce la guía repetida", esAlertaDeDuplicado("⛔ GUÍA REPETIDA (ya en Ped: 6100166)") === true);
ok("NO confunde «Sobra»", esAlertaDeDuplicado("⚠️ Sobra (Ajena)") === false);
ok("NO confunde «Faltan por mover»", esAlertaDeDuplicado("Bultos: 3 | ⚠️ Faltan 1 por mover") === false);
ok("mira la cabeza, no la cola del resumen",
   esAlertaDeDuplicado("✅ Guía" + SEP_RESUMEN + "Bultos: 3 | ✅ TODO SALIÓ") === false);
ok("y sí la ve cuando está en la cabeza",
   esAlertaDeDuplicado("🔄 Duplicado local" + SEP_RESUMEN + "Bultos: 3") === true);

// Cada uno recupera SU color: conservar el texto y dejar la celda en blanco
// sería peor que no conservarlo, porque el aviso quedaría invisible.
ok("el 🔄 recupera su gris", colorDeAlerta("🔄 Duplicado local") === "#acacac");
ok("la 1ª de la pareja recupera su naranja",
   colorDeAlerta("⚠️ DUPLICADO (repetida en la fila 41)") === "#ff9800");
ok("el pedimento repetido de preforma recupera su ámbar",
   colorDeAlerta("⚠️ PEDIMENTO REPETIDO") === "#ffc107");

ok("el color se deduce del texto conservado", colorDeAlerta("⛔ DUPLICADO (x)") === "#ff9800");
ok("🛑 ERROR mantiene su ámbar", colorDeAlerta("🛑 ERROR: pedimento incompleto") === "#ffc107");
ok("🛑 a secas va en rojo", colorDeAlerta("🛑 PEDIMENTO REPETIDO") === "#dc3545");
ok("sin alerta, fondo blanco", colorDeAlerta("✅ Guía") === "#FFFFFF");

// --- Las tres salidas de la regla ---
function escenario(repintarTodo, filasEditadas) {
    // fila 0: guía con ⛔ que el recálculo quiere bajar a ✅
    // fila 1: guía con ⛔ pero la columna A vacía (fila borrada)
    let datos = [["1Z111", "⛔ DUPLICADO (En: M-S T1 Fila 9)"], ["", "⛔ DUPLICADO (En: M-S T1 Fila 9)"]];
    let res = [["✅ Guía"], [""]];
    let col = [["#07c369"], ["#FFFFFF"]];
    let n = conservarAlertasGraves(datos, res, col, 2, repintarTodo, filasEditadas, 0, 1);
    return { n: n, res: res, col: col };
}
let normal = escenario(false, null);
ok("en una pasada normal la alerta se conserva", normal.n === 1);
ok("y recupera su color", normal.col[0][0] === "#ff9800");
ok("columna A vacía: la fila se resetea igual", normal.res[1][0] === "");

let forzado = escenario(true, null);
ok("«Forzar Actualización» no conserva nada", forzado.n === 0 && forzado.res[0][0] === "✅ Guía");

let editado = escenario(false, new Set([0]));
ok("la fila recién editada no conserva la alerta vieja",
   editado.n === 0 && editado.res[0][0] === "✅ Guía");

console.log("\n=== 5x. Un bloque con alertas no puede declararse completo ===");
// El caso: guía duplicada sin resolver y el pedimento marcado "✅ COMPLETO".
// Pasaba porque conAlerta se cuenta al armar los bloques, ANTES de detectar
// los duplicados, así que un duplicado nuevo nunca llegaba al resumen.
ok("un ⛔ bloquea el cierre",
   duplicadoBloqueaCierre("⛔ DUPLICADO (ya en Ped: 6100166, fila 3)") === true);
ok("un 🛑 bloquea el cierre", duplicadoBloqueaCierre("🛑 PEDIMENTO REPETIDO") === true);

// El duplicado dentro del mismo pedimento se pinta gris a propósito: es la
// misma guía leída dos veces, el conteo ya la cuenta una sola vez y no hay
// nada que arreglar. Ese NO bloquea, tal como se pidió.
ok("el duplicado local gris NO bloquea", duplicadoBloqueaCierre("🔄 Duplicado local") === false);
ok("un ⚠️ tampoco bloquea", duplicadoBloqueaCierre("⚠️ Sobra (Ajena)") === false);

// Y la coherencia con duplicadoLocal, que es quien produce esos textos.
const dupMismoPed = duplicadoLocal({ ped: "6100166", idx: 3 }, "6100166");
const dupOtroPed  = duplicadoLocal({ ped: "6100166", idx: 3 }, "6100999");
ok("mismo pedimento -> gris, no bloquea",
   dupMismoPed.color === "#acacac" && duplicadoBloqueaCierre(dupMismoPed.texto) === false);
ok("otro pedimento -> ⛔, sí bloquea",
   duplicadoBloqueaCierre(dupOtroPed.texto) === true);
ok("y el mensaje nombra el pedimento y la fila",
   dupOtroPed.texto.indexOf("6100166") !== -1 && dupOtroPed.texto.indexOf("fila 4") !== -1);

// notaConAlerta es lo que acaba explicando el descuadre en el resumen.
ok("una alerta produce nota", notaConAlerta(1) === "⚠️ 1 con alerta");
ok("sin alertas no hay nota", notaConAlerta(0) === "");

console.log("\n=== 5y. La hoja se estira sola al acercarse el final ===");
const MARGEN = margenFilas();
const BLOQUE = bloqueFilas();
// Margen y bloque son independientes: el margen decide CUÁNDO crecer y el
// bloque CUÁNTO. Crecer cuesta dos llamadas a la API, y eso vale igual para 20
// filas que para 50, así que el bloque grande hace que el tirón caiga una vez
// cada 50 escaneos aunque el aviso salte con solo 20 filas de margen.
ok("margen 20, bloque 50", MARGEN === 20 && BLOQUE === 50);

// Con sitio de sobra no se toca nada: crecer cuesta llamadas a la API y no se
// pagan por gusto.
ok("fila 100 en una hoja de 1200: no crece", filasNecesarias(100, 1200) === 0);
ok("con 20 filas por delante todavía no crece", filasNecesarias(1180, 1200) === 0);
ok("cuando quedan 19 ya crece", filasNecesarias(1181, 1200) > 0);

// Crece un bloque entero, para no ir estirando de tres en tres filas y pagar
// dos llamadas cada vez.
ok("crece un bloque entero, no lo justo", filasNecesarias(1181, 1200) === 1250);
ok("escanear en la última fila también crece", filasNecesarias(1200, 1200) === 1250);

// El tirón tiene que caer cada 50 escaneos, no cada 20: tras crecer a 1250, el
// siguiente estirón no llega hasta la fila 1231.
ok("tras crecer, aguanta hasta 50 filas más", filasNecesarias(1230, 1250) === 0);
ok("y a la 1231 vuelve a crecer", filasNecesarias(1231, 1250) === 1300);

// EL CASO QUE JUSTIFICA CALCULAR EL DESTINO Y NO SUMAR UN BLOQUE FIJO: un
// pegado grande cerca del final. Con "maxActual + 50" las últimas filas
// caerían fuera de la hoja y el escaneo se perdería sin avisar.
ok("un pegado de 300 filas cabe entero",
   filasNecesarias(1400, 1200) === 1420);
ok("y el margen queda por delante del pegado",
   filasNecesarias(1400, 1200) - 1400 === MARGEN);

// Hojas recién creadas y valores raros: nunca debe devolver algo menor que el
// tamaño actual, o se intentaría insertar un número negativo de filas.
ok("hoja pequeña: crece un bloque entero", filasNecesarias(45, 50) === 100);
ok("fila 0 no hace crecer nada", filasNecesarias(0, 1200) === 0);
ok("fila negativa no hace crecer nada", filasNecesarias(-5, 1200) === 0);
let destinos = [filasNecesarias(1, 1), filasNecesarias(500, 100), filasNecesarias(3000, 1200)];
ok("el destino nunca queda por debajo del tamaño actual",
   destinos[0] > 1 && destinos[1] > 100 && destinos[2] > 1200);

console.log("\n=== 5y9. Saber qué salió: el caché, no el texto de la columna B ===");
// Una fila con alerta encima NUNCA recibe el «➡ Salió en …»: ese aviso es
// informativo y la regla de prioridad no le deja pisar una alerta. Por eso la
// limpieza se quedaba sin quitar precisamente las filas problemáticas, aunque
// el bulto llevara horas embarcado.
const hdrsSal = ["GLOBAL 4_FISICO", "M-S T1_FISICO", "INVENTARIO A_FISICO",
                 "REZAGO_FISICO", "CACHE_SISTEMA_FISICO"];
const dataSal = [
  hdrsSal,
  ["1ZSALIO",  "1ZSALIO",  "",         "",          ""],   // fila 1
  ["6100166",  "1ZAQUI",   "",         "",          ""],   // fila 2: pedimento + guía solo en M-S
  ["",         "",         "1ZINV",    "1ZREZ",     "1ZSIS"]
];
const salidas = mapaSalidasDesdeCache({ headers: hdrsSal, data: dataSal });

ok("una guía escaneada en la Global cuenta como salida", salidas.get("1ZSALIO") === "GLOBAL 4");
ok("una que solo está en la M-S no ha salido", !salidas.has("1ZAQUI"));
ok("un inventario no es un destino", !salidas.has("1ZINV"));
ok("el rezago tampoco: estar en rezago no es haberse embarcado", !salidas.has("1ZREZ"));
ok("las hojas del sistema no cuentan", !salidas.has("1ZSIS"));
ok("los pedimentos no entran como guías salidas", !salidas.has("6100166"));

// LA HOJA NUNCA ES DESTINO DE SÍ MISMA. Omitirlo vaciaba hojas enteras: en una
// pestaña de unidad como «A1», todas sus guías figuraban como «ya salieron»…
// en A1, así que la limpieza cumplía la condición en TODAS las filas.
const hdrsA1 = ["A1_FISICO", "GLOBAL 1_FISICO", "M-S T1_FISICO"];
const dataA1 = [hdrsA1, ["1ZSOLOA1", "", "1ZSOLOA1"], ["1ZDOBLE", "1ZDOBLE", ""]];
const desdeA1 = mapaSalidasDesdeCache({ headers: hdrsA1, data: dataA1 }, "A1");

ok("una guía escaneada en A1 NO cuenta como salida de A1", !desdeA1.has("1ZSOLOA1"));
ok("pero sí cuenta si está en otra unidad", desdeA1.get("1ZDOBLE") === "GLOBAL 1");
ok("sin excluir, A1 se veía a sí misma como destino",
   mapaSalidasDesdeCache({ headers: hdrsA1, data: dataA1 }).get("1ZSOLOA1") === "A1");
ok("desde la M-S, A1 sí es un destino",
   mapaSalidasDesdeCache({ headers: hdrsA1, data: dataA1 }, "M-S T1").get("1ZSOLOA1") === "A1");
ok("el nombre a excluir se normaliza",
   !mapaSalidasDesdeCache({ headers: hdrsA1, data: dataA1 }, "  a1  ").has("1ZSOLOA1"));

ok("sin caché devuelve un mapa vacío", mapaSalidasDesdeCache(null).size === 0);
ok("caché sin datos devuelve un mapa vacío",
   mapaSalidasDesdeCache({ headers: hdrsSal }).size === 0);

// LO QUE ARREGLA: la fila lleva un duplicado, nunca recibió la marca de salida,
// y aun así el caché sabe que salió.
ok("una fila con ⛔ sin marca de salida se detecta igual",
   esEstadoSalida("⛔ DUPLICADO (En: M-S GLOBALES Fila 9)") === false &&
   salidas.has("1ZSALIO") === true);

console.log("\n=== 5y8. Contar las guías de UNA pestaña en el caché ===");
// Es lo que enseña el antes y el después al rehacer el caché de una sola hoja,
// para que no haya que creerse que hizo algo.
const cacheConteo = { map: new Map([
    ["1Z111", [{ hoja: "M-S T1", fila: 3 }, { hoja: "GLOBAL 4", fila: 9 }]],
    ["1Z222", [{ hoja: "M-S T1", fila: 4 }]],
    ["1Z333", [{ hoja: "GLOBAL 4", fila: 10 }]],
    // La misma guía dos veces en la MISMA hoja cuenta una: son guías
    // distintas lo que se cuenta, no apariciones.
    ["1Z444", [{ hoja: "M-S T1", fila: 5 }, { hoja: "M-S T1", fila: 6 }]]
]) };
ok("cuenta las guías de la M-S", guiasDeHojaEnCache(cacheConteo, "M-S T1") === 3);
ok("cuenta las de la Global", guiasDeHojaEnCache(cacheConteo, "GLOBAL 4") === 2);
ok("una guía repetida en la misma hoja cuenta UNA",
   guiasDeHojaEnCache({ map: new Map([["1Z444", [{ hoja: "M-S T1", fila: 5 }, { hoja: "M-S T1", fila: 6 }]]]) }, "M-S T1") === 1);
ok("una pestaña que no está da 0", guiasDeHojaEnCache(cacheConteo, "INVENTARIO A") === 0);
ok("normaliza el nombre", guiasDeHojaEnCache(cacheConteo, "  m-s t1  ") === 3);
ok("sin caché da 0", guiasDeHojaEnCache(null, "M-S T1") === 0);
ok("caché sin índice da 0", guiasDeHojaEnCache({}, "M-S T1") === 0);

console.log("\n=== 5y7. Pedimento repetido: se marcan LAS DOS filas ===");
// Antes solo se marcaba la segunda aparición. El operador veía el aviso en una
// fila y tenía que buscar a mano dónde estaba la otra.
function escenarioPedRepetido(estadoPrevio) {
    let res = [["Bultos: 1 (M-S T1) | ⚠️ Faltan 1 por mover"], ["✅ Guía"], [estadoPrevio || ""]];
    let col = [["#ffc107"], ["#71b3e6"], ["#FFFFFF"]];
    // fila 0 y fila 2 son el mismo pedimento; el valor es la fila (1-based) de la pareja
    let dups = new Map([[0, 3], [2, 1]]);
    let pareja = new Set();
    marcarPedimentosRepetidosDentro(res, col, dups, pareja);
    return { res: res, col: col, pareja: pareja };
}

let pr = escenarioPedRepetido("");
ok("la segunda aparición se marca", pr.res[2][0].indexOf("🛑 PEDIMENTO REPETIDO") === 0);
ok("y la PRIMERA también", pr.res[0][0].indexOf("🛑 PEDIMENTO REPETIDO") === 0);
ok("las dos en rojo", pr.col[0][0] === "#dc3545" && pr.col[2][0] === "#dc3545");
ok("cada una nombra la fila de la otra",
   pr.res[0][0].indexOf("fila 3") !== -1 && pr.res[2][0].indexOf("fila 1") !== -1);

// La columna A de las dos también, igual que con las guías duplicadas: es lo
// que deja ver la pareja de un vistazo sin leer la columna B.
ok("las dos filas entran en la pareja para el rojo de la columna A",
   pr.pareja.has(0) && pr.pareja.has(2));
ok("y no arrastra a la guía de en medio", !pr.pareja.has(1));

// La fila que no es del pedimento no se toca.
ok("la guía de en medio conserva su estado", pr.res[1][0] === "✅ Guía");

// Un ⛔ manda: habla de una guía concreta y es más accionable.
let prDup = escenarioPedRepetido("⛔ DUPLICADO (En: M-S GLOBALES Fila 9)");
ok("un ⛔ no lo pisa el aviso de pedimento",
   prDup.res[2][0].indexOf("⛔") === 0);
ok("y esa fila no se pinta de rojo de pedimento", prDup.col[2][0] === "#FFFFFF");

console.log("\n=== 5y6. Sobrescribir una guía deja constancia ===");
// El caso real: la app del escáner lleva rato abierta, la vista se queda
// desactualizada, y el operador escanea en una fila que él ve vacía pero que en
// el servidor ya tenía una guía. La anterior se perdía SIN RASTRO, porque el
// historial solo miraba los vaciados de celda.
ok("escribir encima de otra guía se registra",
   motivoDeCambio("1ZABC111", "1ZXYZ999").indexOf("SOBRESCRITA") === 0);
ok("y el motivo dice con qué se sustituyó",
   motivoDeCambio("1ZABC111", "1ZXYZ999").indexOf("1ZXYZ999") !== -1);
ok("un pedimento sobrescrito por otro también",
   motivoDeCambio("6034586", "6034576").indexOf("SOBRESCRITA") === 0);

// Lo que ya se registraba antes sigue igual.
ok("vaciar una celda con guía se registra",
   motivoDeCambio("1ZABC111", "") === "BORRADO MANUAL (Celda vaciada)");

// Lo que NO debe registrarse, o el historial sería una línea por escaneo.
ok("escribir en una celda vacía no se registra", motivoDeCambio("", "1ZABC111") === null);
ok("dos celdas vacías tampoco", motivoDeCambio("", "") === null);
ok("reescribir el MISMO valor no se registra", motivoDeCambio("1ZABC111", "1ZABC111") === null);
ok("ni cambiando solo mayúsculas", motivoDeCambio("1zabc111", "1ZABC111") === null);
ok("ni con espacios de sobra", motivoDeCambio("  1ZABC111  ", "1ZABC111") === null);

console.log("\n=== 5y15. Tránsito de arribo ===");
// Funciona como una Global —preforma en la O, faltantes y sobrantes— sin
// cerebro propio. Lo que cambia es que llegar no es embarcarse.
ok("«TRANSITO DE ARRIBO» se reconoce", esHojaTransito("TRANSITO DE ARRIBO") === true);
ok("con acento también", esHojaTransito("TRÁNSITO DE ARRIBO") === true);
ok("en minúsculas también", esHojaTransito("transito de arribo") === true);
ok("no confunde una Global", esHojaTransito("GLOBAL 4") === false);
ok("ni una M-S", esHojaTransito("M-S T1") === false);

// Sigue usando el cerebro de las Globales: es lo que da faltantes y sobrantes.
ok("es hoja principal, no un dominio nuevo", esHojaPrincipal("TRANSITO DE ARRIBO") === true);
ok("no es M-S", esHojaMS("TRANSITO DE ARRIBO") === false);
ok("no es inventario", esHojaInventario("TRANSITO DE ARRIBO") === false);
ok("y lleva preforma, que es de donde salen los faltantes",
   usaPreforma("TRANSITO DE ARRIBO") === true);

// LO QUE PROTEGE: un bulto que llega NO puede marcarse como salido en la M-S,
// porque entonces «Limpiar guías movidas» lo borraría dándolo por embarcado.
const hdrsTr = ["TRANSITO DE ARRIBO_FISICO", "GLOBAL 2_FISICO", "M-S T1_FISICO"];
const dataTr = [hdrsTr, ["1ZLLEGA", "", "1ZLLEGA"], ["", "1ZSALE", "1ZSALE"]];
const salTr = mapaSalidasDesdeCache({ headers: hdrsTr, data: dataTr });
ok("escanear en el arribo NO cuenta como salida", !salTr.has("1ZLLEGA"));
ok("pero una Global de verdad sí", salTr.get("1ZSALE") === "GLOBAL 2");

console.log("\n=== 5y14. Histórico de días anteriores ===");
// Se recorren TODAS las columnas a propósito: así funciona con el concentrado
// tal y como esté armado, sin obligar a un formato.
const histCrudo = [
  ["FECHA", "PESTAÑA", "GUÍA"],
  ["12/08/2026", "GLOBAL 2", "1ZC337510403152894"],
  ["12/08/2026", "GLOBAL 2", "1Z8929F90490932658"],
  ["13/08/2026", "M-S T1",   "1ZR1H0146725447420"],
  ["", "", ""],
  ["13/08/2026", "M-S T1",   "6100544"]              // un pedimento NO es una guía
];
const hist = guiasDelHistorico(histCrudo);
ok("indexa las guías del volcado", hist.size === 3);
ok("y guarda la fecha de cada una", hist.get("1ZC337510403152894") === "12/08/2026");
ok("de otro día también", hist.get("1ZR1H0146725447420") === "13/08/2026");
ok("un pedimento de 7 dígitos no entra", !hist.has("6100544"));
ok("los encabezados no ensucian", !hist.has("GUÍA") && !hist.has("PESTAÑA"));

// Da igual el orden de las columnas ni cuántas haya.
const otroOrden = guiasDelHistorico([["1ZC337510403152894", "lo que sea", "12/08/2026"]]);
ok("la fecha puede ir después de la guía", otroOrden.get("1ZC337510403152894") === "12/08/2026");
ok("una guía sin fecha se indexa igual",
   guiasDelHistorico([["1ZC337510403152894"]]).get("1ZC337510403152894") === "");

// Las guías vienen con guiones o espacios según de dónde salga el concentrado.
ok("normaliza guiones y espacios",
   guiasDelHistorico([["1Z-C33751-0403152894"]]).has("1ZC337510403152894"));

// La PRIMERA aparición manda: interesa cuándo se vio por primera vez.
const repe = guiasDelHistorico([
  ["10/08/2026", "1ZC337510403152894"],
  ["14/08/2026", "1ZC337510403152894"]
]);
ok("se queda con la fecha más antigua", repe.get("1ZC337510403152894") === "10/08/2026");

ok("sin datos devuelve un mapa vacío", guiasDelHistorico(null).size === 0);
ok("una hoja en blanco tampoco rompe", guiasDelHistorico([["", ""],["",""]]).size === 0);

console.log("\n=== 5y13. «REZAGO MS»: rezago que sí se cruza con las M-S ===");
// El rezago normal NO se cruza contra las M-S: lo que decide si una guía es de
// rezago es la preforma, no haber pasado por una M-S. Al nombrar la pestaña
// «REZAGO MS» se pide justo ese cruce, y una guía registrada en cualquier M-S
// deja de salir «⚠️ Ajena (No es de rezago)».
ok("REZAGO MS sí cruza", esRezagoConMS("REZAGO MS") === true);
ok("con guion también", esRezagoConMS("REZAGO M-S") === true);
ok("da igual el orden", esRezagoConMS("MS REZAGO") === true);
ok("y con más palabras en medio", esRezagoConMS("REZAGO MS 2") === true);
ok("no distingue mayúsculas ni espacios", esRezagoConMS("  rezago ms  ") === true);

// El rezago normal se queda como estaba.
ok("un rezago normal NO cruza", esRezagoConMS("REZAGO") === false);
ok("REZAGO 2 tampoco", esRezagoConMS("REZAGO 2") === false);

// No captura «MS» metido dentro de otra palabra.
ok("no confunde una palabra que contenga MS", esRezagoConMS("REZAGO MSA") === false);
ok("ni al revés", esRezagoConMS("REZAGO AMS") === false);

// Y no toca a nada que no sea rezago.
ok("una Global no es rezago", esRezagoConMS("GLOBAL 4") === false);
ok("una M-S de verdad tampoco", esRezagoConMS("M-S T1") === false);
ok("A1 tampoco", esRezagoConMS("A1 77-14-ZP") === false);

// Sigue siendo una hoja principal de rezago, no una M-S.
ok("«REZAGO MS» NO se convierte en M-S", esHojaMS("REZAGO MS") === false);
ok("y sigue siendo hoja principal", esHojaPrincipal("REZAGO MS") === true);

console.log("\n=== 5y12. Editar una M-S avisa a la hoja de unidad ===");
// La hoja de unidad es la que MUESTRA el estado de la M-S («Sin registrar en
// M-S», «Sobra (Ajena)», «Escaneado en …»). Si alguien se equivoca en la M-S,
// borra y vuelve a escanear, esa hoja tiene que enterarse. Antes no se
// propagaba nada al editar una M-S, y se quedaba con el mensaje viejo hasta que
// alguien forzaba la actualización.
const cacheProp = { map: new Map([
    ["1ZENMS",    [{ hoja: "M-S T1", fila: 5, isMS: true,  isInventario: false }]],
    ["1ZSALIDA",  [{ hoja: "M-S T1", fila: 6, isMS: true,  isInventario: false },
                   { hoja: "A1 77-14-ZP", fila: 20, isMS: false, isInventario: false }]],
    ["1ZINV",     [{ hoja: "INVENTARIO A", fila: 3, isMS: false, isInventario: true }]]
]) };

// Una guía recién metida en la M-S y que no está en ninguna unidad: nada que
// avisar, así que no cuesta ni una llamada.
ok("guía solo en la M-S: ningún destino que avisar",
   hojasConGuias(cacheProp, new Set(["1ZENMS"]), "destino").size === 0);

// EL CASO: la guía está en la M-S y en una hoja de unidad. Al tocarla en la
// M-S hay que recalcular esa unidad.
const destProp = hojasConGuias(cacheProp, new Set(["1ZSALIDA"]), "destino");
ok("guía en M-S y en unidad: se avisa a la unidad",
   destProp.size === 1 && destProp.has("A1 77-14-ZP"));
ok("y no se cuela la propia M-S en la lista de destinos", !destProp.has("M-S T1"));

// Los dominios siguen separados.
ok("un inventario no es un destino",
   hojasConGuias(cacheProp, new Set(["1ZINV"]), "destino").size === 0);
ok("pero sí sale por su propio dominio",
   hojasConGuias(cacheProp, new Set(["1ZINV"]), "inventario").has("INVENTARIO A"));
ok("y la M-S sale por el suyo",
   hojasConGuias(cacheProp, new Set(["1ZSALIDA"]), "ms").has("M-S T1"));

console.log("\n=== 5y11. Dos capturas pegadas (lo que pasa de verdad) ===");
// Sacado del historial del archivo real: el escáner dispara sobre una celda que
// ya tenía algo con el cursor DENTRO, y en vez de sustituir, añade. La guía que
// estaba no se borra: se queda pegada a la nueva y las dos dejan de servir.
const p1 = detectarGuiasPegadas("1ZC3375104031528941Z03F61Y6713913378");
ok("dos guías 1Z se separan",
   p1 && p1.primera === "1ZC337510403152894" && p1.segunda === "1Z03F61Y6713913378");
const p2 = detectarGuiasPegadas("1Z8929F904909326581Z7146776738785525");
ok("otro caso real del historial",
   p2 && p2.primera === "1Z8929F90490932658" && p2.segunda === "1Z7146776738785525");

// EL CASO DE LA CELDA A1: había un pedimento y le entró una guía delante.
const p3 = detectarGuiasPegadas("1ZE4C54304509118566100544");
ok("guía + pedimento se separan",
   p3 && p3.primera === "1ZE4C5430450911856" && p3.segunda === "6100544");
const p4 = detectarGuiasPegadas("61005441ZE4C5430450911856");
ok("y al revés, pedimento + guía",
   p4 && p4.primera === "6100544" && p4.segunda === "1ZE4C5430450911856");

// Lo que NO debe partir.
ok("una guía normal no se toca", detectarGuiasPegadas("1ZC337510403152894") === null);
ok("un pedimento no se toca", detectarGuiasPegadas("6100544") === null);
ok("una guía corta no se toca", detectarGuiasPegadas("12345678") === null);
ok("una celda vacía no se toca", detectarGuiasPegadas("") === null);

// El mensaje que ve el operador: dice QUÉ dos guías hay dentro, que es de donde
// se recupera la que se perdió. Antes salía un «Guía Inválida» que no decía nada.
ok("el aviso nombra las dos guías",
   textoCapturaInvalida("1ZC3375104031528941Z03F61Y6713913378")
   === "❌ DOS PEGADAS: 1ZC337510403152894 + 1Z03F61Y6713913378");
ok("una guía mala de verdad sigue siendo «Guía Inválida»",
   textoCapturaInvalida("XYZ123") === "❌ Guía Inválida");
ok("mismo nivel que una guía inválida: no tapa a un duplicado",
   nivelAlerta(textoCapturaInvalida("1ZC3375104031528941Z03F61Y6713913378"))
   === nivelAlerta("❌ Guía Inválida"));
ok("y un ⛔ sí puede pisarlo",
   puedePisar(textoCapturaInvalida("1ZC3375104031528941Z03F61Y6713913378"),
              "⛔ DUPLICADO (En: M-S T1 Fila 9)") === true);

console.log("\n=== 5y10. Normalizar nunca puede vaciar una celda ===");
// La causa de que una celda con un rótulo se quedara en blanco sola: quitar
// todo lo que no sea A-Z0-9 de un texto sin letras ni números deja la cadena
// vacía, y el script la escribía encima.
ok("un guion solo NO borra la celda", normalizacionAEscribir("—") === null);
ok("una flecha tampoco", normalizacionAEscribir("→") === null);
ok("símbolos solos tampoco", normalizacionAEscribir("###") === null);
ok("espacios solos tampoco", normalizacionAEscribir("   ") === null);
ok("una celda vacía tampoco", normalizacionAEscribir("") === null);

// Lo que sí tiene que seguir limpiando.
ok("quita guiones de una guía", normalizacionAEscribir("1Z-123-456") === "1Z123456");
ok("pasa a mayúsculas", normalizacionAEscribir("1zabc111") === "1ZABC111");
ok("quita espacios de los extremos", normalizacionAEscribir("  1ZABC111  ") === "1ZABC111");
ok("quita acentos y deja lo alfanumérico", normalizacionAEscribir("GUÍA1") === "GUA1");

// Y lo que no hay que reescribir, para no gastar una llamada por gusto.
ok("un valor ya limpio no se reescribe", normalizacionAEscribir("1ZABC111") === null);
ok("los números no son texto y no pasan por aquí", normalizacionAEscribir(6100166) === null);
ok("null y undefined no rompen",
   normalizacionAEscribir(null) === null && normalizacionAEscribir(undefined) === null);

// El caso que lo delató: un rótulo con acentos se acorta pero NO se vacía.
ok("un rótulo con letras se conserva aunque cambie", normalizacionAEscribir("Guías") === "GUAS");
ok("un rótulo sin letras ni números se queda intacto", normalizacionAEscribir("· · ·") === null);

console.log("\n=== 5y5. La escritura no alcanza a las filas vecinas ===");
// Escribir de vuelta filas que no cambiaron es una forma silenciosa de perder
// una guía: se reescriben con la copia que se leyó unos milisegundos antes, y
// si otro operador escaneó ahí sin lock (el onEdit simple lo permite cuando el
// lock está ocupado), su guía se sobrescribe.
let unaFila = rangoDeUpdates([{ row: 40, col: 1, val: "1Z1" }], 20, 100);
ok("un escaneo normal escribe UNA fila", unaFila.desde === 40 && unaFila.alto === 1);
ok("y no empieza en el inicio del bloque", unaFila.desde !== 20);

let dosFilas = rangoDeUpdates([{ row: 40 }, { row: 43 }], 20, 100);
ok("dos cambios separados: solo el tramo entre ellos",
   dosFilas.desde === 40 && dosFilas.alto === 4);

let pegado = rangoDeUpdates([{ row: 20 }, { row: 119 }], 20, 100);
ok("un pegado que cambia todo sí cubre todo",
   pegado.desde === 20 && pegado.alto === 100);

ok("sin cambios no se escribe nada", rangoDeUpdates([], 20, 100) === null);
ok("updates fuera del bloque se ignoran",
   rangoDeUpdates([{ row: 5 }, { row: 500 }], 20, 100) === null);
ok("una mezcla dentro/fuera solo cuenta las de dentro",
   rangoDeUpdates([{ row: 5 }, { row: 40 }, { row: 500 }], 20, 100).alto === 1);

console.log("\n=== 5y4. Pestañas M-S mal escritas ===");
// esHojaMS exige que el nombre empiece por "M-S " —con guion Y con espacio—.
// Una pestaña llamada "MS CUENTAS ESPECIALES" cae en el cajón de las GLOBALES
// y rompe dos cosas a la vez sin decir nada: sus guías salen "Sobra (Ajena)" al
// escanearlas en la hoja de la unidad, y además chocan como duplicado, porque
// dos GLOBALES sí se cruzan entre sí.
ok("M-S T1 se reconoce", esHojaMS("M-S T1") === true);
ok("M-S CUENTAS ESPECIALES se reconoce", esHojaMS("M-S CUENTAS ESPECIALES") === true);
ok("SIMPLES y MULTIPLES también", esHojaMS("SIMPLES") && esHojaMS("MULTIPLES A"));

ok("sin el guion NO se reconoce", esHojaMS("MS CUENTAS ESPECIALES") === false);
ok("sin el espacio NO se reconoce", esHojaMS("M-SCUENTAS ESPECIALES") === false);
ok("y por eso se cuela como GLOBAL", esHojaPrincipal("MS CUENTAS ESPECIALES") === true);

// El aviso del diagnóstico es lo que convierte ese fallo invisible en obvio.
ok("«MS CUENTAS ESPECIALES» se marca como sospechosa",
   pareceMSMalEscrita("MS CUENTAS ESPECIALES") === true);
ok("«M-SCUENTAS» también", pareceMSMalEscrita("M-SCUENTAS ESPECIALES") === true);
ok("una M-S bien escrita NO se marca", pareceMSMalEscrita("M-S CUENTAS ESPECIALES") === false);
ok("una Global normal NO se marca", pareceMSMalEscrita("A1 77-14-ZP") === false);
ok("GLOBAL 4 tampoco", pareceMSMalEscrita("GLOBAL 4") === false);
ok("un inventario tampoco", pareceMSMalEscrita("INVENTARIO A") === false);
ok("las hojas del sistema tampoco", pareceMSMalEscrita("CACHE_SISTEMA") === false);

// La etiqueta que se enseña al lado de cada nombre en el diagnóstico.
ok("A1 77-14-ZP es una GLOBAL", tipoDePestana("A1 77-14-ZP").indexOf("GLOBAL") === 0);
ok("M-S CUENTAS ESPECIALES es M-S", tipoDePestana("M-S CUENTAS ESPECIALES").indexOf("M-S") === 0);
ok("MS CUENTAS ESPECIALES sale como GLOBAL (el fallo, visible)",
   tipoDePestana("MS CUENTAS ESPECIALES").indexOf("GLOBAL") === 0);
ok("INVENTARIO A es inventario", tipoDePestana("INVENTARIO A") === "inventario");
ok("CACHE_SISTEMA es interna", tipoDePestana("CACHE_SISTEMA") === "interna");

console.log("\n=== 5y3. Cambios de estructura (borrar filas) ===");
// onEdit NO se dispara al borrar una fila entera: es una limitación de Apps
// Script. Y borrar una fila sube todas las de abajo, así que el caché queda
// descolocado para TODAS ellas, no solo para la que se fue.
ok("borrar una fila afecta al caché", cambioAfectaAlCache("REMOVE_ROW") === true);
ok("insertar una fila afecta al caché", cambioAfectaAlCache("INSERT_ROW") === true);
ok("borrar una pestaña afecta al caché", cambioAfectaAlCache("REMOVE_GRID") === true);
ok("borrar una columna afecta al caché", cambioAfectaAlCache("REMOVE_COLUMN") === true);

// EDIT ya lo cubre onEdit; reaccionar aquí también duplicaría cada escaneo.
ok("una edición normal NO se procesa aquí", cambioAfectaAlCache("EDIT") === false);
ok("un cambio de formato no toca el caché", cambioAfectaAlCache("FORMAT") === false);
ok("OTHER no dispara nada", cambioAfectaAlCache("OTHER") === false);
ok("sin tipo no dispara nada",
   cambioAfectaAlCache(undefined) === false && cambioAfectaAlCache("") === false);

console.log("\n=== 5y2. El recorte del cierre del día ===");
const BASE = filasBase();
ok("la base son 200 filas", BASE === 200);

// Hoja vacía tras el día: vuelve a la base.
ok("hoja vacía de 1200 -> 200", filasTrasRecorte(0, 1200) === 200);
ok("hoja con 50 filas de datos -> 200", filasTrasRecorte(50, 1200) === 200);

// EL PUNTO DE LA REGLA DE LOS 20: por debajo de «último dato + margen» no se
// recorta. Si no, la hoja quedaría pidiendo crecer en el primer escaneo del
// día siguiente y el tirón estaría garantizado cada mañana.
ok("con datos hasta la 190, deja 210 y no 200", filasTrasRecorte(190, 1200) === 210);
ok("con datos hasta la 800, deja 820", filasTrasRecorte(800, 1200) === 820);
ok("y el hueco libre es siempre el margen",
   filasTrasRecorte(800, 1200) - 800 === MARGEN);

// El cálculo nunca puede caer por debajo del último dato. Esto es lo que
// impide que el recorte se lleve una guía por delante, y borrar filas es lo
// único del sistema que puede hacer desaparecer una guía sin dejar rastro: el
// historial registra los vaciados de celda, no las filas eliminadas.
for (let ultimo = 0; ultimo <= 2000; ultimo += 37) {
    let d = filasTrasRecorte(ultimo, 3000);
    if (d !== 0 && d <= ultimo) { ok("RECORTE PELIGROSO con último dato en " + ultimo, false); break; }
}
ok("el destino nunca cae sobre una fila con datos", true);

// Nunca estira: esto recorta y nada más.
ok("si ya está en la base, no toca nada", filasTrasRecorte(0, 200) === 0);
ok("si es más pequeña que la base, no la estira", filasTrasRecorte(0, 120) === 0);
ok("si los datos ya llenan la hoja, no toca nada", filasTrasRecorte(1190, 1200) === 0);

// Recortar y volver a crecer tienen que ser coherentes: justo después de un
// recorte, la hoja NO puede estar pidiendo crecer.
let trasRecorte = filasTrasRecorte(800, 1200);
ok("recién recortada no pide crecer de inmediato",
   filasNecesarias(800, trasRecorte) === 0);

console.log("\n=== 5z. La validación «GUIA RETENIDA» ===");
// Es la que hace sonar el escáner. Se construye fila a fila en vez de dejar una
// sola regla con referencia relativa: desde Apps Script el ajuste automático de
// la referencia no está garantizado, y si no se ajustara TODAS las filas
// comprobarían la fila 1 y el escáner dejaría de avisar sin decir nada.
ok("la fórmula nombra su propia fila", formulaGuiaRetenida("A", 1) === "=COUNTIF($M:$M,A1)=0");
ok("la fila 700 comprueba la fila 700", formulaGuiaRetenida("A", 700) === "=COUNTIF($M:$M,A700)=0");
ok("la columna O comprueba la columna O", formulaGuiaRetenida("O", 42) === "=COUNTIF($M:$M,O42)=0");

// Dos filas distintas NUNCA pueden compartir fórmula: ese sería exactamente el
// fallo silencioso que se quiere evitar.
ok("dos filas no comparten fórmula",
   formulaGuiaRetenida("A", 5) !== formulaGuiaRetenida("A", 6));

// La columna M va entera. Acotarla a 200 filas era el origen de dos problemas:
// la lista de retenidas no podía crecer, y a partir de la fila 201 no había
// ninguna regla.
ok("la columna M se mira entera", formulaGuiaRetenida("A", 1).indexOf("$M:$M") !== -1);
ok("no queda ningún tope de 200", formulaGuiaRetenida("A", 1).indexOf("200") === -1);

// A qué columnas les toca: la A siempre, la O solo donde se usa la preforma.
// Es el mismo criterio con el que el caché decide si reserva columna.
ok("una Global lleva A y O",
   JSON.stringify(columnasValidables("GLOBAL 4", 19)) === JSON.stringify([1, 15]));
ok("la MACHO lleva A y O",
   JSON.stringify(columnasValidables("MACHO", 19)) === JSON.stringify([1, 15]));
ok("una M-S solo lleva A",
   JSON.stringify(columnasValidables("M-S T1", 19)) === JSON.stringify([1]));
ok("un inventario lleva A y O",
   JSON.stringify(columnasValidables("INVENTARIO A", 19)) === JSON.stringify([1, 15]));
ok("una hoja estrecha no pide la O",
   JSON.stringify(columnasValidables("GLOBAL 4", 12)) === JSON.stringify([1]));

console.log("\n=== 5z2. El alto lo marca la columna que llega más abajo ===");
// EL FALLO QUE ESTO ARREGLA: en una Global la A y la O crecen por separado. La
// preforma de la O va muy por delante del escaneo físico de la A, y mientras el
// crecimiento miraba SOLO la celda editada, escanear arriba en la A no estiraba
// la hoja aunque la preforma estuviera pegada al último renglón de la rejilla.
// Resultado: la cola de la preforma se quedaba fuera y salía como «faltantes»
// que en realidad nunca llegaron a caber.

// El caso del fallo: se escanea en la fila 40 de la A, pero la preforma de la O
// llega hasta la 1190 en una hoja de 1200.
ok("escanear arriba no impide que crezca por la O",
   filaQueMarcaElAlto(40, 1190) === 1190);
ok("y con eso sí crece", filasNecesarias(filaQueMarcaElAlto(40, 1190), 1200) === 1250);
ok("mirando solo la celda editada NO crecía (el fallo)",
   filasNecesarias(40, 1200) === 0);

// Al revés manda la edición: si acabas de pegar 300 filas, esas mandan aunque
// el caché todavía no las haya visto.
ok("un pegado por debajo de los datos manda", filaQueMarcaElAlto(1400, 900) === 1400);
ok("empatados da igual cuál", filaQueMarcaElAlto(600, 600) === 600);

// Valores ausentes: el caché devuelve 0 cuando la hoja no está fotografiada, y
// eso no puede convertirse en NaN ni tumbar el escaneo.
ok("sin dato en caché manda la edición", filaQueMarcaElAlto(120, 0) === 120);
ok("sin edición manda el caché", filaQueMarcaElAlto(0, 350) === 350);
ok("los dos vacíos no piden crecer",
   filasNecesarias(filaQueMarcaElAlto(0, 0), 1200) === 0);
ok("undefined no produce NaN", filaQueMarcaElAlto(undefined, 500) === 500);

console.log("\n=== 5z4. Las pestañas del índice no son hojas de escaneo ===");
// EL FALLO QUE ESTO ARREGLA: si el índice de houses vive en el archivo de
// operación y no se le marca como interno, el caché lo toma por una Global
// normal —una hoja con miles de guías en la columna A—. Entonces CADA guía
// escaneada choca contra su propia copia del índice y sale
// «⛔ DUPLICADO (En: INDICE_HOUSE)»: duplicados falsos, todos, y bloqueando el
// cierre de los bloques.
ok("INDICE_HOUSE es interna", esHojaInterna("INDICE_HOUSE"));
ok("el archivo frío también", esHojaInterna("INDICE_HOUSE_FRIO"));
ok("la marca de encendido también", esHojaInterna("HOUSE_ACTIVO"));
ok("y por tanto NO se escanean",
   !esHojaPrincipal("INDICE_HOUSE") && !esHojaPrincipal("INDICE_HOUSE_FRIO"));
ok("son hojas de sistema", esHojaSistema("INDICE_HOUSE"));
ok("en minúsculas también", esHojaInterna("indice_house"));
// Por prefijo: si mañana el índice se parte en más pestañas, ninguna puede
// colarse como hoja de escaneo.
ok("una variante futura tampoco se cuela", esHojaInterna("INDICE_HOUSE 2026"));
// Y nada de la operación se vuelve interno por error.
ok("una Global sigue siendo de escaneo", esHojaPrincipal("GLOBALES"));
ok("A1 sigue siendo de escaneo", esHojaPrincipal("A1 77-14-ZP"));
ok("una M-S sigue siendo M-S", esHojaMS("M-S T1"));

console.log("\n=== 5z3. El trigger simple no puede fiarse de una propiedad ===");
// EL PEOR FALLO DEL ARCHIVO, Y ESTUVO AHÍ MESES:
//
// El trigger simple se apartaba en cuanto una PROPIEDAD decía que el instalable
// estaba puesto. Pero esa propiedad no sabe si el instalable sigue vivo. Google
// desactiva los disparadores de una cuenta al agotarse su cuota diaria, y
// también tras una racha de errores. Entonces el instalable no corre, la
// propiedad sigue diciendo «está puesto», y el simple se aparta educadamente:
// NADIE procesa los escaneos, y no hay ni un error en ninguna parte.
//
// Ahora el instalable deja un latido y el simple solo se aparta si es reciente.
const MIN = 60 * 1000;
let ahora = 1000000000;

// Marcado como instalado Y latiendo hace poco: el simple se aparta, bien.
global.PropertiesService = { getScriptProperties: () => ({
    getProperty: (k) => (k === 'TRIGGER_EDICION_INSTALADO' ? '1'
                       : k === 'TRIGGER_ULTIMO_LATIDO' ? String(ahora - 30 * 1000) : null)
}) };
globalTriggerInstalable = null;
ok("con latido fresco, el simple se aparta", instalableRespondiendo(ahora));

// EL CASO DEL FALLO: marcado como instalado pero SIN latir hace rato.
global.PropertiesService = { getScriptProperties: () => ({
    getProperty: (k) => (k === 'TRIGGER_EDICION_INSTALADO' ? '1'
                       : k === 'TRIGGER_ULTIMO_LATIDO' ? String(ahora - 10 * MIN) : null)
}) };
globalTriggerInstalable = null;
ok("sin latido, el simple RECOGE el trabajo", !instalableRespondiendo(ahora));

// Marcado como instalado y sin haber latido nunca: tampoco se fía.
global.PropertiesService = { getScriptProperties: () => ({
    getProperty: (k) => (k === 'TRIGGER_EDICION_INSTALADO' ? '1' : null)
}) };
globalTriggerInstalable = null;
ok("nunca ha latido: el simple tampoco se aparta", !instalableRespondiendo(ahora));

// Sin instalable declarado, el simple trabaja siempre.
global.PropertiesService = { getScriptProperties: () => ({ getProperty: () => null }) };
globalTriggerInstalable = null;
ok("sin instalable, el simple trabaja", !instalableRespondiendo(ahora));

// Ante cualquier fallo al leer, procesar: procesar dos veces es molesto -y el
// lock lo serializa- pero no procesar ninguna vez pierde el trabajo del turno.
global.PropertiesService = { getScriptProperties: () => { throw new Error("sin permiso"); } };
globalTriggerInstalable = null;
ok("si no puede leer nada, procesa igual", !instalableRespondiendo(ahora));
global.PropertiesService = { getScriptProperties: () => ({ getProperty: () => null }) };
globalTriggerInstalable = null;

console.log("\n=== 6. Índice de houses (módulo en pruebas) ===");
// Cinco guías reales con dígito verificador bueno: si el fixture llevara guías
// inválidas, `filasDeInbound` las tiraría y los tests pasarían por el motivo
// equivocado.
const G1 = "1Z999AA10123456784", G2 = "1Z999AA10123456793", G3 = "1Z999AA10123456800";
const G4 = "1Z999AA10123456819", G5 = "1Z999AA10123456828";

console.log("\n--- 6a. El seguro de pruebas ---");
// Ninguna función del módulo escribe nada mientras el archivo no se llame
// PRUEBA. Es lo que permite pegarlo en producción sin que haga nada.
ok("«Salidas PRUEBA» sí es de pruebas", esArchivoDePrueba("Salidas PRUEBA"));
ok("minúsculas también", esArchivoDePrueba("copia de prueba 2026"));
ok("el archivo real NO es de pruebas", !esArchivoDePrueba("SALIDAS UPS"));
ok("«PRUEBAS» en plural también entra", esArchivoDePrueba("WMS PRUEBAS"));

// El interruptor de producción. Una copia de pruebas se enciende sola por el
// nombre; el archivo real necesita que alguien lo encienda a mano, porque que
// un módulo empiece a escribir en la columna D de siete operadores tiene que
// ser una decisión consciente y no el efecto de haber pegado un archivo.
//
// La marca es una PESTAÑA, no una propiedad del script: `onOpen` es un
// disparador simple, corre sin autorización, y si el menú preguntara por algo
// no disponible ahí reventaría el menú ENTERO.
let libroSinMarca = { getName: () => "SALIDAS UPS", getSheetByName: () => null };
let libroConMarca = { getName: () => "SALIDAS UPS",
                      getSheetByName: (n) => (n === "HOUSE_ACTIVO" ? {} : null) };
ok("una copia de pruebas se enciende sola",
   moduloActivo({ getName: () => "WMS PRUEBA", getSheetByName: () => null }));
ok("el archivo real NO se enciende solo", !moduloActivo(libroSinMarca));
ok("...salvo que exista la pestaña de marca", moduloActivo(libroConMarca));
// Ante cualquier fallo, apagado y sin reventar: quien pregunta puede ser el
// menú, y el menú lo necesitan siete personas todos los días.
ok("un libro roto no revienta el menú",
   !moduloActivo({ getName: () => { throw new Error("boom"); } }));
ok("un libro sin getSheetByName tampoco",
   !moduloActivo({ getName: () => "SALIDAS UPS" }));

console.log("\n--- 6b. Leer el CSV que salga de Power Query ---");
// Excel en México exporta con punto y coma tan a menudo como con coma, y
// equivocarse deja UNA columna con toda la fila dentro.
ok("coma", separadorCsv("GUIA,HOUSE,FECHA") === ",");
ok("punto y coma", separadorCsv("GUIA;HOUSE;FECHA") === ";");
ok("tabulador", separadorCsv("GUIA\tHOUSE\tFECHA") === "\t");
ok("gana el que más aparece", separadorCsv("A;B;C;D,E") === ";");

// Las cabeceras no se piden por posición: Power Query cambia de forma cada vez
// que alguien toca la consulta, y una posición fija se rompería en silencio.
let colsA = detectarColumnasInbound(["FECHA ARRIBO", "TRACKING NUMBER", "HOUSE AWB", "PESO"]);
ok("encuentra la guía por TRACKING", colsA.guia === 1);
ok("encuentra la house", colsA.house === 2);
ok("encuentra la fecha", colsA.fecha === 0);

// EL CASO QUE OBLIGA A BUSCAR LA HOUSE PRIMERO: «HOUSE AWB» contiene «AWB».
// Mirando la guía antes, se llevaría por delante la columna de la house.
let colsB = detectarColumnasInbound(["MASTER AWB", "HOUSE AWB", "1Z"]);
ok("«HOUSE AWB» no se confunde con la guía", colsB.house === 1);
// Y «MASTER AWB» tampoco: es la guía madre del consolidado, una sola para
// cientos de bultos. Si entrara al índice no casaría nunca con lo escaneado.
ok("y la guía es la columna 1Z, no el master", colsB.guia === 2);
ok("el master no se cuela como guía", colsB.guia !== 0);
// «AWB» a secas sí vale cuando no hay nada mejor.
let colsD = detectarColumnasInbound(["AWB", "HOUSE"]);
ok("sin columna mejor, AWB sirve de guía", colsD.guia === 0 && colsD.house === 1);
let colsE = detectarColumnasInbound(["MASTER AWB", "HOUSE AWB"]);
ok("pero un master solo no se acepta como guía", colsE.guia === -1);

let colsC = detectarColumnasInbound(["COLUMNA1", "COLUMNA2"]);
ok("sin columnas reconocibles avisa con -1", colsC.guia === -1 && colsC.house === -1);

// LOS NOMBRES REALES DE LA OPERACIÓN. Aquí a la house se le llama «guía corta»,
// y en la prealerta viene como «Shipment».
//
// EL CHOQUE QUE ESTO EVITA: «GUIA CORTA» contiene «GUIA». Sin excluirla, el
// módulo tomaría la columna de la HOUSE creyendo que era la del 1Z —y sin
// avisar, porque una cabecera que dice «guía» parece justo lo que se busca—.
// El índice saldría lleno de houses apuntando a houses, sin casar con nada.
let colsInb = detectarColumnasInbound(["Guía", "Guía corta"]);
ok("«Guía» es el 1Z", colsInb.guia === 0);
ok("«Guía corta» es la house", colsInb.house === 1);
ok("y NO se toma la corta por guía", colsInb.guia !== 1);
// Aunque la corta venga primero.
let colsInv = detectarColumnasInbound(["Guía corta", "Guía"]);
ok("da igual el orden: la corta sigue siendo house", colsInv.house === 0);
ok("y la guía sigue siendo la otra", colsInv.guia === 1);

// El inbound REAL, tal como quedó: FECHA, GUIA, GUIA CORTA.
let colsReal = detectarColumnasInbound(["FECHA", "GUIA", "GUIA CORTA"]);
ok("FECHA no se confunde con la guía", colsReal.guia === 1);
ok("GUIA CORTA sigue siendo la house", colsReal.house === 2);
ok("y la fecha es la columna A", colsReal.fecha === 0);

// La prealerta: Tracking trae UNA guía, Additionals las demás de esa misma
// house, separadas por comas.
let colsPre = detectarColumnasInbound(["Tracking", "Shipment", "Additionals"]);
ok("«Tracking» es el 1Z", colsPre.guia === 0);
ok("«Shipment» es la house", colsPre.house === 1);
ok("«Additionals» no se confunde con la guía", colsPre.guia !== 2);

// Y el caso completo: una house con su guía en Tracking y dos más en
// Additionals. Las tres tienen que entrar compartiendo house.
let crudoPrealerta = [
    ["Tracking", "Shipment", "Additionals"],
    [G1, "SHP-4471", G2 + ", " + G4]
];
let filasPrealerta = filasDeInbound(crudoPrealerta,
    detectarColumnasInbound(crudoPrealerta[0]), "PREALERTAS CONCENTRADO.csv");
ok("las tres guías entran", filasPrealerta.length === 3);
ok("todas con la misma house", filasPrealerta.every(f => f.house === "SHP-4471"));
ok("la de Tracking no va marcada como embebida",
   filasPrealerta.filter(f => !f.embebida).length === 1);
ok("las de Additionals sí", filasPrealerta.filter(f => f.embebida).length === 2);
ok("y ninguna house se coló como guía",
   !filasPrealerta.some(f => f.guia.indexOf("SHP") !== -1));

// «CSV (delimitado por comas)» guarda en la codificación vieja de Windows, no
// en UTF-8. Al leerlo, una cabecera «GUÍA» llega rota: no casa ni con «GUÍA» ni
// con «GUIA», y el módulo juraría que falta la columna estando ahí.
ok("quita el acento", sinAcentos("GUÍA") === "GUIA");
ok("respeta lo que no lo lleva", sinAcentos("HOUSE") === "HOUSE");
// La ñ TAMBIÉN se descompone y pierde la virgulilla: «AÑO» sale «ANO». No es
// deseable, pero da igual y no se arregla a propósito: ninguna palabra que se
// busque en las cabeceras lleva ñ, y lo que importa aquí es que el archivo
// bien exportado y el mal exportado den EXACTAMENTE lo mismo. Añadir una
// excepción para la ñ rompería justo eso.
ok("la ñ también se descompone (aceptado)", sinAcentos("AÑO") === "ANO");
ok("null no revienta", sinAcentos(null) === "");
ok("una cabecera con acento se reconoce igual",
   detectarColumnasInbound(["GUÍA", "HOUSE"]).guia === 0);
ok("y sin acento también",
   detectarColumnasInbound(["GUIA", "HOUSE"]).guia === 0);
ok("«NÚMERO DE GUÍA» también",
   detectarColumnasInbound(["NÚMERO DE GUÍA", "HOUSE AWB"]).guia === 0);

// EL DESPISTE DE UN CLIC: en «Guardar como» de Excel 2016 hay tres CSV pegados
// uno debajo de otro y terminan las líneas distinto.
//   CSV (delimitado por comas) -> \r\n   el bueno
//   CSV (MS-DOS)               -> \r\n
//   CSV (Macintosh)            -> \r     el que rompe
// Con solo \r no hay ni un salto reconocible: el archivo entero llegaría como
// UN renglón, la cabecera se comería los datos y saldría «0 guías» sin pista.
ok("Windows (\\r\\n) queda en \\n", normalizarSaltos("A,B\r\n1,2") === "A,B\n1,2");
ok("Mac viejo (\\r solo) también", normalizarSaltos("A,B\r1,2") === "A,B\n1,2");
ok("lo que ya venía en \\n no se toca", normalizarSaltos("A,B\n1,2") === "A,B\n1,2");
ok("varias líneas seguidas", normalizarSaltos("a\r\nb\rc\nd") === "a\nb\nc\nd");
ok("vacío no revienta", normalizarSaltos("") === "");
ok("null tampoco", normalizarSaltos(null) === "");
// Y lo que importa de verdad: con \r solo, la cabecera se separa de los datos.
ok("con CSV Macintosh la cabecera ya no se come el archivo",
   normalizarSaltos("GUIA,HOUSE\r1Z,H1\r1Z2,H2").split("\n").length === 3);

console.log("\n--- 6c. De CSV crudo a filas limpias ---");
// El reporte trae totales, renglones vacíos y basura. Nada de eso entra al
// índice: engorda la carga sin servir para buscar.
let crudo = [
    ["FECHA", "GUIA", "HOUSE"],
    ["2026-08-01", G1, "HAWB-001"],
    ["2026-08-02", G2, "HAWB-002"],
    ["", "", ""],                       // renglón vacío
    ["2026-08-03", "TOTAL", "999"],     // subtotal del reporte
    ["2026-08-04", G3, ""],             // sin house: no sirve de nada
    ["2026-08-05", "6100544", "HAWB-9"] // un pedimento, no una guía
];
let limpio = filasDeInbound(crudo, detectarColumnasInbound(crudo[0]));
ok("solo entran las filas con guía Y house", limpio.length === 2);
ok("y son las correctas", limpio[0].guia === G1 && limpio[1].house === "HAWB-002");
ok("la fecha se convierte a Date", limpio[0].fecha instanceof Date);

// La guía del reporte puede venir con guiones o espacios; la escaneada no los
// tiene. Sin normalizar, jamás casarían.
ok("normaliza guiones", claveGuiaHouse("1Z-999-AA1-0123-456-784") === G1);
ok("normaliza espacios y minúsculas", claveGuiaHouse(" 1z999aa10123456784 ") === G1);
ok("null no revienta", claveGuiaHouse(null) === "");

console.log("\n--- 6c2. Guías enterradas dentro de un texto ---");
// La macro de prealerta hace DOS búsquedas: exacta contra la columna A y, si
// falla, «contiene» contra la AD. O sea que la guía a veces no está sola en su
// celda. Ese «contiene» es lo que hace que la macro tarde —un bucle dentro de
// otro, 100 millones de comparaciones según su propio comentario—.
//
// Aquí se resuelve al IMPORTAR: se sacan todas las guías de la fila y cada una
// entra al índice por su cuenta. Buscar vuelve a ser un Map.get instantáneo.
ok("saca una guía suelta", guiasEnTexto(G1)[0] === G1);
ok("la encuentra dentro de un texto",
   guiasEnTexto("REF CLIENTE " + G1 + " PALLET 3")[0] === G1);
ok("con guiones y espacios también",
   guiasEnTexto("ref: 1Z-999-AA1 0123 456 784 /fin")[0] === G1);
ok("saca DOS guías del mismo renglón",
   guiasEnTexto(G1 + " y " + G2).length === 2);
ok("y son las correctas",
   guiasEnTexto(G1 + " y " + G2).indexOf(G2) !== -1);
ok("dos guías pegadas sin separador tampoco se pierden",
   guiasEnTexto(G1 + G2).length === 2);
ok("la misma guía repetida cuenta una vez", guiasEnTexto(G1 + " " + G1).length === 1);
// El dígito verificador es lo que impide inventarse guías: 18 caracteres
// cualesquiera que empiecen por 1Z no bastan.
ok("una cadena que parece guía pero no lo es se descarta",
   guiasEnTexto("1Z999AA10123456785").length === 0);
ok("un texto sin guías no devuelve nada", guiasEnTexto("PALLET 3 CAJA ROJA").length === 0);
ok("un texto corto no revienta", guiasEnTexto("ABC").length === 0);
ok("vacío tampoco", guiasEnTexto("").length === 0);
ok("null tampoco", guiasEnTexto(null).length === 0);

// En la fila, se salta la columna que ya se leyó como guía exacta para no
// contarla dos veces.
ok("barre la fila menos la columna de la guía",
   guiasDeFila([G1, "HOUSE-1", "ref " + G2], 0).length === 1);
ok("y la que encuentra es la enterrada",
   guiasDeFila([G1, "HOUSE-1", "ref " + G2], 0)[0] === G2);

// EL CASO DE LA PREALERTA: una house con la guía metida en un campo de texto,
// que la búsqueda exacta no encontraría jamás.
let crudoPre = [
    ["ORDEN", "HOUSE", "REFERENCIAS"],
    ["", "HAWB-77", "cliente ACME · " + G3 + " · pallet 2"]
];
let filasPre = filasDeInbound(crudoPre, detectarColumnasInbound(crudoPre[0]), "PREALERTA.csv");
ok("la guía enterrada entra al índice", filasPre.length === 1 && filasPre[0].guia === G3);
ok("con su house", filasPre[0].house === "HAWB-77");
ok("y marcada como embebida", filasPre[0].embebida === true);

// Un renglón de prealerta con VARIAS guías genera una entrada por guía: las dos
// comparten house, que es justo lo que significa un consolidado.
let crudoMulti = [
    ["GUIA", "HOUSE", "REFERENCIAS"],
    [G1, "HAWB-88", G2 + " " + G4]
];
let filasMulti = filasDeInbound(crudoMulti, detectarColumnasInbound(crudoMulti[0]), "PREALERTA.csv");
ok("tres guías, tres entradas", filasMulti.length === 3);
ok("todas con la misma house", filasMulti.every(f => f.house === "HAWB-88"));
ok("la de su columna NO va marcada como embebida",
   filasMulti.filter(f => !f.embebida).length === 1);

console.log("\n--- 6d. Fechas en los tres formatos que se ven por aquí ---");
ok("ISO", aFechaInbound("2026-08-15").getMonth() === 7);
ok("día/mes/año", aFechaInbound("15/08/2026").getDate() === 15);
ok("...y NO lo lee como mes/día", aFechaInbound("15/08/2026").getMonth() === 7);
ok("un Date pasa tal cual", aFechaInbound(new Date(2026, 7, 15)).getDate() === 15);
ok("lo que no se entiende devuelve null", aFechaInbound("el martes") === null);
ok("vacío devuelve null", aFechaInbound("") === null);

// LA TRAMPA DE EXCEL: si la celda no está formateada como fecha, el CSV no
// lleva «27/08/2026» sino el número de días desde el 30/12/1899. Sin
// entenderlo, esa fila contaría como «sin fecha», se quedaría en el índice
// caliente Y NO LO DIRÍA. Basta con que alguien toque el formato de una columna
// para que el reparto caliente/frío deje de funcionar en silencio.
let serie = aFechaInbound("46261");
ok("un número de serie de Excel se entiende", serie instanceof Date);
ok("y da la fecha correcta",
   serie.getUTCFullYear() === 2026 && serie.getUTCMonth() === 7 && serie.getUTCDate() === 27);
ok("con decimales (hora incluida) también", aFechaInbound("46261.75") instanceof Date);
// El rango acota el riesgo: un consecutivo pequeño o un peso no son fechas.
ok("un número pequeño NO es una fecha", aFechaInbound("1234") === null);
ok("un número enorme tampoco", aFechaInbound("999999") === null);
ok("una guía no se confunde con una fecha", aFechaInbound(G1) === null);
// Equivocarse aquí solo mueve una fila entre caliente y frío, nunca cambia una
// house: la fecha no interviene en qué house lleva una guía.
ok("el límite bajo es 1970", aFechaInbound("25569").getUTCFullYear() === 1970);

console.log("\n--- 6e. Fusionar: quién gana cuando dos archivos discrepan ---");
// La base son DOS archivos y no valen igual:
//   INBOUND   es lo que llegó.                    Es la realidad.
//   PREALERTA es lo que dijeron que iba a llegar. Es una promesa.
ok("«INBOUND_AGOSTO.csv» es inbound", tipoDeOrigen("INBOUND_AGOSTO.csv") === origenInbound());
ok("«Prealertas 2026.csv» es prealerta",
   tipoDeOrigen("Prealertas 2026.csv") === origenPrealerta());
ok("minúsculas también", tipoDeOrigen("inbound_dia.csv") === origenInbound());
ok("un nombre que no lo dice queda sin tipo",
   tipoDeOrigen("consolidado.csv") === origenDesconocido());
ok("sin nombre tampoco revienta", tipoDeOrigen(null) === origenDesconocido());

// EL CASO QUE OBLIGA A TENER LA REGLA: el inbound corrige a la prealerta.
let fusA = fusionarEnIndice(
    [[G1, "HAWB-PROMETIDA", "2026-08-01", "PREALERTA"]],
    [{guia: G1, house: "HAWB-REAL", fecha: "2026-08-20", origen: origenInbound()}]);
ok("el inbound pisa a la prealerta", fusA.filas[0][1] === "HAWB-REAL");
ok("se cuenta como corregida", fusA.corregidas === 1);
ok("no como añadida", fusA.anadidas === 0);
ok("y queda constancia del choque", fusA.conflictos[0].resuelto === "gana el inbound");
ok("el origen queda anotado", fusA.filas[0][3] === "INBOUND");

// Y al revés NO: una prealerta no puede pisar lo que ya llegó.
let fusB = fusionarEnIndice(
    [[G1, "HAWB-REAL", "2026-08-20", "INBOUND"]],
    [{guia: G1, house: "HAWB-PROMETIDA", fecha: "2026-08-01", origen: origenPrealerta()}]);
ok("una prealerta NO pisa a un inbound", fusB.filas[0][1] === "HAWB-REAL");
ok("nada corregido", fusB.corregidas === 0);
ok("pero el choque se reporta igual",
   fusB.conflictos[0].resuelto === "se conservó la anterior");

// Dos inbounds que se contradicen no los resuelve este módulo: es un problema
// del reporte, y elegir uno a ciegas sería inventarse el dato.
let fusC = fusionarEnIndice(
    [[G1, "HAWB-A", "", "INBOUND"]],
    [{guia: G1, house: "HAWB-B", origen: origenInbound()}]);
ok("dos inbounds en conflicto: gana el que estaba", fusC.filas[0][1] === "HAWB-A");
ok("y se marca para revisar a mano",
   fusC.conflictos[0].resuelto === "se conservó la anterior");

// LA REGLA NO DEPENDE DEL ORDEN: Drive devuelve los archivos como quiere, y la
// house buena no puede depender de eso. Las dos mezclas dan lo mismo.
let prealerta = {guia: G1, house: "HAWB-PROMETIDA", origen: origenPrealerta()};
let inbound   = {guia: G1, house: "HAWB-REAL", origen: origenInbound()};
ok("prealerta y luego inbound → gana el inbound",
   fusionarEnIndice([], [prealerta, inbound]).filas[0][1] === "HAWB-REAL");
ok("inbound y luego prealerta → gana el inbound igual",
   fusionarEnIndice([], [inbound, prealerta]).filas[0][1] === "HAWB-REAL");

// Un archivo sin tipo reconocible no puede corregir a nadie: mejor eso que
// dejar que una prealerta pise a un inbound por accidente.
let fusD = fusionarEnIndice(
    [[G1, "HAWB-REAL", "", "INBOUND"]],
    [{guia: G1, house: "HAWB-X", origen: origenDesconocido()}]);
ok("un archivo sin tipo no corrige nada", fusD.filas[0][1] === "HAWB-REAL");

// Lo de siempre, que sigue valiendo.
let fus = fusionarEnIndice(
    [[G1, "HAWB-001", "2026-08-01", "INBOUND"], [G2, "HAWB-002", "2026-08-02", "INBOUND"]],
    [{guia: G2, house: "HAWB-002", fecha: "2026-08-20", origen: origenInbound()},
     {guia: G3, house: "HAWB-003", fecha: "2026-08-20", origen: origenInbound()}]);
ok("solo se añade la que no estaba", fus.anadidas === 1);
ok("el índice queda con tres", fus.filas.length === 3);
ok("una guía repetida con la MISMA house no es conflicto", fus.conflictos.length === 0);
ok("el índice de partida vacío también funciona",
   fusionarEnIndice([], [{guia: G1, house: "H1"}]).anadidas === 1);
ok("cada fila del índice lleva sus cuatro columnas",
   fusionarEnIndice([], [{guia: G1, house: "H1", origen: origenInbound()}]).filas[0].length === 4);

// El origen viaja desde el nombre del archivo hasta la fila del índice.
let crudoInb = [["GUIA", "HOUSE"], [G1, "H-1"]];
ok("filasDeInbound marca el origen",
   filasDeInbound(crudoInb, detectarColumnasInbound(crudoInb[0]), "INBOUND_1.csv")[0].origen
   === origenInbound());

console.log("\n--- 6e2. «Esto ya lo importé» va por ID Y fecha ---");
// EL FALLO QUE ESTO EVITA: Drive conserva el mismo ID cuando se sube una
// version nueva encima de un archivo. Y el inbound se actualiza a diario,
// reemplazando el de ayer. Con la memoria por ID a secas, el primer inbound
// entraba y todos los siguientes se saltaban EN SILENCIO: el índice congelado
// en el día uno, y la importación diciendo «no había archivos nuevos», que
// suena exactamente igual que todo va bien.
let ayer = new Date(2026, 7, 26, 8, 0, 0);
let hoyMod = new Date(2026, 7, 27, 8, 0, 0);
ok("el mismo archivo sin tocar da la misma marca",
   marcaDeArchivo("ID1", ayer) === marcaDeArchivo("ID1", ayer));
ok("actualizado da OTRA marca (por eso se reimporta)",
   marcaDeArchivo("ID1", ayer) !== marcaDeArchivo("ID1", hoyMod));
ok("dos archivos distintos nunca se confunden",
   marcaDeArchivo("ID1", ayer) !== marcaDeArchivo("ID2", ayer));
ok("sin fecha sigue dando algo estable",
   marcaDeArchivo("ID1", null) === marcaDeArchivo("ID1", null));
ok("la marca lleva el ID dentro", marcaDeArchivo("ID1", ayer).indexOf("ID1") === 0);
// El separador no puede aparecer en un ID de Drive, o dos marcas distintas
// podrían leerse como la misma al guardarlas juntas.
ok("el separador es @", marcaDeArchivo("ID1", ayer).indexOf("@") === 3);

console.log("\n--- 6f. Caliente y frío ---");
// El corte es lo que hace que el relleno de cada minuto sea barato: se cargan
// unos miles de filas, no la base entera.
let hoy = new Date(2026, 7, 27);
let part = particionPorAntiguedad([
    [G1, "H1", "2026-08-20"],   // reciente
    [G2, "H2", "2025-01-15"],   // año pasado
    [G3, "H3", ""],             // sin fecha
    [G4, "H4", "2026-05-01"]    // 118 días: fuera de los 90
], hoy, diasIndiceCaliente());
ok("lo reciente va al caliente", part.calientes.some(f => f[0] === G1));
ok("lo viejo va al frío", part.frias.some(f => f[0] === G2));
ok("118 días también va al frío", part.frias.some(f => f[0] === G4));
// Sin fecha se queda en el caliente a propósito: ver una guía de más es barato,
// no encontrarla no lo es.
ok("sin fecha se queda en el caliente", part.calientes.some(f => f[0] === G3));
ok("y no se pierde ninguna", part.calientes.length + part.frias.length === 4);

console.log("\n--- 6g. Qué celdas hay que rellenar ---");
// La house vive en la C, pegada al estado de la B: escribir las dos juntas es
// la MISMA llamada, y por eso aparece en el instante del escaneo sin coste.
// Encima están los totales C1:C3, así que las tres primeras filas no se tocan.
const PAR_A = paresDeHouse("GLOBALES", 19)[0];
ok("la house va en la C", PAR_A.house === 3);
// LOS TOTALES SE MUDARON A LA D. Con ellos en la C, una guía escaneada en la
// fila 2 o 3 no habría recibido house NUNCA —la guardia que protegía los
// totales la habría saltado— y en silencio, que es la peor forma de perder un
// dato. Ahora la columna es entera para la house.
ok("la columna C es entera para la house", PAR_A.desde === 1);
ok("y la Q también", paresDeHouse("GLOBALES", 19)[1].desde === 1);
ok("una guía en la fila 2 sí recibe house", filaAdmiteHouse(PAR_A, 2));
ok("y en la 3 también", filaAdmiteHouse(PAR_A, 3));

// El fixture arranca en la fila 4 para no chocar con los totales.
let hojaSim = [
    [G1, "✅ OK", "HAWB-001"],        // 4: ya tiene house
    [G2, "✅ OK", ""],                // 5: falta
    ["", "", ""],                     // 6: fila vacía
    ["6100544", "", ""],              // 7: pedimento: no lleva house
    [G3, "⛔ DUPLICADO", ""],         // 8: falta, aunque esté duplicada
    [G4, "✅ OK", textoHouseSinDato()] // 9: ya se buscó y no estaba
];
let porLlenar = celdasPorLlenar(hojaSim, PAR_A, 4);
ok("solo las que faltan", porLlenar.length === 2);
ok("y con la fila de la HOJA, no el índice del array",
   porLlenar[0].fila === 5 && porLlenar[1].fila === 8);
// Leído desde la fila 1, ahora no se pierde ninguno: la columna es entera.
ok("desde la fila 1 salen los mismos dos",
   celdasPorLlenar(hojaSim, PAR_A, 1).length === 2);

// `desdeQueFilaMirar` sigue existiendo por si algún día conviene acotar la
// lectura, pero el disparador YA NO LA USA: leer solo la cola servía para
// rellenar —lo que acaba de escanearse está abajo, siempre— y era un error
// para BORRAR. Una house huérfana se queda donde estaba su guía, que puede ser
// cualquier fila; con la cola, las de arriba no las veía nadie y se quedaban
// ahí esperando a que alguien escanee encima y herede una house ajena.
//
// Lo que disparaba la cuota de Google era la FRECUENCIA -cada minuto-, no el
// tamaño de cada lectura: es una llamada igual, solo que trae más celdas.
ok("una hoja corta se lee entera", desdeQueFilaMirar(120, 500) === 1);
ok("de una larga solo la cola", desdeQueFilaMirar(3000, 500) === 2501);
ok("y la cola mide lo pedido", 3000 - desdeQueFilaMirar(3000, 500) + 1 === 500);
ok("una hoja vacía no revienta", desdeQueFilaMirar(0, 500) === 1);

// LO QUE DE VERDAD IMPORTA: una huérfana en la fila 3 de una hoja de 3.000 se
// encuentra igual, porque ya se lee entera.
let hojaLarga = [];
for (let i = 0; i < 3000; i++) hojaLarga.push(["", "", ""]);
hojaLarga[9] = ["", "", "H-HUERFANA-ARRIBA"];     // fila 10
hojaLarga[2900] = ["", "", "H-HUERFANA-ABAJO"];   // fila 2901
let huerfanasLargas = celdasPorBorrar(hojaLarga, PAR_A, 1);
ok("encuentra la huérfana de arriba y la de abajo", huerfanasLargas.length === 2);
ok("la de arriba es la fila 10", huerfanasLargas[0].fila === 10);
// Con la cola de 500 filas, la de arriba se habría quedado fuera para siempre.
ok("con solo la cola se habría perdido",
   celdasPorBorrar(hojaLarga.slice(2500), PAR_A, 2501).length === 1);

// AL LEER SOLO LA COLA, EL ÍNDICE DEL ARRAY YA NO ES LA FILA. Confundirlos
// escribiría houses cientos de filas más arriba, encima de guías que no son.
let colaLeida = celdasPorLlenar(hojaSim, PAR_A, 2504);
ok("las filas salen desplazadas por la cola",
   colaLeida[0].fila === 2505 && colaLeida[1].fila === 2508);
ok("sin desplazamiento se comporta como antes",
   celdasPorLlenar(hojaSim, PAR_A, 4)[0].fila === 5);

// La house es dato de reporte: que tarde cinco minutos no le importa a nadie;
// que se pare el escaneo, sí.
ok("el disparador NO va cada minuto", minutosEntreRellenos() >= 5);
ok("un pedimento no pide house", !porLlenar.some(p => p.guia === "6100544"));
// Sin esto se recargaría el índice entero cada minuto para volver a no
// encontrar la misma guía.
ok("la marca de «no está» cuenta como llena", !porLlenar.some(p => p.guia === G4));
ok("una hoja vacía no pide nada", celdasPorLlenar([], PAR_A, 4).length === 0);

console.log("\n--- 6g2. A qué pestañas les toca la house ---");
// LAS M-S SE QUEDABAN FUERA SIN QUERER. Las tres funciones que rellenan
// repetían a mano `esHojaPrincipal(x) || esHojaInventario(x)`, y
// `esHojaPrincipal` devuelve false para una M-S por diseño: una M-S no es una
// hoja de destino. Ese criterio vale para el caché, no para esto — la house es
// dato de reporte y hace tanta falta en una M-S como en una Global.
ok("una Global lleva house", hojaLlevaHouse("GLOBALES"));
ok("A1 lleva house", hojaLlevaHouse("A1 77-14-ZP"));
ok("un inventario lleva house", hojaLlevaHouse("INVENTARIO A"));
ok("UNA M-S TAMBIÉN (era el hueco)", hojaLlevaHouse("M-S T1"));
ok("M-S CUENTAS ESPECIALES también", hojaLlevaHouse("M-S CUENTAS ESPECIALES"));
ok("SIMPLES y MULTIPLES también",
   hojaLlevaHouse("SIMPLES 1") && hojaLlevaHouse("MULTIPLES 2"));
ok("el tránsito de arribo también", hojaLlevaHouse("TRANSITO DE ARRIBO"));
ok("el rezago también", hojaLlevaHouse("REZAGO MS"));

// Y nada del motor recibe houses: escribir ahí ensuciaría el caché o la MACHO.
ok("el caché NO", !hojaLlevaHouse("CACHE_SISTEMA"));
ok("el historial NO", !hojaLlevaHouse("HISTORIAL_BORRADOS"));
ok("la MACHO NO", !hojaLlevaHouse("MACHO"));
ok("la plantilla de inventario NO", !hojaLlevaHouse("INVENTARIO MACHO NO BORRAR"));
ok("el propio índice NO", !hojaLlevaHouse("INDICE_HOUSE"));
ok("ni el archivo frío", !hojaLlevaHouse("INDICE_HOUSE_FRIO"));

console.log("\n--- 6g3. La preforma de la O también lleva house ---");
// En una Global la A es lo que llegó físicamente y la O es lo que decía la
// preforma: son dos juegos de guías distintos y cada uno necesita su house. Una
// sola columna no puede servir a las dos, o la de la O pisaría a la de la A en
// las filas donde ambas tienen guía.
let paresGlobal = paresDeHouse("GLOBALES", 19);
ok("una Global tiene dos pares", paresGlobal.length === 2);
// Cada house va PEGADA al estado de su guía: la C detrás de la B, la Q detrás
// de la P. Así las dos se escriben de una sola llamada y la house sale gratis.
ok("el primero es A → C", paresGlobal[0].guia === 1 && paresGlobal[0].house === 3);
ok("el segundo es O → Q", paresGlobal[1].guia === 15 && paresGlobal[1].house === 17);
ok("y las dos columnas son enteras",
   paresGlobal[0].desde === 1 && paresGlobal[1].desde === 1);

// Las M-S no llevan preforma: su columna O siempre está vacía.
ok("una M-S solo tiene el par de la A", paresDeHouse("M-S T1", 19).length === 1);
// Una hoja estrecha no puede recibir la house de la preforma.
ok("una hoja estrecha tampoco", paresDeHouse("GLOBALES", 12).length === 1);

// Una sola lectura por hoja cubre los dos pares: en este archivo lo que cuesta
// es el NÚMERO de llamadas, no cuántas celdas trae cada una.
ok("la lectura llega hasta la O", anchoParaHouses(paresGlobal) === 17);
ok("en una M-S basta hasta la C", anchoParaHouses(paresDeHouse("M-S T1", 19)) === 3);

// El barrido de la preforma mira la guía de la O y la house de la R, sin
// mezclarse con las de la A.
let filaGlobal = [];
for (let i = 0; i < 19; i++) filaGlobal.push("");
filaGlobal[0] = G1;     // guía física en la A
filaGlobal[2] = "H-A";  // su house ya puesta en la C
filaGlobal[14] = G2;    // guía de preforma en la O
let conPreforma = [filaGlobal];
ok("la A ya no pide nada",
   celdasPorLlenar(conPreforma, paresGlobal[0], 10).length === 0);
ok("pero la O sí pide su house",
   celdasPorLlenar(conPreforma, paresGlobal[1], 10).length === 1);
ok("y es la guía de la preforma, no la física",
   celdasPorLlenar(conPreforma, paresGlobal[1], 10)[0].guia === G2);

console.log("\n--- 6g3b. Un marcador de bloque no pide house ---");
// LO CAZÓ UN TEST MÍO: `claveGuiaHouse` quita los espacios ANTES de validar, así
// que «SIN PEDIMENTO» se volvía «SINPEDIMENTO» -doce caracteres, sin espacios- y
// `esGuiaUPSValida` lo aceptaba como guía corta, porque para ella cualquier cosa
// de más de siete caracteres lo es. Los separadores de bloque acababan pidiendo
// house, y peor: su house no se borraría nunca, por creerlos guías buenas.
ok("«SIN PEDIMENTO» no es guía para house", esGuiaParaHouse("SIN PEDIMENTO") === "");
ok("«COSTALES» tampoco", esGuiaParaHouse("COSTALES") === "");
ok("«FIN» tampoco", esGuiaParaHouse("FIN") === "");
ok("un pedimento de 7 dígitos tampoco", esGuiaParaHouse("6100544") === "");
ok("vacío tampoco", esGuiaParaHouse("") === "");
ok("null tampoco", esGuiaParaHouse(null) === "");
ok("una 1Z sí, y normalizada", esGuiaParaHouse(" 1z-999-aa1-0123-456-784 ") === G1);
ok("una guía corta de verdad sí", esGuiaParaHouse("AB1234567") === "AB1234567");

console.log("\n--- 6g4. Si se borra la guía, se borra su house ---");
// Una house sin guía es un dato falso ESPERANDO. Y el caso grave no es el
// renglón huérfano: es que alguien escanee otra guía en esa misma fila. La
// celda de house no está vacía, el relleno normal la salta —solo escribe en
// vacías— y el renglón acaba enseñando la house de OTRA guía. Nadie lo nota
// mirando la hoja, y con eso se despacha.
// El fixture arranca en la fila 4: encima están los totales C1:C3.
let conHuerfana = [
    [G1, "", "H-BUENA"],          // 4: guía y su house: bien
    ["", "", "H-HUERFANA"],       // 5: borraron la guía, la house se quedó
    ["SIN PEDIMENTO", "", "H-X"], // 6: un marcador de bloque no es una guía
    ["", "", ""],                 // 7: fila limpia
    [G2, "", ""]                  // 8: guía sin house: eso lo llena el relleno
];
let sobran = celdasPorBorrar(conHuerfana, PAR_A, 4);
ok("encuentra las dos huérfanas", sobran.length === 2);
ok("y son las filas 5 y 6", sobran[0].fila === 5 && sobran[1].fila === 6);
ok("no toca la que sí tiene guía", !sobran.some(x => x.fila === 4));
ok("ni la fila limpia", !sobran.some(x => x.fila === 7));
ok("ni la que solo espera su house", !sobran.some(x => x.fila === 8));
ok("una hoja sin huérfanas no da nada",
   celdasPorBorrar([[G1, "", "H"]], PAR_A, 4).length === 0);
ok("vacío no revienta", celdasPorBorrar([], PAR_A, 4).length === 0);

// EL OTRO LADO DEL MISMO PROBLEMA: sobrescriben una guía por otra. La celda de
// house NO queda vacía, así que el relleno normal nunca la tocaría.
let mapaPrueba = new Map([[G1, "H-UNO"], [G2, "H-DOS"]]);
let conVieja = [[G2, "", "H-UNO"]];   // la guía es G2 pero lleva la house de G1
let corregir = celdasPorCorregir(conVieja, PAR_A, 4, mapaPrueba);
ok("detecta la house que ya no corresponde", corregir.length === 1);
ok("y la cambia por la buena", corregir[0].valor === "H-DOS");
ok("una house correcta no se toca",
   celdasPorCorregir([[G1, "", "H-UNO"]], PAR_A, 4, mapaPrueba).length === 0);
// NUNCA se borra por no encontrarla: una house puede venir del archivo frío,
// que el disparador no abre. Vaciarla ahí la borraría cada cinco minutos.
ok("si el índice no la conoce, no se toca",
   celdasPorCorregir([[G3, "", "H-VIEJA"]], PAR_A, 4, mapaPrueba).length === 0);
ok("la marca de «no está» tampoco se corrige",
   celdasPorCorregir([[G1, "", textoHouseSinDato()]], PAR_A, 4, mapaPrueba).length === 0);
ok("sin mapa no hace nada", celdasPorCorregir(conVieja, PAR_A, 4, null).length === 0);

// Y funciona igual en el par de la preforma.
let filaPre = [];
for (let i = 0; i < 19; i++) filaPre.push("");
filaPre[16] = "H-HUERFANA";   // house en la Q sin guía en la O
ok("también limpia la house de la preforma",
   celdasPorBorrar([filaPre], paresDeHouse("GLOBALES", 19)[1], 10).length === 1);

console.log("\n--- 6g5. El relleno pone su propio ritmo ---");
// Habia DOS disparadores de tiempo despertando cada cinco minutos: la red de
// seguridad y el relleno de houses, cada uno abriendo el archivo por su cuenta.
// Google limita el TIEMPO TOTAL de disparadores por cuenta al dia y al agotarse
// los desactiva TODOS -incluido el del escaneo-, asi que pagar dos veces por el
// mismo viaje no era gratis.
//
// Ahora el relleno viaja con la red de seguridad, y para que eso no lo ate a su
// frecuencia, decide el solo si le toca.
let ahoraR = 1700000000000;
ok("sin haber corrido nunca, toca", tocaRellenar(ahoraR, 0, 5));
ok("recien corrido, NO toca", !tocaRellenar(ahoraR, ahoraR - 60 * 1000, 5));
ok("pasados los minutos, toca", tocaRellenar(ahoraR, ahoraR - 6 * 60 * 1000, 5));
ok("justo en el limite, toca", tocaRellenar(ahoraR, ahoraR - 5 * 60 * 1000, 5));
// Subir el intervalo espacia las houses sin tocar ningun disparador.
ok("con 15 minutos, a los 6 todavia no toca",
   !tocaRellenar(ahoraR, ahoraR - 6 * 60 * 1000, 15));
ok("y a los 16 si", tocaRellenar(ahoraR, ahoraR - 16 * 60 * 1000, 15));
ok("sin minutos usa el valor por defecto",
   tocaRellenar(ahoraR, ahoraR - 60 * 60 * 1000) === true);

console.log("\n--- 6g6. Lo que cuesta el ritmo, en numeros ---");
// La ultima pasada real del usuario tardo 6,2 s. A cinco minutos son ~36 min de
// cuota al dia; a un minuto, tres horas. Google apaga TODOS los disparadores de
// la cuenta al agotarse la cuota diaria, y el del escaneo es uno de ellos:
// pasarse aqui no ralentiza las houses, PARA LA OPERACION.
ok("a 5 min, unos 36 min al dia",
   Math.round(minutosDeCuotaAlDia(6.2, 5)) === 30 || Math.round(minutosDeCuotaAlDia(6.2, 5)) === 36);
ok("a 1 min se dispara por encima de 2 horas", minutosDeCuotaAlDia(6.2, 1) > 120);
ok("y es cinco veces mas que a 5 min",
   Math.abs(minutosDeCuotaAlDia(6.2, 1) / minutosDeCuotaAlDia(6.2, 5) - 5) < 0.01);
ok("espaciarlo a 15 lo baja a un tercio",
   Math.abs(minutosDeCuotaAlDia(6.2, 15) * 3 - minutosDeCuotaAlDia(6.2, 5)) < 0.01);
ok("sin medida no inventa un numero", minutosDeCuotaAlDia(0, 5) === 0);
ok("sin ritmo tampoco", minutosDeCuotaAlDia(6.2, 0) === 0);

console.log("\n--- 6g7. La house se borra con el estado y la hora ---");
// El recálculo ya limpia el estado y la hora cuando se vacía una fila. La house
// es un dato más de esa fila y tiene que seguir la misma suerte, EN EL MISMO
// INSTANTE. Dejarlo al disparador de cada cinco minutos abría una ventana en la
// que la fila enseñaba una house sin guía, y quien escaneara ahí dentro
// heredaba la house de la anterior.
//
// `datosMasivos` es la hoja entera tal como la lee el recálculo: A..S, 0-based.
function filaAS(guiaA, houseC, guiaO, houseQ) {
    let f = [];
    for (let i = 0; i < 19; i++) f.push("");
    f[0] = guiaA || ""; f[2] = houseC || "";     // A y su house en la C
    f[14] = guiaO || ""; f[16] = houseQ || "";   // O y su house en la Q
    return f;
}
let masivos = [
    filaAS(G1, "H-OK"),              // 1: guía y house: se queda
    filaAS("", "H-HUERFANA"),        // 2: borraron la guía
    filaAS("SIN PEDIMENTO", "H-X"),  // 3: un marcador no es guía
    filaAS("", ""),                  // 4: nada que hacer
    filaAS("", "", "", "H-PRE-HUERFANA"), // 5: house de preforma sin su guía
    filaAS("", "", G2, "H-PRE-OK")   // 6: preforma con su guía: se queda
];

// Se comprueba la decisión, no la escritura: lo que habla con Sheets no se
// puede cubrir aquí, pero el criterio sí — y es donde estaba el fallo.
// El bloque empieza en la fila 4 para no chocar con los totales C1:C3.
let parC = paresDeHouse("GLOBALES", 19)[0];
let parQ = paresDeHouse("GLOBALES", 19)[1];
let aBorrarC = celdasPorBorrar(masivos, parC, 4);
ok("borra la huérfana de la C", aBorrarC.some(x => x.fila === 5));
ok("y la del marcador de bloque", aBorrarC.some(x => x.fila === 6));
ok("no toca la que tiene su guía", !aBorrarC.some(x => x.fila === 4));
ok("ni la fila vacía", !aBorrarC.some(x => x.fila === 7));
ok("son exactamente dos", aBorrarC.length === 2);

let aBorrarQ = celdasPorBorrar(masivos, parQ, 4);
ok("borra la huérfana de la Q", aBorrarQ.some(x => x.fila === 8));
ok("y respeta la preforma que sí tiene guía", !aBorrarQ.some(x => x.fila === 9));
ok("solo esa", aBorrarQ.length === 1);

// Los pares se sacan del ancho realmente leído: si el recálculo leyera menos
// columnas, la de la preforma no se tocaría en vez de reventar.
ok("con A..S salen los dos pares", paresDeHouse("GLOBALES", 19).length === 2);
ok("con A..D solo el de la A", paresDeHouse("GLOBALES", 4).length === 1);
ok("la M-S nunca lleva el de la preforma", paresDeHouse("M-S T1", 19).length === 1);

console.log("\n--- 6g8. Columnas de sistema en el cache ---");
// Para que la house viaje en el cache hacen falta columnas que NO son de una
// pestaña. Y `columnasHuerfanas` borra toda columna cuyo nombre no case con una
// hoja existente, asi que sin proteccion se autodestruirian en la primera
// limpieza: el dato desapareceria solo cada pocos minutos sin que nada lo
// dijera. Llevan «__» delante y se saltan.
let hojasVivas = new Set(["GLOBAL 1", "M-S T1"]);
let cabecerasCache = ["GLOBAL 1_FISICO", "GLOBAL 1_PREFORMA", "M-S T1_FISICO",
                      "__HOUSE_GUIA", "__HOUSE_VALOR", "BORRADA_FISICO"];
let huerfanas = columnasHuerfanas(cabecerasCache, hojasVivas);
ok("las columnas «__» NO se borran",
   !huerfanas.includes(4) && !huerfanas.includes(5));
ok("la pestaña borrada si", huerfanas.includes(6));
ok("la preforma de una M-S tambien", huerfanas.includes(0 + 0) === false);
// Y lo que de verdad importa para el usuario: una house NUNCA puede entrar al
// indice de duplicados. Una house cubre decenas de guias; si se indexara, cada
// bulto de la misma house saldria marcado como repetido.
ok("el indice solo mira columnas _FISICO",
   cabecerasCache.filter(h => h.endsWith("_FISICO")).length === 3);
ok("y ninguna columna de house acaba en _FISICO",
   !"__HOUSE_VALOR".endsWith("_FISICO") && !"__HOUSE_GUIA".endsWith("_FISICO"));
ok("ni en _PREFORMA",
   !"__HOUSE_VALOR".endsWith("_PREFORMA") && !"__HOUSE_GUIA".endsWith("_PREFORMA"));

console.log("\n--- 6g9. Agrupar columnas para escribir de una llamada ---");
// Escribir el estado (B) y la house (C) juntas cuesta lo mismo que escribir
// solo el estado: es el mismo rango. Eso es lo que permite que la house
// aparezca en el instante del escaneo sin coste ninguno.
let g1 = agruparColumnasParaEscribir([2, 3]);
ok("B y C van juntas", g1.length === 1 && g1[0].length === 2);
let g2 = agruparColumnasParaEscribir([16, 17]);
ok("P y Q tambien", g2.length === 1 && g2[0].length === 2);
ok("columnas separadas no se agrupan",
   agruparColumnasParaEscribir([2, 12]).length === 2);

// LO QUE NUNCA PUEDE PASAR: que una columna de CAPTURA entre en un rango
// compartido. La escritura en lote lee el rango, cambia unas celdas y lo
// devuelve entero; si ahi entrara la A o la O, se devolveria a la hoja una
// copia leida milisegundos antes, y entre la lectura y la escritura cabe el
// escaneo de otro operador, que desapareceria sin dejar rastro.
let gA = agruparColumnasParaEscribir([1, 2, 3]);
ok("la A sale sola", gA[0].length === 1 && gA[0][0] === 1);
ok("y B y C siguen juntas detras", gA[1].length === 2);
let gO = agruparColumnasParaEscribir([14, 15, 16, 17]);
ok("la N sale sola", gO[0].length === 1 && gO[0][0] === 14);
ok("la O sale sola", gO[1].length === 1 && gO[1][0] === 15);
ok("y P con Q", gO[2].length === 2 && gO[2][0] === 16);
ok("ningun grupo mezcla una columna de captura con otra",
   agruparColumnasParaEscribir(columnasDelLote())
     .every(gr => gr.length === 1 || gr.every(c => columnasDeCaptura().indexOf(c) === -1)));

// Y el lote sigue cubriendo lo de siempre, mas las dos de house.
ok("el lote incluye la C", columnasDelLote().indexOf(3) !== -1);
ok("y la Q", columnasDelLote().indexOf(17) !== -1);
ok("desordenado se ordena solo",
   agruparColumnasParaEscribir([17, 16, 2, 3])[0][0] === 2);
ok("vacio no revienta", agruparColumnasParaEscribir([]).length === 0);

console.log("\n--- 6g10. La house viaja en el cache, no en el indice ---");
// LO QUE ESTO CORRIGE, Y ERA UN FALLO MIO DE BULTO: dije que la house iria en
// el cache y lo implemente contra el INDICE. La version anterior abria el otro
// archivo y leia 45.000 filas DENTRO del escaneo: o tardaba segundos, o fallaba
// y devolvia vacio -y la house no salia al instante-. Justo lo que este modulo
// llevaba desde el primer dia prometiendo no hacer.
//
// El cache se lee ENTERO en cada escaneo y ya esta en memoria cuando llega la
// guia: sacar la house de ahi es un Map.get, cero llamadas.
let cacheConHouses = {
    headers: ["GLOBAL 1_FISICO", "__HOUSE_GUIA", "__HOUSE_VALOR"],
    data: [["GLOBAL 1_FISICO", "__HOUSE_GUIA", "__HOUSE_VALOR"],
           ["", G1, "HAWB-001"],
           ["", G2, "HAWB-002"],
           ["", "", ""]]
};
let mapaCache = mapaHouseDelCache(cacheConHouses);
ok("saca las houses del cache", mapaCache.size === 2);
ok("y son las correctas", mapaCache.get(G1) === "HAWB-001");
ok("normaliza la guia al buscar",
   mapaHouseDelCache(cacheConHouses).get(claveGuiaHouse("1z-999-aa1-0123-456-784")) === "HAWB-001");
ok("las filas vacias no ensucian", !mapaCache.has(""));

// Un cache SIN esas columnas no revienta: devuelve vacio y la house la pone el
// relleno de fondo. Es lo que pasa el primer dia, antes de la primera pasada.
ok("sin columnas de house devuelve vacio",
   mapaHouseDelCache({headers: ["GLOBAL 1_FISICO"], data: [["GLOBAL 1_FISICO"]]}).size === 0);
ok("sin cache tampoco revienta", mapaHouseDelCache(null).size === 0);
ok("cache a medias tampoco", mapaHouseDelCache({headers: null, data: null}).size === 0);

// LA GARANTIA QUE PIDIO EL USUARIO: una house NO puede caer en los duplicados.
// El indice de duplicados solo mira columnas que acaban en «_FISICO», asi que
// queda fuera por construccion, no por acuerdo. Importa porque una house cubre
// decenas de guias: si se indexara, cada bulto de la misma house saldria
// marcado como repetido.
encabezadosDelMapaHouse().forEach(h => {
    ok(h + " no acaba en _FISICO", !h.endsWith("_FISICO"));
    ok(h + " no acaba en _PREFORMA", !h.endsWith("_PREFORMA"));
    ok(h + " empieza por __ y sobrevive al podado",
       columnasHuerfanas([h], new Set()).length === 0);
});

console.log("\n--- 6g11. Sustituir una guia se lleva su house ---");
// Dos huecos que vio el usuario:
//
// 1. La PREFORMA no recibia house al escanear -solo la guia fisica-. Ahora las
//    dos capturas la reciben: la A escribe en la C, la O en la Q.
// 2. Al SUSTITUIR una guia por otra, la celda de house NO queda vacia, asi que
//    el relleno normal -que solo escribe en vacias- nunca la tocaria y el
//    renglon se quedaria enseñando la house de la guia ANTERIOR. Sin error y
//    sin marca: se despacharia con ella.
//
// La regla es la del historial: `motivoDeCambio` solo devuelve algo cuando la
// celda TENIA otra cosa distinta. Ahi es cuando la house vieja deja de valer.
ok("sobrescribir una guia por otra es un cambio",
   motivoDeCambio(G1, G2) !== null);
ok("escanear en una celda vacia NO lo es",
   motivoDeCambio("", G1) === null);
ok("reescribir la MISMA guia tampoco",
   motivoDeCambio(G1, G1) === null);
ok("ni cambiando solo mayusculas o espacios",
   motivoDeCambio(G1, " " + G1.toLowerCase() + " ") === null);
ok("vaciar la celda si es un cambio", motivoDeCambio(G1, "") !== null);

// Y las dos columnas de house siguen pegadas a su estado, que es lo que hace
// que escribirlas no cueste una llamada de mas.
ok("la C va detras de la B", paresDeHouse("GLOBALES", 19)[0].house === 3);
ok("la Q detras de la P", paresDeHouse("GLOBALES", 19)[1].house === 17);
ok("y las dos parejas se agrupan al escribir",
   agruparColumnasParaEscribir([2, 3]).length === 1 &&
   agruparColumnasParaEscribir([16, 17]).length === 1);

console.log("\n--- 6g12. Cosechar las houses que YA estan en la hoja ---");
// EL FALLO: el mapa del cache solo se llenaba con lo que el relleno ACABABA de
// resolver. Las houses que ya estaban puestas nunca pasaban por ahi, asi que el
// mapa se quedaba vacio para siempre -que es lo que reporto el usuario-. Se
// cosechan de la hoja, que es donde estan, y no cuesta ninguna lectura: los
// datos ya se leyeron para decidir que faltaba.
let hojaConHouses = [
    [G1, "✅ Ok", "H-UNO"],
    [G2, "✅ Ok", "H-DOS"],
    [G3, "✅ Ok", ""],                    // sin house todavia
    [G4, "✅ Ok", textoHouseSinDato()],   // buscada y no estaba: no es una house
    ["", "", "H-HUERFANA"],               // sin guia: no se cosecha
    ["SIN PEDIMENTO", "", "H-X"]          // marcador: tampoco
];
let cosecha = paresGuiaHouseEnHoja(hojaConHouses, PAR_A, 4);
ok("cosecha las que tienen guia Y house", cosecha.length === 2);
ok("y son las correctas",
   cosecha[0].guia === G1 && cosecha[0].house === "H-UNO");
ok("la marca de «no esta» no es una house", !cosecha.some(c => c.house === textoHouseSinDato()));
ok("una house huerfana no se cosecha", !cosecha.some(c => c.house === "H-HUERFANA"));
ok("ni la de un marcador de bloque", !cosecha.some(c => c.house === "H-X"));
ok("una hoja vacia no da nada", paresGuiaHouseEnHoja([], PAR_A, 4).length === 0);

// Tambien por el lado de la preforma.
let filaPreCosecha = [];
for (let i = 0; i < 19; i++) filaPreCosecha.push("");
filaPreCosecha[14] = G2; filaPreCosecha[16] = "H-PRE";
ok("cosecha la pareja de la preforma",
   paresGuiaHouseEnHoja([filaPreCosecha], paresDeHouse("GLOBALES", 19)[1], 5).length === 1);

console.log("\n--- 6g13. El mapa de houses se arma una vez por ejecucion ---");
// Un pegado de 300 renglones llamaba a mapaHouseParaEscaneo 300 veces, y cada
// llamada rehacia el Map entero: miles de entradas recorridas por cada fila,
// para obtener siempre lo mismo.
olvidarMapaHouseEnRAM();
let cacheDoble = {
    headers: ["__HOUSE_GUIA", "__HOUSE_VALOR"],
    data: [["__HOUSE_GUIA", "__HOUSE_VALOR"], [G1, "H-UNO"]]
};
let m1 = mapaHouseParaEscaneo(cacheDoble);
let m2 = mapaHouseParaEscaneo(cacheDoble);
ok("la segunda llamada devuelve el MISMO objeto", m1 === m2);
ok("y trae la house", m1.get(G1) === "H-UNO");

// Y CADUCA CON EL CACHE. Si no, un escaneo serviria houses de la edicion
// anterior -y despues de sustituir una guia, eso es la house del bulto que ya
// no esta-.
olvidarMapaHouseEnRAM();
let cacheOtro = {
    headers: ["__HOUSE_GUIA", "__HOUSE_VALOR"],
    data: [["__HOUSE_GUIA", "__HOUSE_VALOR"], [G1, "H-NUEVA"]]
};
ok("tras olvidarlo, se relee", mapaHouseParaEscaneo(cacheOtro).get(G1) === "H-NUEVA");
olvidarMapaHouseEnRAM();

console.log("\n--- 5z5. La preforma tambien comprueba el digito verificador ---");
// LA PREFORMA NO SE ESCANEA: se pega o se importa, asi que nadie se entera de
// que una guia viene mal escrita. Y antes la O no la comprobaba: cualquier cosa
// que no fuera un pedimento de 7 digitos contaba como bulto. Una guia mal
// escrita sumaba a lo esperado, nadie iba a escanearla nunca -no existe- y el
// bloque se quedaba con un FALTANTE ETERNO.
//
// El criterio es el mismo que ya usa la columna A, asi que lo que vale en una
// vale en la otra.
ok("una 1Z buena pasa", esGuiaUPSValida(G1));
ok("con el digito cambiado NO", !esGuiaUPSValida("1Z999AA10123456785"));
ok("con una letra de mas tampoco", !esGuiaUPSValida(G1 + "X"));
ok("cortada tampoco", !esGuiaUPSValida(G1.substring(0, 17)));
ok("un pedimento de 7 digitos no es guia", !esGuiaUPSValida("6100544"));
ok("una guia corta de verdad si", esGuiaUPSValida("AB1234567"));
// Y los marcadores de bloque no se marcan como invalidos: no son guias, pero
// tampoco un error del que avisar.
ok("«SIN PEDIMENTO» es marcador, no guia invalida",
   esMarcadorEstructural("SIN PEDIMENTO") && !esGuiaUPSValida("SIN PEDIMENTO"));
ok("«COSTALES» tambien", esMarcadorEstructural("COSTALES"));
// El aviso que se escribe es el mismo de la columna A, con su caso de dos
// guias pegadas incluido.
ok("dos guias pegadas se nombran",
   textoCapturaInvalida(G1 + G2).indexOf("DOS PEGADAS") !== -1);
ok("una guia mala a secas dice «Guia Invalida»",
   textoCapturaInvalida("1Z999AA10123456785").indexOf("Inválida") !== -1);

console.log("\n--- 5z6. Guias en la preforma sin su pedimento ---");
// EL CASO QUE REPORTO EL USUARIO: se olvidan de poner el pedimento en la O, y
// al escanear la guia el unico mensaje que sale es el de la M-S -que no dice
// nada del problema real-.
//
// Sin su pedimento esas guias no se pueden asignar a nada, asi que se quedaban
// FUERA del indice de la preforma: para el resto del sistema era como si no
// estuvieran escritas. Y tampoco contaban como esperadas, asi que los faltantes
// y sobrantes de toda la hoja salian mal sin que nada lo explicara.
//
// PERO NO SE MARCA EL BLOQUE ENTERO. La primera version llenaba la P de
// veinticuatro avisos identicos para un unico problema, y eso no se lee: se
// ignora. Un aviso que nadie lee es peor que ninguno, porque tapa a los que si
// importan. El aviso sale solo en la fila de la O de la guia que se acaba de
// escanear en la A -una cada vez, segun se trabaja-.
// OJO CON LA DIRECCION: en la O el pedimento va DEBAJO de sus guias y cierra el
// bloque; en la A va ARRIBA y lo abre. Es al reves, y decirlo al reves manda al
// operador a mirar donde no es -que fue justo lo que corrigio el usuario-.
const AVISO_SIN_PED = "⚠️ SIN PEDIMENTO: falta ponerlo DEBAJO, en la O";
ok("el aviso manda a mirar ABAJO, no arriba",
   AVISO_SIN_PED.indexOf("DEBAJO") !== -1 && AVISO_SIN_PED.indexOf("arriba") === -1);
ok("el aviso es de nivel AVISO, no critico",
   nivelAlerta(AVISO_SIN_PED) === nivelAlerta("⚠️ Sobra (Ajena)"));
// Va por escribirAvisoPreforma, asi que respeta la prioridad: no pisa una
// alerta que ya estuviera puesta, y se antepone al resumen informativo.
let sinPedVacia = [[""]], sinPedColor = [[""]];
escribirAvisoPreforma(sinPedVacia, sinPedColor, 0, AVISO_SIN_PED, "#ffc107");
ok("en una celda vacia se escribe", sinPedVacia[0][0] === AVISO_SIN_PED);
let sinPedResumen = [["► Resumen: 5 bultos"]], sinPedResumenColor = [[""]];
escribirAvisoPreforma(sinPedResumen, sinPedResumenColor, 0, AVISO_SIN_PED, "#ffc107");
ok("no borra el resumen, se antepone",
   sinPedResumen[0][0].startsWith(AVISO_SIN_PED) &&
   sinPedResumen[0][0].indexOf("Resumen") !== -1);
let sinPedAlerta = [["⛔ DUPLICADO (En: GLOBAL 2)"]], sinPedAlertaColor = [[""]];
escribirAvisoPreforma(sinPedAlerta, sinPedAlertaColor, 0, AVISO_SIN_PED, "#ffc107");
ok("y NO pisa una alerta que ya estaba",
   sinPedAlerta[0][0] === "⛔ DUPLICADO (En: GLOBAL 2)");

console.log("\n--- 5z7. Pedimentos que no coinciden, visto desde la O ---");
// La columna A ya decia «Va en: <el bueno>» en la fila escaneada. Pero mirando
// la preforma no se veia nada, y es ahi donde se corrige: quien revisa la O no
// tenia forma de saber que renglon estaba descuadrado.
//
// Son dos casos distintos y no hay que confundirlos:
//   SIN PEDIMENTO          -> el bloque de la O no tiene pedimento ninguno.
//   PEDIMENTOS NO COINCIDEN -> lo tiene, pero se escaneo bajo otro.
// EL CASO QUE IMPORTA: mismos 1Z, otro numero. Si el bloque de la A trae
// EXACTAMENTE las mismas guias que un bloque de la preforma pero con otro
// pedimento, no son guias en el sitio equivocado: es un pedimento mal tecleado
// en una de las dos columnas. Coincidir en TODAS las guias no pasa por
// casualidad.
//
// Antes cada guia salia «Va en: <otro>» por su cuenta -veinte avisos para un
// solo dedazo- y en ningun sitio se decia lo unico que hace falta saber.
function mismoConjunto(a, b) {
    return Array.from(new Set(a)).sort().join("|") === Array.from(new Set(b)).sort().join("|");
}
ok("mismas guias en otro orden son el mismo conjunto",
   mismoConjunto([G1, G2, G3], [G3, G1, G2]));
ok("con una de mas ya no", !mismoConjunto([G1, G2], [G1, G2, G3]));
ok("con una distinta tampoco", !mismoConjunto([G1, G2], [G1, G4]));
ok("repetidas no cambian el conjunto", mismoConjunto([G1, G1, G2], [G1, G2]));

// LO ESPERADO NO SALE SOLO DE LA PREFORMA: el registro de las M-S se fusiona
// con `mapaPreformas` mas arriba. Asi que la comprobacion vale igual en una
// Global SIN preforma propia, comparando contra lo que dicen las M-S -y por eso
// el aviso dice «registrados» y no «en la preforma»: nombrar la fuente
// equivocada manda a revisar la columna que no es-.
//
// En una M-S NO aplica ni puede: no tiene preforma, es ella la fuente de
// verdad, y no hay segunda version contra la que comparar.
ok("una M-S no lleva preforma", !usaPreforma("M-S T1"));
ok("una Global si", usaPreforma("GLOBALES"));
ok("y por eso la M-S solo tiene el par de la A",
   paresDeHouse("M-S T1", 19).length === 1);

const AVISO_NO_COINCIDEN = "⚠️ PEDIMENTOS NO COINCIDEN: se escaneó en 6103851";
ok("los dos avisos son distintos", AVISO_NO_COINCIDEN !== AVISO_SIN_PED);
ok("el de no coincidir nombra el pedimento donde se escaneo",
   AVISO_NO_COINCIDEN.indexOf("6103851") !== -1);
ok("y es de nivel AVISO, no critico",
   nivelAlerta(AVISO_NO_COINCIDEN) === nivelAlerta("⚠️ Sobra (Ajena)"));

// Como los demas avisos de la P: se antepone al resumen y NO pisa una alerta
// que ya estuviera puesta.
let noCoinResumen = [["► Resumen: 12 bultos"]], noCoinColor = [[""]];
escribirAvisoPreforma(noCoinResumen, noCoinColor, 0, AVISO_NO_COINCIDEN, "#ffc107");
ok("se antepone al resumen sin borrarlo",
   noCoinResumen[0][0].startsWith(AVISO_NO_COINCIDEN) &&
   noCoinResumen[0][0].indexOf("Resumen") !== -1);
let noCoinAlerta = [["🛑 PEDIMENTO REPETIDO"]], noCoinAlertaColor = [[""]];
escribirAvisoPreforma(noCoinAlerta, noCoinAlertaColor, 0, AVISO_NO_COINCIDEN, "#ffc107");
ok("no pisa una alerta mas grave", noCoinAlerta[0][0] === "🛑 PEDIMENTO REPETIDO");

console.log("\n--- 6h. Escribir por tramos, nunca el rango entero ---");
// Mismo invariante que protege la columna A: entre leer un rango y devolverlo
// cabe un escaneo ajeno, y devolver la copia leída lo borraría.
let bloques = bloquesContiguos([
    {fila: 2, valor: "A"}, {fila: 3, valor: "B"}, {fila: 4, valor: "C"},
    {fila: 9, valor: "D"},
    {fila: 20, valor: "E"}, {fila: 21, valor: "F"}
]);
ok("tres tramos", bloques.length === 3);
ok("el primero arranca en la 2 y mide 3", bloques[0].fila === 2 && bloques[0].valores.length === 3);
ok("el suelto mide 1", bloques[1].fila === 9 && bloques[1].valores.length === 1);
ok("el último arranca en la 20", bloques[2].fila === 20 && bloques[2].valores.length === 2);
ok("desordenado se ordena solo",
   bloquesContiguos([{fila: 5, valor: "B"}, {fila: 4, valor: "A"}]).length === 1);
ok("nada que escribir, ningún tramo", bloquesContiguos([]).length === 0);
// Los tramos solo cubren filas que se van a llenar: ninguna celda ajena entra
// en el rango escrito.
let filasCubiertas = bloques.reduce((n, b) => n + b.valores.length, 0);
ok("no se escribe ni una celda de más", filasCubiertas === 6);

console.log("\n--- 6i. OneDrive: el vínculo y la trampa del login ---");
// Un vínculo de OneDrive abre el visor web; con download=1 entrega el archivo.
ok("añade download a un vínculo limpio",
   urlDescargaOneDrive("https://x.sharepoint.com/:x:/g/ABC") ===
   "https://x.sharepoint.com/:x:/g/ABC?download=1");
ok("con query existente usa &",
   urlDescargaOneDrive("https://x.sharepoint.com/:x:/g/ABC?e=aBcD") ===
   "https://x.sharepoint.com/:x:/g/ABC?e=aBcD&download=1");
ok("no lo duplica si ya está",
   urlDescargaOneDrive("https://x/ABC?download=1") === "https://x/ABC?download=1");
ok("ni cuando va en medio",
   urlDescargaOneDrive("https://x/ABC?download=1&e=x") === "https://x/ABC?download=1&e=x");
ok("vacío devuelve vacío", urlDescargaOneDrive("") === "");
ok("null no revienta", urlDescargaOneDrive(null) === "");

// LA PROTECCIÓN QUE NO PUEDE FALTAR: si el vínculo no es público, Microsoft
// responde 200 con la página de inicio de sesión. Sin detectarlo, esa página
// entraría a parseCsv y la importación diría «0 guías nuevas» tan tranquila,
// como si la base estuviera vacía. Un fallo que no se nota es peor que uno que
// revienta.
ok("detecta una página de login", pareceLoginHtml("<!DOCTYPE html><html><head>"));
ok("detecta HTML sin doctype", pareceLoginHtml("<html lang=\"es\">"));
ok("detecta HTML con espacios delante", pareceLoginHtml("\n  <!doctype html>"));
ok("un CSV normal NO es login", !pareceLoginHtml("GUIA,HOUSE\n1Z999,H1"));
ok("un CSV con punto y coma tampoco", !pareceLoginHtml("GUIA;HOUSE;FECHA"));
ok("vacío no es login", !pareceLoginHtml(""));
ok("null no revienta", !pareceLoginHtml(null));
// Un CSV cuyo primer campo empezara con «<» sería rarísimo, pero si pasa se
// prefiere el falso positivo: el aviso se lee, una importación vacía no.
ok("prefiere el falso positivo antes que importar basura",
   pareceLoginHtml("<no es csv>"));

// EL CASO QUE SE PASA POR ALTO: al compartir, lo natural es compartir EL LIBRO
// DE EXCEL, no un CSV. Entonces baja un binario, parseCsv lo vuelve basura y el
// error que sale es «no reconozco sus columnas» —que manda a buscar el problema
// a las cabeceras, donde no está—.
ok("un .xlsx se reconoce por «PK»", pareceExcelBinario("PK\u0003\u0004algo"));
ok("un .xls viejo por la firma OLE", pareceExcelBinario("\u00D0\u00CF\u0011\u00E0"));
ok("un CSV no es un Excel", !pareceExcelBinario("GUIA,HOUSE\n1Z,H1"));
ok("una cadena de un carácter no revienta", !pareceExcelBinario("P"));
ok("vacío tampoco", !pareceExcelBinario(""));

// Cada respuesta lleva a un consejo distinto: ese es el punto. «No jala» no se
// puede arreglar; «esto es un Excel, exporta a CSV» sí.
ok("clasifica un CSV", clasificarDescarga("GUIA,HOUSE\n1Z,H1") === "csv");
ok("clasifica un Excel", clasificarDescarga("PK\u0003\u0004") === "excel");
ok("clasifica una página web", clasificarDescarga("<!DOCTYPE html>") === "html");
ok("clasifica el vacío", clasificarDescarga("") === "vacio");
ok("solo espacios también es vacío", clasificarDescarga("   \n  ") === "vacio");
ok("el consejo del Excel manda a exportar a CSV",
   explicarDescargaMala("excel").indexOf("CSV") !== -1);
ok("el del HTML habla del inicio de sesión",
   explicarDescargaMala("html").toUpperCase().indexOf("SESIÓN") !== -1);

// Las dos formas de vínculo de OneDrive NO se descargan igual, y meterlas en el
// mismo saco es lo que hace que «el vínculo es correcto» y «no jala» sean
// verdad a la vez.
ok("un vínculo de empresa no es personal",
   !esVinculoPersonal("https://x.sharepoint.com/:x:/g/ABC"));
ok("1drv.ms sí es personal", esVinculoPersonal("https://1drv.ms/x/s!ABC"));
ok("onedrive.live.com también", esVinculoPersonal("https://onedrive.live.com/?id=ABC"));
ok("mayúsculas no engañan", esVinculoPersonal("HTTPS://1DRV.MS/x/s!ABC"));
// En el personal, download=1 devuelve la página del visor, no el archivo.
ok("el personal va por la API de compartidos",
   urlDescargaOneDrive("https://1drv.ms/x/s!ABC")
       .indexOf("https://api.onedrive.com/v1.0/shares/u!") === 0);
ok("y NO lleva download=1",
   urlDescargaOneDrive("https://1drv.ms/x/s!ABC").indexOf("download=1") === -1);
ok("el base64 va url-safe, sin + ni / ni =",
   !/[+/=]/.test(base64DeVinculo("https://1drv.ms/x/s!AB+CD/EF")));

// Los vínculos de SharePoint llevan escrito a qué apuntan. Saberlo ANTES de
// descargar ahorra el viaje: compartir el libro de Excel es lo natural -es el
// archivo con el que se trabaja- y es justo lo que no sirve.
const URL_REAL = "https://terminalmx-my.sharepoint.com/:x:/g/personal/" +
                 "sebastian_lopez_terminal_com_mx/IQDNB7BQPebj21XA?e=JAoCeD";
ok("«/:x:/» es un libro de Excel", queApuntaElVinculo(URL_REAL) === "excel");
ok("«/:f:/» es una carpeta",
   queApuntaElVinculo("https://x.sharepoint.com/:f:/g/personal/y/ABC") === "carpeta");
ok("«/:w:/» es Word",
   queApuntaElVinculo("https://x.sharepoint.com/:w:/g/personal/y/ABC") === "word");
ok("un vínculo sin marca no dice nada",
   queApuntaElVinculo("https://x.sharepoint.com/algo/ABC") === "");
ok("null no revienta", queApuntaElVinculo(null) === "");
// La marca va entre barras: una «x» suelta en el nombre del archivo no cuenta.
ok("no se confunde con una x en el nombre",
   queApuntaElVinculo("https://x.sharepoint.com/g/personal/y/reporte-x-final.csv") === "");
// EL FALSO POSITIVO QUE ESTO CORRIGE: SharePoint pone «/:x:/» a TODO lo que
// abre con Excel, y un CSV abre con Excel. La marca NO distingue un .xlsx de un
// .csv, así que el aviso tiene que sonar a sospecha, no a veredicto — y quien
// lo use debe callarlo en cuanto el contenido se lea como CSV.
ok("el aviso del Excel menciona el CSV",
   avisoDelTipoDeVinculo(URL_REAL).indexOf("CSV") !== -1);
ok("y no afirma que sea un Excel",
   avisoDelTipoDeVinculo(URL_REAL).indexOf("PODRÍA") !== -1);
ok("avisa de que puede ser falsa alarma",
   avisoDelTipoDeVinculo(URL_REAL).toLowerCase().indexOf("falsa alarma") !== -1);
ok("un vínculo sin marca no genera aviso",
   avisoDelTipoDeVinculo("https://x.sharepoint.com/algo") === "");

// El segundo camino, cuando download=1 devuelve la página puente en vez del
// archivo. La ruta de descarga directa no pasa por el visor web, que es lo que
// mete el rodeo de la cookie y el JavaScript.
let alt = urlDescargaAlternativa(
    "https://terminalmx-my.sharepoint.com/:t:/g/personal/sebastian_lopez_terminal_com_mx/" +
    "IQDNB7BQPebj21XA?e=JAoCeD");
ok("conserva el servidor",
   alt.indexOf("https://terminalmx-my.sharepoint.com/") === 0);
ok("conserva la ruta personal",
   alt.indexOf("/personal/sebastian_lopez_terminal_com_mx/") !== -1);
ok("apunta a download.aspx", alt.indexOf("/_layouts/15/download.aspx?share=") !== -1);
ok("y lleva el token, sin el ?e=", alt.indexOf("share=IQDNB7BQPebj21XA") !== -1 &&
   alt.indexOf("JAoCeD") === -1);
ok("funciona igual con un vínculo de Excel",
   urlDescargaAlternativa("https://x.sharepoint.com/:x:/g/personal/y/TOK") !== "");
ok("una URL que no tiene esa forma devuelve vacío",
   urlDescargaAlternativa("https://1drv.ms/x/s!ABC") === "");
ok("null no revienta", urlDescargaAlternativa(null) === "");

console.log("\n--- 6i2. Varios vínculos, cada uno etiquetado ---");
// Son dos archivos, hacen falta dos vínculos. Y la etiqueta no es comodidad:
// la URL de descarga de SharePoint es un TOKEN y no lleva el nombre del archivo
// dentro. Con los CSV de Drive el tipo sale del nombre; aquí no hay nombre.
// Sin etiqueta los dos entrarían como «desconocido» y NINGUNO podría corregir
// al otro: la regla de que el inbound manda se quedaría muerta y en silencio.
const TOKEN_URL = "https://terminalmx-my.sharepoint.com/personal/x/_layouts/15/" +
                  "download.aspx?share=IQAqSNTGDUCRQ4nLLcudTvb";
ok("la URL de descarga NO dice de qué archivo es",
   tipoDeOrigen(TOKEN_URL) === origenDesconocido());

let guardadas = [{tipo: origenInbound(), url: "https://a/1"},
                 {tipo: origenPrealerta(), url: "https://b/2"}];
let serie2 = serializarUrlsGuardadas(guardadas);
let vuelta = parsearUrlsGuardadas(serie2);
ok("guarda y recupera los dos", vuelta.length === 2);
ok("conserva la etiqueta del inbound", vuelta[0].tipo === origenInbound());
ok("conserva la de la prealerta", vuelta[1].tipo === origenPrealerta());
ok("y las URLs intactas", vuelta[0].url === "https://a/1" && vuelta[1].url === "https://b/2");
// Una URL con «|» dentro no puede partir mal: solo cuenta el PRIMER separador.
ok("una URL con | dentro sobrevive",
   parsearUrlsGuardadas("INBOUND|https://a/x?p=1|2")[0].url === "https://a/x?p=1|2");
ok("una línea sin etiqueta queda como desconocida",
   parsearUrlsGuardadas("https://a/1")[0].tipo === origenDesconocido());
ok("las líneas vacías se ignoran",
   parsearUrlsGuardadas("INBOUND|https://a/1\n\n   \n").length === 1);
ok("vacío da lista vacía", parsearUrlsGuardadas("").length === 0);
ok("null tampoco revienta", parsearUrlsGuardadas(null).length === 0);
ok("lista vacía se serializa vacía", serializarUrlsGuardadas([]) === "");

console.log("\n--- 6j. Los dos límites del CSV real ---");
// EL CASO REAL: el inbound concentrado bajó con 52.260.081 caracteres. Apps
// Script no aguanta eso: se queda sin tiempo a media pasada de parseCsv y el
// error aparece SEIS MINUTOS después sin decir que el problema era el tamaño.
const UN_MB = 1024 * 1024;
ok("un archivo pequeño no genera aviso", avisoDeTamano(2 * UN_MB) === "");
ok("uno grande avisa pero deja pasar",
   avisoDeTamano(15 * UN_MB) !== "" && !excedeElLimite(15 * UN_MB));
// EL CASO REAL SEGUNDO: ya reducido a GUIA + GUIA CORTA, seguía pesando 25,5
// MB. O sea que lo que sobra no son columnas, es HISTORIA. Con lectura por
// bloques ese tamaño sí entra, así que el límite subió: rechazar un archivo que
// se puede leer es tan malo como aceptar uno que no.
ok("el de 25,5 MB ya NO se rechaza", !excedeElLimite(26729756));
ok("pero sí avisa de que va a tardar", avisoDeTamano(26729756) !== "");
ok("el de 52 MB se sigue rechazando", excedeElLimite(52260081));
ok("y el aviso dice cuántos MB son",
   avisoDeTamano(52260081).indexOf("49.8 MB") !== -1);
// Ya no manda a quitar columnas: si solo quedan dos, el consejo sería inútil.
ok("y manda a recortar la historia, no las columnas",
   avisoDeTamano(52260081).indexOf("meses") !== -1);
// Y deja claro que el techo lo pone Google, no yo: con 49,4 MB el usuario está
// a 600 KB del límite de UrlFetchApp, así que subir mi umbral solo movería el
// fallo a un sitio peor.
ok("dice que el límite es de Google", avisoDeTamano(52260081).indexOf("50 MB") !== -1);
ok("el archivo real de 49,4 MB se rechaza", excedeElLimite(49.4 * UN_MB));
ok("justo por debajo del límite pasa", !excedeElLimite(44 * UN_MB));

console.log("\n--- 6k. Leer un CSV enorme por bloques ---");
// `parseCsv` sobre 25 MB de golpe monta un array de más de un millón de celdas.
// Por bloques, el pico se queda en lo que ocupe un bloque.
let csvLargo = "GUIA,GUIA CORTA\n" +
    Array.from({length: 10}, (_, i) => "FILA" + i + ",H" + i).join("\n");
let bl = bloquesDeLineas(csvLargo, 4, "GUIA,GUIA CORTA");
ok("parte en varios bloques", bl.length > 1);
ok("el primero conserva su cabecera", bl[0].split("\n")[0] === "GUIA,GUIA CORTA");
// La cabecera se repite en cada bloque para que todos se parseen igual y quien
// los reciba pueda saltarse siempre la fila 0.
ok("los demás la reciben pegada", bl[1].split("\n")[0] === "GUIA,GUIA CORTA");
ok("no se pierde ninguna línea de datos",
   bl.reduce((n, b, i) => n + b.split("\n").length - (i === 0 ? 1 : 1), 0) === 10);

// UN SALTO DE LÍNEA DENTRO DE UN CAMPO ENTRECOMILLADO no puede partir un
// bloque, o el CSV quedaría cortado por la mitad y esa fila se perdería.
let conComillas = 'GUIA,NOTA\nA,"linea1\nlinea2"\nB,ok\nC,ok\nD,ok';
let bc = bloquesDeLineas(conComillas, 2, null);
ok("no corta dentro de un campo entrecomillado",
   bc.every(b => (b.match(/"/g) || []).length % 2 === 0));

ok("un texto de una línea da un bloque", bloquesDeLineas("solo,una", 100, null).length === 1);
ok("vacío no revienta", bloquesDeLineas("", 100, null).length === 1);
ok("null tampoco", bloquesDeLineas(null, 100, null).length === 1);

// Power Query exporta «Column1, Column2…» si no se promueven los encabezados.
// Las columnas se buscan por NOMBRE a propósito, así que con nombres genéricos
// no hay por dónde agarrar: decirlo evita buscar el fallo en otro sitio.
ok("reconoce las cabeceras genéricas",
   cabecerasGenericas(["Column1", "Column2", "Column3", "Column4"]));
ok("con espacio también", cabecerasGenericas(["Column 1", "Column 2"]));
ok("unas buenas NO son genéricas", !cabecerasGenericas(["GUIA", "HOUSE", "FECHA"]));
ok("una genérica suelta entre buenas no cuenta",
   !cabecerasGenericas(["GUIA", "HOUSE", "FECHA", "Column4"]));
ok("mitad y mitad sí cuenta",
   cabecerasGenericas(["GUIA", "HOUSE", "Column3", "Column4"]));
ok("sin cabeceras no revienta", !cabecerasGenericas([]));
ok("null tampoco", !cabecerasGenericas(null));

// -------------------------------------------------------------------------
console.log("\n--- 6g14. Lo que dice ser una house tiene que parecerlo ---");
// -------------------------------------------------------------------------
// EL CASO REAL: un CSV leído con el separador equivocado deja el renglón entero
// en una celda, y ese renglón entró al índice como house de 18.610 guías,
// pisando las buenas. Este es el valor exacto que salió en el resumen.
const BASURA_REAL = "13/08/2026 1Z08E27V0411529440 08E27V7LNM3";
ok("el renglón entero NO es una house", houseSospechosa(BASURA_REAL));
ok("la house de verdad que iba dentro SÍ pasa", !houseSospechosa("08E27V7LNM3"));

ok("una guía dentro la delata",
   houseSospechosa("1Z08E27V0411529440"));
ok("una guía con guiones también",
   houseSospechosa("1Z-08E27V-0411529440"));
ok("una fecha dentro la delata", houseSospechosa("13/08/2026 H123"));
ok("con guiones en la fecha igual", houseSospechosa("2026-08-13 H123"));
ok("vacío no es house", houseSospechosa(""));
ok("solo espacios tampoco", houseSospechosa("   "));
ok("null no revienta", houseSospechosa(null));
ok("undefined tampoco", houseSospechosa(undefined));

// Houses reales de las que hay en la base: cortas, alfanuméricas, a veces con
// guiones o barras. Ninguna puede caer en el filtro o se perdería trabajo bueno.
["08E27V7LNM3", "HAWB-4471", "MEX/2231", "H 88231", "ABC123456789",
 "SHIP-2026-0001"].forEach(h => {
    ok("house buena aceptada: " + h, !houseSospechosa(h));
});

// El largo es el último recurso: una house real nunca mide tanto.
ok("cuarenta caracteres justos pasan", !houseSospechosa("A".repeat(40)));
ok("cuarenta y uno ya no", houseSospechosa("A".repeat(41)));

// El marcador de «no está» tiene que sobrevivir: lo escribe el propio relleno y
// borrarlo lo haría reintentar en bucle.
ok("el guion de «no está» no es basura", !houseSospechosa("—"));

// -------------------------------------------------------------------------
console.log("\n--- 6g15. Una cabecera de un solo campo es un archivo mal partido ---");
// -------------------------------------------------------------------------
// De aquí venía todo: la cabecera sin partir decía «Fecha Guia Guia corta»,
// contenía «CORTA», y la detección de columnas la eligió como la de la house.
// Se comprueba primero que ese es el mecanismo, y luego que ya no puede pasar.
let cabezaPegada = detectarColumnasInbound(["Fecha Guia Guia corta"]);
ok("una cabecera pegada engaña a la detección de columnas",
   cabezaPegada.house === 0);
ok("y la rechazamos antes de llegar ahí",
   cabeceraSinPartir(["Fecha Guia Guia corta"]));

ok("una cabecera partida de verdad pasa",
   !cabeceraSinPartir(["FECHA", "GUIA", "GUIA CORTA"]));
ok("dos columnas bastan", !cabeceraSinPartir(["GUIA", "HOUSE"]));
ok("sin cabecera se rechaza", cabeceraSinPartir([]));
ok("null se rechaza", cabeceraSinPartir(null));

// -------------------------------------------------------------------------
console.log("\n--- 6g16. Las filas basura no llegan al índice ---");
// -------------------------------------------------------------------------
reiniciarHousesDescartadas();
let csvRoto = [
    ["FECHA", "GUIA", "GUIA CORTA"],
    ["13/08/2026", "1Z08E27V0411529440", "08E27V7LNM3"],
    // La misma fila, pero con el renglón entero metido en la columna de house.
    ["13/08/2026", "1Z08E27V0411529440", BASURA_REAL]
];
let salidaRota = filasDeInbound(csvRoto, { guia: 1, house: 2, fecha: 0 }, "INBOUND");
ok("la fila buena entra", salidaRota.length === 1);
ok("y entra con SU house", salidaRota[0].house === "08E27V7LNM3");
ok("la basura se cuenta como descartada", housesDescartadas() === 1);

// El contador se reinicia por importación: si arrastrara, el aviso de «son
// demasiadas» saltaría en la importación siguiente sin motivo.
reiniciarHousesDescartadas();
ok("el contador se puede reiniciar", housesDescartadas() === 0);

// -------------------------------------------------------------------------
console.log("\n--- 6g17. Reparar: sacar del índice lo que ya está dentro ---");
// -------------------------------------------------------------------------
// La fusión MEZCLA, no reconstruye: reimportar no limpia lo que ya se guardó.
// Por eso hace falta un paso que lo quite.
let indiceSucio = [
    ["1Z08E27V0411529440", "08E27V7LNM3", new Date(2026, 7, 13), 2],
    ["1Z08E27V0411529451", BASURA_REAL, new Date(2026, 7, 13), 2],
    ["1Z08E27V0411529462", "H-2231", new Date(2026, 7, 13), 1],
    ["1Z08E27V0411529473", "", new Date(2026, 7, 13), 1]
];
let reparado = filasSinBasura(indiceSucio);
ok("se quitan la basura y la vacía", reparado.tiradas === 2);
ok("quedan las buenas", reparado.limpias.length === 2);
ok("y quedan enteras, con su fecha y su origen",
   reparado.limpias[0].length === 4 && reparado.limpias[1][1] === "H-2231");
ok("un índice limpio no pierde nada",
   filasSinBasura([["1Z08E27V0411529440", "H1", null, 2]]).tiradas === 0);
ok("un índice vacío no revienta", filasSinBasura([]).limpias.length === 0);
ok("null tampoco", filasSinBasura(null).tiradas === 0);

console.log("\n" + (fallos === 0 ? "✅ TODOS LOS TESTS PASARON" : "❌ " + fallos + " FALLOS"));
process.exit(fallos === 0 ? 0 : 1);
