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
ok("la columna Q ya no está en el lote", columnasDelLote().indexOf(17) === -1);
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
const cacheDosIW = {
  map: new Map([[G, [
    { hoja: "INVENTARIO A", fila: 30, isMS: false, isInventario: true },
    { hoja: "INVENTARIO A", fila: 55, isMS: false, isInventario: true }
  ]]]),
  headers: [], data: []
};
let filasInv = [];
for (let i = 0; i < 60; i++) filasInv.push([""]);
filasInv[30] = [G];
filasInv[55] = [G];

let dupDosIW = calcularDuplicadosExternos(filasInv, 60, "INVENTARIO A", cacheDosIW);
ok("marca la fila 30", dupDosIW.has(30));
ok("marca también la fila 55", dupDosIW.has(55));
ok("cada una apunta a la otra",
   dupDosIW.get(30).fila === 55 && dupDosIW.get(55).fila === 30);
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

console.log("\n" + (fallos === 0 ? "✅ TODOS LOS TESTS PASARON" : "❌ " + fallos + " FALLOS"));
process.exit(fallos === 0 ? 0 : 1);
