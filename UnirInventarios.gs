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
// 3. LA HOJA DESTINO SE DIMENSIONA UNA SOLA VEZ, Y SE ESCRIBE POR TRAMOS.
//    Una hoja nueva nace con 1.000 filas y 26 columnas, así que hay que
//    agrandarla. La primera versión lo hacía DENTRO del bucle —una
//    redimensión y un `setValues` gigante por pestaña— y Google contestaba
//    «Error de servicio: Hojas de cálculo», que es lo que dice cuando una
//    operación pide demasiado de golpe.
//
//    Ahora se cuenta primero cuánto va a ocupar todo (solo `getLastRow` y
//    `getLastColumn`, que son baratos), se agranda la hoja UNA vez, y los
//    datos entran en tramos de 20.000 filas. Misma cantidad de datos, muchas
//    menos cosas que Google tenga que hacer a la vez.
//
// 4. SIN FILAS DE TÍTULO. La versión original metía un renglón «>>> NOMBRE»
//    entre pestaña y pestaña. Fuera: ensucia el volcado, estorba al filtrar y
//    ordenar, y obligaba a tres llamadas a la API por pestaña solo para
//    pintarlo.
// =========================================================================

// El prefijo importa: ver el punto 2 de arriba. Si le cambias el nombre, que
// siga empezando por «CONSOLIDADO».
const UI_HOJA_DESTINO = 'CONSOLIDADO INVENTARIO';
const UI_FILAS_ENCABEZADO = 1;       // filas de encabezado por hoja (0 si no hay)
const UI_REPETIR_ENCABEZADO = false; // true = deja el encabezado de cada hoja
const UI_SOLO_EMPIEZA_CON = false;   // true = solo las que EMPIEZAN por «INVENTARIO»

// Filas por escritura. Un `setValues` de cientos de miles de filas es lo que
// hace contestar «Error de servicio»; por tramos, cada llamada es pequeña.
const UI_FILAS_POR_ESCRITURA = 20000;

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

