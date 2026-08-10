// =========================================================================
// WMS SOBRE GOOGLE SHEETS — MOTOR DE ESCANEO
//
// Arquitectura: caché híbrido (hoja oculta CACHE_SISTEMA + índice en RAM),
// escrituras siempre en lote, y tres dominios aislados entre sí:
//   · GLOBALES / REZAGO / AGA  -> cruzan Físico (col A) contra Preforma (col O)
//   · BODEGAS (M-S ...)        -> cruzan solo contra otras bodegas
//   · INVENTARIOS              -> cruzan SOLO contra otros inventarios
//
// Regla de oro: ninguna llamada a la API de Sheets dentro de un bucle.
// =========================================================================

// Opcional: ID del archivo. Solo hace falta para los triggers por tiempo,
// donde getActiveSpreadsheet() puede devolver null.
const ID_ARCHIVO = '';

// Hojas internas del motor. Nunca se escanean y NUNCA reciben el volcado de la
// columna M: la M de CACHE_SISTEMA guarda datos de caché, no la lista FEMAD.
const HOJAS_INTERNAS = ["CACHE_SISTEMA", "HISTORIAL_BORRADOS"];

// Hoja origen de la lista FEMAD (guías retenidas por la Guardia Nacional).
// Su columna M alimenta la validación de datos y los colores del resto de
// pestañas; se edita una vez al día y algún añadido suelto.
const HOJA_MACHO = "MACHO";

const PROP_TRIGGER = 'TRIGGER_EDICION_INSTALADO';

// =========================================================================
// COLORES DE LA COLUMNA A
//
// Los pinta el script para poder retirar el formato condicional, que Google
// reevalúa en cada cambio y frena tanto al script como al navegador.
// Mientras el formato condicional siga puesto, él manda y esto no se ve:
// se puede pegar el código y quitar las reglas después, sin prisa.
//
// Poner COLOREAR_COLUMNA_A en false devuelve el control al formato condicional.
// =========================================================================
const COLOREAR_COLUMNA_A = true;

// La columna O (preforma) conserva su esquema por bloques según la letra de
// la columna N, y encima recibe los dos colores de la A:
//   pedimento → azul, repetido (pedimento o guía) → rojo.
// Poner en false para dejar la O exactamente como estaba.
const COLOREAR_PEDIMENTO_Y_DUP_EN_O = true;

const COLOR_A_PEDIMENTO = "#178ccc";  // pedimento (7 dígitos) → azul
const COLOR_A_GUIA      = "#00ff00";  // guía válida → verde (el mismo de la columna O)
const COLOR_A_DUPLICADO = "#df5f6b";  // duplicada → rojo
const COLOR_A_UBICACION = "#a4c2f4";  // ubicación IW en inventarios → azul claro
const COLOR_A_NEUTRO    = "#ffffff";  // fila vacía o sin clasificar

// Color de bloque de la columna O según la letra de la columna N del pedimento.
function colorBloqueO(letraN) {
    let l = String(letraN).trim().toLowerCase();
    if (l === "a") return "#35ec09";
    if (l === "b") return "#ff00ff";
    if (l === "c") return "#39b1b9";
    return "#00ff00";
}

// Filas cuya guía ya apareció antes en la columna O de la misma hoja. Se mira
// la columna O completa, no bloque por bloque: una guía no puede estar en dos
// pedimentos, y repetirla infla el conteo de bultos esperados. Los pedimentos
// (7 dígitos) y los marcadores estructurales se saltan: los primeros tienen su
// propia detección, los segundos se repiten de forma legítima.
function filasGuiaRepetidaEnPreforma(datosMasivos, ultimaFila) {
    let repetidas = new Set();
    let vistas = new Set();
    for (let i = 0; i < ultimaFila; i++) {
        let v = String(datosMasivos[i][14]).trim().toUpperCase();
        if (v === "" || /^\d{7}$/.test(v) || esMarcadorEstructural(v)) continue;
        if (vistas.has(v)) repetidas.add(i);
        else vistas.add(v);
    }
    return repetidas;
}

// Decide el color de una celda de la columna A a partir del valor y su estado.
function colorColumnaA(valor, estado) {
    let v = String(valor).trim().toUpperCase();
    if (v === "") return COLOR_A_NEUTRO;

    // Duplicada en cualquiera de sus formas: entre hojas, entre pedimentos, o la
    // primera de la pareja marcada con "⚠️ DUPLICADO (repetida en...)". Se busca
    // la raíz sin distinguir mayúsculas para que ningún texto se escape.
    let e = String(estado).toUpperCase();
    if (e.indexOf("DUPLICAD") !== -1) return COLOR_A_DUPLICADO;

    if (v.startsWith("IW")) return COLOR_A_UBICACION;
    if (/^\d{7}$/.test(v)) return COLOR_A_PEDIMENTO;
    if (esMarcadorEstructural(v)) return COLOR_A_NEUTRO;
    if (esGuiaUPSValida(v)) return COLOR_A_GUIA;
    return COLOR_A_DUPLICADO;   // guía inválida: también en rojo
}

// Variables globales de memoria (sobreviven entre escaneos dentro de una
// misma ejecución del motor V8).
let globalCacheData = null;
let globalCacheHeaders = null;
let globalCacheMap = null; // Índice O(1) con soporte para múltiples ubicaciones por guía
let globalUsuario = null;
let globalTriggerInstalable = null;

// =========================================================================
// NORMALIZACIÓN DE NOMBRES DE HOJA
// Todo el sistema (headers del caché, comparaciones, clasificación) usa la
// clave normalizada. Nunca comparar contra hoja.getName() en crudo.
// =========================================================================
function claveHoja(nombre) {
    return String(nombre).trim().toUpperCase();
}

// Motor: caché e historial. Ni se escanean ni reciben la columna M.
function esHojaInterna(nombreHoja) {
    let n = claveHoja(nombreHoja);
    return HOJAS_INTERNAS.indexOf(n) !== -1 || n.indexOf("HISTORIAL") !== -1;
}

// Cualquier pestaña con "MACHO" en el nombre: o es la lista FEMAD, o es una
// plantilla de inventario. Ninguna se escanea ni entra al índice de duplicados,
// pero las plantillas SÍ reciben el volcado de la columna M (las copias que
// salgan de ellas ya vienen con la validación puesta).
function esHojaMacho(nombreHoja) {
    return claveHoja(nombreHoja).indexOf("MACHO") !== -1;
}

// "De sistema" = todo lo que el motor de escaneo debe ignorar.
function esHojaSistema(nombreHoja) {
    return esHojaInterna(nombreHoja) || esHojaMacho(nombreHoja);
}

function esHojaMS(nombreHoja) {
    let n = claveHoja(nombreHoja);
    return n.startsWith("M-S ") || n.startsWith("SIMPLES") || n.startsWith("MULTIPLES");
}

// El tipo de una bodega lo decide el operador al elegir la pestaña. No se
// puede deducir de las guías: con guías cortas no hay nada que distinga un T1
// de un global, y con guías 1Z el prefijo del embarcador tampoco lo dice.
function tipoMS(nombreHoja) {
    let n = claveHoja(nombreHoja);
    // Solo abreviatura para que la celda no se alargue. NO lleva ninguna regla
    // de comportamiento asociada: esta hoja es una M-S como cualquier otra.
    if (n.indexOf("CUENTAS ESPECIALES") !== -1) return "M-S CTAS ESP";
    if (n.indexOf("A1") !== -1) return "M-S A1";
    if (n.indexOf("SEGUIMIENTOS") !== -1) return "M-S SEGUIMIENTOS";
    if (n.startsWith("M-S GLOBALES") || n.startsWith("MULTIPLES")) return "M-S GLOBALES";
    if (n.startsWith("M-S T1") || n.startsWith("SIMPLES")) return "M-S T1";
    return n;
}

function esHojaInventario(nombreHoja) {
    return claveHoja(nombreHoja).indexOf("INVENTARIO") !== -1;
}

function esHojaPrincipal(nombreHoja) {
    let n = claveHoja(nombreHoja);
    if (esHojaSistema(n)) return false;
    if (esHojaInventario(n)) return false;
    if (esHojaMS(n)) return false;
    return true;
}

// Textos que el propio script escribe en la columna A como separadores de
// bloque. NO son guías: si se tratan como tales cuentan como bultos, entran al
// índice del caché y acaban marcándose como duplicados entre pestañas.
function esMarcadorEstructural(v) {
    let s = String(v).trim().toUpperCase();
    if (s === "") return false;
    return s === "COSTALES" || s === "FIN" || s === "SIN_CABECERA" || s.indexOf("SIN PEDIMENTO") !== -1;
}

// Una fila de columna A es cabecera de bloque si es un pedimento de 7 dígitos
// o uno de esos marcadores.
function esCabeceraBloque(v) {
    return /^\d{7}$/.test(String(v).trim()) || esMarcadorEstructural(v);
}

function asegurarColumnas(hoja, minimo) {
    let max = hoja.getMaxColumns();
    if (max < minimo) hoja.insertColumnsAfter(max, minimo - max);
}

function asegurarFilas(hoja, minimo) {
    let max = hoja.getMaxRows();
    if (max < minimo) hoja.insertRowsAfter(max, (minimo - max) + 100);
}

function invalidarCacheRAM() {
    globalCacheData = null;
    globalCacheHeaders = null;
    globalCacheMap = null;
}

function obtenerArchivo() {
    let ss = SpreadsheetApp.getActiveSpreadsheet();
    if (!ss && ID_ARCHIVO) ss = SpreadsheetApp.openById(ID_ARCHIVO);
    if (!ss) throw new Error('No se pudo resolver el archivo. Rellena ID_ARCHIVO en el script.');
    return ss;
}

// Quién hizo la edición, para el historial.
//
// getActiveUser() devuelve al editor, pero entre cuentas de consumidor
// (@gmail.com) distintas devuelve cadena vacía: Google no deja identificar a
// otro usuario.
//
// getEffectiveUser() es el usuario bajo cuya autoridad corre el script:
//   · en un trigger SIMPLE     -> es el propio editor, así que sirve;
//   · en un trigger INSTALABLE -> es quien lo instaló, NO quien editó.
//
// Por eso el respaldo solo se usa con el trigger simple. En un instalable
// atribuiría cada borrado al instalador, y un nombre equivocado en una
// auditoría es peor que ningún nombre.
function obtenerUsuarioActual() {
    if (globalUsuario !== null) return globalUsuario;

    let email = "";
    try { email = Session.getActiveUser().getEmail() || ""; } catch (err) { email = ""; }

    if (email === "" && !triggerInstalableActivo()) {
        try { email = Session.getEffectiveUser().getEmail() || ""; } catch (err) { email = ""; }
    }

    globalUsuario = email !== "" ? email : "(no identificado)";
    return globalUsuario;
}

// =========================================================================
// PUNTOS DE ENTRADA DE EDICIÓN
//
// onEdit  -> trigger simple (límite 30 s, sin identidad del editor)
// alEditar -> trigger instalable (límite 6 min, sí identifica al editor)
//
// Si el instalable está activo, el simple se aparta para no duplicar trabajo.
// =========================================================================
function onEdit(e) {
    if (triggerInstalableActivo()) return;
    procesarEdicion(e);
}

function alEditar(e) {
    procesarEdicion(e);
}

function triggerInstalableActivo() {
    if (globalTriggerInstalable === null) {
        try {
            globalTriggerInstalable = PropertiesService.getScriptProperties().getProperty(PROP_TRIGGER) === '1';
        } catch (err) {
            globalTriggerInstalable = false;
        }
    }
    return globalTriggerInstalable;
}

function instalarTriggerAvanzado() {
    const ss = obtenerArchivo();
    ScriptApp.getProjectTriggers().forEach(t => {
        if (t.getHandlerFunction() === 'alEditar') ScriptApp.deleteTrigger(t);
    });
    ScriptApp.newTrigger('alEditar').forSpreadsheet(ss).onEdit().create();
    PropertiesService.getScriptProperties().setProperty(PROP_TRIGGER, '1');
    globalTriggerInstalable = true;

    // Red de seguridad: recoge los escaneos que se perdieron por lock ocupado.
    ScriptApp.getProjectTriggers().forEach(t => {
        if (t.getHandlerFunction() === 'actualizadorAutomaticoGlobal') ScriptApp.deleteTrigger(t);
    });
    ScriptApp.newTrigger('actualizadorAutomaticoGlobal').timeBased().everyMinutes(5).create();

    ss.toast('✅ Trigger avanzado activo (6 min de límite y usuario en el historial) + repaso automático cada 5 min.', 'Listo', 8);
}

function desinstalarTriggerAvanzado() {
    const ss = obtenerArchivo();
    ScriptApp.getProjectTriggers().forEach(t => {
        if (t.getHandlerFunction() === 'alEditar' ||
            t.getHandlerFunction() === 'actualizadorAutomaticoGlobal') ScriptApp.deleteTrigger(t);
    });
    PropertiesService.getScriptProperties().deleteProperty(PROP_TRIGGER);
    globalTriggerInstalable = false;
    ss.toast('↩️ Se volvió al trigger simple.', 'Listo', 6);
}

