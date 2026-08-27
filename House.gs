// =========================================================================
// ÍNDICE DE HOUSES  ·  MÓDULO EN PRUEBAS
// =========================================================================
//
// Saca la HOUSE de cada 1Z a partir de la base de inbound y prealertas, y la
// escribe en la columna D mientras se escanea, sin tocar el escaneo.
//
// LA REGLA QUE HACE QUE ESTO NO ALENTE NADA:
//
//   El índice NUNCA se carga durante un escaneo.
//
// Leer 1.000 filas cuesta ~242 ms medidos en este archivo. Una base de inbound
// de varios meses son decenas o cientos de miles de filas: cargarla dentro del
// `onEdit` multiplicaría por veinte un escaneo que hoy tarda ~900 ms, y el
// trigger simple se muere a los 30 s. Además el escaneo no necesita la house
// para nada: su trabajo es decidir duplicados, faltantes y sobrantes, y eso lo
// resuelve con el caché. La house es dato de reporte.
//
// Por eso el relleno vive en un disparador aparte, cada minuto, y hace la
// comprobación barata ANTES de cargar nada: mira si hay celdas de house vacías
// y, si no las hay —que es lo normal casi siempre—, se sale sin abrir el
// índice.
//
// SEGURO DE PRUEBAS: mientras el archivo no se llame PRUEBA, ninguna función de
// este módulo escribe nada. Es para poder pegarlo también en producción sin que
// haga nada hasta que se decida implementarlo.
// =========================================================================

const MARCA_PRUEBA = "PRUEBA";

const HOJA_INDICE_HOUSE = "INDICE_HOUSE";        // caliente: lo reciente
const HOJA_INDICE_HOUSE_FRIO = "INDICE_HOUSE_FRIO"; // archivo: solo bajo demanda
const CARPETA_INBOUND = "INBOUND_PREALERTAS";    // carpeta de Drive con los CSV

// Columna D. Está libre: el script escribe en A, B, C1:C3, L, M, N, O, P,
// Q1:Q2 y S, y la D es donde iba la marca «T1», que ya se retiró.
//
// Ir dentro de las columnas 1-19 no es casualidad: es el rango que lee
// `recortarFilasSobrantes` antes de borrar filas en el cierre. Poniendo la
// house ahí, el recorte NUNCA borrará una fila que tenga house. En la T o más
// allá esa protección no llegaría.
const COL_HOUSE = 4;

// Cuántos días de prealerta se quedan en el índice caliente. Una guía que se
// escanea hoy se prealertó hace días o semanas, no hace dos años: el 99 % de
// las búsquedas caen aquí, y cargar el archivo entero cada minuto sería pagar
// decenas de segundos para encontrar algo que estaba en los primeros renglones.
const DIAS_INDICE_CALIENTE = 90;

// Marca de «buscada y no está». Sin ella, una guía que no aparece en el índice
// se reintentaría cada minuto para siempre, y cada reintento arrastra la carga
// del índice entero. Con la marca se busca una vez.
const TXT_HOUSE_SIN_DATO = "—";

const PROP_ARCHIVOS_IMPORTADOS = 'HOUSE_ARCHIVOS_IMPORTADOS';

function colHouse() { return COL_HOUSE; }
function textoHouseSinDato() { return TXT_HOUSE_SIN_DATO; }
function diasIndiceCaliente() { return DIAS_INDICE_CALIENTE; }

// -------------------------------------------------------------------------
// EL SEGURO
// -------------------------------------------------------------------------
function esArchivoDePrueba(nombreArchivo) {
    return String(nombreArchivo).trim().toUpperCase().indexOf(MARCA_PRUEBA) !== -1;
}

