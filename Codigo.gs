// Variables globales de memoria (Sobreviven entre escaneos rápidos)
let globalCacheData = null;
let globalCacheHeaders = null;
let globalCacheMap = null; // Índice O(1) con soporte para múltiples ubicaciones por guía

function onEdit(e) {
  if (!e || !e.source) return;

  const lock = LockService.getDocumentLock();
  try {
    lock.waitLock(3000);
  } catch (lockError) {
    return;
  }

  try {
    const hoja = e.source.getActiveSheet();
    const celda = e.range;
    const colInicial = celda.getColumn();
    const filaInicial = celda.getRow();
    const numRows = celda.getNumRows();
    const numCols = celda.getNumColumns();
    const nombreHoja = hoja.getName().toUpperCase();

    // =========================================================================
    // SISTEMA: SINCRONIZACIÓN MAESTRA DE HOJA "MACHO"
    // =========================================================================
    if (colInicial <= 13 && (colInicial + numCols - 1) >= 13) {
        if (nombreHoja === "MACHO") {
            sincronizarMacho(hoja, e.source);
            e.source.toast('✅ Columna M sincronizada en todas las pestañas', 'Sincronización MACHO', 4);
        }
        if (numCols === 1 && colInicial === 13) return;
    }

    const colsValidas = [1, 4, 14, 15, 17];
    let tocaValida = false;
    for (let c = 0; c < numCols; c++) {
        if (colsValidas.includes(colInicial + c)) tocaValida = true;
    }
    if (!tocaValida) return;

    let valoresEditados = celda.getValues();
    let huboCambiosRelevantes = false;
    let esModoInventario = nombreHoja.includes("INVENTARIO");

    // LECTURA DE CACHÉ SÚPER RÁPIDA (RAM)
    let cacheInfo = getCacheData(e.source);

    // Variables para Batch Writes (Escritura en lote) de errores
    let batchUpdates = [];
    let valsC12 = (colInicial <= 1 && colInicial + numCols - 1 >= 1) ? hoja.getRange(filaInicial, 12, numRows, 1).getValues() : null;

    for (let r = 0; r < numRows; r++) {
        for (let c = 0; c < numCols; c++) {
            let filaActual = filaInicial + r;
            let colActual = colInicial + c;

            if (!colsValidas.includes(colActual) || filaActual < 1) continue;

            let valRaw = valoresEditados[r][c];
            let valorIngresado = typeof valRaw === 'string' ? valRaw.trim().toUpperCase() : String(valRaw);

            // DETECTAR BORRADOS
            if (valorIngresado === "" && (colActual === 1 || colActual === 15)) {
                let celdaEstadoRelacionada = hoja.getRange(filaActual, colActual === 1 ? 2 : 16);
                let valorAnteriorEstado = String(celdaEstadoRelacionada.getValue()).trim();

                let valorBorrado = "";
                if (cacheInfo && cacheInfo.headers) {
                    let sufijo = (colActual === 1) ? "_FISICO" : "_PREFORMA";
                    let idx = cacheInfo.headers.indexOf(nombreHoja + sufijo);
                    if (idx !== -1 && cacheInfo.data.length > filaActual) {
                        valorBorrado = String(cacheInfo.data[filaActual][idx]).trim();
                    }
                }

                if (valorBorrado !== "") {
                    let tipoCol = (colActual === 1) ? "Físico (Col A)" : "Preforma (Col O)";
                    registrarEnHistorial(e.source, nombreHoja, filaActual, tipoCol, valorBorrado, valorAnteriorEstado, "BORRADO MANUAL (Celda vaciada)");
                }
            }

            if (valorIngresado === "" && colActual !== 14) continue;
            huboCambiosRelevantes = true;

            if (colActual === 1 || colActual === 15) {
                let clean = valorIngresado.replace(/[^A-Z0-9]/g, '');
                if (valorIngresado !== clean) {
                    batchUpdates.push({row: filaActual, col: colActual, val: clean});
                    valorIngresado = clean;
                    valoresEditados[r][c] = clean;
                }
            }

            // OPTIMIZACIÓN: Se acumulan los errores estructurales para escribirlos en bloque
            if ((colActual === 1 || colActual === 15) && /^\d{1,6}$/.test(valorIngresado)) {
                let colEstado = (colActual === 1) ? 2 : 16;
                let colHora = (colActual === 1) ? 12 : 19;
                let faltantes = 7 - valorIngresado.length;
                let textoNum = faltantes === 1 ? "número" : "números";

                batchUpdates.push({row: filaActual, col: colEstado, val: "🛑 ERROR: Faltan " + faltantes + " " + textoNum, bg: "#ffc107"});
                batchUpdates.push({row: filaActual, col: colHora, clear: true});
                continue;
            }

            // BÚSQUEDA SÚPER RÁPIDA DE DUPLICADOS EN ARRAY DE MEMORIA
            if (colActual === 1 && valorIngresado !== "COSTALES") {
                let duplicadoInfo = verificarDuplicadoConCache(cacheInfo, nombreHoja, valorIngresado);

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
                procesarCostales(hoja, filaActual, cacheInfo);
            }
        }
    }

    // APLICAR ESCRITURAS EN LOTE (BATCH) PARA MAXIMIZAR RENDIMIENTO
    if (batchUpdates.length > 0) {
        let minRow = filaInicial;
        let rowCount = numRows;
        [1, 2, 12, 15, 16, 19].forEach(col => {
            let updates = batchUpdates.filter(u => u.col === col);
            if (updates.length > 0) {
                let range = hoja.getRange(minRow, col, rowCount, 1);
                let vals = range.getValues();
                let bgs = updates.some(u => u.bg) ? range.getBackgrounds() : null;

                updates.forEach(u => {
                    let idx = u.row - minRow;
                    if (u.clear) vals[idx][0] = "";
                    else if (u.val !== undefined) vals[idx][0] = u.val;
                    if (u.bg) bgs[idx][0] = u.bg;
                });

                range.setValues(vals);
                if (bgs) range.setBackgrounds(bgs);
            }
        });
    }

    if (huboCambiosRelevantes) {
        if (esModoInventario) {
            actualizarInventario(hoja);
        } else if (esHojaBodega(nombreHoja)) {
            actualizarConteos(hoja, e.source);
        } else if (esHojaPrincipal(nombreHoja)) {
            actualizarGlobalPreforma(hoja, e.source, cacheInfo);
        }

        actualizarBloqueEnCache(e.source, nombreHoja, filaInicial, numRows, colInicial, numCols, valoresEditados);
    }

  } finally {
    lock.releaseLock();
  }
}

