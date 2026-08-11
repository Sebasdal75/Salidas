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

console.log("\n" + (fallos === 0 ? "✅ TODOS LOS TESTS PASARON" : "❌ " + fallos + " FALLOS"));
process.exit(fallos === 0 ? 0 : 1);