// =========================================================================
// MOTOR PRINCIPAL DE EDICIÓN
// =========================================================================
function procesarEdicion(e) {
  if (!e || !e.source) return;

  const hoja = e.source.getActiveSheet();
  const celda = e.range;
  const colInicial = celda.getColumn();
  const filaInicial = celda.getRow();
  const numRows = celda.getNumRows();
  const numCols = celda.getNumColumns();
  const nombreHoja = claveHoja(hoja.getName());

  // Descartes baratos ANTES de pedir el lock: así los escaneos no compiten
  // con ediciones irrelevantes.
  const colsValidas = [1, 4, 14, 15, 17];
  let tocaValida = false;
  for (let c = 0; c < numCols; c++) {
      if (colsValidas.indexOf(colInicial + c) !== -1) tocaValida = true;
  }
  const tocaMacho = (nombreHoja === HOJA_MACHO && colInicial <= 13 && (colInicial + numCols - 1) >= 13);
  if (!tocaValida && !tocaMacho) return;
  if (esHojaSistema(nombreHoja) && !tocaMacho) return;

  const lock = LockService.getDocumentLock();
  if (!intentarLock(lock)) {
      // No se pudo entrar. Dejamos marca visible en vez de perder el escaneo
      // en silencio: el operador ve que esa fila no quedó validada.
      marcarPendiente(hoja, filaInicial, numRows, colInicial, numCols);
      return;
  }

  try {
    // =====================================================================
    // SINCRONIZACIÓN MAESTRA DE HOJA "MACHO" (columna M)
    // =====================================================================
    if (tocaMacho) {
        sincronizarMacho(hoja, e.source);
        e.source.toast('✅ Columna M sincronizada en todas las pestañas', 'Sincronización MACHO', 4);
        if (numCols === 1 && colInicial === 13) return;
    }
    if (!tocaValida) return;

    let valoresEditados = celda.getValues();
    let huboCambiosRelevantes = false;
    let esModoInventario = esHojaInventario(nombreHoja);

    // LECTURA DE CACHÉ SÚPER RÁPIDA (RAM)
    let cacheInfo = getCacheData(e.source);

    let batchUpdates = [];
    let filasHistorial = [];
    let hayCostales = false;

    const tocaColA = (colInicial <= 1 && colInicial + numCols - 1 >= 1);
    const tocaColO = (colInicial <= 15 && colInicial + numCols - 1 >= 15);

    // Lecturas de apoyo en bloque (una sola llamada cada una), nunca dentro del bucle.
    // Una sola lectura para las tres columnas de apoyo (B=2, L=12, P=16) en
    // vez de tres llamadas. En este archivo cada ida y vuelta a la API cuesta
    // cientos de milisegundos, así que lo que importa es el NÚMERO de llamadas,
    // no cuántas celdas trae cada una.
    let anchoHoja = hoja.getMaxColumns();
    let colFinApoyo = (tocaColO && anchoHoja >= 16) ? 16 : 12;
    let apoyo = (tocaColA || (tocaColO && anchoHoja >= 16))
        ? hoja.getRange(filaInicial, 2, numRows, colFinApoyo - 1).getValues() : null;
    // Índices dentro de `apoyo`: col 2 -> 0, col 12 -> 10, col 16 -> 14.
    let valsEstadoB = apoyo;                      // [r][0]
    let valsC12     = apoyo;                      // [r][10]
    let valsEstadoP = (colFinApoyo === 16) ? apoyo : null;   // [r][14]

    for (let r = 0; r < numRows; r++) {
        for (let c = 0; c < numCols; c++) {
            let filaActual = filaInicial + r;
            let colActual = colInicial + c;

            if (colsValidas.indexOf(colActual) === -1 || filaActual < 1) continue;

            let valRaw = valoresEditados[r][c];
            let valorIngresado = typeof valRaw === 'string' ? valRaw.trim().toUpperCase() : String(valRaw);

            // -------- DETECTAR BORRADOS --------
            if (valorIngresado === "" && (colActual === 1 || colActual === 15)) {
                let valorAnteriorEstado = "";
                if (colActual === 1 && valsEstadoB) valorAnteriorEstado = String(valsEstadoB[r][0]).trim();
                else if (colActual === 15 && valsEstadoP) valorAnteriorEstado = String(valsEstadoP[r][14]).trim();

                // Valor previo: e.oldValue lo trae gratis en ediciones de una sola celda;
                // si no, lo sacamos del caché.
                let valorBorrado = "";
                if (numRows === 1 && numCols === 1 && e.oldValue !== undefined && e.oldValue !== null) {
                    valorBorrado = String(e.oldValue).trim();
                }
                if (valorBorrado === "" && cacheInfo && cacheInfo.headers) {
                    let sufijo = (colActual === 1) ? "_FISICO" : "_PREFORMA";
                    let idx = cacheInfo.headers.indexOf(nombreHoja + sufijo);
                    if (idx !== -1 && cacheInfo.data.length > filaActual) {
                        valorBorrado = String(cacheInfo.data[filaActual][idx]).trim();
                    }
                }

                if (valorBorrado !== "") {
                    let tipoCol = (colActual === 1) ? "Físico (Col A)" : "Preforma (Col O)";
                    filasHistorial.push(eventoHistorial(nombreHoja, filaActual, tipoCol, valorBorrado,
                                                      valorAnteriorEstado, "BORRADO MANUAL (Celda vaciada)"));
                }
            }

            // Un vaciado de A u O SÍ es un cambio relevante: hay que purgar el
            // caché y recalcular la hoja. (Antes se salía por el continue y el
            // dato borrado seguía vivo en memoria.)
            if (valorIngresado === "") {
                if (colActual === 1 || colActual === 15) huboCambiosRelevantes = true;
                if (colActual !== 14) continue;
            }
            huboCambiosRelevantes = true;

            if (colActual === 1 || colActual === 15) {
                let clean = valorIngresado.replace(/[^A-Z0-9]/g, '');
                if (valorIngresado !== clean) {
                    batchUpdates.push({row: filaActual, col: colActual, val: clean});
                    valorIngresado = clean;
                    valoresEditados[r][c] = clean;
                }
            }

            // Errores estructurales (pedimento incompleto) acumulados para escribir en bloque.
            if ((colActual === 1 || colActual === 15) && /^\d{1,6}$/.test(valorIngresado)) {
                let colEstado = (colActual === 1) ? 2 : 16;
                let colHora = (colActual === 1) ? 12 : 19;
                let faltantes = 7 - valorIngresado.length;
                let textoNum = faltantes === 1 ? "número" : "números";

                batchUpdates.push({row: filaActual, col: colEstado, val: "🛑 ERROR: Faltan " + faltantes + " " + textoNum, bg: "#ffc107"});
                batchUpdates.push({row: filaActual, col: colHora, clear: true});
                continue;
            }

            // Duplicados: búsqueda O(1) en el índice en RAM.
            if (colActual === 1 && valorIngresado !== "COSTALES") {
                let duplicadoInfo = verificarDuplicadoConCache(cacheInfo, nombreHoja, valorIngresado, filaActual);

                if (duplicadoInfo.encontrado) {
                    batchUpdates.push({row: filaActual, col: 2, val: "⛔ DUPLICADO (En: " + duplicadoInfo.ubicacion + ")", bg: "#ff9800"});
                    let horaActual = valsC12 ? valsC12[r][10] : "";
                    if (!horaActual) {
                        batchUpdates.push({row: filaActual, col: 12, val: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "HH:mm:ss")});
                    }
                    continue;
                }
            }

            if (colActual === 4 && valorIngresado === "COSTALES") {
                if (procesarCostales(hoja, filaActual)) hayCostales = true;
            }
        }
    }

    // -------- ESCRITURAS EN LOTE --------
    aplicarBatchUpdates(hoja, batchUpdates, filaInicial, numRows);
    registrarEnHistorialLote(e.source, filasHistorial);

    if (!huboCambiosRelevantes) return;

    // procesarCostales escribe directo en la columna A, así que el bloque
    // editado ya no describe la hoja: hay que re-fotografiarla entera.
    if (hayCostales) {
        actualizarFotografiaMental(hoja, e.source);
        invalidarCacheRAM();
        cacheInfo = getCacheData(e.source);
        recalcularHoja(hoja, e.source, cacheInfo, null);
        return;
    }

    // El caché se actualiza ANTES de recalcular: así los recálculos ven la
    // realidad y pueden reevaluar duplicados desde cero.
    let guiasAfectadas = actualizarBloqueEnCache(e.source, nombreHoja, filaInicial, numRows,
                                                 colInicial, numCols, valoresEditados);
    if (guiasAfectadas === null) {
        // Hubo que reconstruir la fotografía de la hoja: recargamos el caché.
        cacheInfo = getCacheData(e.source);
    }

    let tocoPreforma = tocaColO || (colInicial <= 14 && colInicial + numCols - 1 >= 14);
    recalcularHoja(hoja, e.source, cacheInfo, guiasAfectadas, tocoPreforma);

    if (esModoInventario) {
        sincronizarInventariosAfectados(e.source, cacheInfo, guiasAfectadas, nombreHoja);
    }

  } finally {
    lock.releaseLock();
  }
}

function intentarLock(lock) {
    try {
        lock.waitLock(10000);
        return true;
    } catch (err) {
        return false;
    }
}

const TXT_PENDIENTE = "⏳ Pendiente (reintenta)";

// Estado de una guía de M-S que ya salió en una unidad. Se reconoce también el
// texto antiguo ("➡ Movido a ...") para que las hojas ya escritas se migren
// solas en la siguiente pasada en vez de dejar de reconocerse.
const TXT_SALIO = "➡ Salió en ";
function esEstadoSalida(txt) {
    let t = String(txt).trim();
    return t.startsWith(TXT_SALIO) || t.toUpperCase().startsWith("➡ MOVIDO A");
}

// Una fila está sin validar si tiene dato pero no estado, o si quedó marcada
// como pendiente porque el lock estaba ocupado. Lo segundo importa: si solo se
// mirara "estado vacío", las filas que marcamos como pendientes serían
// precisamente las que la red de seguridad dejaría de recoger.
function filaSinValidar(valDato, valEstado) {
    let d = String(valDato).trim();
    if (d === "") return false;
    let e = String(valEstado).trim();
    return e === "" || e === TXT_PENDIENTE;
}

function marcarPendiente(hoja, filaInicial, numRows, colInicial, numCols) {
    try {
        if (colInicial > 1 || colInicial + numCols - 1 < 1) return;
        let rango = hoja.getRange(filaInicial, 2, numRows, 1);
        let vals = rango.getValues();
        let cambio = false;
        for (let r = 0; r < numRows; r++) {
            if (String(vals[r][0]).trim() === "") { vals[r][0] = TXT_PENDIENTE; cambio = true; }
        }
        if (cambio) rango.setValues(vals);
    } catch (err) {
        // Si ni esto se puede escribir, el trigger por tiempo lo recogerá después.
    }
}

function aplicarBatchUpdates(hoja, batchUpdates, minRow, rowCount) {
    if (!batchUpdates || batchUpdates.length === 0) return;
    [1, 2, 12, 15, 16, 19].forEach(col => {
        let updates = batchUpdates.filter(u => u.col === col);
        if (updates.length === 0) return;
        if (hoja.getMaxColumns() < col) return;

        let range = hoja.getRange(minRow, col, rowCount, 1);
        let vals = range.getValues();
        let bgs = updates.some(u => u.bg) ? range.getBackgrounds() : null;

        updates.forEach(u => {
            let idx = u.row - minRow;
            if (idx < 0 || idx >= rowCount) return;
            if (u.clear) vals[idx][0] = "";
            else if (u.val !== undefined) vals[idx][0] = u.val;
            if (u.bg && bgs) bgs[idx][0] = u.bg;
        });

        range.setValues(vals);
        if (bgs) range.setBackgrounds(bgs);
    });
}

// `tocoPreforma`: si es false, no se recalculan los colores de la columna O.
// Un escaneo normal (columna A) no puede cambiarlos, y comprobarlos cuesta una
// lectura de columna completa. Los menús pasan true para repintado total.
function recalcularHoja(hoja, source, cacheInfo, guiasAfectadas, tocoPreforma, repintarTodo) {
    if (tocoPreforma === undefined) tocoPreforma = true;
    let n = perf("nombre de la hoja", 0, () => claveHoja(hoja.getName()));
    if (esHojaInventario(n)) actualizarInventario(hoja, cacheInfo, repintarTodo);
    else if (esHojaMS(n)) actualizarMS(hoja, source, cacheInfo, repintarTodo);
    else if (esHojaPrincipal(n)) actualizarGlobalPreforma(hoja, source, cacheInfo, guiasAfectadas, tocoPreforma, repintarTodo);
}

// =========================================================================
// SISTEMA DE LECTURA DE CACHÉ (soporta múltiples ubicaciones por guía)
// =========================================================================
function getCacheData(source) {
    if (globalCacheData && globalCacheMap) return { data: globalCacheData, headers: globalCacheHeaders, map: globalCacheMap };

    let cacheSheet = source.getSheetByName("CACHE_SISTEMA");
    if (!cacheSheet) return null;

    let lr = cacheSheet.getLastRow();
    let lc = cacheSheet.getLastColumn();
    if (lr < 1 || lc < 1) return null;

    let fullData = cacheSheet.getRange(1, 1, lr, lc).getValues();
    globalCacheHeaders = fullData[0];
    globalCacheData = fullData;

    globalCacheMap = new Map();
    for (let c = 0; c < globalCacheHeaders.length; c++) {
        let header = String(globalCacheHeaders[c]);
        if (!header.endsWith("_FISICO")) continue;

        let hojaHeader = claveHoja(header.replace("_FISICO", ""));
        let isMSHeader = esHojaMS(hojaHeader);
        let isInventarioHeader = esHojaInventario(hojaHeader);

        for (let r = 1; r < globalCacheData.length; r++) {
            let v = String(globalCacheData[r][c]).trim().toUpperCase();
            if (v === "" || esMarcadorEstructural(v)) continue;
            let arr = globalCacheMap.get(v) || [];
            arr.push({ hoja: hojaHeader, fila: r, isMS: isMSHeader, isInventario: isInventarioHeader });
            globalCacheMap.set(v, arr);
        }
    }

    return { data: globalCacheData, headers: globalCacheHeaders, map: globalCacheMap };
}

// Índice: clave de hoja -> columna de su _FISICO dentro del caché.
function mapaColumnasFisico(cacheInfo) {
    let m = new Map();
    if (!cacheInfo || !cacheInfo.headers) return m;
    for (let c = 0; c < cacheInfo.headers.length; c++) {
        let header = String(cacheInfo.headers[c]);
        if (header.endsWith("_FISICO")) m.set(claveHoja(header.replace("_FISICO", "")), c);
    }
    return m;
}

// Última fila con dato en la columna A de una hoja, sacada del caché en vez de
// preguntársela a Sheets.
//
// getLastRow() resultó ser, con diferencia, la llamada más cara de todo el
// escaneo: 128-409 ms cada una, contra los ~48 ms de una llamada normal. En el
// barrido de M-S se pagaba una por pestaña, y solo eso eran 641 ms de un
// recálculo de 1,690 ms (y 2,044 ms del barrido completo).
//
// El caché mantiene la columna A de cada hoja en su columna _FISICO, con la
// fila del caché igual a la fila de la hoja, así que la respuesta ya está en
// memoria. Devuelve -1 si esa hoja no está indexada, para poder caer de vuelta
// en getLastRow().
function ultimaFilaEnCache(cacheInfo, colIdx) {
    if (!cacheInfo || !cacheInfo.data || colIdx === undefined || colIdx === null || colIdx < 0) return -1;
    for (let r = cacheInfo.data.length - 1; r >= 1; r--) {
        if (String(cacheInfo.data[r][colIdx]).trim() !== "") return r;
    }
    return 0;
}

// Claves de las pestañas M-S que contienen alguna de las guías tocadas, sacadas
// del índice del caché sin abrir una sola pestaña.
//
// Antes el barrido recorría TODAS las pestañas del archivo llamando a getName()
// en cada una para saber cuáles eran M-S: una llamada a la API por pestaña, en
// cada escaneo, para acabar abriendo casi siempre una sola.
function hojasMSConGuias(cacheInfo, guias) {
    let out = new Set();
    if (!cacheInfo || !cacheInfo.map || !guias) return out;
    guias.forEach(g => {
        let entradas = cacheInfo.map.get(String(g).trim().toUpperCase());
        if (!entradas) return;
        entradas.forEach(e => { if (e.isMS) out.add(e.hoja); });
    });
    return out;
}

function hojaContieneAlgunaGuia(cacheInfo, colIdx, guias) {
    if (colIdx === undefined || !guias || guias.size === 0) return false;
    for (let r = 1; r < cacheInfo.data.length; r++) {
        let v = String(cacheInfo.data[r][colIdx]).trim().toUpperCase();
        if (v !== "" && guias.has(v)) return true;
    }
    return false;
}

// -------------------------------------------------------------------------
// AISLAMIENTO DE DOMINIOS
//   INVENTARIO -> solo choca con INVENTARIO (incluida otra ubicación IW de la
//                 misma pestaña: por eso NO se descarta la hoja actual, solo
//                 la fila exacta).
//   BODEGA     -> solo choca con otras BODEGAS.
//   GLOBAL     -> solo choca con otras GLOBALES/REZAGO/AGA.
// -------------------------------------------------------------------------
function verificarDuplicadoConCache(cacheInfo, nombreHojaActual, guiaBuscada, filaActual) {
    if (!cacheInfo || !cacheInfo.map) return { encontrado: false };

    let clave = claveHoja(nombreHojaActual);
    let isCurrentMS = esHojaMS(clave);
    let isCurrentInv = esHojaInventario(clave);
    let matches = cacheInfo.map.get(guiaBuscada);
    if (!matches) return { encontrado: false };

    for (let i = 0; i < matches.length; i++) {
        let match = matches[i];

        if (isCurrentInv) {
            if (match.hoja === clave && match.fila === filaActual) continue;
            if (!match.isInventario) continue;
            let ubic = (match.hoja === clave)
                ? "esta hoja, fila " + match.fila
                : match.hoja + " Fila " + match.fila;
            return { encontrado: true, ubicacion: ubic };
        }

        if (match.hoja === clave) continue;

        if (isCurrentMS) {
            if (match.isMS) return { encontrado: true, ubicacion: match.hoja + " Fila " + match.fila };
        } else {
            if (!match.isMS && !match.isInventario) {
                return { encontrado: true, ubicacion: match.hoja + " Fila " + match.fila };
            }
        }
    }

    return { encontrado: false };
}

// Recalcula desde cero los duplicados externos de una hoja completa.
// Antes el texto "⛔ DUPLICADO" se conservaba tal cual y nunca se limpiaba
// aunque el original se hubiera borrado; ahora se reevalúa en cada pasada.
// Devuelve Map: índice de fila (0-based) -> match del caché.
function calcularDuplicadosExternos(datosMasivos, ultimaFila, claveEsta, cacheInfo) {
    let res = new Map();
    if (!cacheInfo || !cacheInfo.map) return res;

    let esInv = esHojaInventario(claveEsta);
    let esMS = esHojaMS(claveEsta);

    for (let i = 0; i < ultimaFila; i++) {
        let v = String(datosMasivos[i][0]).trim().toUpperCase();
        if (v === "" || v.startsWith("IW") || esCabeceraBloque(v)) continue;

        let matches = cacheInfo.map.get(v);
        if (!matches) continue;

        for (let m = 0; m < matches.length; m++) {
            let match = matches[m];
            if (match.hoja === claveEsta && match.fila === i) continue;

            if (esInv) {
                if (!match.isInventario) continue;   // inventario ignora Global y Bodegas
            } else if (esMS) {
                if (!match.isMS || match.hoja === claveEsta) continue;
            } else {
                if (match.isMS || match.isInventario || match.hoja === claveEsta) continue;
            }

            res.set(i, match);
            break;
        }
    }
    return res;
}

