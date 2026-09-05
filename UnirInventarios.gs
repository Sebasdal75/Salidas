// =========================================================================
// UNIR LAS PESTAÑAS DE INVENTARIO EN UNA SOLA
// =========================================================================
//
// Copia el contenido de todas las hojas cuyo nombre lleve «INVENTARIO» a una
// hoja nueva, una debajo de la otra. Solo LEE de las originales: no mueve ni
// cambia nada en ellas.
//
// -------------------------------------------------------------------------
// LO QUE HUBO QUE CAMBIAR DEL ORIGINAL, Y POR QUÉ
// -------------------------------------------------------------------------
//
// 1. FUERA EL `onOpen`. El original traía el suyo para crear un menú propio.
//    En Apps Script todos los archivos comparten el mismo espacio de nombres:
//    dos `onOpen` no conviven, gana el último que cargue, y el OTRO menú
//    desaparece entero. Aquí eso significaba quedarse sin «📦 Opciones
//    Avanzadas» —sin escaneo, sin caché, sin nada—. Ya pasó una vez en este
//    proyecto y costó una mañana. El botón va dentro del menú que ya existe.
//
// 2. LA HOJA DESTINO NO PUEDE LLAMARSE SOLO «CONSOLIDADO INVENTARIO».
//    `esHojaInventario` reconoce por «contiene INVENTARIO», así que una hoja
//    con ese nombre sería, para el motor, UNA PESTAÑA DE ESCANEO MÁS: entraría
//    al caché con su columna _FISICO y CADA guía copiada chocaría contra su
//    original. Miles de duplicados falsos, todos inventados por esta
//    herramienta, y encima bloqueando el cierre de bloques.
//
//    Por eso el nombre empieza por «CONSOLIDADO» y ese prefijo está declarado
//    como interno en Codigo.gs. Es lo correcto de por sí: un volcado de solo
//    lectura no es una hoja de escaneo, es un informe.
//
// 3. LA HOJA DESTINO SE AGRANDA ANTES DE ESCRIBIR. Una hoja nueva nace con
//    1.000 filas y 26 columnas. Volcar varios inventarios pasa de ahí y
//    `setValues` revienta a media copia, dejando el consolidado incompleto y
//    con pinta de estar bien.
// =========================================================================

// El prefijo importa: ver el punto 2 de arriba. Si le cambias el nombre, que
// siga empezando por «CONSOLIDADO».
const UI_HOJA_DESTINO = 'CONSOLIDADO INVENTARIO';
const UI_FILAS_ENCABEZADO = 1;       // filas de encabezado por hoja (0 si no hay)
const UI_REPETIR_ENCABEZADO = false; // true = deja el encabezado de cada hoja
const UI_PONER_TITULO = true;        // true = fila con el nombre de la hoja
const UI_SOLO_EMPIEZA_CON = false;   // true = solo las que EMPIEZAN por «INVENTARIO»

// Qué hojas se unen.
//
// Se excluyen las internas —el propio consolidado, el caché, los índices— por
// `esHojaInterna` y no por nombre exacto: si mañana hay dos consolidados o
// alguien renombra el destino, seguir comparando contra una cadena fija
// volvería a meter el volcado dentro de sí mismo.
function hojaEntraEnConsolidado(nombre) {
    let n = claveHoja(nombre);
    if (esHojaInterna(n) || esHojaMacho(n)) return false;
    return UI_SOLO_EMPIEZA_CON ? n.indexOf('INVENTARIO') === 0
                               : n.indexOf('INVENTARIO') !== -1;
}

function unirInventarios() {
    const ss = obtenerArchivo();
    const ui = SpreadsheetApp.getUi();

    let hojas = ss.getSheets().filter(h => hojaEntraEnConsolidado(h.getName()));
    if (hojas.length === 0) {
        ui.alert("📚 Unir inventarios",
                 "No encontré ninguna pestaña con «INVENTARIO» en el nombre.",
                 ui.ButtonSet.OK);
        return;
    }

    let r = ui.alert("📚 Unir inventarios",
        "Voy a copiar estas " + hojas.length + " pestañas a «" + UI_HOJA_DESTINO +
        "»:\n\n" + hojas.map(h => "  · " + h.getName()).join("\n") + "\n\n" +
        "Las originales NO se tocan; solo se leen. Si ya existe un consolidado " +
        "anterior, se borra y se rehace.\n\n¿Sigo?", ui.ButtonSet.YES_NO);
    if (r !== ui.Button.YES) return;

    let destino = ss.getSheetByName(UI_HOJA_DESTINO);
    if (destino) destino.clear();
    else destino = ss.insertSheet(UI_HOJA_DESTINO, ss.getNumSheets());

    let fila = 1;
    let esPrimera = true;
    let resumen = [];

    hojas.forEach(h => {
        let ultimaFila = h.getLastRow();
        let ultimaCol = h.getLastColumn();
        if (ultimaFila === 0 || ultimaCol === 0) return;   // hoja vacía

        let datos = h.getRange(1, 1, ultimaFila, ultimaCol).getValues();

        // El encabezado solo se conserva en la primera, salvo que se pida lo
        // contrario: repetirlo en medio de los datos rompe cualquier filtro.
        if (!esPrimera && !UI_REPETIR_ENCABEZADO && UI_FILAS_ENCABEZADO > 0) {
            datos = datos.slice(UI_FILAS_ENCABEZADO);
        }
        if (datos.length === 0) return;

        // Agrandar ANTES de escribir. Una hoja nueva nace con 1.000 filas y 26
        // columnas; sin esto, `setValues` revienta a media copia y deja el
        // consolidado incompleto pero con pinta de estar bien.
        asegurarFilas(destino, fila + datos.length + 1);
        let anchoNecesario = datos[0].length;
        if (destino.getMaxColumns() < anchoNecesario) {
            destino.insertColumnsAfter(destino.getMaxColumns(),
                                       anchoNecesario - destino.getMaxColumns());
        }

        if (UI_PONER_TITULO) {
            destino.getRange(fila, 1)
                   .setValue('>>> ' + h.getName())
                   .setFontWeight('bold')
                   .setBackground('#d9ead3');
            fila++;
        }

        destino.getRange(fila, 1, datos.length, anchoNecesario).setValues(datos);
        fila += datos.length;
        esPrimera = false;
        resumen.push(h.getName() + ': ' + datos.length + ' filas');
    });

    ss.setActiveSheet(destino);
    ui.alert("📚 Unir inventarios",
             "Listo. Se unieron " + resumen.length + " pestañas:\n\n" +
             resumen.join("\n") + "\n\n" +
             "Esta hoja es un INFORME: el motor de escaneo la ignora, así que " +
             "las guías copiadas no salen como duplicadas de sus originales.",
             ui.ButtonSet.OK);
}