// =========================================================================
// SISTEMA DE LECTURA DE CACHÉ OPTIMIZADO (Soporta múltiples ubicaciones)
// =========================================================================
function getCacheData(source) {
    if (globalCacheData && globalCacheMap) return { data: globalCacheData, headers: globalCacheHeaders, map: globalCacheMap };

    let cacheSheet = source.getSheetByName("CACHE_SISTEMA");
    if (!cacheSheet) return null;

    let lr = cacheSheet.getLastRow();
    let lc = cacheSheet.getLastColumn(); // OPTIMIZADO: Lee solo columnas reales
    if (lr < 1 || lc < 1) return null;

    let fullData = cacheSheet.getRange(1, 1, lr, lc).getValues();
    globalCacheHeaders = fullData[0];
    globalCacheData = fullData;

    globalCacheMap = new Map();
    for (let c = 0; c < globalCacheHeaders.length; c++) {
        let header = String(globalCacheHeaders[c]);
        if (header.endsWith("_FISICO")) {
            let hojaHeader = header.replace("_FISICO", "");
            let isBodegaHeader = esHojaBodega(hojaHeader);
            let isInventarioHeader = hojaHeader.includes("INVENTARIO");

            for (let r = 1; r < globalCacheData.length; r++) {
                let v = String(globalCacheData[r][c]).trim().toUpperCase();
                if (v !== "") {
                    let arr = globalCacheMap.get(v) || [];
                    arr.push({ hoja: hojaHeader, fila: r, isBodega: isBodegaHeader, isInventario: isInventarioHeader });
                    globalCacheMap.set(v, arr);
                }
            }
        }
    }

    return { data: globalCacheData, headers: globalCacheHeaders, map: globalCacheMap };
}

function verificarDuplicadoConCache(cacheInfo, nombreHojaActual, guiaBuscada) {
    if (!cacheInfo || !cacheInfo.map) return { encontrado: false };

    let isCurrentBodega = esHojaBodega(nombreHojaActual);
    let isCurrentInv = nombreHojaActual.includes("INVENTARIO");
    let matches = cacheInfo.map.get(guiaBuscada);

    if (matches) {
        for (let i = 0; i < matches.length; i++) {
            let match = matches[i];
            if (match.hoja === nombreHojaActual) continue;

            // OPTIMIZADO: Aislar INVENTARIO estrictamente de las demás áreas
            if (isCurrentInv) {
                if (match.isInventario) return { encontrado: true, ubicacion: match.hoja + " Fila " + match.fila };
            }
            else if (isCurrentBodega) {
                if (match.isBodega) return { encontrado: true, ubicacion: match.hoja + " Fila " + match.fila };
            }
            else {
                // GLOBAL, REZAGO, etc.
                if (!match.isBodega && !match.isInventario) {
                    return { encontrado: true, ubicacion: match.hoja + " Fila " + match.fila };
                }
            }
        }
    }

    return { encontrado: false };
}

// =========================================================================
// ESCRITURA EN RAM CON LIMPIEZA INTELIGENTE DE BORRADOS
// =========================================================================
function actualizarBloqueEnCache(source, nombreHoja, filaInicial, numRows, colInicial, numCols, valoresEditados) {
    let cacheSheet = source.getSheetByName("CACHE_SISTEMA");

    if (!cacheSheet) {
        actualizarFotografiaMental(source.getSheetByName(nombreHoja), source);
        return;
    }
    let maxCols = Math.max(cacheSheet.getLastColumn(), 1); // OPTIMIZADO
    let headers = cacheSheet.getRange(1, 1, 1, maxCols).getValues()[0];

    if (headers.indexOf(nombreHoja + "_FISICO") === -1) {
        actualizarFotografiaMental(source.getSheetByName(nombreHoja), source);
        return;
    }

    let isBodegaActual = esHojaBodega(nombreHoja);
    let isInventarioActual = nombreHoja.includes("INVENTARIO");

    // Expandir matriz RAM dinámicamente si los nuevos escaneos exceden las filas actuales
    if (globalCacheData) {
        while (globalCacheData.length <= filaInicial + numRows) {
            globalCacheData.push(new Array(headers.length).fill(""));
        }
    }

    if (colInicial <= 1 && colInicial + numCols - 1 >= 1) {
        let idxData = 1 - colInicial;
        let colIdx = headers.indexOf(nombreHoja + "_FISICO");
        if (colIdx >= 0) {
            let valsToSet = [];
            for(let r=0; r<numRows; r++) {
                let val = valoresEditados[r][idxData];
                valsToSet.push([val]);

                // Mantenimiento de Memoria RAM
                if (globalCacheData) {
                    let oldVal = globalCacheData[filaInicial + r][colIdx];
                    let oldStr = String(oldVal).trim().toUpperCase();
                    let vStr = String(val).trim().toUpperCase();

                    globalCacheData[filaInicial + r][colIdx] = val;

                    if (globalCacheMap) {
                        // 1. Elimina el rastro viejo de RAM instantáneamente si lo borraste en la hoja
                        if (oldStr !== "" && oldStr !== vStr) {
                            let arr = globalCacheMap.get(oldStr);
                            if (arr) {
                                let newArr = arr.filter(m => !(m.hoja === nombreHoja && m.fila === filaInicial + r));
                                if (newArr.length === 0) globalCacheMap.delete(oldStr);
                                else globalCacheMap.set(oldStr, newArr);
                            }
                        }
                        // 2. Agrega el nuevo dato
                        if (vStr !== "") {
                            let arr = globalCacheMap.get(vStr) || [];
                            if (!arr.some(m => m.hoja === nombreHoja && m.fila === filaInicial + r)) {
                                arr.push({ hoja: nombreHoja, fila: filaInicial + r, isBodega: isBodegaActual, isInventario: isInventarioActual });
                                globalCacheMap.set(vStr, arr);
                            }
                        }
                    }
                }
            }
            cacheSheet.getRange(filaInicial + 1, colIdx + 1, numRows, 1).setValues(valsToSet);
        }
    }

    if (colInicial <= 15 && colInicial + numCols - 1 >= 15) {
        let idxData = 15 - colInicial;
        let colIdx = headers.indexOf(nombreHoja + "_PREFORMA");
        if (colIdx >= 0) {
            let valsToSet = [];
            for(let r=0; r<numRows; r++) {
                let val = valoresEditados[r][idxData];
                valsToSet.push([val]);

                if (globalCacheData) {
                    globalCacheData[filaInicial + r][colIdx] = val;
                }
            }
            cacheSheet.getRange(filaInicial + 1, colIdx + 1, numRows, 1).setValues(valsToSet);
        }
    }
}