// =========================================================================
// ESCRITURA EN CACHÉ (RAM + hoja) CON LIMPIEZA DE BORRADOS
// Devuelve un Set con las guías tocadas (valores nuevos y antiguos), o null
// si hubo que reconstruir la fotografía completa de la hoja.
// =========================================================================
function actualizarBloqueEnCache(source, nombreHoja, filaInicial, numRows, colInicial, numCols, valoresEditados) {
    let clave = claveHoja(nombreHoja);
    let cacheSheet = source.getSheetByName("CACHE_SISTEMA");
    let hojaObjetivo = buscarHojaPorClave(source, clave);

    if (!cacheSheet) {
        if (hojaObjetivo) actualizarFotografiaMental(hojaObjetivo, source);
        invalidarCacheRAM();
        return null;
    }

    // Headers desde RAM cuando ya están cargados: evita 2 llamadas por escaneo.
    let headers = globalCacheHeaders;
    if (!headers) {
        let maxCols = Math.max(cacheSheet.getLastColumn(), 1);
        headers = cacheSheet.getRange(1, 1, 1, maxCols).getValues()[0];
    }

    if (headers.indexOf(clave + "_FISICO") === -1) {
        if (hojaObjetivo) actualizarFotografiaMental(hojaObjetivo, source);
        invalidarCacheRAM();
        return null;
    }

    let isMSActual = esHojaMS(clave);
    let isInventarioActual = esHojaInventario(clave);
    let guiasAfectadas = new Set();

    // La hoja de caché también tiene que crecer, no solo el array en RAM.
    asegurarFilas(cacheSheet, filaInicial + numRows + 1);

    if (globalCacheData) {
        while (globalCacheData.length <= filaInicial + numRows) {
            globalCacheData.push(new Array(headers.length).fill(""));
        }
    }

    if (colInicial <= 1 && colInicial + numCols - 1 >= 1) {
        let idxData = 1 - colInicial;
        let colIdx = headers.indexOf(clave + "_FISICO");
        if (colIdx >= 0) {
            let valsToSet = [];
            for (let r = 0; r < numRows; r++) {
                let val = valoresEditados[r][idxData];
                valsToSet.push([val]);

                if (!globalCacheData) continue;

                let oldStr = String(globalCacheData[filaInicial + r][colIdx]).trim().toUpperCase();
                let vStr = String(val).trim().toUpperCase();
                globalCacheData[filaInicial + r][colIdx] = val;

                if (oldStr !== "") guiasAfectadas.add(oldStr);
                if (vStr !== "") guiasAfectadas.add(vStr);

                if (!globalCacheMap) continue;

                // 1. Purga el rastro viejo (esto es lo que hace que un borrado
                //    deje de contar como duplicado al instante).
                if (oldStr !== "" && oldStr !== vStr) {
                    let arr = globalCacheMap.get(oldStr);
                    if (arr) {
                        let newArr = arr.filter(m => !(m.hoja === clave && m.fila === filaInicial + r));
                        if (newArr.length === 0) globalCacheMap.delete(oldStr);
                        else globalCacheMap.set(oldStr, newArr);
                    }
                }
                // 2. Registra el dato nuevo.
                if (vStr !== "") {
                    let arr = globalCacheMap.get(vStr) || [];
                    if (!arr.some(m => m.hoja === clave && m.fila === filaInicial + r)) {
                        arr.push({ hoja: clave, fila: filaInicial + r, isMS: isMSActual, isInventario: isInventarioActual });
                        globalCacheMap.set(vStr, arr);
                    }
                }
            }
            cacheSheet.getRange(filaInicial + 1, colIdx + 1, numRows, 1).setValues(valsToSet);
        }
    }

    if (colInicial <= 15 && colInicial + numCols - 1 >= 15) {
        let idxData = 15 - colInicial;
        let colIdx = headers.indexOf(clave + "_PREFORMA");
        if (colIdx >= 0) {
            let valsToSet = [];
            for (let r = 0; r < numRows; r++) {
                let val = valoresEditados[r][idxData];
                valsToSet.push([val]);
                if (globalCacheData) globalCacheData[filaInicial + r][colIdx] = val;
            }
            cacheSheet.getRange(filaInicial + 1, colIdx + 1, numRows, 1).setValues(valsToSet);
        }
    }

    return guiasAfectadas;
}

function buscarHojaPorClave(source, clave) {
    let objetivo = claveHoja(clave);
    let hojas = source.getSheets();
    for (let i = 0; i < hojas.length; i++) {
        if (claveHoja(hojas[i].getName()) === objetivo) return hojas[i];
    }
    return null;
}

// Las bodegas (M-S ...) no llevan preforma: su columna O siempre está vacía.
// No tiene sentido reservarles columna en el caché ni leerla en cada foto.
function usaPreforma(nombreHoja) {
    return !esHojaMS(nombreHoja);
}

// Devuelve la columna (1-based) del header, creándola al final si no existe.
function columnaDeHeader(cacheSheet, headers, titulo) {
    let idx = headers.indexOf(titulo);
    if (idx !== -1) return idx + 1;

    let col = headers.filter(String).length + 1;
    if (col > cacheSheet.getMaxColumns()) {
        cacheSheet.insertColumnsAfter(cacheSheet.getMaxColumns(), 2);
    }
    cacheSheet.getRange(1, col).setValue(titulo);
    headers[col - 1] = titulo;
    return col;
}

function actualizarFotografiaMental(hoja, source) {
    let clave = claveHoja(hoja.getName());
    if (esHojaSistema(clave)) return;

    let cacheSheet = source.getSheetByName("CACHE_SISTEMA");
    if (!cacheSheet) {
        cacheSheet = source.insertSheet("CACHE_SISTEMA");
        cacheSheet.hideSheet();
    }

    let lr = Math.max(hoja.getLastRow(), 1);
    asegurarFilas(cacheSheet, lr + 1);

    let maxCols = Math.max(cacheSheet.getLastColumn(), 1);
    let headers = cacheSheet.getRange(1, 1, 1, maxCols).getValues()[0];

    // Las columnas se reservan por separado, no en pares: así una bodega ocupa
    // una sola columna en vez de dos, una de ellas siempre vacía.
    let conPreforma = usaPreforma(clave);
    let colFisico = columnaDeHeader(cacheSheet, headers, clave + "_FISICO");
    let colPreforma = conPreforma ? columnaDeHeader(cacheSheet, headers, clave + "_PREFORMA") : -1;

    let maxFilasCache = cacheSheet.getMaxRows();
    if (maxFilasCache > 1) {
        cacheSheet.getRange(2, colFisico, maxFilasCache - 1, 1).clearContent();
        if (colPreforma !== -1) cacheSheet.getRange(2, colPreforma, maxFilasCache - 1, 1).clearContent();
    }

    cacheSheet.getRange(2, colFisico, lr, 1).setValues(hoja.getRange(1, 1, lr, 1).getValues());

    if (colPreforma !== -1 && hoja.getMaxColumns() >= 15) {
        cacheSheet.getRange(2, colPreforma, lr, 1).setValues(hoja.getRange(1, 15, lr, 1).getValues());
    }
}

// Elimina del caché las columnas de hojas que ya no existen (renombradas o
// borradas). Sin esto, una pestaña eliminada seguía generando duplicados
// fantasma para siempre.
function podarCacheHuerfano(source) {
    let cacheSheet = source.getSheetByName("CACHE_SISTEMA");
    if (!cacheSheet) return 0;

    let lc = cacheSheet.getLastColumn();
    if (lc < 1) return 0;

    let headers = cacheSheet.getRange(1, 1, 1, lc).getValues()[0];
    let existentes = new Set(source.getSheets().map(h => claveHoja(h.getName())));

    let aBorrar = [];
    for (let i = 0; i < headers.length; i++) {
        let h = String(headers[i]);
        if (h === "") continue;
        let nombre = claveHoja(h.replace("_FISICO", "").replace("_PREFORMA", ""));

        // Pestaña renombrada o borrada.
        if (!existentes.has(nombre)) { aBorrar.push(i + 1); continue; }
        // Columna de preforma de una bodega: siempre vacía, no se usa.
        if (h.endsWith("_PREFORMA") && !usaPreforma(nombre)) aBorrar.push(i + 1);
    }

    // De derecha a izquierda para que los índices no se muevan.
    aBorrar.sort((a, b) => b - a).forEach(col => cacheSheet.deleteColumn(col));
    return aBorrar.length;
}

// =========================================================================
// HISTORIAL AUDITADO (en lote, con usuario)
// =========================================================================
// Orden por defecto al crear la hoja desde cero. Si la hoja YA existe, se
// respeta el orden de sus encabezados: el historial es un registro de auditoría
// y reordenar sus columnas invalidaría lo ya registrado.
const HIST_ORDEN_DEFECTO = ["FECHA", "USUARIO", "PESTAÑA", "FILA", "COLUMNA", "VALOR", "ESTADO", "MOTIVO"];

const HIST_TITULOS = {
    FECHA:   "FECHA Y HORA",
    USUARIO: "USUARIO",
    "PESTAÑA": "PESTAÑA",
    FILA:    "FILA",
    COLUMNA: "COLUMNA",
    VALOR:   "GUÍA/PEDIMENTO BORRADO",
    ESTADO:  "ESTADO ANTERIOR",
    MOTIVO:  "MOTIVO"
};

// Sinónimos aceptados al leer los encabezados existentes (sin acentos y en
// mayúsculas), para reconocer la columna aunque el título varíe.
const HIST_SINONIMOS = {
    "FECHA Y HORA": "FECHA", "FECHA": "FECHA", "FECHA/HORA": "FECHA",
    "USUARIO": "USUARIO", "EMAIL": "USUARIO", "CORREO": "USUARIO",
    "PESTANA": "PESTAÑA", "HOJA": "PESTAÑA",
    "FILA": "FILA",
    "COLUMNA": "COLUMNA",
    "GUIA/PEDIMENTO BORRADO": "VALOR", "GUIA": "VALOR", "VALOR": "VALOR",
    "VALOR BORRADO": "VALOR", "GUIA BORRADA": "VALOR",
    "ESTADO ANTERIOR": "ESTADO", "ESTADO": "ESTADO",
    "MOTIVO": "MOTIVO"
};

function normalizarTitulo(t) {
    return String(t).trim().toUpperCase()
        .replace(/Á/g, "A").replace(/É/g, "E").replace(/Í/g, "I")
        .replace(/Ó/g, "O").replace(/Ú/g, "U").replace(/Ñ/g, "N");
}

function eventoHistorial(hojaAfectada, fila, columnaStr, valorBorrado, estadoAnterior, motivo) {
    return {
        FECHA:   Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "dd/MM/yyyy HH:mm:ss"),
        USUARIO: obtenerUsuarioActual(),
        "PESTAÑA": hojaAfectada,
        FILA:    fila,
        COLUMNA: columnaStr,
        VALOR:   valorBorrado,
        ESTADO:  estadoAnterior,
        MOTIVO:  motivo
    };
}

function registrarEnHistorialLote(source, eventos) {
    if (!eventos || eventos.length === 0) return;

    let hojaHistorial = source.getSheetByName("HISTORIAL_BORRADOS");
    let orden;

    if (!hojaHistorial) {
        hojaHistorial = source.insertSheet("HISTORIAL_BORRADOS");
        orden = HIST_ORDEN_DEFECTO.slice();
        hojaHistorial.getRange(1, 1, 1, orden.length).setValues([orden.map(k => HIST_TITULOS[k])]);
        hojaHistorial.getRange(1, 1, 1, orden.length).setFontWeight("bold").setBackground("#d9d9d9");
        hojaHistorial.setFrozenRows(1);
    } else {
        // Se lee el layout real de la hoja en vez de asumir uno.
        let ancho = Math.max(hojaHistorial.getLastColumn(), 1);
        let titulos = hojaHistorial.getRange(1, 1, 1, ancho).getValues()[0];
        orden = titulos.map(t => HIST_SINONIMOS[normalizarTitulo(t)] || null);

        // Campos que la hoja todavía no tiene: se añaden al final.
        let faltantes = HIST_ORDEN_DEFECTO.filter(k => orden.indexOf(k) === -1);
        if (faltantes.length > 0) {
            asegurarColumnas(hojaHistorial, ancho + faltantes.length);
            hojaHistorial.getRange(1, ancho + 1, 1, faltantes.length)
                .setValues([faltantes.map(k => HIST_TITULOS[k])])
                .setFontWeight("bold").setBackground("#d9d9d9");
            orden = orden.concat(faltantes);
        }
    }

    let filas = eventos.map(ev => orden.map(k => (k === null ? "" : ev[k])));

    let inicio = hojaHistorial.getLastRow() + 1;
    asegurarFilas(hojaHistorial, inicio + filas.length);
    hojaHistorial.getRange(inicio, 1, filas.length, orden.length).setValues(filas);
}

// =========================================================================
// SINCRONIZACIÓN MACHO
// =========================================================================
function sincronizarMacho(hojaMacho, source) {
    let ultimaFila = hojaMacho.getLastRow();
    let valoresMacho = [];
    if (ultimaFila > 0) valoresMacho = hojaMacho.getRange(1, 13, ultimaFila, 1).getValues();

    let hojas = source.getSheets();
    for (let i = 0; i < hojas.length; i++) {
        let hojaDestino = hojas[i];
        let n = claveHoja(hojaDestino.getName());

        // La propia MACHO es el origen, no destino.
        if (n === HOJA_MACHO) continue;
        // CACHE_SISTEMA e HISTORIAL_BORRADOS quedan fuera: la columna M de
        // CACHE_SISTEMA es una columna de caché, no la lista FEMAD.
        if (esHojaInterna(n)) continue;
        // Las plantillas de inventario SÍ la reciben, para que sus copias
        // nazcan con la validación y los colores ya puestos.

        let maxRows = hojaDestino.getMaxRows();
        if (maxRows > 0) hojaDestino.getRange(1, 13, maxRows, 1).clearContent();
        if (valoresMacho.length > 0) {
            if (maxRows < valoresMacho.length) hojaDestino.insertRowsAfter(maxRows, valoresMacho.length - maxRows);
            hojaDestino.getRange(1, 13, valoresMacho.length, 1).setValues(valoresMacho);
        }
    }
}

// =========================================================================
// VALIDACIÓN DE GUÍAS
// =========================================================================
function esGuiaUPSValida(guia) {
  let g = String(guia).trim().toUpperCase();
  if (g === "" || /^\d{7}$/.test(g)) return false;
  if (esMarcadorEstructural(g)) return false;
  if (g.startsWith("1Z")) {
      if (g.length !== 18) return false;
      const mapa = { 'A':2, 'B':3, 'C':4, 'D':5, 'E':6, 'F':7, 'G':8, 'H':9, 'I':0, 'J':1, 'K':2, 'L':3, 'M':4, 'N':5, 'O':6, 'P':7, 'Q':8, 'R':9, 'S':0, 'T':1, 'U':2, 'V':3, 'W':4, 'X':5, 'Y':6, 'Z':7 };
      let numStr = g.substring(2, 17); let checkDigitReal = parseInt(g.substring(17), 10);
      if (isNaN(checkDigitReal)) return false;
      let sumaImpares = 0; let sumaPares = 0;
      for (let i = 0; i < 15; i++) {
        let c = numStr.charAt(i); let val = (c >= '0' && c <= '9') ? parseInt(c, 10) : mapa[c];
        if (val === undefined || isNaN(val)) return false;
        if (i % 2 === 0) sumaImpares += val; else sumaPares += val;
      }
      return ((10 - ((sumaImpares + (sumaPares * 2)) % 10)) % 10) === checkDigitReal;
  }
  if (g.length > 7) return true;
  return false;
}

// Fixture de regresión: correr desde el editor tras tocar esGuiaUPSValida.
function TEST_guias() {
  const casos = [
    ["1Z999AA10123456784", true],   // ejemplo canónico de UPS
    ["1Z999AA10123456785", false],  // dígito verificador alterado
    ["1Z999AA1012345678",  false],  // longitud incorrecta
    ["6098234",            false],  // pedimento, no guía
    ["609823",             false],  // pedimento incompleto
    ["",                   false]
  ];
  let fallos = [];
  casos.forEach(c => { if (esGuiaUPSValida(c[0]) !== c[1]) fallos.push(c[0] + " → esperado " + c[1]); });
  Logger.log(fallos.length === 0 ? "✅ TEST_guias OK (" + casos.length + " casos)" : "❌ " + fallos.join(" | "));
  return fallos;
}

// =========================================================================
// PRE-PROCESAMIENTO DESDE CACHÉ
// =========================================================================
function obtenerGuiasRezagoDesdeCache(cacheInfo) {
    let guias = new Map();
    if (!cacheInfo || !cacheInfo.headers) return guias;

    for (let c = 0; c < cacheInfo.headers.length; c++) {
        let header = String(cacheInfo.headers[c]);
        if (!header.endsWith("_PREFORMA")) continue;

        let nombreHoja = claveHoja(header.replace("_PREFORMA", ""));
        if (nombreHoja.indexOf("REZAGO") === -1) continue;

        let pedActual = "";
        for (let r = 1; r < cacheInfo.data.length; r++) {
            let v = String(cacheInfo.data[r][c]).trim().toUpperCase();
            if (/^\d{7}$/.test(v)) pedActual = v;
            else if (v !== "" && !esMarcadorEstructural(v)) guias.set(v, { hoja: nombreHoja, pedimento: pedActual });
        }
    }
    return guias;
}