// Devuelve true si se puede seguir. Si no, avisa y corta.
function exigirModoPrueba(ss) {
    if (esArchivoDePrueba(ss.getName())) return true;
    SpreadsheetApp.getUi().alert(
        "🧪 Módulo en pruebas",
        "El índice de houses solo funciona en una copia de pruebas.\n\n" +
        "Este archivo se llama «" + ss.getName() + "». Para probarlo, haz una copia " +
        "cuyo nombre contenga la palabra PRUEBA y pégalo ahí.\n\n" +
        "Así ninguna prueba puede tocar la operación real.",
        SpreadsheetApp.getUi().ButtonSet.OK);
    return false;
}

// -------------------------------------------------------------------------
// LECTURA DEL CSV DE INBOUND
// -------------------------------------------------------------------------

// Excel en México exporta CSV con punto y coma tan a menudo como con coma, y
// equivocarse deja UNA sola columna con toda la fila dentro. Se decide contando
// en la línea de cabeceras, que es la que no lleva texto libre.
function separadorCsv(primeraLinea) {
    let linea = String(primeraLinea);
    let comas = (linea.match(/,/g) || []).length;
    let puntoYComa = (linea.match(/;/g) || []).length;
    let tabs = (linea.match(/\t/g) || []).length;
    if (tabs > comas && tabs > puntoYComa) return "\t";
    return puntoYComa > comas ? ";" : ",";
}

// Encuentra en qué columna está la guía, la house y la fecha.
//
// No se piden posiciones fijas a propósito: el reporte de inbound cambia de
// forma cada vez que alguien toca la consulta de Power Query, y una posición
// fija se rompe en silencio —empezaría a leer houses de la columna de al lado
// sin que nada avise—. Buscando por nombre, si el reporte cambia, la
// importación falla RUIDOSAMENTE y se puede arreglar.
//
// La house se busca ANTES que la guía: «HOUSE AWB» contiene «AWB», y si se
// mirara la guía primero se llevaría esa columna por delante.
function detectarColumnasInbound(headers) {
    let norm = (headers || []).map(h => String(h).trim().toUpperCase());
    let buscar = (claves, excluir) => {
        for (let i = 0; i < norm.length; i++) {
            let h = norm[i];
            if (excluir && excluir.some(x => h.indexOf(x) !== -1)) continue;
            if (claves.some(c => h.indexOf(c) !== -1)) return i;
        }
        return -1;
    };
    const NO_ES_GUIA = ["HOUSE", "HAWB", "HBL", "CASA", "MASTER", "MAWB"];
    let house = buscar(["HOUSE", "HAWB", "HBL", "CASA"]);

    // La guía se busca en dos rondas, de lo específico a lo genérico. «AWB» a
    // secas es demasiado ancho: casa con «MASTER AWB», que es la guía madre del
    // consolidado y NO es la que se escanea. Si estuviera en la misma ronda que
    // «1Z», ganaría por aparecer antes en el reporte y el índice se llenaría de
    // guías madre —una sola para cientos de bultos—, que nunca casarían con
    // nada. Solo se acepta «AWB» cuando no hay ninguna columna mejor.
    let guia = buscar(["1Z", "TRACKING", "GUIA", "GUÍA", "RASTREO"], NO_ES_GUIA);
    if (guia === -1) guia = buscar(["AWB"], NO_ES_GUIA);

    let fecha = buscar(["FECHA", "DATE", "ARRIBO", "PREALERT"]);
    return { guia: guia, house: house, fecha: fecha };
}

// Fechas: el CSV las trae como texto y en cualquiera de los tres formatos que
// se ven por aquí. Lo que NO se entiende se devuelve como null, y quien lo
// reciba lo trata como reciente: dejar una prealerta en el índice caliente por
// no saber su fecha cuesta unas filas; mandarla al frío por error la esconde.
function aFechaInbound(v) {
    if (v instanceof Date && !isNaN(v.getTime())) return v;
    let s = String(v).trim();
    if (s === "") return null;

    let m = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));

    m = s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})/);
    if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));

    return null;
}