function actualizarFotografiaMental(hoja, source) {
    let nHoja = hoja.getName();
    if (nHoja === "MACHO" || nHoja.includes("HISTORIAL") || nHoja === "CACHE_SISTEMA") return;

    let cacheSheet = source.getSheetByName("CACHE_SISTEMA");
    if (!cacheSheet) {
        cacheSheet = source.insertSheet("CACHE_SISTEMA").hideSheet();
    }

    let lr = hoja.getLastRow();
    if (lr < 1) lr = 1;

    if (lr + 1 > cacheSheet.getMaxRows()) {
        cacheSheet.insertRowsAfter(cacheSheet.getMaxRows(), (lr + 1 - cacheSheet.getMaxRows()) + 100);
    }

    let maxCols = Math.max(cacheSheet.getLastColumn(), 1); // OPTIMIZADO
    let headers = cacheSheet.getRange(1, 1, 1, maxCols).getValues()[0];

    let colFisico = -1; let colPreforma = -1;
    let headerFisico = nHoja + "_FISICO"; let headerPreforma = nHoja + "_PREFORMA";

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

        cacheSheet.getRange(1, colFisico).setValue(headerFisico);
        cacheSheet.getRange(1, colPreforma).setValue(headerPreforma);
    }

    let maxFilasCache = cacheSheet.getMaxRows();
    if (maxFilasCache > 1) {
        cacheSheet.getRange(2, colFisico, maxFilasCache - 1, 1).clearContent();
        cacheSheet.getRange(2, colPreforma, maxFilasCache - 1, 1).clearContent();
    }

    let valsFisico = hoja.getRange(1, 1, lr, 1).getValues();
    let valsPreforma = hoja.getRange(1, 15, lr, 1).getValues();

    cacheSheet.getRange(2, colFisico, lr, 1).setValues(valsFisico);
    cacheSheet.getRange(2, colPreforma, lr, 1).setValues(valsPreforma);
}

// =========================================================================
// HISTORIAL Y SINCRONIZACIÓN
// =========================================================================
function registrarEnHistorial(source, hojaAfectada, fila, columnaStr, valorBorrado, estadoAnterior, motivo) {
    let ss = source;
    let hojaHistorial = ss.getSheetByName("HISTORIAL_BORRADOS");

    if (!hojaHistorial) {
        hojaHistorial = ss.insertSheet("HISTORIAL_BORRADOS");
        hojaHistorial.appendRow(["FECHA Y HORA", "PESTAÑA", "FILA", "COLUMNA", "GUÍA/PEDIMENTO BORRADO", "ESTADO ANTERIOR", "MOTIVO"]);
        hojaHistorial.getRange("A1:G1").setFontWeight("bold").setBackground("#d9d9d9");
        hojaHistorial.setFrozenRows(1);
    }

    let fechaHora = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "dd/MM/yyyy HH:mm:ss");
    hojaHistorial.appendRow([fechaHora, hojaAfectada, fila, columnaStr, valorBorrado, estadoAnterior, motivo]);
}

function sincronizarMacho(hojaMacho, source) {
    let ultimaFila = hojaMacho.getLastRow();
    let valoresMacho = [];
    if (ultimaFila > 0) valoresMacho = hojaMacho.getRange(1, 13, ultimaFila, 1).getValues();
    let hojas = source.getSheets();
    for (let i = 0; i < hojas.length; i++) {
        let hojaDestino = hojas[i];
        if (hojaDestino.getName().toUpperCase() !== "MACHO") {
            let maxRows = hojaDestino.getMaxRows();
            if (maxRows > 0) hojaDestino.getRange(1, 13, maxRows, 1).clearContent();
            if (valoresMacho.length > 0) {
                if (maxRows < valoresMacho.length) hojaDestino.insertRowsAfter(maxRows, valoresMacho.length - maxRows);
                hojaDestino.getRange(1, 13, valoresMacho.length, 1).setValues(valoresMacho);
            }
        }
    }
}

function esHojaBodega(nombreHoja) {
    let n = nombreHoja.toUpperCase();
    if (n.startsWith("M-S ") || n.startsWith("SIMPLES") || n.startsWith("MULTIPLES")) return true;
    return false;
}

function esHojaPrincipal(nombreHoja) {
    let n = nombreHoja.toUpperCase();
    if (n === "MACHO" || n.includes("INVENTARIO") || esHojaBodega(n)) return false;
    return true;
}

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

// =========================================================================
// PRE-PROCESAMIENTO OPTIMIZADO PARA PREFORMA/BODEGA
// =========================================================================
function obtenerGuiasRezagoDesdeCache(cacheInfo) {
    let guias = new Map();
    if (!cacheInfo || !cacheInfo.headers) return guias;

    for (let c = 0; c < cacheInfo.headers.length; c++) {
        let header = String(cacheInfo.headers[c]);
        if (header.endsWith("_PREFORMA")) {
            let nombreHoja = header.replace("_PREFORMA", "");
            if (nombreHoja.includes("REZAGO")) {
                let pedActual = "";
                for (let r = 1; r < cacheInfo.data.length; r++) {
                    let v = String(cacheInfo.data[r][c]).trim().toUpperCase();
                    if (/^\d{7}$/.test(v)) pedActual = v;
                    else if (v !== "") guias.set(v, { hoja: nombreHoja, pedimento: pedActual });
                }
            }
        }
    }
    return guias;
}

function obtenerDatosBodegaDesdeCache(cacheInfo, nombreHojaActual) {
    let guiasOrigen = new Map();
    let preformaBodega = new Map();
    if (!cacheInfo || !cacheInfo.headers) return { guiasOrigen: guiasOrigen, preformaBodega: preformaBodega };

    let esA1 = nombreHojaActual.toUpperCase().includes("A1");
    let esCtasEsp = nombreHojaActual.toUpperCase().includes("CUENTAS ESPECIALES");

    for (let c = 0; c < cacheInfo.headers.length; c++) {
        let header = String(cacheInfo.headers[c]);
        if (header.endsWith("_FISICO")) {
            let nombreHoja = header.replace("_FISICO", "").toUpperCase();
            let origen = "";

            if (esHojaBodega(nombreHoja)) {
                if (nombreHoja.startsWith("M-S T1") || nombreHoja.startsWith("SIMPLES")) origen = "M-S T1";
                else if (nombreHoja.startsWith("M-S GLOBALES") || nombreHoja.startsWith("MULTIPLES")) origen = "M-S GLOBALES";
                else if (nombreHoja.startsWith("M-S A1")) origen = "M-S A1";
                else if (nombreHoja.startsWith("M-S SEGUIMIENTOS")) origen = "M-S SEGUIMIENTOS";
                else if (nombreHoja.startsWith("M-S CUENTAS ESPECIALES")) origen = "M-S CTAS ESP";
            }

            if (origen !== "" && nombreHoja !== nombreHojaActual.toUpperCase()) {
                if (esA1) {
                } else if (esCtasEsp) {
                    if (origen !== "M-S CTAS ESP") continue;
                } else {
                    if (origen === "M-S A1" || origen === "M-S CTAS ESP") continue;
                }

                let pedActual = "";
                for (let r = 1; r < cacheInfo.data.length; r++) {
                    let v = String(cacheInfo.data[r][c]).trim().toUpperCase();
                    if (/^\d{7}$/.test(v)) {
                        pedActual = v;
                        if (!preformaBodega.has(pedActual)) preformaBodega.set(pedActual, new Set());
                    } else if (v !== "") {
                        if (!guiasOrigen.has(v)) {
                            guiasOrigen.set(v, origen);
                        }
                        if (pedActual !== "") preformaBodega.get(pedActual).add(v);
                    }
                }
            }
        }
    }
    return { guiasOrigen: guiasOrigen, preformaBodega: preformaBodega };
}