function obtenerRegistroMSDesdeCache(cacheInfo, nombreHojaActual) {
    let guiasOrigen = new Map();
    let registroMS = new Map();
    if (!cacheInfo || !cacheInfo.headers) return { guiasOrigen: guiasOrigen, registroMS: registroMS };

    let claveActual = claveHoja(nombreHojaActual);

    for (let c = 0; c < cacheInfo.headers.length; c++) {
        let header = String(cacheInfo.headers[c]);
        if (!header.endsWith("_FISICO")) continue;

        let nombreHoja = claveHoja(header.replace("_FISICO", ""));
        if (!esHojaMS(nombreHoja) || nombreHoja === claveActual) continue;

        // El registro previo de CUALQUIER M-S alimenta a CUALQUIER destino:
        // la carga se separa a mano por tipo, así que no hace falta filtrar por
        // nombre. `origen` solo sirve para el texto "(Escaneado en …)".
        let origen = tipoMS(nombreHoja);

        let pedActual = "";
        for (let r = 1; r < cacheInfo.data.length; r++) {
            let v = String(cacheInfo.data[r][c]).trim().toUpperCase();
            if (/^\d{7}$/.test(v)) {
                pedActual = v;
                if (!registroMS.has(pedActual)) registroMS.set(pedActual, new Set());
            } else if (v !== "" && !esMarcadorEstructural(v)) {
                if (!guiasOrigen.has(v)) guiasOrigen.set(v, origen);
                if (pedActual !== "") registroMS.get(pedActual).add(v);
            }
        }
    }
    return { guiasOrigen: guiasOrigen, registroMS: registroMS };
}

// Marca en las bodegas las guías que ya fueron escaneadas en una hoja destino.
// `guiasAfectadas` acota el trabajo: si sabemos qué guías cambiaron, las bodegas
// que no las contienen no se tocan (cero llamadas a la API). Con null hace
// barrido completo (menú / trigger por tiempo).
function sincronizarSalidasMS(source, cacheInfo, guiasAfectadas) {
    if (!cacheInfo || !cacheInfo.headers) return;

    let escaneadosDestino = new Map();
    let colPorHoja = mapaColumnasFisico(cacheInfo);

    // Recorre el caché entero (todas las columnas de destino × todas las filas)
    // para saber qué guía salió en qué pestaña. Es puro cálculo, sin API.
    perf("(memoria) índice de salidas", 0, () => {
        for (let c = 0; c < cacheInfo.headers.length; c++) {
            let header = String(cacheInfo.headers[c]);
            if (!header.endsWith("_FISICO")) continue;

            let n = claveHoja(header.replace("_FISICO", ""));
            if (esHojaMS(n) || esHojaInventario(n) || esHojaSistema(n) || n.indexOf("REZAGO") !== -1) continue;

            for (let r = 1; r < cacheInfo.data.length; r++) {
                let v = String(cacheInfo.data[r][c]).trim().toUpperCase();
                if (v !== "" && !esCabeceraBloque(v)) escaneadosDestino.set(v, n);
            }
        }
    });

    // Qué pestañas M-S hay que abrir. En un escaneo el caché ya sabe cuáles
    // contienen la guía, así que se piden por nombre y no se toca ninguna otra.
    // El camino largo (recorrer todas las pestañas preguntando su nombre una
    // por una) solo queda para el barrido completo desde los menús.
    let objetivos = [];
    let porNombre = guiasAfectadas && guiasAfectadas.size > 0;

    if (porNombre) {
        let claves = hojasMSConGuias(cacheInfo, guiasAfectadas);
        if (claves.size === 0) return;   // ninguna M-S tiene esas guías
        claves.forEach(clave => {
            if (!porNombre) return;
            let h = perf("abrir M-S por nombre", 0, () => source.getSheetByName(clave));
            // El caché guarda el nombre normalizado; si la pestaña real está
            // escrita distinto, getSheetByName falla y hay que ir por el largo.
            if (h) objetivos.push({ hoja: h, clave: clave });
            else porNombre = false;
        });
    }

    if (!porNombre) {
        objetivos = [];
        let hojas = perf("listar pestañas", 0, () => source.getSheets());
        for (let i = 0; i < hojas.length; i++) {
            let h = hojas[i];
            let n = perf("nombre de pestaña", 0, () => claveHoja(h.getName()));
            if (!esHojaMS(n)) continue;
            if (guiasAfectadas && guiasAfectadas.size > 0 &&
                !hojaContieneAlgunaGuia(cacheInfo, colPorHoja.get(n), guiasAfectadas)) continue;
            objetivos.push({ hoja: h, clave: n });
        }
    }

    let msModificadas = [];

    for (let i = 0; i < objetivos.length; i++) {
        let hojaMS = objetivos[i].hoja;
        let nMS = objetivos[i].clave;

        // El caché sabe hasta dónde llega la columna A de esta M-S; solo se le
        // pregunta a Sheets si la pestaña todavía no está indexada.
        let lr = ultimaFilaEnCache(cacheInfo, colPorHoja.get(nMS));
        if (lr < 0) lr = perf("M-S: getLastRow (sin caché)", 0, () => hojaMS.getLastRow());
        if (lr < 1) continue;

        let rangoStatus = hojaMS.getRange(1, 1, lr, 2);
        let vals = perf("M-S: leer A:B", lr * 2, () => rangoStatus.getValues());
        let modificados = false;

        for (let r = 0; r < lr; r++) {
            let v = String(vals[r][0]).trim().toUpperCase();
            if (v === "" || esCabeceraBloque(v)) continue;

            let statusActual = String(vals[r][1]).trim();
            let destino = escaneadosDestino.get(v);

            if (destino) {
                let textoEsperado = TXT_SALIO + destino;
                if (statusActual !== textoEsperado) { vals[r][1] = textoEsperado; modificados = true; }
            } else if (esEstadoSalida(statusActual)) {
                vals[r][1] = ""; modificados = true;
            }
        }

        if (modificados) {
            perf("M-S: escribir A:B", lr * 2, () => rangoStatus.setValues(vals));
            msModificadas.push(hojaMS);
        }
    }

    msModificadas.forEach(hojaMS => actualizarMS(hojaMS, source, cacheInfo, false));
}

// Propaga un cambio al resto de pestañas de INVENTARIO. Solo se abren las que
// realmente contienen alguna de las guías tocadas.
function sincronizarInventariosAfectados(source, cacheInfo, guiasAfectadas, hojaOrigen) {
    if (!cacheInfo || !cacheInfo.headers) return;

    let claveOrigen = claveHoja(hojaOrigen);
    let colPorHoja = mapaColumnasFisico(cacheInfo);
    let hojas = source.getSheets();

    for (let i = 0; i < hojas.length; i++) {
        let h = hojas[i];
        let n = claveHoja(h.getName());
        if (!esHojaInventario(n) || n === claveOrigen) continue;

        if (guiasAfectadas && guiasAfectadas.size > 0) {
            if (!hojaContieneAlgunaGuia(cacheInfo, colPorHoja.get(n), guiasAfectadas)) continue;
        }

        actualizarInventario(h, cacheInfo);
    }
}

// =========================================================================
// CRONÓMETRO DE LLAMADAS A LA API
// =========================================================================
// Apagado siempre salvo mientras corre «Medir velocidad de escaneo». Sirve
// para saber en qué llamada concreta se va el tiempo, en vez de deducirlo:
// cada etiqueta acumula milisegundos, número de llamadas y celdas movidas.
// Con el cronómetro apagado el coste es una llamada a función vacía, nada
// frente a los ~59 ms que cuesta cualquier ida y vuelta a Sheets.
let PERF = null;

function perfIniciar() { PERF = { orden: [], ms: {}, n: {}, celdas: {} }; }
function perfFin() { let p = PERF; PERF = null; return p; }

function perf(etiqueta, celdas, fn) {
    if (!PERF) return fn();
    let t = Date.now();
    let r = fn();
    if (PERF.ms[etiqueta] === undefined) {
        PERF.orden.push(etiqueta);
        PERF.ms[etiqueta] = 0; PERF.n[etiqueta] = 0; PERF.celdas[etiqueta] = 0;
    }
    PERF.ms[etiqueta] += Date.now() - t;
    PERF.n[etiqueta]++;
    PERF.celdas[etiqueta] += celdas;
    return r;
}

// Devuelve las líneas del desglose, de la etiqueta más cara a la más barata.
function perfLineas(p, totalMs) {
    if (!p || p.orden.length === 0) return ["   (sin datos)"];
    let filas = p.orden.map(e => ({ e: e, ms: p.ms[e], n: p.n[e], c: p.celdas[e] }));
    filas.sort((a, b) => b.ms - a.ms);
    let sumaMs = 0, sumaN = 0;
    let out = [];
    filas.forEach(f => {
        sumaMs += f.ms; sumaN += f.n;
        let pct = totalMs > 0 ? Math.round(f.ms * 100 / totalMs) : 0;
        out.push("   " + String(f.ms).padStart(5) + " ms  " + String(pct).padStart(3) + "%  ·  " +
                 f.n + (f.n === 1 ? " llamada" : " llamadas") +
                 (f.c > 0 ? ", " + f.c.toLocaleString() + " celdas" : "") +
                 "  ·  " + f.e);
    });
    out.push("   " + String(sumaMs).padStart(5) + " ms       ·  " + sumaN + " llamadas en total");
    if (totalMs > sumaMs) out.push("   " + String(totalMs - sumaMs).padStart(5) + " ms       ·  resto (cálculo en memoria y llamadas sin medir)");
    return out;
}

// =========================================================================
// ESCRITURA DIFERENCIAL POR BLOQUES
// =========================================================================
// Filas vacías que se toleran dentro de un mismo bloque de escritura.
//
// Cada llamada a la API cuesta decenas de milisegundos independientemente de
// cuántas celdas lleve, así que escribir 200 filas de más en UNA llamada sale
// mucho más barato que partir en dos y pagar otra ida y vuelta. Con el valor
// anterior (2) una hoja con cambios dispersos generaba decenas de bloques y
// cada uno costaba de 3 a 5 llamadas: ahí se iban los segundos por escaneo.
const HUECO_MAX_BLOQUE = 200;

// Texto del duplicado dentro de la MISMA hoja.
//
// Antes salía siempre "🔄 Duplicado local", sin decir dónde estaba la otra: el
// mensaje que sí nombraba el pedimento existía en el código pero era
// inalcanzable, porque la comprobación de "ya la vi" se hacía primero y tapaba
// a la de "ya está asignada a un pedimento". El operador necesita saber a qué
// pedimento ir, así que ahora siempre se dice.
function duplicadoLocal(previa, pedActual, etiqueta) {
    let et = etiqueta || "Ped";   // los inventarios agrupan por ubicación, no por pedimento
    let fila = previa.idx + 1;
    let tienePed = previa.ped && previa.ped !== "SIN_CABECERA" && !esMarcadorEstructural(previa.ped);

    // Repetida dentro del MISMO pedimento (o la misma ubicación): es un doble
    // escaneo y basta con borrar la de abajo. No hay que ir a buscar nada, así
    // que va en gris discreto y la primera ni se marca.
    if (previa.ped === pedActual) {
        return { texto: "🔄 Duplicado local", color: "#acacac", marcarPrimera: false };
    }

    // En otro pedimento sí importa: hay que decidir a cuál pertenece. Naranja,
    // con la referencia de dónde está la otra, y se pintan las dos.
    if (!tienePed) {
        return { texto: "⛔ DUPLICADO (ya escaneada en la fila " + fila + ")", color: "#ff9800", marcarPrimera: true };
    }
    return { texto: "⛔ DUPLICADO (ya en " + et + ": " + previa.ped + ", fila " + fila + ")", color: "#ff9800", marcarPrimera: true };
}

// Y el aviso que se pone en la PRIMERA de las dos, para que se pinten ambas y
// se vea la pareja de un vistazo.
function textoPrimeraDuplicada(info) {
    if (info.veces === 1) return "⚠️ DUPLICADO (repetida en la fila " + info.fila + ")";
    return "⚠️ DUPLICADO (repetida " + info.veces + " veces, la 1ª en la fila " + info.fila + ")";
}

// Registra que `idx` (primera aparición) tiene una repetición en `filaRepetida`.
function anotarRepeticion(repeticiones, idx, filaRepetida) {
    let info = repeticiones.get(idx);
    if (!info) { info = { veces: 0, fila: filaRepetida }; repeticiones.set(idx, info); }
    info.veces++;
    return info;
}

// Construye los colores de la columna A a partir del valor y del estado final
// ya calculado. Devuelve null si el coloreado por script está desactivado.
function coloresDeColumnaA(datosMasivos, resultadosB, ultimaFila) {
    if (!COLOREAR_COLUMNA_A) return null;
    let out = [];
    for (let i = 0; i < ultimaFila; i++) {
        out.push([colorColumnaA(datosMasivos[i][0], resultadosB[i][0])]);
    }
    return out;
}

function aplicarCambiosOptimizado(hoja, colStatus, colHora, idxStatusOriginal, idxHoraOriginal, resultadosStatus, resultadosHoras, datosMasivos, coloresNuevos, fontLinesA, fontColorsA, coloresA, repintarTodo) {
    let n = resultadosStatus.length;
    if (n === 0) return;

    // Repintado total: se escribe la hoja entera aunque nada haya cambiado.
    // Hace falta al retirar el formato condicional, porque si no las filas
    // cuyo estado no cambió se quedarían sin color. Solo lo usan los menús.
    if (repintarTodo) {
        hoja.getRange(1, colStatus, n, 1).setValues(resultadosStatus);
        hoja.getRange(1, colHora, n, 1).setValues(resultadosHoras);
        if (coloresNuevos) hoja.getRange(1, colStatus, n, 1).setBackgrounds(coloresNuevos);
        if (coloresA)   hoja.getRange(1, 1, n, 1).setBackgrounds(coloresA);
        if (fontLinesA) hoja.getRange(1, 1, n, 1).setFontLines(fontLinesA);
        if (fontColorsA) hoja.getRange(1, 1, n, 1).setFontColors(fontColorsA);
        return;
    }

    // Deliberadamente NO se leen los fondos actuales para detectar cambios de
    // color: eso costaba una lectura de columna completa por llamada (dos por
    // recálculo de una Global) y es lo que más pesa en el camino del escaneo.
    // El color se escribe junto con el estado, así que solo puede quedar
    // desfasado si el texto no cambió pero el color sí — caso raro que se
    // corrige en la siguiente edición de esa fila o con «Forzar Actualización».
    let bloques = []; let min = -1, max = -1;
    for (let i = 0; i < n; i++) {
        let originalStatus = datosMasivos[i] ? String(datosMasivos[i][idxStatusOriginal]) : "";
        let originalHora = datosMasivos[i] ? String(datosMasivos[i][idxHoraOriginal]).trim() : "";
        let nuevaHora = String(resultadosHoras[i][0]).trim();

        let cambioStatus = String(resultadosStatus[i][0]) !== originalStatus;
        // Se detecta tanto poner hora como QUITARLA (antes solo lo primero, así
        // que quedaban horas huérfanas en filas ya vacías).
        let cambioHora = (originalHora === "" && nuevaHora !== "") || (originalHora !== "" && nuevaHora === "");

        if (cambioStatus || cambioHora) {
            if (min === -1) { min = i; max = i; }
            else if (i - max > HUECO_MAX_BLOQUE) { bloques.push({min: min, max: max}); min = i; max = i; }
            else { max = i; }
        }
    }
    if (min !== -1) bloques.push({min: min, max: max});

    bloques.forEach(b => {
        let numRows = b.max - b.min + 1;
        perf("escribir estado", numRows, () =>
            hoja.getRange(b.min + 1, colStatus, numRows, 1).setValues(resultadosStatus.slice(b.min, b.max + 1)));
        perf("escribir hora", numRows, () =>
            hoja.getRange(b.min + 1, colHora, numRows, 1).setValues(resultadosHoras.slice(b.min, b.max + 1)));

        if (coloresNuevos) perf("color del estado", numRows, () =>
            hoja.getRange(b.min + 1, colStatus, numRows, 1).setBackgrounds(coloresNuevos.slice(b.min, b.max + 1)));
        if (coloresA) perf("color de la columna A", numRows, () =>
            hoja.getRange(b.min + 1, 1, numRows, 1).setBackgrounds(coloresA.slice(b.min, b.max + 1)));
        if (fontLinesA) perf("tachado de la columna A", numRows, () =>
            hoja.getRange(b.min + 1, 1, numRows, 1).setFontLines(fontLinesA.slice(b.min, b.max + 1)));
        if (fontColorsA) perf("color de fuente de la columna A", numRows, () =>
            hoja.getRange(b.min + 1, 1, numRows, 1).setFontColors(fontColorsA.slice(b.min, b.max + 1)));
    });
}

// Conserva la hora de escaneo original: solo sella la hora actual cuando la
// celda estaba vacía. Antes se reescribía "ahora" en todas las filas del
// bloque, borrando la trazabilidad de las filas vecinas.
function horaPreservada(datosMasivos, i, idxHora, valorFila, horaActual) {
    if (String(valorFila).trim() === "") return '';
    let previa = datosMasivos[i][idxHora];
    return String(previa).trim() !== "" ? previa : horaActual;
}