// Del CSV crudo a filas limpias. Se tira todo lo que no sea una guía válida:
// el reporte trae totales, subtotales y renglones en blanco, y meterlos al
// índice lo engorda sin que sirvan para buscar nada.
function filasDeInbound(datos, cols) {
    let salida = [];
    if (!datos || cols.guia === -1 || cols.house === -1) return salida;
    for (let i = 1; i < datos.length; i++) {
        let fila = datos[i];
        if (!fila) continue;
        let guia = claveGuiaHouse(fila[cols.guia]);
        let house = String(fila[cols.house] === undefined ? "" : fila[cols.house]).trim();
        if (guia === "" || house === "") continue;
        if (!esGuiaUPSValida(guia)) continue;
        let fecha = cols.fecha === -1 ? null : aFechaInbound(fila[cols.fecha]);
        salida.push({ guia: guia, house: house, fecha: fecha });
    }
    return salida;
}

// La misma normalización que usa el escaneo para la columna A, para que una
// guía escrita con guiones en el reporte case con la escaneada sin ellos.
function claveGuiaHouse(v) {
    return String(v === undefined || v === null ? "" : v)
        .trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// -------------------------------------------------------------------------
// EL ÍNDICE
// -------------------------------------------------------------------------

// Mete las filas nuevas sin duplicar y sin pisar lo que ya había.
//
// Si una guía ya está con OTRA house, se conserva la vieja y se reporta el
// choque. Pisarla en silencio sería lo peor que puede hacer este módulo: la
// house es el dato con el que se despacha, y una house cambiada sin que nadie
// lo sepa no se descubre hasta que el bulto está en el lugar equivocado.
function fusionarEnIndice(existentes, nuevas) {
    let filas = [];
    let vistos = new Map();
    (existentes || []).forEach(f => {
        let g = claveGuiaHouse(f[0]);
        if (g === "" || vistos.has(g)) return;
        vistos.set(g, String(f[1]).trim());
        filas.push([g, String(f[1]).trim(), f[2] === undefined ? "" : f[2]]);
    });

    let anadidas = 0;
    let conflictos = [];
    (nuevas || []).forEach(n => {
        let previo = vistos.get(n.guia);
        if (previo !== undefined) {
            if (previo !== n.house) {
                conflictos.push({ guia: n.guia, viejo: previo, nuevo: n.house });
            }
            return;
        }
        vistos.set(n.guia, n.house);
        filas.push([n.guia, n.house, n.fecha || ""]);
        anadidas++;
    });

    return { filas: filas, anadidas: anadidas, conflictos: conflictos };
}

// Parte el índice en caliente y frío. Sin fecha se queda en el caliente: ver
// una guía de más es barato, no encontrarla no lo es.
function particionPorAntiguedad(filas, hoy, dias) {
    let corte = new Date(hoy.getTime() - dias * 24 * 60 * 60 * 1000);
    let calientes = [], frias = [];
    (filas || []).forEach(f => {
        let fecha = aFechaInbound(f[2]);
        if (fecha === null || fecha >= corte) calientes.push(f);
        else frias.push(f);
    });
    return { calientes: calientes, frias: frias };
}

// -------------------------------------------------------------------------
// QUÉ HAY QUE RELLENAR
// -------------------------------------------------------------------------

// `datos` son las columnas A..D de la hoja tal cual. Devuelve las filas con una
// guía válida en la A y la house vacía en la D.
//
// La marca de «no encontrada» cuenta como llena: si se reintentara, cada minuto
// se volvería a cargar el índice entero para volver a no encontrarla.
function celdasPorLlenar(datos, colDeHouse) {
    let idx = (colDeHouse || COL_HOUSE) - 1;
    let salida = [];
    for (let i = 0; i < (datos || []).length; i++) {
        let fila = datos[i];
        if (!fila) continue;
        let guia = claveGuiaHouse(fila[0]);
        if (guia === "" || !esGuiaUPSValida(guia)) continue;
        let house = String(fila[idx] === undefined ? "" : fila[idx]).trim();
        if (house !== "") continue;
        salida.push({ fila: i + 1, guia: guia });
    }
    return salida;
}

// Agrupa filas consecutivas para escribir por tramos en vez de celda a celda.
//
// Se escriben SOLO las celdas que se llenan, nunca un rango leído y devuelto
// entero. Es el mismo invariante que protege la columna A: entre la lectura y
// la escritura cabe un escaneo ajeno, y devolver la copia leída lo borraría.
// La D no la teclea nadie, pero la disciplina cuesta diez líneas.
function bloquesContiguos(items) {
    let bloques = [];
    let orden = (items || []).slice().sort((a, b) => a.fila - b.fila);
    for (let i = 0; i < orden.length; i++) {
        let ultimo = bloques[bloques.length - 1];
        if (ultimo && orden[i].fila === ultimo.fila + ultimo.valores.length) {
            ultimo.valores.push([orden[i].valor]);
        } else {
            bloques.push({ fila: orden[i].fila, valores: [[orden[i].valor]] });
        }
    }
    return bloques;
}

// -------------------------------------------------------------------------
// FUNCIONES QUE HABLAN CON SHEETS
// -------------------------------------------------------------------------

function hojaIndice(ss, nombre, crear) {
    let h = ss.getSheetByName(nombre);
    if (!h && crear) {
        h = ss.insertSheet(nombre);
        h.getRange(1, 1, 1, 3).setValues([["GUIA", "HOUSE", "FECHA"]]);
        h.setFrozenRows(1);
        h.hideSheet();
    }
    return h;
}

function leerIndice(ss, nombre) {
    let h = hojaIndice(ss, nombre, false);
    if (!h) return [];
    let lr = h.getLastRow();
    if (lr < 2) return [];
    return h.getRange(2, 1, lr - 1, 3).getValues();
}

// Un Map guía → house. Cargarlo cuesta una lectura; buscar en él es gratis.
function mapaDeIndice(filas) {
    let m = new Map();
    (filas || []).forEach(f => {
        let g = claveGuiaHouse(f[0]);
        if (g !== "") m.set(g, String(f[1]).trim());
    });
    return m;
}

// -------------------------------------------------------------------------
// IMPORTAR: de los CSV de Drive al índice
// -------------------------------------------------------------------------
function importarInboundAlIndice() {
    const ss = obtenerArchivo();
    const ui = SpreadsheetApp.getUi();
    if (!exigirModoPrueba(ss)) return;

    let carpetas = DriveApp.getFoldersByName(CARPETA_INBOUND);
    if (!carpetas.hasNext()) {
        ui.alert("📥 Importar inbound",
                 "No encontré una carpeta de Drive llamada «" + CARPETA_INBOUND + "».\n\n" +
                 "Créala y sube ahí los CSV que exportes de Excel.", ui.ButtonSet.OK);
        return;
    }

    let yaImportados = (PropertiesService.getScriptProperties()
                        .getProperty(PROP_ARCHIVOS_IMPORTADOS) || "").split(",");
    let archivos = carpetas.next().getFiles();
    let nuevas = [], leidos = [], saltados = [], sinCabecera = [];

    while (archivos.hasNext()) {
        let f = archivos.next();
        if (yaImportados.indexOf(f.getId()) !== -1) continue;

        let nombre = f.getName();
        if (!/\.csv$/i.test(nombre)) {
            saltados.push(nombre);
            continue;
        }

        let texto = f.getBlob().getDataAsString();
        let primeraLinea = texto.split(/\r?\n/)[0] || "";
        let datos = Utilities.parseCsv(texto, separadorCsv(primeraLinea));
        let cols = detectarColumnasInbound(datos[0] || []);
        if (cols.guia === -1 || cols.house === -1) {
            sinCabecera.push(nombre);
            continue;
        }

        filasDeInbound(datos, cols).forEach(r => nuevas.push(r));
        leidos.push(f.getId());
    }

    if (nuevas.length === 0 && leidos.length === 0) {
        ui.alert("📥 Importar inbound",
                 "No había archivos nuevos que importar." +
                 (saltados.length ? "\n\nIgnorados (no son CSV): " + saltados.join(", ") : "") +
                 (sinCabecera.length ? "\n\n⚠️ Sin columnas reconocibles de guía y house: " +
                                       sinCabecera.join(", ") : ""),
                 ui.ButtonSet.OK);
        return;
    }

    let fusion = fusionarEnIndice(leerIndice(ss, HOJA_INDICE_HOUSE)
                                  .concat(leerIndice(ss, HOJA_INDICE_HOUSE_FRIO)), nuevas);
    let particion = particionPorAntiguedad(fusion.filas, new Date(), DIAS_INDICE_CALIENTE);

    escribirIndice(ss, HOJA_INDICE_HOUSE, particion.calientes);
    escribirIndice(ss, HOJA_INDICE_HOUSE_FRIO, particion.frias);

    PropertiesService.getScriptProperties()
        .setProperty(PROP_ARCHIVOS_IMPORTADOS,
                     yaImportados.concat(leidos).filter(x => x !== "").join(","));

    let msg = "Guías nuevas en el índice: " + fusion.anadidas + "\n" +
              "Índice caliente (últimos " + DIAS_INDICE_CALIENTE + " días): " +
              particion.calientes.length + "\n" +
              "Archivo frío: " + particion.frias.length;
    if (fusion.conflictos.length) {
        msg += "\n\n⚠️ " + fusion.conflictos.length + " guías traían una house DISTINTA " +
               "de la que ya estaba. Se conservó la anterior:\n" +
               fusion.conflictos.slice(0, 5)
                   .map(c => "  " + c.guia + ": " + c.viejo + " ≠ " + c.nuevo).join("\n");
    }
    if (sinCabecera.length) {
        msg += "\n\n⚠️ Sin columnas reconocibles: " + sinCabecera.join(", ");
    }
    ui.alert("📥 Importar inbound", msg, ui.ButtonSet.OK);
}

function escribirIndice(ss, nombre, filas) {
    let h = hojaIndice(ss, nombre, true);
    let lr = h.getLastRow();
    if (lr > 1) h.getRange(2, 1, lr - 1, 3).clearContent();
    if (filas.length === 0) return;
    asegurarFilas(h, filas.length + 1);
    h.getRange(2, 1, filas.length, 3).setValues(filas);
}

// -------------------------------------------------------------------------
// RELLENAR: el disparador de cada minuto
// -------------------------------------------------------------------------
function rellenarHousesPendientes() {
    const ss = obtenerArchivo();
    if (!esArchivoDePrueba(ss.getName())) return;   // silencioso: es un trigger

    // PRIMERO la comprobación barata. El índice no se abre hasta saber que hay
    // algo que rellenar, y casi todos los minutos no lo hay.
    let pendientes = [];
    ss.getSheets().forEach(hoja => {
        let clave = claveHoja(hoja.getName());
        if (!esHojaPrincipal(clave) && !esHojaInventario(clave)) return;
        let lr = hoja.getLastRow();
        if (lr < 1) return;
        let datos = hoja.getRange(1, 1, lr, COL_HOUSE).getValues();
        let faltan = celdasPorLlenar(datos, COL_HOUSE);
        if (faltan.length) pendientes.push({ hoja: hoja, faltan: faltan });
    });
    if (pendientes.length === 0) return;

    let mapa = mapaDeIndice(leerIndice(ss, HOJA_INDICE_HOUSE));

    pendientes.forEach(p => {
        let items = p.faltan.map(f => ({
            fila: f.fila,
            valor: mapa.get(f.guia) || TXT_HOUSE_SIN_DATO
        }));
        bloquesContiguos(items).forEach(b => {
            p.hoja.getRange(b.fila, COL_HOUSE, b.valores.length, 1).setValues(b.valores);
        });
    });
}

// Las que quedaron con la marca de «no está»: se buscan en el archivo frío, que
// nunca se abre en automático. Botón, no disparador.
function completarHousesDesdeFrio() {
    const ss = obtenerArchivo();
    const ui = SpreadsheetApp.getUi();
    if (!exigirModoPrueba(ss)) return;

    let mapa = mapaDeIndice(leerIndice(ss, HOJA_INDICE_HOUSE)
                            .concat(leerIndice(ss, HOJA_INDICE_HOUSE_FRIO)));
    let encontradas = 0, siguenSinAparecer = 0;

    ss.getSheets().forEach(hoja => {
        let clave = claveHoja(hoja.getName());
        if (!esHojaPrincipal(clave) && !esHojaInventario(clave)) return;
        let lr = hoja.getLastRow();
        if (lr < 1) return;
        let datos = hoja.getRange(1, 1, lr, COL_HOUSE).getValues();
        let items = [];
        for (let i = 0; i < datos.length; i++) {
            let guia = claveGuiaHouse(datos[i][0]);
            let actual = String(datos[i][COL_HOUSE - 1]).trim();
            if (guia === "" || !esGuiaUPSValida(guia)) continue;
            if (actual !== "" && actual !== TXT_HOUSE_SIN_DATO) continue;
            let house = mapa.get(guia);
            if (house) { items.push({ fila: i + 1, valor: house }); encontradas++; }
            else siguenSinAparecer++;
        }
        bloquesContiguos(items).forEach(b => {
            hoja.getRange(b.fila, COL_HOUSE, b.valores.length, 1).setValues(b.valores);
        });
    });

    ui.alert("🏠 Houses desde el archivo",
             "Encontradas: " + encontradas + "\nSiguen sin aparecer: " + siguenSinAparecer +
             (siguenSinAparecer ? "\n\nEsas no están en la base importada. Revisa que el " +
                                  "CSV de su día esté en la carpeta de Drive." : ""),
             ui.ButtonSet.OK);
}

// Borra las marcas de «no está» para que el disparador vuelva a intentarlo.
// Se usa después de importar un CSV que faltaba.
function reintentarHousesNoEncontradas() {
    const ss = obtenerArchivo();
    const ui = SpreadsheetApp.getUi();
    if (!exigirModoPrueba(ss)) return;

    let limpiadas = 0;
    ss.getSheets().forEach(hoja => {
        let clave = claveHoja(hoja.getName());
        if (!esHojaPrincipal(clave) && !esHojaInventario(clave)) return;
        let lr = hoja.getLastRow();
        if (lr < 1) return;
        let col = hoja.getRange(1, COL_HOUSE, lr, 1).getValues();
        let items = [];
        for (let i = 0; i < col.length; i++) {
            if (String(col[i][0]).trim() === TXT_HOUSE_SIN_DATO) {
                items.push({ fila: i + 1, valor: "" });
                limpiadas++;
            }
        }
        bloquesContiguos(items).forEach(b => {
            hoja.getRange(b.fila, COL_HOUSE, b.valores.length, 1).setValues(b.valores);
        });
    });
    ui.alert("🔁 Reintentar", "Marcas borradas: " + limpiadas +
             "\n\nEl disparador las volverá a buscar en el próximo minuto.", ui.ButtonSet.OK);
}

// -------------------------------------------------------------------------
// DISPARADOR
// -------------------------------------------------------------------------
function instalarTriggerHouse() {
    const ss = obtenerArchivo();
    const ui = SpreadsheetApp.getUi();
    if (!exigirModoPrueba(ss)) return;

    quitarTriggerHouse(true);
    ScriptApp.newTrigger('rellenarHousesPendientes').timeBased().everyMinutes(1).create();
    ui.alert("🏠 Houses", "Listo: las houses se rellenarán solas cada minuto.", ui.ButtonSet.OK);
}

function quitarTriggerHouse(silencioso) {
    ScriptApp.getProjectTriggers().forEach(t => {
        if (t.getHandlerFunction() === 'rellenarHousesPendientes') ScriptApp.deleteTrigger(t);
    });
    if (!silencioso) {
        SpreadsheetApp.getUi().alert("🏠 Houses", "Disparador quitado.",
                                     SpreadsheetApp.getUi().ButtonSet.OK);
    }
}