function sincronizarMovidosBodegaDesdeCache(source, cacheInfo) {
    if (!cacheInfo || !cacheInfo.headers) return;
    let escaneadosDestino = new Map();

    for (let c = 0; c < cacheInfo.headers.length; c++) {
        let header = String(cacheInfo.headers[c]);
        if (header.endsWith("_FISICO")) {
            let n = header.replace("_FISICO", "");
            if (!esHojaBodega(n) && !n.includes("INVENTARIO") && n !== "MACHO" && !n.includes("REZAGO")) {
                for (let r = 1; r < cacheInfo.data.length; r++) {
                    let v = String(cacheInfo.data[r][c]).trim().toUpperCase();
                    if (v !== "" && !/^\d{7}$/.test(v)) escaneadosDestino.set(v, n);
                }
            }
        }
    }

    let hojas = source.getSheets();
    let bodegasModificadas = [];
    for (let i = 0; i < hojas.length; i++) {
        let hojaBodega = hojas[i];
        let nBodega = hojaBodega.getName().toUpperCase();

        if (esHojaBodega(nBodega)) {
            let lr = hojaBodega.getLastRow();
            if (lr < 1) continue;

            let rangoStatus = hojaBodega.getRange(1, 1, lr, 2);
            let vals = rangoStatus.getValues();
            let modificados = false;

            for (let r = 0; r < lr; r++) {
                let v = String(vals[r][0]).trim().toUpperCase();

                if (v !== "" && !/^\d{7}$/.test(v)) {
                    let statusActual = String(vals[r][1]).trim();
                    let destino = escaneadosDestino.get(v);

                    if (destino) {
                        let textoEsperado = "➡ Movido a " + destino;
                        if (statusActual !== textoEsperado) {
                            vals[r][1] = textoEsperado;
                            modificados = true;
                        }
                    } else if (statusActual.startsWith("➡ Movido a")) {
                        vals[r][1] = "";
                        modificados = true;
                    }
                }
            }

            if (modificados) {
                rangoStatus.setValues(vals);
                bodegasModificadas.push(hojaBodega);
            }
        }
    }

    bodegasModificadas.forEach(hojaBodega => {
        actualizarConteos(hojaBodega, source);
    });
}