// =========================================================================
// COSTALES
// =========================================================================
function procesarCostales(hoja, filaDestino) {
  const ultimaFila = Math.max(hoja.getLastRow(), 1);
  asegurarColumnas(hoja, 17);
  const datosOaQ = hoja.getRange(1, 15, ultimaFila, 3).getValues();

  let inicioCostal = -1; let finCostal = -1;
  for (let i = 0; i < ultimaFila; i++) {
      if (String(datosOaQ[i][2]).trim().toUpperCase() === "COSTALES") { inicioCostal = i; break; }
  }
  if (inicioCostal === -1) {
      hoja.getRange(filaDestino, 4).setValue("⚠️ NO HAY COSTAL EN PREFORMA");
      return false;
  }

  for (let i = inicioCostal; i < ultimaFila; i++) {
    let valO = String(datosOaQ[i][0]).trim();
    let marca = String(datosOaQ[i][2]).trim().toUpperCase();
    if (marca === "FIN") { finCostal = i; break; }
    else if (valO === "") { finCostal = i - 1; break; }
  }
  if (finCostal === -1) finCostal = ultimaFila - 1;

  let pedimentosOrdenados = [];
  let guiasTemp = [];
  for (let i = inicioCostal; i <= finCostal; i++) {
    let valO = String(datosOaQ[i][0]).trim().toUpperCase();
    if (valO === "") continue;
    if (/^\d{7}$/.test(valO)) {
        pedimentosOrdenados.push({ pedimento: valO, guias: guiasTemp.slice() });
        guiasTemp = [];
    } else {
        guiasTemp.push(valO);
    }
  }
  if (guiasTemp.length > 0) pedimentosOrdenados.push({ pedimento: "⚠️ SIN PEDIMENTO", guias: guiasTemp.slice() });

  let datosAPegar = []; let tiposAPegar = [];
  pedimentosOrdenados.forEach(bloque => {
    datosAPegar.push([bloque.pedimento]); tiposAPegar.push(["COSTALES"]);
    bloque.guias.forEach(g => { datosAPegar.push([g]); tiposAPegar.push([""]); });
  });
  if (datosAPegar.length === 0) return false;

  asegurarFilas(hoja, filaDestino + datosAPegar.length);

  // Antes se escribía a ciegas y se pisaba lo que hubiera debajo. Ahora se
  // comprueba y se avisa en vez de destruir escaneos.
  let destino = hoja.getRange(filaDestino, 1, datosAPegar.length, 1).getValues();
  let ocupadas = destino.filter(r => String(r[0]).trim() !== "").length;
  if (ocupadas > 0) {
      hoja.getRange(filaDestino, 4).setValue("⚠️ SIN ESPACIO: hay " + ocupadas + " filas con datos debajo");
      return false;
  }

  hoja.getRange(filaDestino, 1, datosAPegar.length, 1).setValues(datosAPegar);
  hoja.getRange(filaDestino, 4, tiposAPegar.length, 1).setValues(tiposAPegar);
  hoja.getRange(inicioCostal + 1, 17).setValue("✅ COSTAL PROCESADO");
  return true;
}

// =========================================================================
// CEREBRO PRINCIPAL: GLOBALES, T1, REZAGO, PREFORMA Y AGA
// =========================================================================
function actualizarGlobalPreforma(hoja, source, cacheInfo, guiasAfectadas, tocoPreforma, repintarTodo) {
  if (tocoPreforma === undefined) tocoPreforma = true;
  const ultimaFila = perf("getLastRow", 0, () => Math.max(hoja.getLastRow(), 1));
  if (ultimaFila < 1) return;

  perf("asegurarColumnas", 0, () => asegurarColumnas(hoja, 19));

  const datosMasivos = perf("leer la hoja A:S", ultimaFila * 19, () =>
      hoja.getRange(1, 1, ultimaFila, 19).getValues());
  const horaActual = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "HH:mm:ss");

  let nombreHoja = perf("nombre de la hoja", 0, () => claveHoja(hoja.getName()));
  let esHojaMSLocal = esHojaMS(nombreHoja);
  let esRezago = nombreHoja.indexOf("REZAGO") !== -1;
  let requiereAlertaMS = !esHojaMSLocal && esHojaPrincipal(nombreHoja) && !esRezago;

  let datosMS = perf("(memoria) registro M-S", 0, () => obtenerRegistroMSDesdeCache(cacheInfo, nombreHoja));
  let guiasEnMS = datosMS.guiasOrigen;
  let registroMS = datosMS.registroMS;
  let guiasRezagoGlobal = esRezago ? obtenerGuiasRezagoDesdeCache(cacheInfo) : null;

  // Duplicados externos reevaluados desde el caché en cada pasada.
  let dupExternos = perf("(memoria) duplicados", 0, () =>
      calcularDuplicadosExternos(datosMasivos, ultimaFila, nombreHoja, cacheInfo));

  let mapaPreformas = {}; let mapaInversoPreforma = new Map();
  let resultadosP = []; let resultadosHorasP = []; let coloresP = [];
  let coloresColumnaO = [];

  let totalPedimentosPreforma = 0; let totalBultosPreforma = 0;
  let bloquesPreforma = []; let pedimentosVistosPreforma = new Set(); let filasDuplicadasPreforma = new Set();

  for (let i = 0; i < ultimaFila; i++) {
    let valP = String(datosMasivos[i][14]).trim();
    let estP = String(datosMasivos[i][15]).trim();
    // Si la columna O está vacía, la fila se resetea por completo: sin estado
    // fijo, sin hora, sin color. Así borrar O limpia todo, no solo el dato.
    let esErrP = valP !== "" && estP.startsWith("🛑 ERROR");

    resultadosP.push([esErrP ? estP : '']);
    resultadosHorasP.push([horaPreservada(datosMasivos, i, 18, valP, horaActual)]);
    coloresP.push([esErrP ? '#ffc107' : '#FFFFFF']);
    coloresColumnaO.push(['#FFFFFF']);
  }

  if (esRezago) {
      let bPAct = null;
      for (let i = 0; i < ultimaFila; i++) {
          let v = String(datosMasivos[i][14]).trim().toUpperCase(); if (v === "") continue;
          let esErrP = resultadosP[i][0] !== '';
          if (/^\d{7}$/.test(v)) {
              if (!esErrP) totalPedimentosPreforma++;
              if (pedimentosVistosPreforma.has(v)) filasDuplicadasPreforma.add(i); else pedimentosVistosPreforma.add(v);
              if (bPAct) bloquesPreforma.push(bPAct);
              bPAct = { pedimento: v, filaPedimento: i, guias: [], filasGuias: [], esErr: esErrP };
          } else {
              totalBultosPreforma++;
              if (bPAct) { bPAct.guias.push(v); bPAct.filasGuias.push(i); }
              else { bPAct = { pedimento: "SIN_CABECERA", filaPedimento: -1, guias: [v], filasGuias: [i], esErr: false }; }
          }
      }
      if (bPAct) bloquesPreforma.push(bPAct);
  } else {
      let gTmp = []; let fTmp = [];
      for (let i = 0; i < ultimaFila; i++) {
          let v = String(datosMasivos[i][14]).trim().toUpperCase(); if (v === "") continue;
          let esErrP = resultadosP[i][0] !== '';
          if (/^\d{7}$/.test(v)) {
              if (!esErrP) totalPedimentosPreforma++;
              if (pedimentosVistosPreforma.has(v)) filasDuplicadasPreforma.add(i); else pedimentosVistosPreforma.add(v);
              bloquesPreforma.push({ pedimento: v, filaPedimento: i, guias: gTmp.slice(), filasGuias: fTmp.slice(), esErr: esErrP });
              gTmp = []; fTmp = [];
          } else {
              totalBultosPreforma++; gTmp.push(v); fTmp.push(i);
          }
      }
      if (gTmp.length > 0) bloquesPreforma.push({ pedimento: "SIN_CABECERA", filaPedimento: -1, guias: gTmp.slice(), filasGuias: fTmp.slice(), esErr: false });
  }

  let filasGuiaRepetidaPreforma = COLOREAR_PEDIMENTO_Y_DUP_EN_O
      ? filasGuiaRepetidaEnPreforma(datosMasivos, ultimaFila)
      : new Set();

  bloquesPreforma.forEach(bloque => {
    let pedimento = bloque.pedimento; let setGuias = new Set(bloque.guias);
    if (pedimento !== "" && pedimento !== "SIN_CABECERA") {
        mapaPreformas[pedimento] = setGuias;
        setGuias.forEach(g => mapaInversoPreforma.set(g, pedimento));
    }

    let colorFondoPreforma = "#00ff00";
    if (bloque.filaPedimento !== -1) {
        colorFondoPreforma = colorBloqueO(datosMasivos[bloque.filaPedimento][13]);
        // La letra de la N sigue mandando en las guías del bloque; el azul
        // sólo se queda con la celda del pedimento.
        coloresColumnaO[bloque.filaPedimento][0] = COLOREAR_PEDIMENTO_Y_DUP_EN_O
            ? COLOR_A_PEDIMENTO
            : colorFondoPreforma;
    }
    bloque.filasGuias.forEach(fG => { coloresColumnaO[fG][0] = colorFondoPreforma; });

    if (bloque.esErr) return;
    let textoEsperando = setGuias.size + " bultos";
    if (bloque.filaPedimento !== -1 && !esRezago) resultadosP[bloque.filaPedimento][0] = textoEsperando;
    if (bloque.filasGuias.length > 0 && !esRezago) resultadosP[bloque.filasGuias[bloque.filasGuias.length - 1]][0] = "► Resumen: " + textoEsperando;
  });

  filasDuplicadasPreforma.forEach(fila => {
      if (!resultadosP[fila][0].startsWith("⛔")) {
          resultadosP[fila][0] = "⚠️ PEDIMENTO REPETIDO";
          coloresP[fila][0] = "#ffc107";
      }
  });

  // El rojo va al final: pisa tanto el azul del pedimento como el color de
  // bloque de las guías, para que un repetido nunca pase desapercibido.
  if (COLOREAR_PEDIMENTO_Y_DUP_EN_O) {
      filasDuplicadasPreforma.forEach(fila => { coloresColumnaO[fila][0] = COLOR_A_DUPLICADO; });
      filasGuiaRepetidaPreforma.forEach(fila => {
          coloresColumnaO[fila][0] = COLOR_A_DUPLICADO;
          // Sin aviso en P la celda roja no diría por qué. No pisa errores
          // estructurales ni duplicados entre hojas, que son más graves, y si
          // la fila ya trae el "► Resumen" se antepone en vez de borrarlo.
          let estadoPrevio = resultadosP[fila][0];
          if (estadoPrevio === "") {
              resultadosP[fila][0] = "⚠️ GUÍA REPETIDA EN PREFORMA";
              coloresP[fila][0] = "#ffc107";
          } else if (!estadoPrevio.startsWith("⛔") && !estadoPrevio.startsWith("🛑")) {
              resultadosP[fila][0] = "⚠️ GUÍA REPETIDA | " + estadoPrevio;
              coloresP[fila][0] = "#ffc107";
          }
      });
  }

  if (!esHojaMSLocal && !esRezago) {
      registroMS.forEach((guiasSet, pedimento) => {
          if (!mapaPreformas[pedimento]) mapaPreformas[pedimento] = new Set();
          guiasSet.forEach(g => {
              mapaPreformas[pedimento].add(g);
              mapaInversoPreforma.set(g, pedimento);
          });
      });
  }

  let resultadosB = []; let resultadosHoras = []; let coloresB = [];
  for (let i = 0; i < ultimaFila; i++) {
    let valB = String(datosMasivos[i][0]).trim();
    let estB = String(datosMasivos[i][1]).trim();
    let esErrEstructura = estB.startsWith("🛑 ERROR");
    let esMovido = esEstadoSalida(estB);
    let dup = dupExternos.get(i);

    let fijo = '';
    let color = '#FFFFFF';
    // valB es la columna A. Si está vacía, la fila queda reseteada del todo:
    // sin estado fijo, sin hora, sin color. Borrar A limpia la fila completa.
    if (valB === "") {
        // fila vacía: se deja todo en blanco
    } else if (esErrEstructura) { fijo = estB; color = '#ffc107'; }
    else if (dup) { fijo = "⛔ DUPLICADO (En: " + dup.hoja + " Fila " + dup.fila + ")"; color = '#ff9800'; }
    else if (esMovido) { fijo = estB; color = '#e0e0e0'; }

    resultadosB.push([fijo]);
    resultadosHoras.push([horaPreservada(datosMasivos, i, 11, valB, horaActual)]);
    coloresB.push([color]);
  }

  let guiasGlobales = new Set(); let totalPedimentos = 0; let escaneadasEnA = new Set();

  for (let i = 0; i < ultimaFila; i++) {
     let v = String(datosMasivos[i][0]).trim().toUpperCase();
     if (v === "") continue;
     if (/^\d{7}$/.test(v)) continue;
     if (!esGuiaUPSValida(v)) continue;
     escaneadasEnA.add(v); guiasGlobales.add(v);
  }

  let bloquesFisicos = []; let pedimentosVistosFisico = new Set(); let filasDuplicadasFisico = new Set();
  let bAAct = null;

  for (let i = 0; i < ultimaFila; i++) {
      let v = String(datosMasivos[i][0]).trim().toUpperCase(); if (v === "") continue;
      let esErr = resultadosB[i][0] !== '';
      let forz = String(datosMasivos[i][3]).trim().toUpperCase() === "T1" ? "T1" : "";

      if (esCabeceraBloque(v)) {
          // "SIN PEDIMENTO" y demás marcadores abren bloque pero no son pedimentos:
          // no se cuentan ni pueden salir como "PEDIMENTO REPETIDO".
          let esPedimento = /^\d{7}$/.test(v);
          if (esPedimento) {
              if (!esErr) totalPedimentos++;
              if (pedimentosVistosFisico.has(v)) filasDuplicadasFisico.add(i); else pedimentosVistosFisico.add(v);
          }
          if (bAAct) bloquesFisicos.push(bAAct);
          bAAct = { pedimento: v, filaPedimento: i, guias: [], filasGuias: [], forzado: forz, esErr: esErr };
      } else {
          if (!esGuiaUPSValida(v) && !esErr) { resultadosB[i][0] = "❌ Guía Inválida"; coloresB[i][0] = "#df5f6b"; }
          else if (!esErr) {
              if (bAAct) { bAAct.guias.push(v); bAAct.filasGuias.push(i); }
              else { bAAct = { pedimento: "SIN_CABECERA", filaPedimento: -1, guias: [v], filasGuias: [i], forzado: "", esErr: false }; }
          }
      }
  }
  if (bAAct) bloquesFisicos.push(bAAct);

  // Una sola estructura: guía -> { ped, idx } de su PRIMERA aparición. Antes
  // había dos (un Set y un Map) que se llenaban a la vez, y el Set tapaba
  // siempre al Map: por eso el mensaje con el pedimento nunca salía.
  let primeraAparicion = new Map();
  let repeticiones = new Map();   // idx de la primera -> { veces, fila }
  let pedimentosCompletos = new Set(); let guiasFaltantesMap = new Map();

  for (let ped in mapaPreformas) {
      let faltantesArr = [];
      mapaPreformas[ped].forEach(g => { if (!escaneadasEnA.has(g)) faltantesArr.push(g); });
      guiasFaltantesMap.set(ped, faltantesArr);
      if (faltantesArr.length === 0 && mapaPreformas[ped].size > 0) pedimentosCompletos.add(ped);
  }

  bloquesFisicos.forEach(bloque => {
      let ped = bloque.pedimento;
      let esperadas = mapaPreformas[ped] || new Set();
      let sobran = 0; let escaneadasUnicas = new Set();
      // Bodegas donde estas guías fueron escaneadas de verdad, según el caché.
      let origenesReales = new Set();

      let txtFalta = "";
      if (requiereAlertaMS) {
          // Ya no se adivina si "debería" haber pasado por T1 o por GLOBALES:
          // no hay nada en la guía que lo indique.
          txtFalta = " ⚠️ Sin registrar en M-S";
      }

      bloque.guias.forEach((g, idx) => {
          let filaG = bloque.filasGuias[idx];
          let origen = guiasEnMS.get(g);
          let pedReal = mapaInversoPreforma.get(g);

          let previa = primeraAparicion.get(g);
          if (previa) {
              let dupLocal = duplicadoLocal(previa, ped);
              resultadosB[filaG][0] = dupLocal.texto;
              coloresB[filaG][0] = dupLocal.color;
              if (dupLocal.marcarPrimera) anotarRepeticion(repeticiones, previa.idx, filaG + 1);
          }
          else {
              primeraAparicion.set(g, { ped: ped, idx: filaG }); escaneadasUnicas.add(g);
              if (origen) origenesReales.add(origen);

              if (esRezago) {
                  if (pedReal) {
                      resultadosB[filaG][0] = pedimentosCompletos.has(pedReal) ? "✅ Recuperado (Ped: " + pedReal + ") | 🌟 COMPLETO" : "✅ Recuperado (Ped: " + pedReal + ")";
                      coloresB[filaG][0] = "#07c369";
                  } else {
                      let infoOtro = guiasRezagoGlobal.get(g);
                      if (infoOtro && infoOtro.hoja !== nombreHoja) { resultadosB[filaG][0] = "❌ Va en: " + infoOtro.hoja + " (Ped: " + infoOtro.pedimento + ")"; coloresB[filaG][0] = "#f5c6cb"; }
                      else { resultadosB[filaG][0] = "⚠️ Ajena (No es de rezago)"; coloresB[filaG][0] = "#df5f6b"; }
                  }
              } else {
                  if (esperadas.size === 0) {
                      resultadosB[filaG][0] = "✅ Guía" + (origen ? " (Escaneado en " + origen + ")" : "");
                      coloresB[filaG][0] = (!origen && requiereAlertaMS) ? "#ffc107" : "#71b3e6";
                  } else if (esperadas.has(g)) {
                      resultadosB[filaG][0] = "✅ Ok" + (origen ? " (Escaneado en " + origen + ")" : "");
                      coloresB[filaG][0] = "#07c369";
                  } else {
                      if (pedReal) { resultadosB[filaG][0] = "❌ Va en: " + pedReal; coloresB[filaG][0] = "#f5c6cb"; }
                      else { resultadosB[filaG][0] = "⚠️ Sobra (Ajena)" + (origen ? " (Escaneado en " + origen + ")" : txtFalta); coloresB[filaG][0] = "#df5f6b"; }
                      sobran++;
                  }
              }
          }
      });

      if (!bloque.esErr && ped !== "SIN_CABECERA" && !esRezago) {
          let estadoStr = "";

          if (esperadas.size === 0) {
              if (escaneadasUnicas.size === 0) {
                  estadoStr = "⚠️ No en preforma";
                  coloresB[bloque.filaPedimento][0] = "#FFF3CD";
              } else {
                  let registradoEnMS = true;
                  bloque.guias.forEach(g => { if (!guiasEnMS.has(g)) registradoEnMS = false; });

                  if (!registradoEnMS && requiereAlertaMS) {
                      estadoStr = txtFalta.trim();
                      coloresB[bloque.filaPedimento][0] = "#ffc107";
                  } else {
                      // Se informa la bodega REAL por la que pasó, tomada del
                      // caché, en vez de deducirla del formato de las guías.
                      if (bloque.forzado === "T1") estadoStr = "✅ T1";
                      else if (nombreHoja.indexOf("A1") !== -1) estadoStr = "✅ A1 COMPLETO";
                      else if (origenesReales.size > 0) estadoStr = "✅ " + Array.from(origenesReales).sort().join(" + ");
                      else estadoStr = "✅ Escaneado";
                      coloresB[bloque.filaPedimento][0] = "#178ccc";
                  }
              }
          } else {
              let faltantesArr = guiasFaltantesMap.get(ped) || [];
              let faltan = faltantesArr.length;
              if (faltan === 0 && sobran === 0) {
                  estadoStr = escaneadasUnicas.size === 0 ? "⏳ Esperando guías..." : "✅ COMPLETO";
                  coloresB[bloque.filaPedimento][0] = escaneadasUnicas.size === 0 ? "#e2e3e5" : "#07c369";
              } else {
                  let det = [];
                  if (faltan > 0) det.push("❌ Faltan " + faltan + " (" + faltantesArr.join(", ") + ")");
                  if (sobran > 0) det.push("⚠️ Sobran " + sobran);
                  estadoStr = det.join(" y "); coloresB[bloque.filaPedimento][0] = "#FFF3CD";
              }
          }
          let txtResumen = "Bultos: " + escaneadasUnicas.size + " | " + estadoStr;
          resultadosB[bloque.filaPedimento][0] = txtResumen;

          if (bloque.filasGuias.length > 0) {
              let fUltima = bloque.filasGuias[bloque.filasGuias.length - 1];
              resultadosB[fUltima][0] = resultadosB[fUltima][0].replace(/ \(Escaneado en .*?\)/g, "") + "   ►   " + txtResumen;
          }
      }
  });

  // Se pintan las DOS guías de la pareja, no solo la repetida. Va después de
  // los resúmenes de bloque para no pisarlos: si esta fila era la última del
  // bloque y arrastra el "► Bultos: ...", esa cola se conserva.
  repeticiones.forEach((info, idx) => {
      let previo = String(resultadosB[idx][0]);
      let corte = previo.indexOf("   ►   ");
      resultadosB[idx][0] = textoPrimeraDuplicada(info) + (corte !== -1 ? previo.substring(corte) : "");
      coloresB[idx][0] = "#ff9800";
  });

  filasDuplicadasFisico.forEach(fila => {
      if (!resultadosB[fila][0].startsWith("⛔")) {
          resultadosB[fila][0] = "🛑 PEDIMENTO REPETIDO";
          coloresB[fila][0] = "#dc3545";
      }
  });

  if (esRezago) {
      bloquesPreforma.forEach(bloque => {
        if (bloque.pedimento !== "" && bloque.pedimento !== "SIN_CABECERA" && !bloque.esErr) {
          if (pedimentosCompletos.has(bloque.pedimento)) {
            resultadosP[bloque.filaPedimento][0] = "✅ REZAGO COMPLETO"; coloresP[bloque.filaPedimento][0] = "#07c369";
          } else {
            let faltantesArr = guiasFaltantesMap.get(bloque.pedimento) || [];
            resultadosP[bloque.filaPedimento][0] = faltantesArr.length > 0
                ? "⏳ Faltan " + faltantesArr.length + " (" + faltantesArr.join(", ") + ")"
                : "⏳ Faltan 0 bultos";
            coloresP[bloque.filaPedimento][0] = "#FFF3CD";
          }
        }
      });
      totalPedimentos = pedimentosCompletos.size;
  }

  let coloresA = coloresDeColumnaA(datosMasivos, resultadosB, ultimaFila);
  aplicarCambiosOptimizado(hoja, 2, 12, 1, 11, resultadosB, resultadosHoras, datosMasivos, coloresB, null, null, coloresA, repintarTodo);
  aplicarCambiosOptimizado(hoja, 16, 19, 15, 18, resultadosP, resultadosHorasP, datosMasivos, coloresP, null, null, null, repintarTodo);

  // Columna O: solo se toca si la edición afectó a la preforma. Un escaneo en
  // la columna A no puede cambiar estos colores, así que en el caso normal nos
  // ahorramos una lectura y una escritura de columna completa.
  if (tocoPreforma) {
      // "Forzar Actualización" repinta sin preguntar: se salta la lectura de
      // comparación, que ahí solo sería una llamada de más.
      let bgODistinto = repintarTodo === true;
      if (!bgODistinto) {
          let bgOActual = perf("leer fondos de la columna O", ultimaFila, () =>
              hoja.getRange(1, 15, ultimaFila, 1).getBackgrounds());
          for (let i = 0; i < ultimaFila; i++) {
              if (String(bgOActual[i][0]).toLowerCase() !== String(coloresColumnaO[i][0]).toLowerCase()) { bgODistinto = true; break; }
          }
      }
      if (bgODistinto) perf("color de la columna O", ultimaFila, () =>
          hoja.getRange(1, 15, ultimaFila, 1).setBackgrounds(coloresColumnaO));
  }

  // C1:C3 y Q1:Q2 ya vienen dentro de datosMasivos (columnas 3 y 17): se
  // comparan desde memoria y solo se escribe si cambiaron. Antes eran dos
  // lecturas extra a la API en cada escaneo.
  let textoPedimentosTop = esRezago ? "Pedimentos (Completos): " : "Total pedimentos: ";
  let cAct = i => (ultimaFila > i && datosMasivos[i]) ? String(datosMasivos[i][2]) : "";
  let c1c3Nuevo = [ ["Total bultos: " + guiasGlobales.size], [textoPedimentosTop + totalPedimentos], [""] ];
  if (cAct(0) !== c1c3Nuevo[0][0] || cAct(1) !== c1c3Nuevo[1][0])
      perf("totales C1:C3", 3, () => hoja.getRange("C1:C3").setValues(c1c3Nuevo));

  let qAct = i => (ultimaFila > i && datosMasivos[i]) ? String(datosMasivos[i][16]) : "";
  let q1q2Nuevo = [ ["Bultos (Preforma): " + totalBultosPreforma], ["Pedimentos (Preforma): " + totalPedimentosPreforma] ];
  if (qAct(0) !== q1q2Nuevo[0][0] || qAct(1) !== q1q2Nuevo[1][0])
      perf("totales Q1:Q2", 2, () => hoja.getRange("Q1:Q2").setValues(q1q2Nuevo));

  if (!esRezago) {
      sincronizarSalidasMS(source, cacheInfo, guiasAfectadas);
  }
}