// El plan de copia, dado el tamaño de cada pestaña de origen.
//
// Se separa de lo que habla con Sheets para poder probarlo: la aritmética de
// «cuántas filas salto» y «desde cuál empiezo» es justo lo que, si se equivoca,
// no da error — devuelve un consolidado al que le falta la primera fila de cada
// inventario, o que repite encabezados, y eso solo se ve contándolo a mano.
//
// `tamanos` es [{nombre, filas, columnas}]. Devuelve {plan, filas, ancho}.
function planDeConsolidado(tamanos) {
    let plan = [], filasTotales = 0, anchoTotal = 1;
    (tamanos || []).forEach(t => {
        let lr = t.filas || 0, lc = t.columnas || 0;
        if (lr === 0 || lc === 0) return;
        // El encabezado solo se conserva en la PRIMERA que de verdad aporta
        // filas, no en la primera de la lista: si la primera está vacía, la
        // siguiente pasa a ser la que manda y su encabezado tiene que quedarse.
        let saltar = (plan.length > 0 && !UI_REPETIR_ENCABEZADO) ? UI_FILAS_ENCABEZADO : 0;
        let utiles = lr - saltar;
        if (utiles <= 0) return;
        plan.push({ nombre: t.nombre, desde: saltar + 1, filas: utiles, ancho: lc });
        filasTotales += utiles;
        if (lc > anchoTotal) anchoTotal = lc;
    });
    return { plan: plan, filas: filasTotales, ancho: anchoTotal };
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

    // PRIMERA PASADA: solo medir. `getLastRow` y `getLastColumn` son baratos y
    // así se sabe el tamaño final ANTES de tocar la hoja destino. Agrandarla
    // dentro del bucle era lo que hacía contestar «Error de servicio».
    let porNombre = new Map();
    let tamanos = hojas.map(h => {
        porNombre.set(h.getName(), h);
        return { nombre: h.getName(), filas: h.getLastRow(), columnas: h.getLastColumn() };
    });
    let calculado = planDeConsolidado(tamanos);
    let plan = calculado.plan;
    let filasTotales = calculado.filas;
    let anchoTotal = calculado.ancho;

    if (filasTotales === 0) {
        ui.alert("📚 Unir inventarios", "Esas pestañas están vacías.", ui.ButtonSet.OK);
        return;
    }

    // Sheets no admite más de 10 millones de celdas POR ARCHIVO. Un consolidado
    // que se pase no falla al escribirse: hace fallar el archivo entero, y con
    // él la operación de siete personas. Más vale no empezar.
    if (filasTotales * anchoTotal > 2000000) {
        ui.alert("📚 Unir inventarios",
            "El consolidado saldría de " + filasTotales.toLocaleString() + " filas × " +
            anchoTotal + " columnas = " +
            (filasTotales * anchoTotal).toLocaleString() + " celdas.\n\n" +
            "Es demasiado para meterlo en este archivo, que tiene un tope de 10 " +
            "millones de celdas en total. Usa «📏 Espacio del archivo» para ver " +
            "cuánto queda libre, o une menos pestañas.", ui.ButtonSet.OK);
        return;
    }

    // La hoja destino se BORRA y se rehace en vez de limpiarla: `clear()` sobre
    // un consolidado anterior de cientos de miles de celdas es otra operación
    // pesada, y encima deja el tamaño viejo.
    let previa = ss.getSheetByName(UI_HOJA_DESTINO);
    if (previa) ss.deleteSheet(previa);
    let destino = ss.insertSheet(UI_HOJA_DESTINO, ss.getNumSheets());

    // Dimensionar UNA vez, no una por pestaña.
    if (destino.getMaxRows() < filasTotales + 1) {
        destino.insertRowsAfter(destino.getMaxRows(),
                                filasTotales + 1 - destino.getMaxRows());
    }
    if (destino.getMaxColumns() < anchoTotal) {
        destino.insertColumnsAfter(destino.getMaxColumns(),
                                   anchoTotal - destino.getMaxColumns());
    }

    // SEGUNDA PASADA: copiar. Cada pestaña se lee y se escribe por tramos, así
    // que ninguna llamada mueve más de UI_FILAS_POR_ESCRITURA filas por muy
    // grande que sea el inventario.
    let fila = 1;
    let resumen = [];
    let fallos = [];

    plan.forEach(p => {
        try {
            let copiadas = 0;
            let origen = porNombre.get(p.nombre);
            for (let off = 0; off < p.filas; off += UI_FILAS_POR_ESCRITURA) {
                let alto = Math.min(UI_FILAS_POR_ESCRITURA, p.filas - off);
                let datos = origen.getRange(p.desde + off, 1, alto, p.ancho).getValues();
                destino.getRange(fila, 1, alto, p.ancho).setValues(datos);
                fila += alto;
                copiadas += alto;
            }
            resumen.push(p.nombre + ': ' + copiadas.toLocaleString() + ' filas');
        } catch (err) {
            // Una pestaña que falle no puede llevarse por delante a las demás:
            // más vale un consolidado al que le falta una y saber CUÁL, que un
            // error genérico y no saber por dónde se quedó.
            fallos.push(p.nombre + ': ' + err);
        }
    });

    ss.setActiveSheet(destino);
    let msg = "Listo. Se unieron " + resumen.length + " pestañas, " +
              (fila - 1).toLocaleString() + " filas en total:\n\n" +
              resumen.join("\n");
    if (fallos.length) {
        msg += "\n\n❌ Estas NO se pudieron copiar:\n" + fallos.join("\n");
    }
    msg += "\n\nEsta hoja es un INFORME: el motor de escaneo la ignora, así que " +
           "las guías copiadas no salen como duplicadas de sus originales.";
    ui.alert("📚 Unir inventarios", msg, ui.ButtonSet.OK);
}