function aplicarCambiosOptimizado(hoja, colStatus, colHora, idxStatusOriginal, idxHoraOriginal, resultadosStatus, resultadosHoras, datosMasivos, coloresNuevos, fontLinesA, fontColorsA) {
    let bloques = []; let min = -1, max = -1;
    for (let i = 0; i < resultadosStatus.length; i++) {
        let originalStatus = datosMasivos[i] ? String(datosMasivos[i][idxStatusOriginal]) : "";
        let originalHora = datosMasivos[i] ? String(datosMasivos[i][idxHoraOriginal]) : "";
        let nuevaHora = String(resultadosHoras[i][0]);

        if (String(resultadosStatus[i][0]) !== originalStatus || (originalHora === "" && nuevaHora !== "")) {
            if (min === -1) { min = i; max = i; }
            else { if (i - max > 2) { bloques.push({min: min, max: max}); min = i; max = i; } else { max = i; } }
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

// =========================================================================
// OPTIMIZACIÓN: Preforma unificada
// =========================================================================
function procesarCostales(hoja, filaDestino, cacheInfo) {
  const ultimaFila = Math.max(hoja.getLastRow(), 1);
  const datosOaQ = hoja.getRange(1, 15, ultimaFila, 3).getValues();

  let inicioCostal = -1; let finCostal = -1;
  for (let i = 0; i < ultimaFila; i++) if (String(datosOaQ[i][2]).trim().toUpperCase() === "COSTALES") { inicioCostal = i; break; }
  if (inicioCostal === -1) { hoja.getRange(filaDestino, 4).setValue("⚠️ NO HAY COSTAL EN PREFORMA"); return; }

  for (let i = inicioCostal; i < ultimaFila; i++) {
    let valO = String(datosOaQ[i][0]).trim(); let marca = String(datosOaQ[i][2]).trim().toUpperCase();
    if (marca === "FIN") { finCostal = i; break; } else if (valO === "") { finCostal = i - 1; break; }
  }
  if (finCostal === -1) finCostal = ultimaFila - 1;

  let pedimentosOrdenados = [];
  let guiasTemp = [];
  for (let i = inicioCostal; i <= finCostal; i++) {
    let valO = String(datosOaQ[i][0]).trim().toUpperCase(); if (valO === "") continue;
    if (/^\d{7}$/.test(valO)) {
        pedimentosOrdenados.push({ pedimento: valO, guias: [...guiasTemp] });
        guiasTemp = [];
    } else {
        guiasTemp.push(valO);
    }
  }
  if (guiasTemp.length > 0) pedimentosOrdenados.push({ pedimento: "⚠️ SIN PEDIMENTO", guias: [...guiasTemp] });

  let datosAPegar = []; let tiposAPegar = [];
  pedimentosOrdenados.forEach(bloque => {
    datosAPegar.push([bloque.pedimento]); tiposAPegar.push(["COSTALES"]);
    bloque.guias.forEach(g => { datosAPegar.push([g]); tiposAPegar.push([""]); });
  });
  if (datosAPegar.length === 0) return;

  hoja.getRange(filaDestino, 1, datosAPegar.length, 1).setValues(datosAPegar);
  hoja.getRange(filaDestino, 4, tiposAPegar.length, 1).setValues(tiposAPegar);
  hoja.getRange(inicioCostal + 1, 17).setValue("✅ COSTAL PROCESADO");

  let nHoja = hoja.getName().toUpperCase();
  if (esHojaPrincipal(nHoja) || esHojaBodega(nHoja)) {
      actualizarGlobalPreforma(hoja, hoja.getParent(), cacheInfo);
  } else {
      actualizarConteos(hoja, hoja.getParent());
  }
}

// =========================================================================
// CEREBRO PRINCIPAL PARA GLOBALES, T1, REZAGO, PREFORMA Y AGA
// =========================================================================
function actualizarGlobalPreforma(hoja, source, cacheInfo) {
  const ultimaFila = Math.max(hoja.getLastRow(), 1); if (ultimaFila < 1) return;

  const maxCol = hoja.getMaxColumns();
  if (maxCol < 19) hoja.insertColumnsAfter(maxCol, 19 - maxCol);

  const datosMasivos = hoja.getRange(1, 1, ultimaFila, 19).getValues();
  let horaActual = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "HH:mm:ss");

  let nombreHoja = hoja.getName().toUpperCase();
  let esHojaBodegaL = esHojaBodega(nombreHoja);
  let esRezago = nombreHoja.includes("REZAGO");
  let requiereAlertaBodega = !esHojaBodegaL && esHojaPrincipal(nombreHoja) && !esRezago;

  let datosBodega = obtenerDatosBodegaDesdeCache(cacheInfo, nombreHoja);
  let guiasBodega = datosBodega.guiasOrigen;
  let preformaBodega = datosBodega.preformaBodega;
  let guiasRezagoGlobal = esRezago ? obtenerGuiasRezagoDesdeCache(cacheInfo) : null;

  let mapaPreformas = {}; let mapaInversoPreforma = new Map();
  let resultadosP = []; let resultadosHorasP = []; let coloresP = [];
  let coloresColumnaO = [];

  let totalPedimentosPreforma = 0; let totalBultosPreforma = 0;
  let bloquesPreforma = []; let pedimentosVistosPreforma = new Set(); let filasDuplicadasPreforma = new Set();

  for (let i = 0; i < ultimaFila; i++) {
    let valP = String(datosMasivos[i][14]).trim();
    let estP = String(datosMasivos[i][15]).trim();
    let esErrP = estP.startsWith("🛑 ERROR") || estP.startsWith("⛔ DUPLICADO");

    resultadosP.push([esErrP ? estP : '']);

    if (valP === "") {
        resultadosHorasP.push(['']);
    } else {
        resultadosHorasP.push([horaActual]);
    }

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
              bloquesPreforma.push({ pedimento: v, filaPedimento: i, guias: [...gTmp], filasGuias: [...fTmp], esErr: esErrP });
              gTmp = []; fTmp = [];
          } else {
              totalBultosPreforma++; gTmp.push(v); fTmp.push(i);
          }
      }
      if (gTmp.length > 0) bloquesPreforma.push({ pedimento: "SIN_CABECERA", filaPedimento: -1, guias: [...gTmp], filasGuias: [...fTmp], esErr: false });
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
    }

    if (bloque.filaPedimento !== -1) {
        coloresColumnaO[bloque.filaPedimento][0] = colorFondoPreforma;
    }
    bloque.filasGuias.forEach(fG => {
        coloresColumnaO[fG][0] = colorFondoPreforma;
    });

    if (bloque.esErr) return;
    let textoEsperando =  setGuias.size + " bultos";
    if (bloque.filaPedimento !== -1 && !esRezago) resultadosP[bloque.filaPedimento][0] = textoEsperando;
    if (bloque.filasGuias.length > 0 && !esRezago) resultadosP[bloque.filasGuias[bloque.filasGuias.length - 1]][0] = "► Resumen: " + textoEsperando;
  });

  filasDuplicadasPreforma.forEach(fila => {
      if(!resultadosP[fila][0].startsWith("⛔")) {
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
    let esErrExterno = estB.startsWith("⛔ DUPLICADO (En:");
    let esErrEstructura = estB.startsWith("🛑 ERROR");
    let esMovido = estB.startsWith("➡ Movido a");
    let esErrFijo = esErrExterno || esErrEstructura || esMovido;

    resultadosB.push([esErrFijo ? estB : '']);

    if (valB === "") {
        resultadosHoras.push(['']);
    } else {
        resultadosHoras.push([horaActual]);
    }

    coloresB.push([esErrFijo ? (esMovido ? '#e0e0e0' : (esErrExterno ? '#ff9800' : '#ffc107')) : '#FFFFFF']);
  }

  let guiasGlobales = new Set(); let totalPedimentos = 0; let escaneadasEnA = new Set();

  for (let i = 0; i < ultimaFila; i++) {
     let v = String(datosMasivos[i][0]).trim().toUpperCase();
     if (v === "") continue;

     if (/^\d{7}$/.test(v)) { continue; }
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
          if (nombreHoja.includes("CUENTAS ESPECIALES")) {
              txtFalta = " ⚠️ Sin escaneo de M-S CTAS ESP";
          } else if (nombreHoja.includes("A1")) {
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
                      coloresB[filaG][0] = pedimentosCompletos.has(pedReal) ? "#07c369" : "#07c369";
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
                      else if (nombreHoja.includes("A1")) estadoStr = "✅ A1 COMPLETO";
                      else if (nombreHoja.includes("CUENTAS ESPECIALES")) estadoStr = "✅ M-S CTAS ESP";
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
      if(!resultadosB[fila][0].startsWith("⛔")) {
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
            if (faltantesArr.length > 0) {
                resultadosP[bloque.filaPedimento][0] = "⏳ Faltan " + faltantesArr.length + " (" + faltantesArr.join(", ") + ")";
            } else {
                resultadosP[bloque.filaPedimento][0] = "⏳ Faltan " + faltantesArr.length + " bultos";
            }
            coloresP[bloque.filaPedimento][0] = "#FFF3CD";
          }
        }
      });
      totalPedimentos = pedimentosCompletos.size;
  }

  aplicarCambiosOptimizado(hoja, 2, 12, 1, 11, resultadosB, resultadosHoras, datosMasivos, coloresB, null, null);
  aplicarCambiosOptimizado(hoja, 16, 19, 15, 18, resultadosP, resultadosHorasP, datosMasivos, coloresP, null, null);

  hoja.getRange(1, 15, ultimaFila, 1).setBackgrounds(coloresColumnaO);

  let textoPedimentosTop = esRezago ? "Pedimentos (Completos): " : "Total pedimentos: ";
  let c1c3Actual = hoja.getRange("C1:C3").getValues();
  let c1c3Nuevo = [ ["Total bultos: " + guiasGlobales.size], [textoPedimentosTop + totalPedimentos], [""] ];
  if (c1c3Actual[0][0] !== c1c3Nuevo[0][0] || c1c3Actual[1][0] !== c1c3Nuevo[1][0]) hoja.getRange("C1:C3").setValues(c1c3Nuevo);

  let q1q2Actual = hoja.getRange("Q1:Q2").getValues();
  let q1q2Nuevo = [ ["Bultos (Preforma): " + totalBultosPreforma], ["Pedimentos (Preforma): " + totalPedimentosPreforma] ];
  if (q1q2Actual[0][0] !== q1q2Nuevo[0][0] || q1q2Actual[1][0] !== q1q2Nuevo[1][0]) hoja.getRange("Q1:Q2").setValues(q1q2Nuevo);

  if (!esRezago) {
      sincronizarMovidosBodegaDesdeCache(source, cacheInfo);
  }
}