// =========================================================================
// CEREBRO PRINCIPAL: BODEGAS (M-S)
// =========================================================================
function actualizarMS(hoja, source, cacheInfo, repintarTodo) {
  const ultimaFila = Math.max(hoja.getLastRow(), 1);
  if (ultimaFila < 1) return;

  asegurarColumnas(hoja, 12);
  const datosMasivos = perf("leer la hoja A:L", ultimaFila * 12, () =>
      hoja.getRange(1, 1, ultimaFila, 12).getValues());
  const horaActual = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "HH:mm:ss");
  const nombreHojaMayus = claveHoja(hoja.getName());

  let dupExternos = calcularDuplicadosExternos(datosMasivos, ultimaFila, nombreHojaMayus, cacheInfo);

  let resultadosB = []; let resultadosHoras = []; let coloresB = [];
  let fontLinesA = []; let fontColorsA = [];

  for (let i = 0; i < ultimaFila; i++) {
    let valB = String(datosMasivos[i][0]).trim();
    let estB = String(datosMasivos[i][1]).trim();
    // valB es la columna A vacía => fila reseteada del todo (sin estado fijo,
    // sin tachado ni color de fuente). Los marcadores solo valen con dato en A.
    let vacia = valB === "";
    let esErrEstructura = !vacia && estB.startsWith("🛑 ERROR");
    let esMovido = !vacia && esEstadoSalida(estB);
    let dup = vacia ? null : dupExternos.get(i);

    let fijo = '';
    let color = '#FFFFFF';
    if (esErrEstructura) { fijo = estB; color = '#ffc107'; }
    else if (esMovido) { fijo = estB; color = '#e0e0e0'; }
    else if (dup) { fijo = "⛔ DUPLICADO (En: " + dup.hoja + " Fila " + dup.fila + ")"; color = '#ff9800'; }

    resultadosB.push([fijo]);
    resultadosHoras.push([horaPreservada(datosMasivos, i, 11, valB, horaActual)]);
    coloresB.push([color]);
    fontLinesA.push([esMovido ? 'line-through' : 'none']);
    fontColorsA.push([esMovido ? '#9e9e9e' : '#000000']);
  }

  let bloquesFisicos = []; let pedimentosVistosFisico = new Set(); let filasDuplicadasFisico = new Set();
  let bAAct = null; let guiasGlobales = new Set(); let totalPedimentos = 0;

  for (let i = 0; i < ultimaFila; i++) {
      let v = String(datosMasivos[i][0]).trim().toUpperCase(); if (v === "") continue;
      let esErr = resultadosB[i][0] !== '' && !esEstadoSalida(resultadosB[i][0]);

      if (esCabeceraBloque(v)) {
          let esPedimento = /^\d{7}$/.test(v);
          if (esPedimento) {
              if (!esErr) totalPedimentos++;
              if (pedimentosVistosFisico.has(v)) filasDuplicadasFisico.add(i); else pedimentosVistosFisico.add(v);
          }
          if (bAAct) bloquesFisicos.push(bAAct);
          bAAct = { pedimento: v, filaPedimento: i, guias: [], filasGuias: [], esErr: esErr };
      } else {
          if (!esGuiaUPSValida(v) && !esErr) { resultadosB[i][0] = "❌ Guía Inválida"; coloresB[i][0] = "#df5f6b"; }
          else if (!esErr) {
              guiasGlobales.add(v);
              if (bAAct) { bAAct.guias.push(v); bAAct.filasGuias.push(i); }
              else { bAAct = { pedimento: "SIN_CABECERA", filaPedimento: -1, guias: [v], filasGuias: [i], esErr: false }; }
          }
      }
  }
  if (bAAct) bloquesFisicos.push(bAAct);

  let primeraAparicion = new Map();   // guía -> { ped, idx } de la 1ª vez
  let repeticiones = new Map();       // idx de la 1ª -> { veces, fila }
  let totalMovidas = 0;
  let totalPedimentosTipo = 0;

  // El tipo lo da la pestaña en la que el operador decidió meter el pedimento.
  const tipoStr = tipoMS(nombreHojaMayus);

  bloquesFisicos.forEach(bloque => {
      let guiasUnicas = new Set();
      let movidas = 0;

      bloque.guias.forEach((g, idx) => {
          let filaG = bloque.filasGuias[idx];
          let statusActual = resultadosB[filaG][0];

          if (esEstadoSalida(statusActual)) {
              movidas++; totalMovidas++;
              guiasUnicas.add(g);
          } else {
              let previa = primeraAparicion.get(g);
              if (previa) {
                  let dupLocal = duplicadoLocal(previa, bloque.pedimento);
                  resultadosB[filaG][0] = dupLocal.texto;
                  coloresB[filaG][0] = dupLocal.color;
                  if (dupLocal.marcarPrimera) anotarRepeticion(repeticiones, previa.idx, filaG + 1);
              } else {
                  primeraAparicion.set(g, { ped: bloque.pedimento, idx: filaG });
                  guiasUnicas.add(g);
                  resultadosB[filaG][0] = "✅ Guía"; coloresB[filaG][0] = "#71b3e6";
              }
          }
      });

      if (!bloque.esErr && bloque.pedimento !== "SIN_CABECERA") {
          let faltantes = guiasUnicas.size - movidas;
          let msg = "";
          totalPedimentosTipo++;

          if (guiasUnicas.size === 0) {
              msg = "⏳ Esperando guías...";
              coloresB[bloque.filaPedimento][0] = "#e2e3e5";
          } else if (faltantes === 0) {
              msg = "Bultos: " + guiasUnicas.size + " (" + tipoStr + ") | ✅ TODO SALIÓ";
              coloresB[bloque.filaPedimento][0] = "#07c369";
          } else {
              msg = "Bultos: " + guiasUnicas.size + " (" + tipoStr + ") | ⚠️ Faltan " + faltantes + " por mover";
              coloresB[bloque.filaPedimento][0] = "#ffc107";
          }

          resultadosB[bloque.filaPedimento][0] = msg;

          if (bloque.filasGuias.length > 0 && msg !== "") {
              let filaUltimaGuia = bloque.filasGuias[bloque.filasGuias.length - 1];
              let textoLimpio = resultadosB[filaUltimaGuia][0].replace(/ \(Escaneado en .*?\)/g, "").replace(/ ⚠️ Sin escaneo de .*/g, "");
              resultadosB[filaUltimaGuia][0] = textoLimpio + "   ►   " + msg;
          }
      }
  });

  // También aquí se pinta la primera de la pareja, conservando la cola del
  // resumen si esa fila era la última del bloque.
  repeticiones.forEach((info, idx) => {
      let previo = String(resultadosB[idx][0]);
      let corte = previo.indexOf("   ►   ");
      resultadosB[idx][0] = textoPrimeraDuplicada(info) + (corte !== -1 ? previo.substring(corte) : "");
      coloresB[idx][0] = "#ff9800";
  });

  filasDuplicadasFisico.forEach(fila => {
      if (!resultadosB[fila][0].startsWith("⛔")) {
          resultadosB[fila][0] = "🛑 PEDIMENTO REPETIDO";
          coloresB[fila][0] = "#dc3545";
      }
  });

  aplicarCambiosOptimizado(hoja, 2, 12, 1, 11, resultadosB, resultadosHoras, datosMasivos, coloresB, fontLinesA, fontColorsA,
                           coloresDeColumnaA(datosMasivos, resultadosB, ultimaFila), repintarTodo);

  let fila3Resumen = tipoStr + ": " + totalPedimentosTipo;

  // El total incluye las guías ya movidas; se desglosa para no perder el dato
  // de cuántas siguen físicamente en la bodega.
  let textoBultos = "Total bultos: " + guiasGlobales.size;
  if (totalMovidas > 0) textoBultos += " (salieron: " + totalMovidas + " | en piso: " + (guiasGlobales.size - totalMovidas) + ")";

  // C1:C3 ya está dentro de datosMasivos (columna 3): sin lectura extra.
  let nuevosResumenes = [ [textoBultos], ["Total pedimentos: " + totalPedimentos], [fila3Resumen] ];
  let cAct = i => (ultimaFila > i && datosMasivos[i]) ? String(datosMasivos[i][2]) : "";
  if (cAct(0) !== nuevosResumenes[0][0] ||
      cAct(1) !== nuevosResumenes[1][0] ||
      cAct(2) !== nuevosResumenes[2][0]) {
      hoja.getRange("C1:C3").setValues(nuevosResumenes);
  }
}

