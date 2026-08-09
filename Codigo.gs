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

const HOJAS_SISTEMA = ["MACHO", "CACHE_SISTEMA", "HISTORIAL_BORRADOS"];
const PROP_TRIGGER = 'TRIGGER_EDICION_INSTALADO';

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

function esHojaSistema(nombreHoja) {
    let n = claveHoja(nombreHoja);
    return HOJAS_SISTEMA.indexOf(n) !== -1 || n.indexOf("HISTORIAL") !== -1;
}

function esHojaBodega(nombreHoja) {
    let n = claveHoja(nombreHoja);
    return n.startsWith("M-S ") || n.startsWith("SIMPLES") || n.startsWith("MULTIPLES");
}

function esHojaInventario(nombreHoja) {
    return claveHoja(nombreHoja).indexOf("INVENTARIO") !== -1;
}

function esHojaPrincipal(nombreHoja) {
    let n = claveHoja(nombreHoja);
    if (esHojaSistema(n)) return false;
    if (esHojaInventario(n)) return false;
    if (esHojaBodega(n)) return false;
    return true;
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

function obtenerUsuarioActual() {
    if (globalUsuario !== null) return globalUsuario;
    let email = "";
    try { email = Session.getActiveUser().getEmail() || ""; } catch (err) { email = ""; }
    if (email === "") {
        try { email = Session.getEffectiveUser().getEmail() || ""; } catch (err) { email = ""; }
    }
    // Un trigger onEdit *simple* no tiene permiso para identificar al editor.
    // Con el trigger instalable (menú → Instalar trigger avanzado) sí llega el email.
    globalUsuario = email !== "" ? email : "(sin trigger avanzado)";
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
    ss.toast('✅ Trigger avanzado activo: límite de 6 minutos y registro del usuario en el historial.', 'Listo', 8);
}

function desinstalarTriggerAvanzado() {
    const ss = obtenerArchivo();
    ScriptApp.getProjectTriggers().forEach(t => {
        if (t.getHandlerFunction() === 'alEditar') ScriptApp.deleteTrigger(t);
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
  const tocaMacho = (nombreHoja === "MACHO" && colInicial <= 13 && (colInicial + numCols - 1) >= 13);
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
    let valsC12 = tocaColA ? hoja.getRange(filaInicial, 12, numRows, 1).getValues() : null;
    let valsEstadoB = tocaColA ? hoja.getRange(filaInicial, 2, numRows, 1).getValues() : null;
    let valsEstadoP = (tocaColO && hoja.getMaxColumns() >= 16)
        ? hoja.getRange(filaInicial, 16, numRows, 1).getValues() : null;

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
                else if (colActual === 15 && valsEstadoP) valorAnteriorEstado = String(valsEstadoP[r][0]).trim();

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
                    let horaActual = valsC12 ? valsC12[r][0] : "";
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

    recalcularHoja(hoja, e.source, cacheInfo, guiasAfectadas);

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

function marcarPendiente(hoja, filaInicial, numRows, colInicial, numCols) {
    try {
        if (colInicial > 1 || colInicial + numCols - 1 < 1) return;
        let rango = hoja.getRange(filaInicial, 2, numRows, 1);
        let vals = rango.getValues();
        let cambio = false;
        for (let r = 0; r < numRows; r++) {
            if (String(vals[r][0]).trim() === "") { vals[r][0] = "⏳ Pendiente (reintenta)"; cambio = true; }
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

function recalcularHoja(hoja, source, cacheInfo, guiasAfectadas) {
    let n = claveHoja(hoja.getName());
    if (esHojaInventario(n)) actualizarInventario(hoja, cacheInfo);
    else if (esHojaBodega(n)) actualizarConteos(hoja, source, cacheInfo);
    else if (esHojaPrincipal(n)) actualizarGlobalPreforma(hoja, source, cacheInfo, guiasAfectadas);
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
        let isBodegaHeader = esHojaBodega(hojaHeader);
        let isInventarioHeader = esHojaInventario(hojaHeader);

        for (let r = 1; r < globalCacheData.length; r++) {
            let v = String(globalCacheData[r][c]).trim().toUpperCase();
            if (v === "") continue;
            let arr = globalCacheMap.get(v) || [];
            arr.push({ hoja: hojaHeader, fila: r, isBodega: isBodegaHeader, isInventario: isInventarioHeader });
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
    let isCurrentBodega = esHojaBodega(clave);
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

        if (isCurrentBodega) {
            if (match.isBodega) return { encontrado: true, ubicacion: match.hoja + " Fila " + match.fila };
        } else {
            if (!match.isBodega && !match.isInventario) {
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
    let esBod = esHojaBodega(claveEsta);

    for (let i = 0; i < ultimaFila; i++) {
        let v = String(datosMasivos[i][0]).trim().toUpperCase();
        if (v === "" || v.startsWith("IW") || /^\d{7}$/.test(v)) continue;

        let matches = cacheInfo.map.get(v);
        if (!matches) continue;

        for (let m = 0; m < matches.length; m++) {
            let match = matches[m];
            if (match.hoja === claveEsta && match.fila === i) continue;

            if (esInv) {
                if (!match.isInventario) continue;   // inventario ignora Global y Bodegas
            } else if (esBod) {
                if (!match.isBodega || match.hoja === claveEsta) continue;
            } else {
                if (match.isBodega || match.isInventario || match.hoja === claveEsta) continue;
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

    let isBodegaActual = esHojaBodega(clave);
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
                        arr.push({ hoja: clave, fila: filaInicial + r, isBodega: isBodegaActual, isInventario: isInventarioActual });
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

    let headerFisico = clave + "_FISICO";
    let headerPreforma = clave + "_PREFORMA";
    let colFisico = -1, colPreforma = -1;

    for (let i = 0; i < headers.length; i++) {
        if (headers[i] === headerFisico) colFisico = i + 1;
        if (headers[i] === headerPreforma) colPreforma = i + 1;
    }

    if (colFisico === -1) {
        let numHeaders = headers.filter(String).length;
        colFisico = numHeaders + 1;
        colPreforma = numHeaders + 2;
        if (colPreforma > cacheSheet.getMaxColumns()) {
            cacheSheet.insertColumnsAfter(cacheSheet.getMaxColumns(), 2);
        }
        cacheSheet.getRange(1, colFisico, 1, 2).setValues([[headerFisico, headerPreforma]]);
    }

    let maxFilasCache = cacheSheet.getMaxRows();
    if (maxFilasCache > 1) {
        cacheSheet.getRange(2, colFisico, maxFilasCache - 1, 2).clearContent();
    }

    let anchoHoja = hoja.getMaxColumns();
    let valsFisico = hoja.getRange(1, 1, lr, 1).getValues();
    let valsPreforma = anchoHoja >= 15
        ? hoja.getRange(1, 15, lr, 1).getValues()
        : Array.from({ length: lr }, () => [""]);

    cacheSheet.getRange(2, colFisico, lr, 1).setValues(valsFisico);
    cacheSheet.getRange(2, colPreforma, lr, 1).setValues(valsPreforma);
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
        let nombre = h.replace("_FISICO", "").replace("_PREFORMA", "");
        if (!existentes.has(claveHoja(nombre))) aBorrar.push(i + 1);
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
        // CACHE_SISTEMA e HISTORIAL_BORRADOS quedan fuera: su columna M guarda
        // datos del sistema, no la letra del MACHO.
        if (esHojaSistema(hojaDestino.getName())) continue;

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
            else if (v !== "") guias.set(v, { hoja: nombreHoja, pedimento: pedActual });
        }
    }
    return guias;
}

function obtenerDatosBodegaDesdeCache(cacheInfo, nombreHojaActual) {
    let guiasOrigen = new Map();
    let preformaBodega = new Map();
    if (!cacheInfo || !cacheInfo.headers) return { guiasOrigen: guiasOrigen, preformaBodega: preformaBodega };

    let claveActual = claveHoja(nombreHojaActual);
    let esA1 = claveActual.indexOf("A1") !== -1;
    let esCtasEsp = claveActual.indexOf("CUENTAS ESPECIALES") !== -1;

    for (let c = 0; c < cacheInfo.headers.length; c++) {
        let header = String(cacheInfo.headers[c]);
        if (!header.endsWith("_FISICO")) continue;

        let nombreHoja = claveHoja(header.replace("_FISICO", ""));
        if (!esHojaBodega(nombreHoja)) continue;

        let origen = "";
        if (nombreHoja.startsWith("M-S T1") || nombreHoja.startsWith("SIMPLES")) origen = "M-S T1";
        else if (nombreHoja.startsWith("M-S GLOBALES") || nombreHoja.startsWith("MULTIPLES")) origen = "M-S GLOBALES";
        else if (nombreHoja.startsWith("M-S A1")) origen = "M-S A1";
        else if (nombreHoja.startsWith("M-S SEGUIMIENTOS")) origen = "M-S SEGUIMIENTOS";
        else if (nombreHoja.startsWith("M-S CUENTAS ESPECIALES")) origen = "M-S CTAS ESP";

        if (origen === "" || nombreHoja === claveActual) continue;

        if (esCtasEsp) {
            if (origen !== "M-S CTAS ESP") continue;
        } else if (!esA1) {
            if (origen === "M-S A1" || origen === "M-S CTAS ESP") continue;
        }

        let pedActual = "";
        for (let r = 1; r < cacheInfo.data.length; r++) {
            let v = String(cacheInfo.data[r][c]).trim().toUpperCase();
            if (/^\d{7}$/.test(v)) {
                pedActual = v;
                if (!preformaBodega.has(pedActual)) preformaBodega.set(pedActual, new Set());
            } else if (v !== "") {
                if (!guiasOrigen.has(v)) guiasOrigen.set(v, origen);
                if (pedActual !== "") preformaBodega.get(pedActual).add(v);
            }
        }
    }
    return { guiasOrigen: guiasOrigen, preformaBodega: preformaBodega };
}

// Marca en las bodegas las guías que ya fueron escaneadas en una hoja destino.
// `guiasAfectadas` acota el trabajo: si sabemos qué guías cambiaron, las bodegas
// que no las contienen no se tocan (cero llamadas a la API). Con null hace
// barrido completo (menú / trigger por tiempo).
function sincronizarMovidosBodegaDesdeCache(source, cacheInfo, guiasAfectadas) {
    if (!cacheInfo || !cacheInfo.headers) return;

    let escaneadosDestino = new Map();
    let colPorHoja = mapaColumnasFisico(cacheInfo);

    for (let c = 0; c < cacheInfo.headers.length; c++) {
        let header = String(cacheInfo.headers[c]);
        if (!header.endsWith("_FISICO")) continue;

        let n = claveHoja(header.replace("_FISICO", ""));
        if (esHojaBodega(n) || esHojaInventario(n) || esHojaSistema(n) || n.indexOf("REZAGO") !== -1) continue;

        for (let r = 1; r < cacheInfo.data.length; r++) {
            let v = String(cacheInfo.data[r][c]).trim().toUpperCase();
            if (v !== "" && !/^\d{7}$/.test(v)) escaneadosDestino.set(v, n);
        }
    }

    let hojas = source.getSheets();
    let bodegasModificadas = [];

    for (let i = 0; i < hojas.length; i++) {
        let hojaBodega = hojas[i];
        let nBodega = claveHoja(hojaBodega.getName());
        if (!esHojaBodega(nBodega)) continue;

        // Filtro en RAM: evita abrir bodegas que no tienen nada que ver con este escaneo.
        if (guiasAfectadas && guiasAfectadas.size > 0) {
            if (!hojaContieneAlgunaGuia(cacheInfo, colPorHoja.get(nBodega), guiasAfectadas)) continue;
        }

        let lr = hojaBodega.getLastRow();
        if (lr < 1) continue;

        let rangoStatus = hojaBodega.getRange(1, 1, lr, 2);
        let vals = rangoStatus.getValues();
        let modificados = false;

        for (let r = 0; r < lr; r++) {
            let v = String(vals[r][0]).trim().toUpperCase();
            if (v === "" || /^\d{7}$/.test(v)) continue;

            let statusActual = String(vals[r][1]).trim();
            let destino = escaneadosDestino.get(v);

            if (destino) {
                let textoEsperado = "➡ Movido a " + destino;
                if (statusActual !== textoEsperado) { vals[r][1] = textoEsperado; modificados = true; }
            } else if (statusActual.startsWith("➡ Movido a")) {
                vals[r][1] = ""; modificados = true;
            }
        }

        if (modificados) {
            rangoStatus.setValues(vals);
            bodegasModificadas.push(hojaBodega);
        }
    }

    bodegasModificadas.forEach(hojaBodega => actualizarConteos(hojaBodega, source, cacheInfo));
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
// ESCRITURA DIFERENCIAL POR BLOQUES
// =========================================================================
function aplicarCambiosOptimizado(hoja, colStatus, colHora, idxStatusOriginal, idxHoraOriginal, resultadosStatus, resultadosHoras, datosMasivos, coloresNuevos, fontLinesA, fontColorsA) {
    let n = resultadosStatus.length;
    if (n === 0) return;

    let coloresActuales = (coloresNuevos) ? hoja.getRange(1, colStatus, n, 1).getBackgrounds() : null;

    let bloques = []; let min = -1, max = -1;
    for (let i = 0; i < n; i++) {
        let originalStatus = datosMasivos[i] ? String(datosMasivos[i][idxStatusOriginal]) : "";
        let originalHora = datosMasivos[i] ? String(datosMasivos[i][idxHoraOriginal]).trim() : "";
        let nuevaHora = String(resultadosHoras[i][0]).trim();

        let cambioStatus = String(resultadosStatus[i][0]) !== originalStatus;
        // Se detecta tanto poner hora como QUITARLA (antes solo lo primero, así
        // que quedaban horas huérfanas en filas ya vacías).
        let cambioHora = (originalHora === "" && nuevaHora !== "") || (originalHora !== "" && nuevaHora === "");
        let cambioColor = coloresActuales
            ? String(coloresActuales[i][0]).toLowerCase() !== String(coloresNuevos[i][0]).toLowerCase()
            : false;

        if (cambioStatus || cambioHora || cambioColor) {
            if (min === -1) { min = i; max = i; }
            else if (i - max > 2) { bloques.push({min: min, max: max}); min = i; max = i; }
            else { max = i; }
        }
    }
    if (min !== -1) bloques.push({min: min, max: max});

    bloques.forEach(b => {
        let numRows = b.max - b.min + 1;
        hoja.getRange(b.min + 1, colStatus, numRows, 1).setValues(resultadosStatus.slice(b.min, b.max + 1));
        hoja.getRange(b.min + 1, colHora, numRows, 1).setValues(resultadosHoras.slice(b.min, b.max + 1));

        if (coloresNuevos) hoja.getRange(b.min + 1, colStatus, numRows, 1).setBackgrounds(coloresNuevos.slice(b.min, b.max + 1));
        if (fontLinesA) hoja.getRange(b.min + 1, 1, numRows, 1).setFontLines(fontLinesA.slice(b.min, b.max + 1));
        if (fontColorsA) hoja.getRange(b.min + 1, 1, numRows, 1).setFontColors(fontColorsA.slice(b.min, b.max + 1));
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
function actualizarGlobalPreforma(hoja, source, cacheInfo, guiasAfectadas) {
  const ultimaFila = Math.max(hoja.getLastRow(), 1);
  if (ultimaFila < 1) return;

  asegurarColumnas(hoja, 19);

  const datosMasivos = hoja.getRange(1, 1, ultimaFila, 19).getValues();
  const horaActual = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "HH:mm:ss");

  let nombreHoja = claveHoja(hoja.getName());
  let esHojaBodegaL = esHojaBodega(nombreHoja);
  let esRezago = nombreHoja.indexOf("REZAGO") !== -1;
  let requiereAlertaBodega = !esHojaBodegaL && esHojaPrincipal(nombreHoja) && !esRezago;

  let datosBodega = obtenerDatosBodegaDesdeCache(cacheInfo, nombreHoja);
  let guiasBodega = datosBodega.guiasOrigen;
  let preformaBodega = datosBodega.preformaBodega;
  let guiasRezagoGlobal = esRezago ? obtenerGuiasRezagoDesdeCache(cacheInfo) : null;

  // Duplicados externos reevaluados desde el caché en cada pasada.
  let dupExternos = calcularDuplicadosExternos(datosMasivos, ultimaFila, nombreHoja, cacheInfo);

  let mapaPreformas = {}; let mapaInversoPreforma = new Map();
  let resultadosP = []; let resultadosHorasP = []; let coloresP = [];
  let coloresColumnaO = [];

  let totalPedimentosPreforma = 0; let totalBultosPreforma = 0;
  let bloquesPreforma = []; let pedimentosVistosPreforma = new Set(); let filasDuplicadasPreforma = new Set();

  for (let i = 0; i < ultimaFila; i++) {
    let valP = String(datosMasivos[i][14]).trim();
    let estP = String(datosMasivos[i][15]).trim();
    let esErrP = estP.startsWith("🛑 ERROR");

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

  bloquesPreforma.forEach(bloque => {
    let pedimento = bloque.pedimento; let setGuias = new Set(bloque.guias);
    if (pedimento !== "" && pedimento !== "SIN_CABECERA") {
        mapaPreformas[pedimento] = setGuias;
        setGuias.forEach(g => mapaInversoPreforma.set(g, pedimento));
    }

    let colorFondoPreforma = "#00ff00";
    if (bloque.filaPedimento !== -1) {
        let letraN = String(datosMasivos[bloque.filaPedimento][13]).trim().toLowerCase();
        if (letraN === "a") colorFondoPreforma = "#35ec09";
        else if (letraN === "b") colorFondoPreforma = "#ff00ff";
        else if (letraN === "c") colorFondoPreforma = "#39b1b9";
        coloresColumnaO[bloque.filaPedimento][0] = colorFondoPreforma;
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

  if (!esHojaBodegaL && !esRezago) {
      preformaBodega.forEach((guiasSet, pedimento) => {
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
    let esMovido = estB.startsWith("➡ Movido a");
    let dup = dupExternos.get(i);

    let fijo = '';
    let color = '#FFFFFF';
    if (esErrEstructura) { fijo = estB; color = '#ffc107'; }
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

      if (/^\d{7}$/.test(v)) {
          if (!esErr) totalPedimentos++;
          if (pedimentosVistosFisico.has(v)) filasDuplicadasFisico.add(i); else pedimentosVistosFisico.add(v);
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

  let guiasVistasGeneral = new Set(); let guiasYaAsignadasGlobal = new Map();
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
      let basesUnicas = new Set(); let sobran = 0; let escaneadasUnicas = new Set();

      let txtFalta = "";
      if (requiereAlertaBodega) {
          if (nombreHoja.indexOf("CUENTAS ESPECIALES") !== -1) {
              txtFalta = " ⚠️ Sin escaneo de M-S CTAS ESP";
          } else if (nombreHoja.indexOf("A1") !== -1) {
              txtFalta = " ⚠️ Sin escaneo en Bodegas";
          } else {
              bloque.guias.forEach(g => { if (g.length >= 10) basesUnicas.add(g.substring(0, 10)); else basesUnicas.add(g); });
              txtFalta = basesUnicas.size <= 1 ? " ⚠️ Sin escaneo de M-S T1" : " ⚠️ Sin escaneo de M-S GLOBALES";
          }
      }

      bloque.guias.forEach((g, idx) => {
          let filaG = bloque.filasGuias[idx];
          let origen = guiasBodega.get(g);
          let pedReal = mapaInversoPreforma.get(g);

          if (guiasVistasGeneral.has(g)) { resultadosB[filaG][0] = "🔄 Duplicado local"; coloresB[filaG][0] = "#acacac"; }
          else if (guiasYaAsignadasGlobal.has(g) && !esRezago) { resultadosB[filaG][0] = "⛔ Duplicado local (Ya en Ped: " + guiasYaAsignadasGlobal.get(g) + ")"; coloresB[filaG][0] = "#ff9800"; }
          else {
              guiasVistasGeneral.add(g); guiasYaAsignadasGlobal.set(g, ped); escaneadasUnicas.add(g);
              if (g.length >= 10) basesUnicas.add(g.substring(0, 10)); else basesUnicas.add(g);

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
                      coloresB[filaG][0] = (!origen && requiereAlertaBodega) ? "#ffc107" : "#71b3e6";
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
                  let escaneadoEnBodega = true;
                  bloque.guias.forEach(g => { if (!guiasBodega.has(g)) escaneadoEnBodega = false; });

                  if (!escaneadoEnBodega && requiereAlertaBodega) {
                      estadoStr = txtFalta.trim();
                      coloresB[bloque.filaPedimento][0] = "#ffc107";
                  } else {
                      if (bloque.forzado === "T1") estadoStr = "✅ T1";
                      else if (nombreHoja.indexOf("A1") !== -1) estadoStr = "✅ A1 COMPLETO";
                      else if (nombreHoja.indexOf("CUENTAS ESPECIALES") !== -1) estadoStr = "✅ M-S CTAS ESP";
                      else if (basesUnicas.size === 1) estadoStr = "✅ M-S T1";
                      else estadoStr = "✅ M-S GLOBALES";
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

  aplicarCambiosOptimizado(hoja, 2, 12, 1, 11, resultadosB, resultadosHoras, datosMasivos, coloresB, null, null);
  aplicarCambiosOptimizado(hoja, 16, 19, 15, 18, resultadosP, resultadosHorasP, datosMasivos, coloresP, null, null);

  // Columna O: escritura condicional. Antes se repintaba entera en cada escaneo.
  let bgOActual = hoja.getRange(1, 15, ultimaFila, 1).getBackgrounds();
  let bgODistinto = false;
  for (let i = 0; i < ultimaFila; i++) {
      if (String(bgOActual[i][0]).toLowerCase() !== String(coloresColumnaO[i][0]).toLowerCase()) { bgODistinto = true; break; }
  }
  if (bgODistinto) hoja.getRange(1, 15, ultimaFila, 1).setBackgrounds(coloresColumnaO);

  let textoPedimentosTop = esRezago ? "Pedimentos (Completos): " : "Total pedimentos: ";
  let c1c3Actual = hoja.getRange("C1:C3").getValues();
  let c1c3Nuevo = [ ["Total bultos: " + guiasGlobales.size], [textoPedimentosTop + totalPedimentos], [""] ];
  if (c1c3Actual[0][0] !== c1c3Nuevo[0][0] || c1c3Actual[1][0] !== c1c3Nuevo[1][0]) hoja.getRange("C1:C3").setValues(c1c3Nuevo);

  let q1q2Actual = hoja.getRange("Q1:Q2").getValues();
  let q1q2Nuevo = [ ["Bultos (Preforma): " + totalBultosPreforma], ["Pedimentos (Preforma): " + totalPedimentosPreforma] ];
  if (q1q2Actual[0][0] !== q1q2Nuevo[0][0] || q1q2Actual[1][0] !== q1q2Nuevo[1][0]) hoja.getRange("Q1:Q2").setValues(q1q2Nuevo);

  if (!esRezago) {
      sincronizarMovidosBodegaDesdeCache(source, cacheInfo, guiasAfectadas);
  }
}

// =========================================================================
// CEREBRO PRINCIPAL: BODEGAS (M-S)
// =========================================================================
function actualizarConteos(hoja, source, cacheInfo) {
  const ultimaFila = Math.max(hoja.getLastRow(), 1);
  if (ultimaFila < 1) return;

  asegurarColumnas(hoja, 12);
  const datosMasivos = hoja.getRange(1, 1, ultimaFila, 12).getValues();
  const horaActual = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "HH:mm:ss");
  const nombreHojaMayus = claveHoja(hoja.getName());

  let dupExternos = calcularDuplicadosExternos(datosMasivos, ultimaFila, nombreHojaMayus, cacheInfo);

  let resultadosB = []; let resultadosHoras = []; let coloresB = [];
  let fontLinesA = []; let fontColorsA = [];

  for (let i = 0; i < ultimaFila; i++) {
    let valB = String(datosMasivos[i][0]).trim();
    let estB = String(datosMasivos[i][1]).trim();
    let esErrEstructura = estB.startsWith("🛑 ERROR");
    let esMovido = estB.startsWith("➡ Movido a");
    let dup = dupExternos.get(i);

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
      let esErr = resultadosB[i][0] !== '' && !resultadosB[i][0].startsWith("➡ Movido a");

      if (/^\d{7}$/.test(v)) {
          if (!esErr) totalPedimentos++;
          if (pedimentosVistosFisico.has(v)) filasDuplicadasFisico.add(i); else pedimentosVistosFisico.add(v);
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

  let guiasYaAsignadasGlobal = new Map();
  let totalSimples = 0; let totalMultiples = 0; let totalA1 = 0; let totalCuentasEspeciales = 0;
  let totalMovidas = 0;

  let esM_SA1 = nombreHojaMayus.indexOf("A1") !== -1;
  let esCuentasEspeciales = nombreHojaMayus.indexOf("CUENTAS ESPECIALES") !== -1;

  bloquesFisicos.forEach(bloque => {
      let guiasUnicas = new Set(); let basesUnicas = new Set();
      let movidas = 0;

      bloque.guias.forEach((g, idx) => {
          let filaG = bloque.filasGuias[idx];
          let statusActual = resultadosB[filaG][0];

          if (statusActual.startsWith("➡ Movido a")) {
              movidas++; totalMovidas++;
              guiasUnicas.add(g);
              if (g.length >= 10) basesUnicas.add(g.substring(0, 10)); else basesUnicas.add(g);
          } else if (guiasUnicas.has(g)) {
              resultadosB[filaG][0] = "🔄 Duplicado local"; coloresB[filaG][0] = "#acacac";
          } else if (guiasYaAsignadasGlobal.has(g)) {
              resultadosB[filaG][0] = "⛔ Duplicado local (Ya en Ped: " + guiasYaAsignadasGlobal.get(g) + ")"; coloresB[filaG][0] = "#ff9800";
          } else {
              guiasYaAsignadasGlobal.set(g, bloque.pedimento);
              guiasUnicas.add(g);
              if (g.length >= 10) basesUnicas.add(g.substring(0, 10)); else basesUnicas.add(g);
              resultadosB[filaG][0] = "✅ Guía"; coloresB[filaG][0] = "#71b3e6";
          }
      });

      if (!bloque.esErr && bloque.pedimento !== "SIN_CABECERA") {
          let faltantes = guiasUnicas.size - movidas;
          let tipoStr = "";
          let msg = "";

          if (esM_SA1) { tipoStr = "M-S A1"; totalA1++; }
          else if (esCuentasEspeciales) { tipoStr = "M-S CTAS ESP"; totalCuentasEspeciales++; }
          else if (basesUnicas.size === 1) { tipoStr = "M-S T1"; totalSimples++; }
          else if (basesUnicas.size > 1) { tipoStr = "M-S GLOBALES"; totalMultiples++; }

          if (guiasUnicas.size === 0) {
              msg = "⏳ Esperando guías...";
              coloresB[bloque.filaPedimento][0] = "#e2e3e5";
          } else if (faltantes === 0) {
              msg = "Bultos: " + guiasUnicas.size + " (" + tipoStr + ") | ✅ TODO MOVIDO";
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

  filasDuplicadasFisico.forEach(fila => {
      if (!resultadosB[fila][0].startsWith("⛔")) {
          resultadosB[fila][0] = "🛑 PEDIMENTO REPETIDO";
          coloresB[fila][0] = "#dc3545";
      }
  });

  aplicarCambiosOptimizado(hoja, 2, 12, 1, 11, resultadosB, resultadosHoras, datosMasivos, coloresB, fontLinesA, fontColorsA);

  let fila3Resumen;
  if (esM_SA1) fila3Resumen = "M-S A1: " + totalA1;
  else if (esCuentasEspeciales) fila3Resumen = "M-S CTAS ESP: " + totalCuentasEspeciales;
  else fila3Resumen = "M-S T1: " + totalSimples + " | M-S GLOBALES: " + totalMultiples;

  // El total incluye las guías ya movidas; se desglosa para no perder el dato
  // de cuántas siguen físicamente en la bodega.
  let textoBultos = "Total bultos: " + guiasGlobales.size;
  if (totalMovidas > 0) textoBultos += " (movidos: " + totalMovidas + " | en bodega: " + (guiasGlobales.size - totalMovidas) + ")";

  let nuevosResumenes = [ [textoBultos], ["Total pedimentos: " + totalPedimentos], [fila3Resumen] ];
  let actualesResumenes = hoja.getRange("C1:C3").getValues();
  if (actualesResumenes[0][0] !== nuevosResumenes[0][0] ||
      actualesResumenes[1][0] !== nuevosResumenes[1][0] ||
      actualesResumenes[2][0] !== nuevosResumenes[2][0]) {
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
function actualizarInventario(hoja, cacheInfo) {
  const ultimaFila = Math.max(hoja.getLastRow(), 1);
  asegurarColumnas(hoja, 12);

  const datosMasivos = hoja.getRange(1, 1, ultimaFila, 12).getValues();
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
          if (v === "" || v.startsWith("IW") || /^\d{7}$/.test(v)) continue;

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
    let esErrEstructura = estB.startsWith("🛑 ERROR");
    let dup = dupInventario.get(i);

    let fijo = '';
    let color = '#FFFFFF';
    if (esErrEstructura) { fijo = estB; color = '#ffc107'; }
    else if (dup) { fijo = dup; color = '#ff9800'; }

    resultadosB.push([fijo]);
    resultadosHoras.push([horaPreservada(datosMasivos, i, 11, valA, horaActual)]);
    coloresB.push([color]);
  }

  let filaUbicacionActual = -1; let ultimaFilaGuia = -1;
  let guiasFisicas = new Set(); let totalUbicaciones = 0; let totalBultosInventario = 0;

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
      if (guiasFisicas.has(valor)) {
          resultadosB[i][0] = "🔄 Duplicado local"; coloresB[i][0] = "#acacac";
      } else {
          guiasFisicas.add(valor);
          resultadosB[i][0] = "✅ Ok"; coloresB[i][0] = "#07c369";
          ultimaFilaGuia = i;
      }
    }
  }
  cerrarUbicacion();

  aplicarCambiosOptimizado(hoja, 2, 12, 1, 11, resultadosB, resultadosHoras, datosMasivos, coloresB, null, null);

  let c1c3Actual = hoja.getRange("C1:C3").getValues();
  let c1c3Nuevo = [ ["Total bultos: " + totalBultosInventario], ["Ubicaciones (IW): " + totalUbicaciones], [""] ];
  if (c1c3Actual[0][0] !== c1c3Nuevo[0][0] || c1c3Actual[1][0] !== c1c3Nuevo[1][0]) {
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
    .addItem('⚙️ Instalar trigger avanzado (recomendado)', 'instalarTriggerAvanzado')
    .addItem('↩️ Volver al trigger simple', 'desinstalarTriggerAvanzado')
    .addToUi();
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

    recalcularHoja(hoja, ss, cacheInfo, null);
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

        if (esHojaBodega(nombreHoja) || esHojaInventario(nombreHoja)) {
            let datos = hoja.getRange(2, 1, lr - 1, 2).getValues();
            for (let i = 0; i < datos.length; i++) {
                if (String(datos[i][0]).trim() !== "" && String(datos[i][1]).trim() === "") { necesitaActualizar = true; break; }
            }
        } else if (esHojaPrincipal(nombreHoja)) {
            if (hoja.getMaxColumns() >= 16) {
                let datosFisicos = hoja.getRange(2, 1, lr - 1, 2).getValues();
                let datosPreforma = hoja.getRange(2, 15, lr - 1, 2).getValues();
                for (let i = 0; i < datosFisicos.length; i++) {
                    if (String(datosFisicos[i][0]).trim() !== "" && String(datosFisicos[i][1]).trim() === "") { necesitaActualizar = true; break; }
                    if (String(datosPreforma[i][0]).trim() !== "" && String(datosPreforma[i][1]).trim() === "") { necesitaActualizar = true; break; }
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
    sincronizarMovidosBodegaDesdeCache(ss, cacheInfo, null);
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
    const colsToMove = 14;
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

    let datosBodega = obtenerDatosBodegaDesdeCache(cacheInfo, nombreHoja);
    datosBodega.preformaBodega.forEach((guias, ped) => {
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
      let valB = String(fila[1]).trim();
      if (valA === "") continue;

      let estaMovida = valB.toUpperCase().startsWith("➡ MOVIDO A");

      if (/^\d{7}$/.test(valA)) {
          pedFisicoActual = valA;
          if (estaMovida) continue;
          if (!agrupacion.has(pedFisicoActual)) agrupacion.set(pedFisicoActual, { cabecera: fila, guias: [] });
          else agrupacion.get(pedFisicoActual).cabecera = fila;
      } else {
          if (estaMovida) continue;
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
        if (valB.toUpperCase().startsWith("➡ MOVIDO A")) {
            paraEliminar.add(i);
            let guiaBorrada = String(valores[i][0]).trim();
            if (guiaBorrada !== "") {
                filasHistorial.push(eventoHistorial(nombreHoja, filaInicio + i, "Físico (Col A)", guiaBorrada, valB, "LIMPIEZA DE GUÍA MOVIDA"));
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