// =========================================================================
// CEREBRO PRINCIPAL PARA BODEGAS (M-S)
// =========================================================================
function actualizarConteos(hoja, source) {
  const ultimaFila = Math.max(hoja.getLastRow(), 1); if (ultimaFila < 1) return;
  const datosMasivos = hoja.getRange(1, 1, ultimaFila, 12).getValues();
  let horaActual = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "HH:mm:ss");

  let resultadosB = []; let resultadosHoras = []; let coloresB = [];
  let fontLinesA = []; let fontColorsA = [];

  for (let i = 0; i < ultimaFila; i++) {
    let valB = String(datosMasivos[i][0]).trim();
    let estB = String(datosMasivos[i][1]).trim();
    let esErrExterno = estB.startsWith("⛔ DUPLICADO (En:");
    let esErrEstructura = estB.startsWith("🛑 ERROR");
    let esMovido = estB.startsWith("➡ Movido a");
    let esErrFijo = esErrExterno || esErrEstructura || esMovido;

    resultadosB.push([esErrFijo ? estB : '']);

    if (valB === "") {
        resultadosHoras.push(['']);
    } else {
        resultadosHoras.push([horaActual]);
    }

    coloresB.push([esErrFijo ? (esMovido ? '#e0e0e0' : (esErrExterno ? '#ff9800' : '#ffc107')) : '#FFFFFF']);

    fontLinesA.push([esMovido ? 'line-through' : 'none']);
    fontColorsA.push([esMovido ? '#9e9e9e' : '#000000']);
  }

  let bloquesFisicos = []; let pedimentosVistosFisico = new Set(); let filasDuplicadasFisico = new Set();
  let bAAct = null; let guiasGlobales = new Set(); let totalPedimentos = 0;

  for (let i = 0; i < ultimaFila; i++) {
      let v = String(datosMasivos[i][0]).trim().toUpperCase(); if (v === "") continue;
      let esErr = resultadosB[i][0] !== '';

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

  let nombreHojaMayus = hoja.getName().toUpperCase();
  let esM_SA1 = nombreHojaMayus.includes("A1");
  let esCuentasEspeciales = nombreHojaMayus.includes("CUENTAS ESPECIALES");

  bloquesFisicos.forEach(bloque => {
      let guiasUnicas = new Set(); let basesUnicas = new Set();
      let movidas = 0;

      bloque.guias.forEach((g, idx) => {
          let filaG = bloque.filasGuias[idx];
          let statusActual = resultadosB[filaG][0];

          if (statusActual.startsWith("➡ Movido a")) {
              movidas++;
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
      if(!resultadosB[fila][0].startsWith("⛔")) {
          resultadosB[fila][0] = "🛑 PEDIMENTO REPETIDO";
          coloresB[fila][0] = "#dc3545";
      }
  });

  aplicarCambiosOptimizado(hoja, 2, 12, 1, 11, resultadosB, resultadosHoras, datosMasivos, coloresB, fontLinesA, fontColorsA);

  let fila3Resumen = "";
  if (esM_SA1) {
      fila3Resumen = "M-S A1: " + totalA1;
  } else if (esCuentasEspeciales) {
      fila3Resumen = "M-S CTAS ESP: " + totalCuentasEspeciales;
  } else {
      fila3Resumen = "M-S T1: " + totalSimples + " | M-S GLOBALES: " + totalMultiples;
  }

  let nuevosResumenes = [ ["Total bultos: " + guiasGlobales.size], ["Total pedimentos: " + totalPedimentos], [fila3Resumen] ];

  let actualesResumenes = hoja.getRange("C1:C3").getValues();
  if (actualesResumenes[0][0] !== nuevosResumenes[0][0] || actualesResumenes[1][0] !== nuevosResumenes[1][0] || actualesResumenes[2][0] !== nuevosResumenes[2][0]) {
      hoja.getRange("C1:C3").setValues(nuevosResumenes);
  }
}

// =========================================================================
// INVENTARIO
// =========================================================================
function actualizarInventario(hoja) {
  const ultimaFila = Math.max(hoja.getLastRow(), 1);
  const datosMasivos = hoja.getRange(1, 1, ultimaFila, 12).getValues();
  let resultadosB = []; let resultadosHoras = []; let horaActual = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "HH:mm:ss");
  let coloresB = [];

  for (let i = 0; i < ultimaFila; i++) {
    let valB = String(datosMasivos[i][0]).trim();
    let estB = String(datosMasivos[i][1]).trim();
    let esErrExterno = estB.startsWith("⛔ DUPLICADO (En:");
    let esErrEstructura = estB.startsWith("🛑 ERROR");
    let esMovido = estB.startsWith("➡ Movido a");
    let esErrFijo = esErrExterno || esErrEstructura || esMovido;

    resultadosB.push([esErrFijo ? estB : '']);

    if (valB === "") {
        resultadosHoras.push(['']);
    } else {
        resultadosHoras.push([horaActual]);
    }

    coloresB.push([esErrFijo ? (esMovido ? '#e0e0e0' : (esErrExterno ? '#ff9800' : '#ffc107')) : '#FFFFFF']);
  }

  let filaUbicacionActual = -1; let ultimaFilaGuia = -1; let guiasFisicas = new Set(); let totalUbicaciones = 0; let totalBultosInventario = 0;
  for (let i = 0; i < ultimaFila; i++) {
    let valor = String(datosMasivos[i][0]).trim().toUpperCase(); if (valor === "") continue;
    let esErr = resultadosB[i][0] !== '';

    if (valor.startsWith("IW")) {
      if (filaUbicacionActual !== -1 && resultadosB[filaUbicacionActual][0] === '') {
          let msg = guiasFisicas.size === 0 ? "⏳ Esperando guías..." : "Bultos: " + guiasFisicas.size;
          if(guiasFisicas.size > 0) totalBultosInventario += guiasFisicas.size;
          resultadosB[filaUbicacionActual][0] = msg; coloresB[filaUbicacionActual][0] = "#178ccc";
          if (ultimaFilaGuia !== -1 && ultimaFilaGuia > filaUbicacionActual) resultadosB[ultimaFilaGuia][0] = "✅ Ok   ►   " + msg;
      }
      if (!esErr) totalUbicaciones++;
      filaUbicacionActual = i; ultimaFilaGuia = -1; guiasFisicas.clear();
    } else {
      let es1ZInvalida = !esGuiaUPSValida(valor);
      if (esErr) {
      } else if (es1ZInvalida) {
          resultadosB[i][0] = "❌ Guía Inválida"; coloresB[i][0] = "#df5f6b";
      } else if (filaUbicacionActual !== -1) {
          if (guiasFisicas.has(valor)) {
              resultadosB[i][0] = "🔄 Duplicado local"; coloresB[i][0] = "#acacac";
          } else {
              guiasFisicas.add(valor); resultadosB[i][0] = "✅ Ok"; coloresB[i][0] = "#07c369"; ultimaFilaGuia = i;
          }
      }
    }
  }
  if (filaUbicacionActual !== -1 && resultadosB[filaUbicacionActual][0] === '') {
      let msg = guiasFisicas.size === 0 ? "⏳ Esperando guías..." : "Bultos: " + guiasFisicas.size;
      if(guiasFisicas.size > 0) totalBultosInventario += guiasFisicas.size;
      resultadosB[filaUbicacionActual][0] = msg; coloresB[filaUbicacionActual][0] = "#178ccc";
      if (ultimaFilaGuia !== -1 && ultimaFilaGuia > filaUbicacionActual) resultadosB[ultimaFilaGuia][0] = "✅ Ok   ►   " + msg;
  }
  aplicarCambiosOptimizado(hoja, 2, 12, 1, 11, resultadosB, resultadosHoras, datosMasivos, coloresB, null, null);
  let c1c3Actual = hoja.getRange("C1:C3").getValues();
  let c1c3Nuevo = [ ["Total bultos: " + totalBultosInventario], ["Ubicaciones (IW): " + totalUbicaciones], [""] ];
  if (c1c3Actual[0][0] !== c1c3Nuevo[0][0] || c1c3Actual[1][0] !== c1c3Nuevo[1][0]) hoja.getRange("C1:C3").setValues(c1c3Nuevo);
}

// =========================================================================
// MENÚ PERSONALIZADO Y ACTUALIZACIÓN INTELIGENTE
// =========================================================================
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('📦 Opciones Avanzadas')
    .addItem('📋 Agrupar Guías por Pedimento (Col A)', 'agruparPorPedimento')
    .addItem('🧹 Limpiar guías movidas (Rango seleccionado)', 'limpiarGuiasMovidasSeleccion')
    .addSeparator()
    .addItem('🔄 Forzar Actualización de esta pestaña', 'forzarActualizacionHojaActiva')
    .addToUi();
}

function forzarActualizacionHojaActiva() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const hoja = ss.getActiveSheet();
  const nombreHoja = hoja.getName().toUpperCase();

  ss.toast('⏳ Sincronizando datos, por favor espera...', 'Actualizando', 3);
  let cacheInfo = getCacheData(ss);

  if (nombreHoja.includes("INVENTARIO")) {
      actualizarInventario(hoja);
  } else if (esHojaBodega(nombreHoja)) {
      actualizarConteos(hoja, ss);
  } else if (esHojaPrincipal(nombreHoja)) {
      actualizarGlobalPreforma(hoja, ss, cacheInfo);
  } else {
      ss.toast('ℹ️ Esta pestaña no requiere actualización inteligente.', 'Sin Acción', 3);
      return;
  }

  actualizarFotografiaMental(hoja, ss);
  ss.toast('✅ Hoja actualizada y coloreada correctamente.', 'Éxito', 4);
}