// =========================================================================
// CEREBRO PRINCIPAL: INVENTARIOS
//
// Los inventarios forman un dominio cerrado: se cruzan SOLO entre pestañas de
// inventario. Lo que esté en Globales, Bodegas o Rezago no genera ninguna
// alerta aquí. Dentro del dominio sí se detecta:
//   · misma guía en dos pestañas de inventario distintas
//   · misma guía en dos ubicaciones IW distintas de la misma pestaña
//   · misma guía repetida dentro de la misma ubicación (duplicado local)
// =========================================================================
function actualizarInventario(hoja, cacheInfo, repintarTodo) {
  const ultimaFila = Math.max(hoja.getLastRow(), 1);
  asegurarColumnas(hoja, 12);

  const datosMasivos = perf("leer la hoja A:L", ultimaFila * 12, () =>
      hoja.getRange(1, 1, ultimaFila, 12).getValues());
  const horaActual = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "HH:mm:ss");
  const claveEsta = claveHoja(hoja.getName());

  // Ubicación IW vigente en cada fila, para poder nombrarla en los mensajes.
  let ubicacionPorFila = [];
  let ubActual = "";
  for (let i = 0; i < ultimaFila; i++) {
      let v = String(datosMasivos[i][0]).trim().toUpperCase();
      if (v.startsWith("IW")) ubActual = v;
      ubicacionPorFila.push(ubActual);
  }

  // Duplicados dentro del dominio inventario, recalculados desde el caché.
  let dupInventario = new Map();
  if (cacheInfo && cacheInfo.map) {
      for (let i = 0; i < ultimaFila; i++) {
          let v = String(datosMasivos[i][0]).trim().toUpperCase();
          if (v === "" || v.startsWith("IW") || esCabeceraBloque(v)) continue;

          let matches = cacheInfo.map.get(v);
          if (!matches) continue;

          for (let m = 0; m < matches.length; m++) {
              let match = matches[m];
              if (!match.isInventario) continue;                            // ignora Global / Bodegas
              if (match.hoja === claveEsta && match.fila === i) continue;    // la propia fila

              if (match.hoja === claveEsta) {
                  let otraUb = ubicacionPorFila[match.fila];
                  // Misma ubicación: eso es un duplicado local, se marca más abajo.
                  if (otraUb === undefined || otraUb === ubicacionPorFila[i]) continue;
                  dupInventario.set(i, "⛔ DUPLICADO (En: " + otraUb + ", fila " + match.fila + ")");
              } else {
                  dupInventario.set(i, "⛔ DUPLICADO (En: " + match.hoja + " Fila " + match.fila + ")");
              }
              break;
          }
      }
  }

  let resultadosB = []; let resultadosHoras = []; let coloresB = [];
  for (let i = 0; i < ultimaFila; i++) {
    let valA = String(datosMasivos[i][0]).trim();
    let estB = String(datosMasivos[i][1]).trim();
    // valA vacía => fila reseteada del todo. Borrar A limpia estado, hora y color.
    let vacia = valA === "";
    let esErrEstructura = !vacia && estB.startsWith("🛑 ERROR");
    let dup = vacia ? null : dupInventario.get(i);

    let fijo = '';
    let color = '#FFFFFF';
    if (esErrEstructura) { fijo = estB; color = '#ffc107'; }
    else if (dup) { fijo = dup; color = '#ff9800'; }

    resultadosB.push([fijo]);
    resultadosHoras.push([horaPreservada(datosMasivos, i, 11, valA, horaActual)]);
    coloresB.push([color]);
  }

  let filaUbicacionActual = -1; let ultimaFilaGuia = -1;
  // Map en vez de Set: hace falta recordar en qué fila quedó la primera para
  // poder señalarla y pintar las dos guías de la pareja.
  let guiasFisicas = new Map(); let totalUbicaciones = 0; let totalBultosInventario = 0;
  let repeticiones = new Map();

  function cerrarUbicacion() {
      if (filaUbicacionActual === -1 || resultadosB[filaUbicacionActual][0] !== '') return;
      let msg = guiasFisicas.size === 0 ? "⏳ Esperando guías..." : "Bultos: " + guiasFisicas.size;
      totalBultosInventario += guiasFisicas.size;
      resultadosB[filaUbicacionActual][0] = msg;
      coloresB[filaUbicacionActual][0] = "#178ccc";
      if (ultimaFilaGuia !== -1 && ultimaFilaGuia > filaUbicacionActual) {
          resultadosB[ultimaFilaGuia][0] = "✅ Ok   ►   " + msg;
      }
  }

  for (let i = 0; i < ultimaFila; i++) {
    let valor = String(datosMasivos[i][0]).trim().toUpperCase(); if (valor === "") continue;
    let esErr = resultadosB[i][0] !== '';

    if (valor.startsWith("IW")) {
      cerrarUbicacion();
      if (!esErr) totalUbicaciones++;
      filaUbicacionActual = i; ultimaFilaGuia = -1; guiasFisicas.clear();
    } else if (esErr) {
      // Duplicado entre inventarios o error estructural: ya tiene mensaje fijo.
    } else if (!esGuiaUPSValida(valor)) {
      resultadosB[i][0] = "❌ Guía Inválida"; coloresB[i][0] = "#df5f6b";
    } else if (filaUbicacionActual !== -1) {
      let previa = guiasFisicas.get(valor);
      if (previa !== undefined) {
          let ubi = String(datosMasivos[filaUbicacionActual][0]).trim().toUpperCase();
          let dupLocal = duplicadoLocal({ ped: ubi, idx: previa }, ubi, "Ubic");
          resultadosB[i][0] = dupLocal.texto;
          coloresB[i][0] = dupLocal.color;
          if (dupLocal.marcarPrimera) anotarRepeticion(repeticiones, previa, i + 1);
      } else {
          guiasFisicas.set(valor, i);
          resultadosB[i][0] = "✅ Ok"; coloresB[i][0] = "#07c369";
          ultimaFilaGuia = i;
      }
    }
  }
  cerrarUbicacion();

  repeticiones.forEach((info, idx) => {
      let previo = String(resultadosB[idx][0]);
      let corte = previo.indexOf("   ►   ");
      resultadosB[idx][0] = textoPrimeraDuplicada(info) + (corte !== -1 ? previo.substring(corte) : "");
      coloresB[idx][0] = "#ff9800";
  });

  aplicarCambiosOptimizado(hoja, 2, 12, 1, 11, resultadosB, resultadosHoras, datosMasivos, coloresB, null, null,
                           coloresDeColumnaA(datosMasivos, resultadosB, ultimaFila), repintarTodo);

  // C1:C3 ya está dentro de datosMasivos (columna 3): sin lectura extra.
  let c1c3Nuevo = [ ["Total bultos: " + totalBultosInventario], ["Ubicaciones (IW): " + totalUbicaciones], [""] ];
  let cAct = i => (ultimaFila > i && datosMasivos[i]) ? String(datosMasivos[i][2]) : "";
  if (cAct(0) !== c1c3Nuevo[0][0] || cAct(1) !== c1c3Nuevo[1][0]) {
      hoja.getRange("C1:C3").setValues(c1c3Nuevo);
  }
}

// =========================================================================
// MENÚ
// =========================================================================
function onOpen() {
  SpreadsheetApp.getUi().createMenu('📦 Opciones Avanzadas')
    .addItem('📋 Agrupar Guías por Pedimento (Col A)', 'agruparPorPedimento')
    .addItem('🧹 Limpiar guías movidas (Rango seleccionado)', 'limpiarGuiasMovidasSeleccion')
    .addSeparator()
    .addItem('🔄 Forzar Actualización de esta pestaña', 'forzarActualizacionHojaActiva')
    .addItem('♻️ Reconstruir caché completo', 'RECONSTRUIR_CACHE_TOTAL')
    .addSeparator()
    .addItem('🩺 Diagnóstico del sistema', 'diagnosticoSistema')
    .addItem('⏱️ Medir velocidad de escaneo', 'medirRendimiento')
    .addItem('🔒 Proteger hojas del sistema', 'protegerHojasSistema')
    .addSeparator()
    .addItem('⚙️ Instalar trigger avanzado (recomendado)', 'instalarTriggerAvanzado')
    .addItem('↩️ Volver al trigger simple', 'desinstalarTriggerAvanzado')
    .addToUi();
}

// =========================================================================
// PROTECCIÓN DE LAS HOJAS INTERNAS
//
// Se usa protección de SOLO AVISO a propósito. Una protección normal se
// aplicaría también al script: éste escribe con la autoridad de quien dispara
// la edición, así que un operador que no estuviera en la lista de editores
// haría fallar el setValues y perdería su escaneo. El aviso evita el borrado
// accidental sin bloquear a nadie.
// =========================================================================
const DESC_PROTECCION = "Hoja interna del motor de escaneos — no editar a mano";

function protegerHojasSistema() {
  conLock(ss => {
    let protegidas = [];

    ss.getSheets().forEach(hoja => {
      if (!esHojaInterna(hoja.getName())) return;

      // Se retira la protección anterior de este script para no acumular.
      hoja.getProtections(SpreadsheetApp.ProtectionType.SHEET).forEach(p => {
          if (p.getDescription() === DESC_PROTECCION) p.remove();
      });

      hoja.protect().setDescription(DESC_PROTECCION).setWarningOnly(true);
      protegidas.push(hoja.getName());
    });

    if (protegidas.length === 0) {
        ss.toast('No se encontraron hojas internas que proteger.', 'Sin cambios', 5);
        return;
    }
    ss.toast('🔒 Protegidas (solo aviso): ' + protegidas.join(', ') +
             '. El script sigue escribiendo con normalidad.', 'Listo', 8);
  });
}

// =========================================================================
// MEDICIÓN DE RENDIMIENTO
//
// Todos los escaneos del archivo se serializan con el mismo lock de documento,
// así que el techo de throughput NO depende de cuántos operadores haya: es
// 1 / (tiempo por escaneo), repartido entre todos. Esta función mide ese tiempo
// sobre la pestaña activa y traduce el número a escaneos por minuto.
// =========================================================================
function medirRendimiento() {
  const ss = obtenerArchivo();
  const ui = SpreadsheetApp.getUi();
  const hoja = ss.getActiveSheet();
  const nombre = claveHoja(hoja.getName());

  if (esHojaSistema(nombre)) {
    ui.alert("⏱️ Medición", "Esta pestaña es del sistema. Colócate en una hoja de escaneo.", ui.ButtonSet.OK);
    return;
  }

  let L = [];
  let lr = hoja.getLastRow();
  let anchoLeido = esHojaPrincipal(nombre) ? 19 : 12;

  L.push("Pestaña: " + nombre);
  L.push("Filas con datos: " + lr + "  ·  celdas leídas por recálculo: " + (lr * anchoLeido).toLocaleString());

  // ── Peso del archivo ────────────────────────────────────────────────────
  // Coste de UNA llamada trivial a la API. Si esto ya es alto, el problema no
  // es el script: es que el documento pesa y cada ida y vuelta se arrastra.
  let t0 = Date.now();
  for (let k = 0; k < 3; k++) hoja.getRange(1, 1).getValue();
  let msPorLlamada = Math.round((Date.now() - t0) / 3);

  let celdasTotales = 0;
  ss.getSheets().forEach(h => { celdasTotales += h.getMaxRows() * h.getMaxColumns(); });

  L.push("");
  L.push("── PESO DEL ARCHIVO ──");
  L.push("Celdas totales del archivo: " + celdasTotales.toLocaleString() +
         "  (usadas de verdad: " + (lr * anchoLeido).toLocaleString() + ")");
  L.push("Coste de UNA llamada a la API: ~" + msPorLlamada + " ms");
  if (msPorLlamada > 250) {
      L.push("🔴 Muy alto. En un archivo ligero son 30-80 ms. El cuello de botella");
      L.push("   es el peso del documento, no el script. Ver recomendación abajo.");
  } else if (msPorLlamada > 120) {
      L.push("🟡 Alto. Conviene aligerar el archivo.");
  } else {
      L.push("✅ Normal.");
  }
  L.push("");

  // 1. Carga del caché en frío (lo que paga el primer escaneo tras una pausa).
  invalidarCacheRAM();
  t0 = Date.now();
  let cacheInfo = getCacheData(ss);
  let tCache = Date.now() - t0;
  L.push("── DESGLOSE ──");
  L.push("Cargar caché (solo 1ª vez): " + tCache + " ms" +
         (cacheInfo ? "  ·  " + cacheInfo.map.size + " guías indexadas" : "  ·  SIN CACHÉ"));

  // 2. Recálculo completo de la hoja: es el grueso de cada escaneo.
  // 2. Un escaneo de verdad: el recálculo YA arrastra dentro la sincronización
  //    de M-S, así que medirlas por separado y sumarlas contaba ese barrido dos
  //    veces e inflaba el resultado. Y se le pasa una guía real de la hoja,
  //    porque con el conjunto vacío el filtro se desactiva y se abren TODAS las
  //    M-S: eso es el peor caso, no un escaneo normal.
  let guiaMuestra = null;
  if (lr > 0) {
    let colA = hoja.getRange(1, 1, lr, 1).getValues();
    for (let i = lr - 1; i >= 0 && !guiaMuestra; i--) {
      let v = String(colA[i][0]).trim().toUpperCase();
      if (v !== "" && esGuiaUPSValida(v)) guiaMuestra = v;
    }
  }
  let guiasAfectadas = guiaMuestra ? new Set([guiaMuestra]) : new Set();

  perfIniciar();
  t0 = Date.now();
  recalcularHoja(hoja, ss, cacheInfo, guiasAfectadas, false);
  let tEscaneo = Date.now() - t0;
  let perfEscaneo = perfFin();
  L.push("Un escaneo completo:         " + tEscaneo + " ms" +
         (guiaMuestra ? "  (probando con una guía real de la hoja)" : "  (hoja vacía)"));

  // 3. Barrido completo de M-S: no pasa en un escaneo normal, solo cuando la
  //    guía toca muchas pestañas o al forzar desde el menú. Se mide aparte y NO
  //    se suma al tiempo por escaneo.
  let tSyncTodo = 0;
  let perfSyncTodo = null;
  if (esHojaPrincipal(nombre) && nombre.indexOf("REZAGO") === -1) {
    perfIniciar();
    t0 = Date.now();
    sincronizarSalidasMS(ss, cacheInfo, new Set());
    tSyncTodo = Date.now() - t0;
    perfSyncTodo = perfFin();
    L.push("Barrido de TODAS las M-S:    " + tSyncTodo + " ms  (peor caso, aparte)");
  }

  // Dónde se va el tiempo, llamada por llamada. Es lo que decide qué se
  // optimiza después: sin esto solo se puede especular.
  L.push("");
  L.push("── DÓNDE SE VA EL ESCANEO ──");
  perfLineas(perfEscaneo, tEscaneo).forEach(x => L.push(x));
  if (perfSyncTodo) {
    L.push("");
    L.push("── DÓNDE SE VA EL BARRIDO COMPLETO ──");
    perfLineas(perfSyncTodo, tSyncTodo).forEach(x => L.push(x));
  }

  // El caché ya está caliente entre escaneos seguidos, así que el coste
  // representativo es el del escaneo medido arriba, que ya incluye la
  // sincronización de las M-S que de verdad toca esa guía.
  let porEscaneo = tEscaneo;
  let porMinuto = porEscaneo > 0 ? Math.floor(60000 / porEscaneo) : 0;

  L.push("");
  L.push("── CAPACIDAD ──");
  L.push("Tiempo por escaneo: ~" + (porEscaneo / 1000).toFixed(1) + " s");
  L.push("Techo del archivo:  ~" + porMinuto + " escaneos por minuto");
  L.push("Repartido entre 7 operadores: ~" + Math.floor(porMinuto / 7) + " escaneos/min cada uno");
  L.push("");

  if (porEscaneo < 700) {
    L.push("✅ Holgado. Aguanta 7 operadores sin problema.");
  } else if (porEscaneo < 1500) {
    L.push("🟡 Aceptable con pocos operadores. Con 7 en paralelo se notará espera.");
    L.push("   Reduce filas con datos o pide el recálculo incremental.");
  } else {
    L.push("🔴 Lento. Con varios operadores se van a formar colas y saldrá");
    L.push("   «⏳ Pendiente (reintenta)». Hace falta recálculo incremental.");
  }

  L.push("");
  L.push("Nota: todos los operadores comparten el mismo turno (lock del");
  L.push("documento), así que este techo es del archivo entero, no por persona.");

  // Recomendación concreta según dónde esté el cuello de botella.
  if (msPorLlamada > 120) {
      let filasUsadas = Math.max(lr, 50);
      let sugeridas = Math.ceil((filasUsadas + 200) / 100) * 100;
      L.push("");
      L.push("── QUÉ HACER ──");
      L.push("El archivo pesa " + celdasTotales.toLocaleString() + " celdas y solo usas " + lr + " filas.");
      L.push("1. Borra las filas sobrantes de CADA pestaña: deja ~" + sugeridas + ".");
      L.push("2. Revisa el formato condicional: si las reglas cubren columnas");
      L.push("   enteras (A:A, A1:S3000), acótalas al rango que usas.");
      L.push("3. Lo mismo con la validación de datos de la columna M.");
      L.push("Esto suele bajar el coste por llamada de golpe, y con él todo lo demás.");
  }

  ui.alert("⏱️ Velocidad de escaneo", L.join("\n"), ui.ButtonSet.OK);
}

