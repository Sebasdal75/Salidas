// =========================================================================
// REGISTROS: LO QUE TIENE QUE QUEDAR APUNTADO
// =========================================================================
//
// Dos hojas que solo crecen, para poder mirar después lo que pasó:
//
//   · SIS_TIEMPOS_PEDIMENTOS — cada pedimento final, con la hora en que se
//     escaneó. Los papeles llegan por tandas —diez, luego cincuenta…— y esto
//     es lo que permite medir cuánto tardó cada tanda.
//
//   · SIS_REPORTE_ERRORES — lo que se escribe en la columna D de una unidad
//     («ERROR FALTARON 2 BULTOS»), con su unidad, su fila, su pedimento y su
//     guía.
//
// EMPIEZAN POR «SIS_», y eso basta para que el motor no las tome por pestañas
// de escaneo (ver `esHojaInterna`) ni la macro por unidades. NO se ocultan: son
// para leerlas.
//
// SE AÑADE CON `appendRow`, una fila por llamada. Es la única escritura de
// Sheets que es atómica frente a otra ejecución que añade a la vez: con
// «última fila + 1» dos reportes escritos en el mismo segundo podían caer en
// la misma fila y uno se perdía sin dejar rastro.
// =========================================================================

const HOJA_SIS_TIEMPOS = "SIS_TIEMPOS_PEDIMENTOS";
const CABECERA_SIS_TIEMPOS = ["FECHA Y HORA", "UNIDAD", "PEDIMENTO", "RESULTADO AL ESCANEARLO",
                              "PATENTE", "BLOQUE"];

const HOJA_SIS_REPORTES = "SIS_REPORTE_ERRORES";
const CABECERA_SIS_REPORTES = ["FECHA Y HORA", "UNIDAD", "FILA", "PEDIMENTO", "GUÍA", "REPORTE", "QUIÉN"];

// La columna de los reportes en las unidades, y desde qué fila: en la 1-3 de
// la D van los totales que escribe el recálculo, y lo que se escribiera ahí lo
// pisaría el siguiente escaneo.
const COL_REPORTE_UNIDAD = 4;
const FILA_MIN_REPORTE_UNIDAD = 4;

function nombreHojaSisTiempos() { return HOJA_SIS_TIEMPOS; }
function cabeceraSisTiempos() { return CABECERA_SIS_TIEMPOS.slice(); }
function nombreHojaSisReportes() { return HOJA_SIS_REPORTES; }

// Añade filas a un registro, creándolo si no existe.
function anotarEnRegistro(ss, nombre, cabecera, filas) {
    if (!filas || filas.length === 0) return 0;
    let h = ss.getSheetByName(nombre);
    if (!h) {
        h = ss.insertSheet(nombre, ss.getNumSheets());
        h.getRange(1, 1, 1, cabecera.length).setValues([cabecera]).setFontWeight("bold");
        h.setFrozenRows(1);
        h.getRange(2, 1, Math.max(h.getMaxRows() - 1, 1), 1)
         .setNumberFormat("dd/mm/yyyy hh:mm:ss");
    } else if (h.getMaxColumns() < cabecera.length ||
               String(h.getRange(1, cabecera.length).getValue()).trim() !== cabecera[cabecera.length - 1]) {
        // UNA COLUMNA NUEVA EN UN REGISTRO QUE YA EXISTÍA (pasó con BLOQUE):
        // sin título, los datos entrarían en una columna que nadie sabe qué es.
        // Solo se toca la fila de títulos; lo apuntado se queda como está.
        if (h.getMaxColumns() < cabecera.length) {
            h.insertColumnsAfter(h.getMaxColumns(), cabecera.length - h.getMaxColumns());
        }
        h.getRange(1, 1, 1, cabecera.length).setValues([cabecera]).setFontWeight("bold");
    }
    filas.forEach(f => h.appendRow(f));
    return filas.length;
}

// -------------------------------------------------------------------------
// LOS REPORTES DE LA COLUMNA D
// -------------------------------------------------------------------------

// ¿Esta edición es un reporte escrito en la D de una unidad? Una sola
// columna, la D, en una pestaña de unidad, y alguna fila desde la 4.
function edicionEsReporteDeUnidad(nombreHoja, colInicial, numCols, filaInicial, numRows) {
    if (colInicial !== COL_REPORTE_UNIDAD || numCols !== 1) return false;
    if (filaInicial + numRows - 1 < FILA_MIN_REPORTE_UNIDAD) return false;
    return esHojaPrincipal(claveHoja(nombreHoja));
}

// El pedimento del bloque de una fila: el último de 7 dígitos que hay en la
// columna A desde esa fila hacia arriba. Un marcador de bloque —«SIN
// PEDIMENTO», «COSTALES»— corta: lo de debajo no es de nadie. Puro.
function pedimentoDeLaFila(colA, idx) {
    for (let i = Math.min(idx, (colA || []).length - 1); i >= 0; i--) {
        let vi = (colA[i] || [])[0];
        let v = String(vi === undefined || vi === null ? "" : vi).trim().toUpperCase();
        if (/^\d{7}$/.test(v)) return v;
        if (v !== "" && esMarcadorEstructural(v)) return "";
    }
    return "";
}

// Las filas de registro de un reporte. Puro: recibe la columna A hasta la
// última fila tocada y lo escrito en la D.
function filasDeReporteDeUnidad(nombreHoja, filaInicial, notas, colA, ahora, quien) {
    let out = [];
    (notas || []).forEach((n, k) => {
        let fila = filaInicial + k;
        if (fila < FILA_MIN_REPORTE_UNIDAD) return;
        let celda = (n || [])[0];
        let nota = String(celda === undefined || celda === null ? "" : celda).trim();
        // BORRAR UN REPORTE NO SE APUNTA. El registro es de lo que se reportó;
        // vaciar la celda es limpiar la vista, no deshacer lo que pasó.
        if (nota === "") return;
        let va = ((colA || [])[fila - 1] || [])[0];
        let a = String(va === undefined || va === null ? "" : va).trim().toUpperCase();
        let guia = (a !== "" && !/^\d{7}$/.test(a) && esGuiaUPSValida(a)) ? a : "";
        out.push([ahora, nombreHoja, fila, pedimentoDeLaFila(colA, fila - 1), guia, nota, quien || ""]);
    });
    return out;
}

// Lo llama `procesarEdicion` ANTES de pedir el lock del documento: solo lee la
// columna A de la unidad y añade al registro, así que no tiene nada que pisar
// ni nadie a quien hacer esperar.
function atenderReporteDeUnidad(ss, hoja, filaInicial, notas) {
    let ultima = filaInicial + notas.length - 1;
    let colA = hoja.getRange(1, 1, ultima, 1).getValues();
    let quien = "";
    try { quien = obtenerUsuarioActual(); } catch (err) { quien = ""; }
    let filas = filasDeReporteDeUnidad(hoja.getName(), filaInicial, notas, colA, new Date(), quien);
    let n = anotarEnRegistro(ss, HOJA_SIS_REPORTES, CABECERA_SIS_REPORTES, filas);
    if (n > 0) {
        try {
            ss.toast("📝 " + (n === 1 ? "Reporte apuntado" : n + " reportes apuntados") +
                     " en «" + HOJA_SIS_REPORTES + "».", "Reporte", 4);
        } catch (err) { /* el aviso es un extra */ }
    }
    return n;
}