function actualizadorAutomaticoGlobal() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const hojas = ss.getSheets();
  let cacheInfo = getCacheData(ss);

  hojas.forEach(hoja => {
      let nombreHoja = hoja.getName().toUpperCase();
      let lr = hoja.getLastRow();

      if (nombreHoja !== "MACHO" && nombreHoja !== "HISTORIAL_BORRADOS" && nombreHoja !== "CACHE_SISTEMA" && lr > 1) {
          let necesitaActualizar = false;

          if (esHojaBodega(nombreHoja) || nombreHoja.includes("INVENTARIO")) {
              let datos = hoja.getRange(2, 1, lr - 1, 2).getValues();
              for (let i = 0; i < datos.length; i++) {
                  let valA = String(datos[i][0]).trim();
                  let valB = String(datos[i][1]).trim();
                  if (valA !== "" && valB === "") {
                      necesitaActualizar = true;
                      break;
                  }
              }
          }
          else if (esHojaPrincipal(nombreHoja)) {
              let maxCol = hoja.getMaxColumns();
              if (maxCol >= 16) {
                  let datosFisicos = hoja.getRange(2, 1, lr - 1, 2).getValues();
                  let datosPreforma = hoja.getRange(2, 15, lr - 1, 2).getValues();
                  for (let i = 0; i < datosFisicos.length; i++) {
                      let valA = String(datosFisicos[i][0]).trim(); let valB = String(datosFisicos[i][1]).trim();
                      let valO = String(datosPreforma[i][0]).trim(); let valP = String(datosPreforma[i][1]).trim();

                      if (valA !== "" && valB === "") { necesitaActualizar = true; break; }
                      if (valO !== "" && valP === "") { necesitaActualizar = true; break; }
                  }
              } else {
                  necesitaActualizar = true;
              }
          }

          if (necesitaActualizar) {
              if (nombreHoja.includes("INVENTARIO")) {
                  actualizarInventario(hoja);
              } else if (esHojaBodega(nombreHoja)) {
                  actualizarConteos(hoja, ss);
              } else {
                  actualizarGlobalPreforma(hoja, ss, cacheInfo);
              }
              actualizarFotografiaMental(hoja, ss);
          }
      }
  });
}