// =========================================================================
// DIAGNÓSTICO
// =========================================================================
function diagnosticoSistema() {
  const ss = obtenerArchivo();
  const ui = SpreadsheetApp.getUi();

  invalidarCacheRAM();
  let cacheInfo = getCacheData(ss);
  let L = [];

  // --- Caché ---
  L.push("── CACHÉ DE DUPLICADOS ──");
  if (!cacheInfo) {
      L.push("❌ No existe CACHE_SISTEMA. Usa «Reconstruir caché completo».");
  } else {
      let existentes = new Set(ss.getSheets().map(h => claveHoja(h.getName())));
      let indexadas = [], huerfanas = [], preformasSobrantes = [];

      cacheInfo.headers.forEach(h => {
          let t = String(h);
          if (t === "") return;
          let nombre = claveHoja(t.replace("_FISICO", "").replace("_PREFORMA", ""));
          if (!existentes.has(nombre)) { huerfanas.push(t); return; }
          if (t.endsWith("_PREFORMA") && !usaPreforma(nombre)) { preformasSobrantes.push(t); return; }
          if (t.endsWith("_FISICO")) indexadas.push(nombre);
      });

      L.push("✅ Pestañas indexadas: " + indexadas.length + " (" + indexadas.join(", ") + ")");
      L.push("   Guías en el índice: " + cacheInfo.map.size);
      L.push(huerfanas.length === 0
          ? "✅ Sin columnas huérfanas"
          : "⚠️ Columnas de pestañas que ya no existen: " + huerfanas.join(", "));
      if (preformasSobrantes.length > 0) {
          L.push("⚠️ Preformas sobrantes de hojas M-S: " + preformasSobrantes.join(", "));
      }
      if (huerfanas.length > 0 || preformasSobrantes.length > 0) {
          L.push("   → Se limpian con «Reconstruir caché completo».");
      }
  }

  // --- Estado de las pestañas de trabajo ---
  L.push("");
  L.push("── PESTAÑAS ──");
  ss.getSheets().forEach(hoja => {
      let n = claveHoja(hoja.getName());
      if (esHojaSistema(n)) return;

      let lr = hoja.getLastRow();
      if (lr < 1) { L.push("· " + n + ": vacía"); return; }

      let datos = hoja.getRange(1, 1, lr, 2).getValues();
      let conDato = 0, pendientes = 0, duplicados = 0, invalidas = 0;

      datos.forEach(f => {
          let a = String(f[0]).trim();
          if (a === "") return;
          conDato++;
          let b = String(f[1]).trim();
          if (filaSinValidar(a, b)) pendientes++;
          if (b.startsWith("⛔")) duplicados++;
          if (b.startsWith("❌ Guía Inválida")) invalidas++;
      });

      let linea = "· " + n + ": " + conDato + " filas";
      if (pendientes > 0) linea += " | ⏳ " + pendientes + " sin validar";
      if (duplicados > 0) linea += " | ⛔ " + duplicados + " duplicadas";
      if (invalidas > 0) linea += " | ❌ " + invalidas + " inválidas";
      if (pendientes === 0 && duplicados === 0 && invalidas === 0) linea += " | ✅ limpia";
      L.push(linea);
  });

  // --- Disparadores ---
  L.push("");
  L.push("── DISPARADORES ──");
  try {
      let ts = ScriptApp.getProjectTriggers();
      if (ts.length === 0) L.push("⚠️ Ninguno. Solo funciona el trigger simple onEdit.");
      else ts.forEach(t => L.push("· " + t.getHandlerFunction() + " (" + t.getEventType() + ")"));
  } catch (err) {
      L.push("No se pudieron leer: " + err.message);
  }

  // --- Protección ---
  L.push("");
  L.push("── PROTECCIÓN ──");
  let protegidas = [];
  ss.getSheets().forEach(hoja => {
      if (!esHojaInterna(hoja.getName())) return;
      let tiene = hoja.getProtections(SpreadsheetApp.ProtectionType.SHEET)
                      .some(p => p.getDescription() === DESC_PROTECCION);
      protegidas.push((tiene ? "✅ " : "⚠️ sin proteger: ") + hoja.getName());
  });
  L.push(protegidas.join("\n"));

  ui.alert("🩺 Diagnóstico del sistema", L.join("\n"), ui.ButtonSet.OK);
}

// Las funciones de menú también escriben en masa: sin lock pueden corromper
// datos si un operador escanea al mismo tiempo.
function conLock(fn) {
  const ss = obtenerArchivo();
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(20000)) {
      ss.toast('⏳ Hay otra operación en curso. Intenta de nuevo en unos segundos.', 'Ocupado', 6);
      return;
  }
  try { fn(ss); } finally { lock.releaseLock(); }
}

function forzarActualizacionHojaActiva() {
  conLock(ss => {
    const hoja = ss.getActiveSheet();
    const nombreHoja = claveHoja(hoja.getName());

    if (esHojaSistema(nombreHoja)) {
        ss.toast('ℹ️ Esta pestaña es del sistema y no se recalcula.', 'Sin Acción', 4);
        return;
    }

    ss.toast('⏳ Sincronizando datos, por favor espera...', 'Actualizando', 3);

    // La fotografía primero: así el recálculo trabaja con un caché fiel.
    actualizarFotografiaMental(hoja, ss);
    invalidarCacheRAM();
    let cacheInfo = getCacheData(ss);

    // repintarTodo = true: reescribe estados y colores de TODAS las filas.
    // Es lo que hay que correr una vez por pestaña al retirar el formato
    // condicional, para que los colores del script queden aplicados.
    recalcularHoja(hoja, ss, cacheInfo, null, true, true);
    if (esHojaInventario(nombreHoja)) sincronizarInventariosAfectados(ss, cacheInfo, null, nombreHoja);

    ss.toast('✅ Hoja actualizada y coloreada correctamente.', 'Éxito', 4);
  });
}

function actualizadorAutomaticoGlobal() {
  const ss = obtenerArchivo();
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(30000)) return;

  try {
    // Autocuración: quita del caché las pestañas renombradas o borradas antes
    // de que empiecen a generar duplicados fantasma.
    podarCacheHuerfano(ss);

    // PASADA 1: detectar hojas con filas sin validar (escaneos que se perdieron
    // por un lock ocupado o un timeout) y re-fotografiarlas.
    let pendientes = [];
    ss.getSheets().forEach(hoja => {
        let nombreHoja = claveHoja(hoja.getName());
        let lr = hoja.getLastRow();
        if (esHojaSistema(nombreHoja) || lr <= 1) return;

        let necesitaActualizar = false;

        if (esHojaMS(nombreHoja) || esHojaInventario(nombreHoja)) {
            let datos = hoja.getRange(2, 1, lr - 1, 2).getValues();
            for (let i = 0; i < datos.length; i++) {
                if (filaSinValidar(datos[i][0], datos[i][1])) { necesitaActualizar = true; break; }
            }
        } else if (esHojaPrincipal(nombreHoja)) {
            if (hoja.getMaxColumns() >= 16) {
                let datosFisicos = hoja.getRange(2, 1, lr - 1, 2).getValues();
                let datosPreforma = hoja.getRange(2, 15, lr - 1, 2).getValues();
                for (let i = 0; i < datosFisicos.length; i++) {
                    if (filaSinValidar(datosFisicos[i][0], datosFisicos[i][1])) { necesitaActualizar = true; break; }
                    if (filaSinValidar(datosPreforma[i][0], datosPreforma[i][1])) { necesitaActualizar = true; break; }
                }
            } else {
                necesitaActualizar = true;
            }
        }

        if (necesitaActualizar) {
            actualizarFotografiaMental(hoja, ss);
            pendientes.push(hoja);
        }
    });

    // El caché se recarga UNA sola vez, no una por hoja (antes era O(n²)).
    invalidarCacheRAM();
    let cacheInfo = getCacheData(ss);

    // PASADA 2: recalcular. Los recálculos solo escriben estados, horas y
    // colores; nunca tocan las columnas A ni O, así que el caché sigue válido.
    pendientes.forEach(hoja => recalcularHoja(hoja, ss, cacheInfo, null));

    // Barrido completo de "movidos" fuera del camino crítico del escaneo.
    sincronizarSalidasMS(ss, cacheInfo, null);
  } finally {
    lock.releaseLock();
  }
}

function agruparPorPedimento() {
  conLock(ss => {
    const hoja = ss.getActiveSheet();
    let lr = hoja.getLastRow();
    if (lr < 1) return;

    let nombreHoja = claveHoja(hoja.getName());
    if (esHojaSistema(nombreHoja)) {
        ss.toast('ℹ️ Esta pestaña es del sistema.', 'Sin Acción', 4);
        return;
    }

    let cacheInfo = getCacheData(ss);
    // Solo el bloque físico (A..L). NO se toca la columna M (lista FEMAD,
    // que es una lista fija y no pertenece a ninguna fila) ni la N (letra de
    // color, que pertenece al bloque de preforma en la columna O).
    const colsToMove = 12;
    asegurarColumnas(hoja, 15);
    let esRezago = nombreHoja.indexOf("REZAGO") !== -1;

    let mapaPreforma = new Map();
    let valsO = hoja.getRange(1, 15, lr, 1).getValues();

    if (esRezago) {
        let pedActualO = "";
        for (let i = 0; i < lr; i++) {
          let v = String(valsO[i][0]).trim().toUpperCase();
          if (/^\d{7}$/.test(v)) pedActualO = v;
          else if (v !== "" && pedActualO !== "") mapaPreforma.set(v, pedActualO);
        }
    } else {
        let tempGuiasO = [];
        for (let i = 0; i < lr; i++) {
          let v = String(valsO[i][0]).trim().toUpperCase();
          if (/^\d{7}$/.test(v)) { tempGuiasO.forEach(g => mapaPreforma.set(g, v)); tempGuiasO = []; }
          else if (v !== "") tempGuiasO.push(v);
        }
    }

    let datosMS = obtenerRegistroMSDesdeCache(cacheInfo, nombreHoja);
    datosMS.registroMS.forEach((guias, ped) => {
        guias.forEach(g => { if (!mapaPreforma.has(g)) mapaPreforma.set(g, ped); });
    });

    if (esRezago) {
        obtenerGuiasRezagoDesdeCache(cacheInfo).forEach((info, guia) => {
            if (!mapaPreforma.has(guia)) mapaPreforma.set(guia, info.pedimento);
        });
    }

    let rangoData = hoja.getRange(1, 1, lr, colsToMove);
    let datosFisicos = rangoData.getValues();

    let agrupacion = new Map();
    let pedFisicoActual = "SIN PEDIMENTO";

    for (let i = 0; i < datosFisicos.length; i++) {
      let fila = datosFisicos[i];
      let valA = String(fila[0]).trim().toUpperCase();
      if (valA === "") continue;

      // Agrupar REORDENA, nunca borra. Antes las guías ya salidas se
      // descartaban aquí y desaparecían de la hoja sin quedar registradas en el
      // historial: era la causa de que "se borraran guías" solas. Para
      // eliminarlas está «🧹 Limpiar guías movidas», que sí deja rastro.
      if (/^\d{7}$/.test(valA)) {
          pedFisicoActual = valA;
          if (!agrupacion.has(pedFisicoActual)) agrupacion.set(pedFisicoActual, { cabecera: fila, guias: [] });
          else agrupacion.get(pedFisicoActual).cabecera = fila;
      } else {
          let pedDestino = mapaPreforma.get(valA) || pedFisicoActual;
          if (!agrupacion.has(pedDestino)) {
              let dummy = [pedDestino].concat(Array(colsToMove - 1).fill(""));
              agrupacion.set(pedDestino, { cabecera: dummy, guias: [] });
          }
          agrupacion.get(pedDestino).guias.push(fila);
      }
    }

    let newVals = [];
    agrupacion.forEach((bloque, ped) => {
        if (ped === "SIN PEDIMENTO") return;
        if (bloque.cabecera) newVals.push(bloque.cabecera);
        bloque.guias.forEach(g => newVals.push(g));
    });

    if (agrupacion.has("SIN PEDIMENTO")) {
        newVals.push(["SIN PEDIMENTO"].concat(Array(colsToMove - 1).fill("")));
        agrupacion.get("SIN PEDIMENTO").guias.forEach(g => newVals.push(g));
    }

    rangoData.clearContent();
    hoja.getRange(1, 1, lr, colsToMove).setBackground("#FFFFFF").setFontColor("#000000").setFontLine("none");
    if (newVals.length > 0) {
        hoja.getRange(1, 1, newVals.length, colsToMove).setValues(newVals);
    }

    // Las filas se movieron: la fotografía anterior ya no vale.
    actualizarFotografiaMental(hoja, ss);
    invalidarCacheRAM();
    cacheInfo = getCacheData(ss);

    recalcularHoja(hoja, ss, cacheInfo, null);
    if (esHojaInventario(nombreHoja)) sincronizarInventariosAfectados(ss, cacheInfo, null, nombreHoja);

    ss.toast('✅ Guías agrupadas correctamente en la parte superior.', 'Agrupación', 5);
  });
}

function limpiarGuiasMovidasSeleccion() {
  conLock(ss => {
    const hoja = ss.getActiveSheet();
    const rangoSeleccionado = hoja.getActiveRange();
    if (!rangoSeleccionado) return;

    asegurarColumnas(hoja, 12);
    let filaInicio = rangoSeleccionado.getRow();
    let numFilasSeleccion = rangoSeleccionado.getNumRows();
    if (numFilasSeleccion < 1) return;

    let lr = hoja.getLastRow();
    let maxFilaData = Math.max(lr, filaInicio + numFilasSeleccion - 1);
    let totalFilasAProcesar = maxFilaData - filaInicio + 1;
    if (totalFilasAProcesar < 1) return;

    let rangoData = hoja.getRange(filaInicio, 1, totalFilasAProcesar, 12);
    let valores = rangoData.getValues();

    let paraEliminar = new Set();
    let filasHistorial = [];
    let nombreHoja = claveHoja(hoja.getName());

    for (let i = 0; i < numFilasSeleccion && i < valores.length; i++) {
        let valB = String(valores[i][1]).trim();
        if (esEstadoSalida(valB)) {
            paraEliminar.add(i);
            let guiaBorrada = String(valores[i][0]).trim();
            if (guiaBorrada !== "") {
                filasHistorial.push(eventoHistorial(nombreHoja, filaInicio + i, "Físico (Col A)", guiaBorrada, valB, "LIMPIEZA DE GUÍA YA SALIDA"));
            }
        }
    }

    for (let i = 0; i < numFilasSeleccion && i < valores.length; i++) {
        let valA = String(valores[i][0]).trim().toUpperCase();
        if (!/^\d{7}$/.test(valA) || paraEliminar.has(i)) continue;

        let tieneGuias = false;
        for (let j = i + 1; j < numFilasSeleccion && j < valores.length; j++) {
            let nextA = String(valores[j][0]).trim().toUpperCase();
            if (/^\d{7}$/.test(nextA)) break;
            if (nextA !== "" && !paraEliminar.has(j)) { tieneGuias = true; break; }
        }
        if (!tieneGuias) {
            paraEliminar.add(i);
            filasHistorial.push(eventoHistorial(nombreHoja, filaInicio + i, "Físico (Col A)", valA, "Vacío", "LIMPIEZA DE PEDIMENTO VACÍO"));
        }
    }

    if (paraEliminar.size === 0) {
        ss.toast('ℹ️ No se encontraron guías movidas en el rango seleccionado.', 'Sin cambios', 5);
        return;
    }

    registrarEnHistorialLote(ss, filasHistorial);

    let eliminadas = paraEliminar.size;
    let nuevosValores = [];
    for (let i = 0; i < valores.length; i++) {
        if (!paraEliminar.has(i)) nuevosValores.push(valores[i]);
    }
    // Cada fila vacía debe ser un array propio, no la misma referencia repetida.
    for (let k = 0; k < eliminadas; k++) nuevosValores.push(Array(12).fill(""));

    rangoData.setValues(nuevosValores);

    let startEmpty = filaInicio + nuevosValores.length - eliminadas;
    hoja.getRange(startEmpty, 1, eliminadas, 12)
        .setBackground("#FFFFFF").setFontColor("#000000").setFontLine("none");

    actualizarFotografiaMental(hoja, ss);
    invalidarCacheRAM();
    let cacheInfo = getCacheData(ss);

    recalcularHoja(hoja, ss, cacheInfo, null);
    if (esHojaInventario(nombreHoja)) sincronizarInventariosAfectados(ss, cacheInfo, null, nombreHoja);

    ss.toast('✅ Guías limpiadas (' + eliminadas + ' filas). Las validaciones subieron correctamente.', 'Limpieza Completa', 5);
  });
}

// =========================================================================
// RECONSTRUCCIÓN TOTAL DEL CACHÉ
// =========================================================================
function RECONSTRUIR_CACHE_TOTAL() {
  conLock(ss => {
    ss.toast('📸 Tomando fotografía de todas las pestañas...', 'Reconstruyendo Caché', 5);

    // Se borra la hoja entera para que no sobrevivan columnas de pestañas
    // renombradas o eliminadas (duplicados fantasma).
    let vieja = ss.getSheetByName("CACHE_SISTEMA");
    if (vieja) ss.deleteSheet(vieja);
    invalidarCacheRAM();

    ss.getSheets().forEach(hoja => actualizarFotografiaMental(hoja, ss));
    invalidarCacheRAM();

    ss.toast('✅ Caché reconstruido con éxito.', 'Listo', 5);
  });
}