function agruparPorPedimento() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const hoja = ss.getActiveSheet();
  let lr = hoja.getLastRow();
  if (lr < 1) return;

  let cacheInfo = getCacheData(ss);

  const colsToMove = 14;
  let nombreHoja = hoja.getName().toUpperCase();
  let esRezago = nombreHoja.includes("REZAGO");

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
  datosBodega.preformaBodega.forEach((guias, ped) => { guias.forEach(g => { if (!mapaPreforma.has(g)) mapaPreforma.set(g, ped); }); });

  if (esRezago) {
      let guiasR = obtenerGuiasRezagoDesdeCache(cacheInfo);
      guiasR.forEach((info, guia) => { if (!mapaPreforma.has(guia)) mapaPreforma.set(guia, info.pedimento); });
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

    if (/^\d{7}$/.test(valA)) {
        pedFisicoActual = valA;
        if (valB.startsWith("➡ Movido a") || valB.startsWith("➡ MOVIDO A")) continue;
        if (!agrupacion.has(pedFisicoActual)) agrupacion.set(pedFisicoActual, { cabecera: fila, guias: [] });
        else agrupacion.get(pedFisicoActual).cabecera = fila;
    } else {
        if (valB.startsWith("➡ Movido a") || valB.startsWith("➡ MOVIDO A")) continue;
        let pedDestino = mapaPreforma.get(valA) || pedFisicoActual;
        if (!agrupacion.has(pedDestino)) {
            let dummy = [pedDestino, ...Array(colsToMove-1).fill("")];
            agrupacion.set(pedDestino, { cabecera: dummy, guias: [] });
        }
        agrupacion.get(pedDestino).guias.push(fila);
    }
  }

  let newVals = [];
  function pushRow(r) { newVals.push(r); }

  agrupacion.forEach((bloque, ped) => {
      if (ped !== "OTROS" && ped !== "SIN PEDIMENTO") {
          if (bloque.cabecera) pushRow(bloque.cabecera);
          bloque.guias.forEach(g => pushRow(g));
      }
  });

  if (agrupacion.has("SIN PEDIMENTO")) {
      let dummyH = [ "SIN PEDIMENTO", ...Array(colsToMove - 1).fill("") ];
      pushRow(dummyH);
      agrupacion.get("SIN PEDIMENTO").guias.forEach(g => pushRow(g));
  }

  rangoData.clearContent();
  hoja.getRange(1, 1, lr, colsToMove).setBackground("#FFFFFF").setFontColor("#000000").setFontLine("none");
  if (newVals.length > 0) {
      let tRango = hoja.getRange(1, 1, newVals.length, colsToMove);
      tRango.setValues(newVals);
  }

  if (esHojaPrincipal(nombreHoja) || esHojaBodega(nombreHoja)) {
      actualizarGlobalPreforma(hoja, ss, cacheInfo);
  } else {
      actualizarConteos(hoja, ss);
  }

  actualizarFotografiaMental(hoja, ss);
  ss.toast('✅ Guías agrupadas correctamente en la parte superior.', 'Agrupación', 5);
}

function limpiarGuiasMovidasSeleccion() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const hoja = ss.getActiveSheet();
  const rangoSeleccionado = hoja.getActiveRange();

  let cacheInfo = getCacheData(ss);
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

  for (let i = 0; i < numFilasSeleccion; i++) {
      if (i >= valores.length) break;
      let valB = String(valores[i][1]).trim();
      if (valB.startsWith("➡ Movido a") || valB.startsWith("➡ MOVIDO A")) {
          paraEliminar.add(i);
          let guiaBorrada = String(valores[i][0]).trim();
          if (guiaBorrada !== "") {
              registrarEnHistorial(ss, hoja.getName().toUpperCase(), filaInicio + i, "Físico (Col A)", guiaBorrada, valB, "LIMPIEZA DE GUÍA MOVIDA");
          }
      }
  }

  for (let i = 0; i < numFilasSeleccion; i++) {
      if (i >= valores.length) break;
      let valA = String(valores[i][0]).trim().toUpperCase();
      if (/^\d{7}$/.test(valA) && !paraEliminar.has(i)) {
          let tieneGuias = false;
          for (let j = i + 1; j < numFilasSeleccion; j++) {
              if (j >= valores.length) break;
              let nextA = String(valores[j][0]).trim().toUpperCase();
              if (/^\d{7}$/.test(nextA)) break;

              if (nextA !== "" && !paraEliminar.has(j)) {
                  tieneGuias = true;
                  break;
              }
          }
          if (!tieneGuias) {
              paraEliminar.add(i);
              registrarEnHistorial(ss, hoja.getName().toUpperCase(), filaInicio + i, "Físico (Col A)", valA, "Vacío", "LIMPIEZA DE PEDIMENTO VACÍO");
          }
      }
  }

  if (paraEliminar.size === 0) {
      ss.toast('ℹ️ No se encontraron guías movidas en el rango seleccionado.', 'Sin cambios', 5);
      return;
  }

  let eliminadas = paraEliminar.size;
  let nuevosValores = [];

  for (let i = 0; i < valores.length; i++) {
      if (!paraEliminar.has(i)) {
          nuevosValores.push(valores[i]);
      }
  }

  let filesVacias = Array(eliminadas).fill(Array(12).fill(""));
  nuevosValores = nuevosValores.concat(filesVacias);

  rangoData.setValues(nuevosValores);

  let startEmpty = filaInicio + nuevosValores.length - eliminadas;
  hoja.getRange(startEmpty, 1, eliminadas, 12)
      .setBackground("#FFFFFF")
      .setFontColor("#000000")
      .setFontLine("none");

  ss.toast(`✅ Guías limpiadas (${eliminadas} filas). Las validaciones subieron correctamente.`, 'Limpieza Completa', 5);

  let nombreHoja = hoja.getName().toUpperCase();
  if (nombreHoja.includes("INVENTARIO")) {
      actualizarInventario(hoja);
  } else if (esHojaBodega(nombreHoja)) {
      actualizarConteos(hoja, ss);
  } else if (esHojaPrincipal(nombreHoja)) {
      actualizarGlobalPreforma(hoja, ss, cacheInfo);
  }

  actualizarFotografiaMental(hoja, ss);
}

// =========================================================================
// FUNCIÓN PARA RECONSTRUIR EL CACHÉ MANUALMENTE SI ALGO SALE MAL
// =========================================================================
function RECONSTRUIR_CACHE_TOTAL() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const hojas = ss.getSheets();

  ss.toast('📸 Tomando fotografía de todas las pestañas...', 'Reconstruyendo Caché', 5);

  hojas.forEach(hoja => {
    actualizarFotografiaMental(hoja, ss);
  });

  // Borramos la RAM para que se vuelva a cargar fresca en el siguiente escaneo
  globalCacheData = null;
  globalCacheHeaders = null;
  globalCacheMap = null;

  ss.toast('✅ Caché reconstruido con éxito.', 'Listo', 5);
}
