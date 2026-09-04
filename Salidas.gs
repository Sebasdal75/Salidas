// =========================================================================
// ÍNDICE DE SALIDAS: lo que YA se fue
// =========================================================================
//
// QUÉ RESUELVE
//
// Una guía que ya se embarcó hace días y se vuelve a escanear hoy. Hasta ahora
// eso no lo veía nadie: el ⛔ DUPLICADO solo mira las pestañas VIVAS del
// archivo, y en cuanto un bloque se cierra y se limpia, esa guía desaparece del
// caché y vuelve a ser «nueva». Un doble embarque no deja rastro.
//
// La pestaña HISTORICO ya intentaba cubrirlo, pero a medias: hay que llenarla a
// mano, engorda el archivo de operación, y solo revisa cuando alguien aprieta
// el botón —o sea, cuando el camión ya salió—.
//
// CÓMO
//
// Mismo motor que el índice de houses, que ya está probado: se importan los
// concentrados de salidas, se indexan `guía → fecha + pedimento`, y se reparten
// entre un índice CALIENTE (lo reciente, lo que de verdad puede repetirse) y un
// ARCHIVO FRÍO (lo viejo, que se guarda pero no se consulta en caliente).
//
// LO QUE ESTE ARCHIVO NO HACE TODAVÍA
//
// El aviso al escanear. Tiene que ser INSTANTÁNEO y BLOQUEANTE, y ya sabemos
// contra qué: el histórico real son 677.262 renglones, unas 2.900 salidas
// diarias. Ese número es el que manda, y por eso lo primero que hay aquí es una
// VENTANA que acota cuánto entra. Sin ella no hay camino rápido posible, ni
// siquiera importación posible.
//
// LA REGLA QUE MANDA AQUÍ: GANA LA PRIMERA SALIDA
//
// Al contrario que las houses —donde gana el inbound porque es lo que llegó de
// verdad—, aquí lo que importa es CUÁNDO SE FUE POR PRIMERA VEZ. Si un
// concentrado dice que salió el 12/08 y otro que el 03/09, la respuesta útil es
// el 12/08: es la que convierte el segundo escaneo en sospechoso. Quedarse con
// la última haría lo contrario, esconder el primer embarque.
// =========================================================================

const HOJA_INDICE_SALIDAS = "INDICE_SALIDAS";

// UN SOLO NÚMERO manda aquí: la ventana de días (ver «LA VENTANA»). Es el que
// decide qué se importa Y qué se conserva. Tener dos —uno para importar y otro
// para archivar— es cómo el índice acabaría con el triple de lo que se pidió.

const CARPETA_SALIDAS = "SALIDAS_HISTORICO";
const PROP_URL_SALIDAS = 'SALIDAS_URLS_ONEDRIVE';
const PROP_ARCHIVOS_SALIDAS = 'SALIDAS_ARCHIVOS_IMPORTADOS';

const CAB_INDICE_SALIDAS = ["GUIA", "FECHA", "PEDIMENTO", "ORIGEN"];

// -------------------------------------------------------------------------
// LEER EL CONCENTRADO
// -------------------------------------------------------------------------

// Dónde está cada cosa en el CSV de salidas.
//
// Se busca por NOMBRE, igual que en el inbound y por la misma razón: una
// posición fija se rompe en silencio el día que alguien toca la consulta, y
// empezaría a leer fechas de la columna de al lado sin que nada avisara.
//
// La GUÍA es lo único imprescindible. Sin fecha, la salida se queda en el
// índice caliente —que es el lado seguro: verla de más cuesta una consulta, no
// verla cuesta un doble embarque—.
function detectarColumnasSalida(headers) {
    let norm = (headers || []).map(h => sinAcentos(String(h).trim().toUpperCase()));
    let buscar = (claves, excluir) => {
        for (let i = 0; i < norm.length; i++) {
            let h = norm[i];
            if (excluir && excluir.some(x => h.indexOf(x) !== -1)) continue;
            if (claves.some(c => h.indexOf(c) !== -1)) return i;
        }
        return -1;
    };

    // «GUIA CORTA» es la house, no la guía: mismo choque que en el inbound.
    let guia = buscar(["1Z", "TRACKING", "GUIA", "RASTREO"],
                      ["CORTA", "HOUSE", "HAWB", "CASA", "SHIPMENT"]);
    // «FECHA DE SALIDA» y «SALIDA» ganan a un «FECHA» suelto: un concentrado
    // suele traer varias fechas —captura, salida, cierre— y la que vale es la
    // de salida.
    let fecha = buscar(["FECHA SALIDA", "FECHA DE SALIDA", "F. SALIDA"]);
    if (fecha === -1) fecha = buscar(["SALIDA", "EMBARQUE", "DESPACHO"]);
    if (fecha === -1) fecha = buscar(["FECHA", "DATE"]);

    let pedimento = buscar(["PEDIMENTO", "PEDIM"]);
    return { guia: guia, fecha: fecha, pedimento: pedimento };
}

// Cuántas salidas se descartaron por no traer una guía reconocible.
let globalSalidasDescartadas = 0;
function salidasDescartadas() { return globalSalidasDescartadas; }
function reiniciarSalidasDescartadas() {
    globalSalidasDescartadas = 0;
    globalSalidasViejas = 0;
    globalSalidasSinFecha = 0;
}

// Del CSV crudo a filas limpias.
//
// AQUÍ NO SE BARRE LA FILA ENTERA, Y ES A PROPÓSITO. En el inbound sí: rescatar
// una 1Z enterrada en un campo de referencias solo puede AÑADIR una house, y
// equivocarse cuesta un dato de más.
//
// Aquí lo que hay al otro lado es un aviso que BLOQUEA. Una base de datos
// completa arrastra columnas de referencias, observaciones, guías relacionadas,
// devoluciones y comentarios; cualquier 1Z que aparezca ahí quedaría marcada
// como «YA SALIÓ» y frenaría la línea la próxima vez que alguien la escanee,
// aunque esa guía no se haya embarcado nunca. Se lee LA COLUMNA DE LA GUÍA y
// nada más.
//
// Sin columna de guía no se importa nada, y se dice por qué. Barrer «por si
// acaso» es justo lo que no se puede hacer cuando el resultado bloquea.
// `corte` es la fecha más antigua que se acepta, o null para aceptarlo todo.
// Lo anterior NI SIQUIERA SE CONSTRUYE: ver «LA VENTANA» más abajo.
function filasDeSalidas(datos, cols, origen, corte) {
    let salida = [];
    let descartadas = 0, viejas = 0, sinFecha = 0;
    if (!datos || !cols || cols.guia === -1) return salida;

    for (let i = 1; i < datos.length; i++) {
        let fila = datos[i];
        if (!fila) continue;

        let fecha = cols.fecha === -1 ? null : aFechaInbound(fila[cols.fecha]);

        // El filtro va ANTES de todo lo demás: es lo que hace que un histórico
        // de 677.000 renglones quepa en memoria (ver «LA VENTANA»).
        if (corte && fecha && fecha < corte) { viejas++; continue; }
        if (fecha === null) sinFecha++;

        let ped = cols.pedimento === -1 ? ""
                : String(fila[cols.pedimento] === undefined ? "" : fila[cols.pedimento]).trim();
        // Un pedimento es de 7 dígitos. Lo que no lo sea no se guarda como tal:
        // más vale la celda vacía que un número inventado al lado de un aviso
        // que bloquea.
        if (!/^\d{7}$/.test(ped)) ped = "";

        let g = claveGuiaHouse(fila[cols.guia]);
        if (g === "" || !esGuiaUPSValida(g)) { descartadas++; continue; }
        salida.push({ guia: g, fecha: fecha, pedimento: ped,
                      origen: String(origen || "") });
    }
    globalSalidasDescartadas += descartadas;
    globalSalidasViejas += viejas;
    globalSalidasSinFecha += sinFecha;
    return salida;
}

// -------------------------------------------------------------------------
// LA VENTANA: hasta dónde atrás se importa
//
// EL NÚMERO QUE OBLIGA A ESTO: el histórico real trae 677.262 renglones, o sea
// unas 2.900 salidas al día desde enero. Meterlo entero no es cuestión de
// paciencia, es que no cabe:
//
//   · construir 677.000 objetos en memoria revienta el límite de Apps Script;
//   · escribirlos son 2,7 millones de celdas y catorce llamadas, y cada
//     importación posterior tendría que volver a LEERLAS todas para fusionar,
//     contra un tope de ejecución de seis minutos;
//   · y para el aviso instantáneo habría que llevar esa lista al escaneo, que
//     hoy entero dura medio segundo.
//
// Así que se importa una VENTANA. Y el corte no lo pongo yo a ojo: lo pone
// quien sabe hasta cuándo puede reaparecer una guía en el muelle.
//
// Lo que queda fuera no se pierde —sigue en tu Excel— y ampliar la ventana es
// volver a importar con otro número.
// -------------------------------------------------------------------------
const PROP_DIAS_SALIDAS_IMPORT = 'SALIDAS_DIAS_IMPORT';
const DIAS_SALIDAS_IMPORT_DEFECTO = 60;

let globalSalidasViejas = 0;
let globalSalidasSinFecha = 0;
function salidasViejas() { return globalSalidasViejas; }
function salidasSinFechaLeidas() { return globalSalidasSinFecha; }

function diasDeImportacionSalidas() {
    let v = 0;
    try {
        v = Number(PropertiesService.getScriptProperties()
                   .getProperty(PROP_DIAS_SALIDAS_IMPORT) || 0);
    } catch (err) { v = 0; }
    return (v > 0) ? v : DIAS_SALIDAS_IMPORT_DEFECTO;
}

// La fecha más antigua que se acepta. Se calcula UNA vez por importación: con
// 677.000 filas, hacerlo dentro del bucle son 677.000 restas de fechas.
function corteDeImportacion(hoy, dias) {
    if (!dias || dias <= 0) return null;
    return new Date(hoy.getTime() - dias * 24 * 60 * 60 * 1000);
}

function configurarVentanaDeSalidas() {
    const ss = obtenerArchivo();
    const ui = SpreadsheetApp.getUi();
    if (!exigirModoPrueba(ss)) return;

    let actual = diasDeImportacionSalidas();
    let r = ui.prompt("📆 Ventana del histórico de salidas",
        "¿Cuántos días hacia atrás quieres importar?\n\n" +
        "Ahora: " + actual + " días.\n\n" +
        "Con ~2.900 salidas al día, cada 30 días son unas 87.000 guías. " +
        "Cuantas más, más tarda la importación y más pesa el aviso al " +
        "escanear.\n\n" +
        "ESTE NÚMERO TAMBIÉN PODA: lo que se salga de la ventana se quita del " +
        "índice en la próxima importación. Es lo que impide que crezca solo " +
        "hasta no caber.\n\n" +
        "Escribe un número de días (0 = todo, y con tu volumen eso NO va a " +
        "entrar).", ui.ButtonSet.OK_CANCEL);
    if (r.getSelectedButton() !== ui.Button.OK) return;

    let n = Number(String(r.getResponseText()).trim());
    if (isNaN(n) || n < 0) {
        ui.alert("📆 Ventana", "Eso no es un número de días.", ui.ButtonSet.OK);
        return;
    }
    PropertiesService.getScriptProperties()
        .setProperty(PROP_DIAS_SALIDAS_IMPORT, String(n));
    ui.alert("📆 Ventana",
             n === 0 ? "Guardado: se importará TODO. Prepárate para que la " +
                       "importación se pase de tiempo."
                     : "Guardado: se importarán los últimos " + n + " días.",
             ui.ButtonSet.OK);
}

function filasDeCsvDeSalidas(texto, cols, origen, corte) {
    let lineas = String(texto).split("\n");
    let cabecera = lineas[0] || "";
    let sep = separadorCsv(cabecera);
    let salida = [];
    bloquesDeLineas(texto, LINEAS_POR_BLOQUE, cabecera).forEach(bloque => {
        let datos = Utilities.parseCsv(bloque, sep);
        filasDeSalidas(datos, cols, origen, corte).forEach(r => salida.push(r));
    });
    return salida;
}

// -------------------------------------------------------------------------
// FUSIONAR
// -------------------------------------------------------------------------

// Gana la PRIMERA salida (ver la cabecera del archivo). Además se cuenta
// cuántas veces aparece cada guía: una guía que figura dos veces en el propio
// histórico YA es un doble embarque pasado, y eso hay que poder verlo sin
// esperar a que alguien la vuelva a escanear.
//
// Cada fila del índice es [guía, fecha, pedimento, origen].
function fusionarEnIndiceSalidas(existentes, nuevas) {
    let filas = [];
    let porGuia = new Map();
    (existentes || []).forEach(f => {
        let g = claveGuiaHouse(f[0]);
        if (g === "" || porGuia.has(g)) return;
        let fila = [g, f[1] === undefined ? "" : f[1],
                    f[2] === undefined ? "" : f[2],
                    f[3] === undefined ? "" : f[3]];
        porGuia.set(g, fila);
        filas.push(fila);
    });

    let anadidas = 0, adelantadas = 0;
    let repetidas = [];
    (nuevas || []).forEach(n => {
        let previa = porGuia.get(n.guia);
        if (previa === undefined) {
            let fila = [n.guia, n.fecha || "", n.pedimento || "", n.origen || ""];
            porGuia.set(n.guia, fila);
            filas.push(fila);
            anadidas++;
            return;
        }

        let antes = aFechaInbound(previa[1]);
        let ahora = n.fecha;

        // Mismo pedimento y misma fecha: es el mismo renglón visto dos veces
        // (dos concentrados que se solapan). No es un doble embarque.
        let mismaFecha = (antes && ahora && antes.getTime() === ahora.getTime()) ||
                         (!antes && !ahora);
        if (mismaFecha && String(previa[2]) === String(n.pedimento || "")) return;

        // Dos salidas de verdad para la misma guía. Se reporta SIEMPRE: esto ya
        // es el problema que el índice existe para encontrar, solo que ocurrido
        // en el pasado.
        repetidas.push({
            guia: n.guia,
            primera: previa[1], pedPrimera: previa[2],
            segunda: n.fecha || "", pedSegunda: n.pedimento || ""
        });

        // Y se conserva la más ANTIGUA.
        if (antes && ahora && ahora < antes) {
            previa[1] = n.fecha;
            previa[2] = n.pedimento || previa[2];
            previa[3] = n.origen || previa[3];
            adelantadas++;
        } else if (!antes && ahora) {
            previa[1] = n.fecha;
            previa[2] = n.pedimento || previa[2];
            previa[3] = n.origen || previa[3];
        }
    });

    return { filas: filas, anadidas: anadidas, adelantadas: adelantadas,
             repetidas: repetidas };
}

// -------------------------------------------------------------------------
// EL ÍNDICE EN SHEETS
// -------------------------------------------------------------------------

function hojaIndiceSalidas(nombre, crear) {
    let libro = archivoDelIndice();
    let h = libro.getSheetByName(nombre);
    if (!h && crear) {
        h = libro.insertSheet(nombre);
        h.getRange(1, 1, 1, 4).setValues([CAB_INDICE_SALIDAS]);
        h.setFrozenRows(1);
        if (!indiceEstaAparte()) h.hideSheet();
    }
    return h;
}

function leerIndiceSalidas(nombre) {
    let h = hojaIndiceSalidas(nombre, false);
    if (!h) return [];
    let lr = h.getLastRow();
    if (lr < 2) return [];
    let ancho = Math.max(1, Math.min(4, h.getLastColumn()));
    let filas = h.getRange(2, 1, lr - 1, ancho).getValues();
    if (ancho === 4) return filas;
    return filas.map(f => {
        let c = f.slice();
        while (c.length < 4) c.push("");
        return c;
    });
}

function escribirIndiceSalidas(nombre, filas) {
    let h = hojaIndiceSalidas(nombre, true);
    if (h.getMaxColumns() < 4) h.insertColumnsAfter(h.getMaxColumns(), 4 - h.getMaxColumns());
    h.getRange(1, 1, 1, 4).setValues([CAB_INDICE_SALIDAS]);
    let lr = h.getLastRow();
    if (lr > 1) h.getRange(2, 1, lr - 1, 4).clearContent();
    if (filas.length === 0) return;
    asegurarFilas(h, filas.length + 1);
    for (let i = 0; i < filas.length; i += FILAS_POR_ESCRITURA) {
        let tramo = filas.slice(i, i + FILAS_POR_ESCRITURA);
        h.getRange(2 + i, 1, tramo.length, 4).setValues(tramo);
    }
}

// Reparte el índice entre caliente y frío. La fecha va en la posición 1, no en
// la 2 como en el índice de houses, así que no se puede reusar el de allí: la
// alternativa era remapear cada fila para volver a remapearla después, y eso en
// cientos de miles de filas es una búsqueda dentro de un bucle.
//
// Sin fecha se QUEDA, igual que en las houses y por una razón más fuerte
// todavía: aquí lo que hay al otro lado es un aviso que BLOQUEA. Tirar una
// salida cuya fecha no se entendió sería esconder justo el caso que hay que ver.
function particionSalidasPorAntiguedad(filas, hoy, dias) {
    let corte = new Date(hoy.getTime() - dias * 24 * 60 * 60 * 1000);
    let calientes = [], frias = [];
    (filas || []).forEach(f => {
        let fecha = aFechaInbound(f[1]);
        if (fecha === null || fecha >= corte) calientes.push(f);
        else frias.push(f);
    });
    return { calientes: calientes, frias: frias };
}

// Fusiona, PODA lo que se salió de la ventana, escribe, y devuelve el resumen.
//
// LA PODA ES LO QUE MANTIENE ESTO ACOTADO, y sin ella el índice crecería solo:
// cada importación mete los últimos 60 días y CONSERVA lo que ya estaba, así
// que en dos meses el índice tendría 120 días dentro, en tres meses 180, y la
// ventana que elegiste no querría decir nada. Se poda contra la MISMA ventana
// con la que se importa: un número, un significado.
//
// Y aquí no hay archivo frío, al revés que en las houses. Allí una prealerta
// vieja sigue sirviendo —la guía que llega hoy pudo prealertarse hace meses—.
// Aquí una salida fuera de la ventana está fuera POR DECISIÓN: no se consulta
// nunca, así que guardarla solo sería un archivo que crece sin parar y que hay
// que reescribir entero en cada importación. El archivo de verdad es tu Excel,
// y ampliar la ventana lo trae de vuelta.
function volcarAlIndiceSalidas(nuevas) {
    let fusion = fusionarEnIndiceSalidas(
        leerIndiceSalidas(HOJA_INDICE_SALIDAS), nuevas);
    let dias = diasDeImportacionSalidas();
    let particion = particionSalidasPorAntiguedad(fusion.filas, new Date(), dias);
    let calientes = particion.calientes;
    let podadas = particion.frias.length;

    escribirIndiceSalidas(HOJA_INDICE_SALIDAS, calientes);

    // Y el texto comprimido que consulta el escaneo. Si esto no se rehiciera
    // aquí, el índice quedaría al día y el aviso seguiría contestando con los
    // datos de la importación anterior, sin que nada lo dijera.
    let celdasRapido = 0;
    try {
        celdasRapido = guardarBlobDeSalidas(obtenerArchivo(), calientes);
        olvidarBlobSalidasEnRAM();
    } catch (err) { celdasRapido = -1; }

    let conFecha = (nuevas || []).filter(n => n.fecha).length;
    let total = (nuevas || []).length;
    let msg = "Salidas leídas del archivo: " + total.toLocaleString() + "\n" +
              "  · con fecha reconocida: " + conFecha.toLocaleString() + "\n" +
              "Guías nuevas en el índice: " + fusion.anadidas.toLocaleString() + "\n" +
              "Índice (ventana de " + dias + " días): " + calientes.length.toLocaleString();
    if (podadas > 0) {
        msg += "\n  · " + podadas.toLocaleString() + " se salieron de la ventana y " +
               "se podaron";
    }
    msg += celdasRapido >= 0
        ? "\nLista rápida del escaneo: " + celdasRapido + " celdas ✅"
        : "\n⚠️ NO se pudo rehacer la lista rápida del escaneo. El aviso seguirá " +
          "contestando con los datos de antes. Usa «⚡ Rehacer la lista rápida».";

    let tiradas = salidasDescartadas();
    if (tiradas > 0) {
        msg += "\n\n🚫 " + tiradas.toLocaleString() + " renglones sin ninguna guía " +
               "reconocible (totales, subtotales, filas en blanco).";
    }
    let fuera = salidasViejas();
    if (fuera > 0) {
        msg += "\n\n📆 " + fuera.toLocaleString() + " salidas quedaron FUERA de la " +
               "ventana de " + diasDeImportacionSalidas() + " días.\n" +
               "No se pierden: siguen en tu Excel. Para meterlas, amplía la " +
               "ventana y vuelve a importar.";
    }

    if (total > 0 && conFecha < total / 2) {
        msg += "\n\n⚠️ Solo " + conFecha + " de " + total + " salidas traen una " +
               "fecha que se entienda. Las demás se quedan en el índice CALIENTE.\n\n" +
               "Suele ser que la columna de fecha no está formateada como fecha en " +
               "Excel. Dale formato de fecha y vuelve a exportar.";
    }

    if (fusion.repetidas.length) {
        msg += "\n\n⚠️ " + fusion.repetidas.length + " guías que YA SALIERON DOS " +
               "VECES según tu propio histórico:\n" +
               fusion.repetidas.slice(0, 8).map(r =>
                   "  " + r.guia + ": " + textoFechaSalida(r.primera) +
                   (r.pedPrimera ? " (ped. " + r.pedPrimera + ")" : "") +
                   "  y  " + textoFechaSalida(r.segunda) +
                   (r.pedSegunda ? " (ped. " + r.pedSegunda + ")" : "")
               ).join("\n");
        if (fusion.repetidas.length > 8) {
            msg += "\n  …y " + (fusion.repetidas.length - 8) + " más.";
        }
        msg += "\n\nEsto es exactamente lo que el índice existe para evitar, pero " +
               "ya ocurrido. Vale la pena revisarlas antes de seguir.";
    }
    return msg;
}

// dd/MM/yyyy sin pasar por `Utilities.formatDate`.
//
// No es purismo: `formatDate` convierte a la zona horaria del script, y una
// fecha de salida construida a medianoche local puede retroceder un día al
// formatearla. Un aviso que BLOQUEA no puede decir una fecha que no es —el
// operador va a buscar ese embarque al día equivocado—. Aquí la fecha se
// escribe tal como se guardó.
function textoFechaSalida(v) {
    if (v === "" || v === null || v === undefined) return "sin fecha";
    let d = aFechaInbound(v);
    if (!d) return String(v);
    let dd = String(d.getDate());
    let mm = String(d.getMonth() + 1);
    if (dd.length < 2) dd = "0" + dd;
    if (mm.length < 2) mm = "0" + mm;
    return dd + "/" + mm + "/" + d.getFullYear();
}

// -------------------------------------------------------------------------
// CONSULTAR
// -------------------------------------------------------------------------

// Un Map guía → {fecha, pedimento} del índice caliente.
function mapaDeSalidas(filas) {
    let m = new Map();
    (filas || []).forEach(f => {
        let g = claveGuiaHouse(f[0]);
        if (g === "") return;
        m.set(g, { fecha: f[1], pedimento: String(f[2] || "") });
    });
    return m;
}

// El texto del aviso, dado lo que el índice sabe de esa guía.
//
// Se separa del resto para que el día que esto entre en el camino del escaneo
// —que es a donde va— el mensaje ya esté decidido y probado, y no haya que
// inventarlo dentro del bucle caliente.
function avisoDeSalidaPrevia(info) {
    if (!info) return "";
    let f = textoFechaSalida(info.fecha);
    return "⛔ YA SALIÓ el " + f +
           (info.pedimento ? " (ped. " + info.pedimento + ")" : "");
}

// -------------------------------------------------------------------------
// IMPORTAR
//
// Dos caminos, los mismos que el índice de houses y por las mismas razones: una
// carpeta de Drive para cargas grandes de una vez, y vínculos de OneDrive para
// el día a día. Toda la maquinaria de bajar, medir y partir el CSV se reusa;
// aquí solo cambia QUÉ columnas se buscan y en qué índice se vuelca.
// -------------------------------------------------------------------------

function urlsDeSalidas() {
    return String(PropertiesService.getScriptProperties()
                  .getProperty(PROP_URL_SALIDAS) || "")
        .split("\n").map(l => l.trim()).filter(l => l !== "");
}

function configurarUrlSalidas() {
    const ss = obtenerArchivo();
    const ui = SpreadsheetApp.getUi();
    if (!exigirModoPrueba(ss)) return;

    let lista = urlsDeSalidas();
    let r = ui.prompt("🔗 Vínculo del histórico de salidas",
        "Pega el vínculo para compartir del CSV de salidas. Se AÑADE a los que " +
        "ya hay (" + lista.length + " guardados).\n\n" +
        "Tiene que ser de «cualquiera con el vínculo»: la descarga va anónima y " +
        "con «gente de la organización» Microsoft devuelve la pantalla de " +
        "inicio de sesión en vez del archivo.", ui.ButtonSet.OK_CANCEL);
    if (r.getSelectedButton() !== ui.Button.OK) return;

    let url = String(r.getResponseText()).trim();
    if (url === "") return;
    lista.push(url);
    PropertiesService.getScriptProperties()
        .setProperty(PROP_URL_SALIDAS, lista.join("\n"));
    ui.alert("🔗 Vínculo del histórico de salidas",
             "Guardado. Ahora hay " + lista.length + ".", ui.ButtonSet.OK);
}

function quitarUrlsSalidas() {
    const ss = obtenerArchivo();
    const ui = SpreadsheetApp.getUi();
    if (!exigirModoPrueba(ss)) return;
    PropertiesService.getScriptProperties().deleteProperty(PROP_URL_SALIDAS);
    ui.alert("🔗 Vínculos de salidas", "Borrados todos.", ui.ButtonSet.OK);
}

// Lee un texto de CSV ya descargado y lo deja listo para el índice. Devuelve
// {filas, problema}: `problema` explicado en castellano, o "" si todo fue bien.
function salidasDeTexto(texto, etiqueta) {
    let primeraLinea = String(texto).split("\n")[0] || "";
    let sepDiag = diagnosticoDelSeparador(primeraLinea);
    if (sepDiag.campos < 2) {
        return { filas: [], problema: etiqueta + ": " + AVISO_SIN_PARTIR + "\n" +
                 sepDiag.texto + "\nCabecera cruda: " + primeraLinea.trim().slice(0, 90) };
    }

    let cab = Utilities.parseCsv(primeraLinea, sepDiag.sep)[0] || [];
    let cols = detectarColumnasSalida(cab);
    if (cols.guia === -1) {
        return { filas: [], problema: etiqueta + ": no encuentro la columna de la guía" +
                 (cabecerasGenericas(cab) ? " (las cabeceras son «Column1, Column2…»: " +
                  "promueve los encabezados en Power Query)" : "") +
                 ".\nCabeceras: " + cab.slice(0, 8).join(" | ") };
    }
    let corte = corteDeImportacion(new Date(), diasDeImportacionSalidas());
    return { filas: filasDeCsvDeSalidas(texto, cols, etiqueta, corte), problema: "",
             cols: cols, cabeceras: cab };
}

function importarSalidasDesdeOneDrive() {
    const ss = obtenerArchivo();
    const ui = SpreadsheetApp.getUi();
    if (!exigirModoPrueba(ss)) return;

    let lista = urlsDeSalidas();
    if (lista.length === 0) {
        ui.alert("📤 Histórico de salidas",
                 "No hay ningún vínculo guardado.\n\nUsa «Añadir vínculo del " +
                 "histórico de salidas» primero.", ui.ButtonSet.OK);
        return;
    }

    let nuevas = [], problemas = [], sinFecha = [];
    reiniciarSalidasDescartadas();

    for (let i = 0; i < lista.length; i++) {
        let etiqueta = "SALIDAS #" + (i + 1);
        let r = bajarDeOneDrive(lista[i]);

        if (!r || r.error) {
            problemas.push(etiqueta + ": no se pudo descargar (" +
                           ((r && r.error) || "sin respuesta") + ")");
            continue;
        }
        if (r.codigo !== 200) { problemas.push(etiqueta + ": Microsoft respondió " + r.codigo); continue; }
        if (r.clase !== "csv") {
            problemas.push(etiqueta + ": lo que bajó no es un CSV, parece " + r.clase);
            continue;
        }
        if (excedeElLimite(r.texto.length)) {
            problemas.push(etiqueta + ": " + (r.texto.length / 1048576).toFixed(1) +
                           " MB, demasiado grande");
            continue;
        }

        let leido = salidasDeTexto(r.texto, etiqueta);
        if (leido.problema !== "") { problemas.push(leido.problema); continue; }
        if (leido.cols.fecha === -1) sinFecha.push(etiqueta);
        leido.filas.forEach(f => nuevas.push(f));
    }

    if (nuevas.length === 0) {
        ui.alert("📤 Histórico de salidas",
                 "No se pudo leer ninguna salida.\n\n" + problemas.join("\n\n"),
                 ui.ButtonSet.OK);
        return;
    }

    let resumen = "Archivos leídos: " + (lista.length - problemas.length) + " de " +
                  lista.length + "\n\n" + volcarAlIndiceSalidas(nuevas);
    if (sinFecha.length) {
        resumen += "\n\n⚠️ Sin columna de fecha: " + sinFecha.join(", ") +
                   "\nEsas salidas se quedan TODAS en el índice caliente.";
    }
    if (problemas.length) resumen += "\n\n❌ Con problemas:\n" + problemas.join("\n");
    ui.alert("📤 Histórico de salidas", resumen, ui.ButtonSet.OK);
}

function importarSalidasDesdeDrive() {
    const ss = obtenerArchivo();
    const ui = SpreadsheetApp.getUi();
    if (!exigirModoPrueba(ss)) return;

    let carpetas = DriveApp.getFoldersByName(CARPETA_SALIDAS);
    if (!carpetas.hasNext()) {
        ui.alert("📤 Histórico de salidas",
                 "No encontré una carpeta de Drive llamada «" + CARPETA_SALIDAS +
                 "».\n\nCréala y sube ahí los CSV del histórico de salidas.",
                 ui.ButtonSet.OK);
        return;
    }

    let yaImportados = (PropertiesService.getScriptProperties()
                        .getProperty(PROP_ARCHIVOS_SALIDAS) || "").split(",");
    let archivos = carpetas.next().getFiles();
    let nuevas = [], leidos = [], saltados = [], problemas = [];
    reiniciarSalidasDescartadas();

    while (archivos.hasNext()) {
        let f = archivos.next();
        // Por ID **y fecha de modificación**: Drive conserva el ID al subir una
        // versión nueva encima, y un histórico que se actualiza se saltaría en
        // silencio si la memoria fuera solo por ID.
        let marca = marcaDeArchivo(f.getId(), f.getLastUpdated());
        if (yaImportados.indexOf(marca) !== -1) continue;

        let nombre = f.getName();
        if (!/\.csv$/i.test(nombre)) { saltados.push(nombre); continue; }

        let texto = textoDeArchivo(f);
        if (excedeElLimite(texto.length)) {
            problemas.push(nombre + " (" + (texto.length / 1048576).toFixed(1) + " MB)");
            continue;
        }

        let leido = salidasDeTexto(texto, nombre);
        if (leido.problema !== "") { problemas.push(leido.problema); continue; }
        leido.filas.forEach(x => nuevas.push(x));
        leidos.push(marca);
    }

    if (nuevas.length === 0 && leidos.length === 0) {
        ui.alert("📤 Histórico de salidas",
                 "No había archivos nuevos que importar." +
                 (saltados.length ? "\n\nIgnorados (no son CSV): " + saltados.join(", ") : "") +
                 (problemas.length ? "\n\n❌ " + problemas.join("\n") : ""),
                 ui.ButtonSet.OK);
        return;
    }

    let msg = volcarAlIndiceSalidas(nuevas);
    PropertiesService.getScriptProperties()
        .setProperty(PROP_ARCHIVOS_SALIDAS,
                     yaImportados.concat(leidos).filter(x => x !== "").join(","));
    if (problemas.length) msg += "\n\n❌ Con problemas:\n" + problemas.join("\n");
    ui.alert("📤 Histórico de salidas", msg, ui.ButtonSet.OK);
}

function olvidarSalidasImportadas() {
    const ss = obtenerArchivo();
    const ui = SpreadsheetApp.getUi();
    if (!exigirModoPrueba(ss)) return;
    PropertiesService.getScriptProperties().deleteProperty(PROP_ARCHIVOS_SALIDAS);
    ui.alert("♻️ Reimportar salidas",
             "Listo. La próxima importación volverá a leer todos los CSV de la " +
             "carpeta.\n\nNo se pierde nada: las guías que ya estaban no se duplican.",
             ui.ButtonSet.OK);
}

// -------------------------------------------------------------------------
// MEDIR: cuánto pesa el índice caliente
//
// Este es el dato del que depende el siguiente paso —el aviso instantáneo al
// escanear—, y no lo tiene nadie hasta que se importa de verdad. Diseñar el
// camino rápido a ojo es cómo se acaba con un escaneo de tres segundos.
// -------------------------------------------------------------------------
function medirIndiceDeSalidas() {
    const ss = obtenerArchivo();
    const ui = SpreadsheetApp.getUi();

    let t0 = Date.now();
    let calientes = leerIndiceSalidas(HOJA_INDICE_SALIDAS);
    let msLectura = Date.now() - t0;

    let t1 = Date.now();
    let mapa = mapaDeSalidas(calientes);
    let msMapa = Date.now() - t1;

    let L = [];
    L.push("Guías en el índice: " + calientes.length.toLocaleString());
    L.push("Ventana: " + diasDeImportacionSalidas() + " días");
    L.push("");
    L.push("Leer el caliente:      " + msLectura + " ms");
    L.push("Armar el Map:          " + msMapa + " ms");
    L.push("Guías en el Map:       " + mapa.size.toLocaleString());
    L.push("");
    L.push("── QUÉ SIGNIFICA ──");
    // 18 caracteres por guía es el tamaño real de una 1Z; es lo que ocuparía
    // llevar el caliente empaquetado en el caché, que es la vía para que el
    // aviso salga en el mismo escaneo.
    let kb = Math.round(calientes.length * 18 / 1024);
    L.push("Empaquetado en el caché ocuparía ~" + kb.toLocaleString() + " KB,");
    L.push("o sea ~" + Math.ceil(calientes.length * 18 / 50000) + " celdas.");
    L.push("");
    if (calientes.length === 0) {
        L.push("Todavía no hay nada importado.");
    } else if (calientes.length <= 150000) {
        L.push("✅ Cabe de sobra. El aviso instantáneo al escanear es viable");
        L.push("   con este volumen.");
    } else {
        L.push("⚠️ Es mucho para llevarlo en cada escaneo. Habría que bajar la");
        L.push("   ventana de " + diasDeImportacionSalidas() + " días, o cambiar");
        L.push("   de estrategia. Dímelo antes de seguir.");
    }
    ui.alert("📏 Índice de salidas", L.join("\n"), ui.ButtonSet.OK);
}

// -------------------------------------------------------------------------
// PROBAR SIN IMPORTAR
//
// «Sube todo y tú escoges» solo funciona si puedes VER qué escogí antes de que
// entre nada. Una base de datos entera trae veinte columnas y yo me quedo con
// tres; si me equivoco de columna de fecha, el reparto caliente/frío se va al
// traste en silencio, y si me equivoco de columna de guía, el índice se llena
// de basura que después BLOQUEA escaneos.
//
// Esto lee el archivo, enseña qué columnas encontró, cuáles ignora y cómo
// quedarían las primeras filas — y no escribe absolutamente nada.
// -------------------------------------------------------------------------

// El informe, dadas las cabeceras y lo que se detectó. Puro, para poder
// probarlo: es el texto que decide si el usuario aprueba o corrige.
function informeDeColumnasSalida(cab, cols) {
    let L = [];
    let nombre = i => (i === -1 ? null : String((cab || [])[i] === undefined ? "" : cab[i]).trim());

    L.push("── LO QUE VOY A USAR ──");
    L.push("  Guía:      " + (cols.guia === -1
        ? "❌ NO LA ENCUENTRO — sin esto no se importa nada"
        : "columna " + (cols.guia + 1) + "  «" + nombre(cols.guia) + "»"));
    L.push("  Fecha:     " + (cols.fecha === -1
        ? "⚠️ ninguna — TODO se quedaría en el índice caliente"
        : "columna " + (cols.fecha + 1) + "  «" + nombre(cols.fecha) + "»"));
    L.push("  Pedimento: " + (cols.pedimento === -1
        ? "(ninguna; el aviso saldrá sin número de pedimento)"
        : "columna " + (cols.pedimento + 1) + "  «" + nombre(cols.pedimento) + "»"));

    let usadas = [cols.guia, cols.fecha, cols.pedimento];
    let ignoradas = [];
    for (let i = 0; i < (cab || []).length; i++) {
        if (usadas.indexOf(i) !== -1) continue;
        let n = nombre(i);
        ignoradas.push(n === "" ? "(sin nombre)" : n);
    }

    L.push("");
    L.push("── LO QUE IGNORO (" + ignoradas.length + " columnas) ──");
    if (ignoradas.length === 0) L.push("  Ninguna: uso el archivo entero.");
    else {
        L.push("  " + ignoradas.slice(0, 25).join(" · "));
        if (ignoradas.length > 25) L.push("  …y " + (ignoradas.length - 25) + " más.");
        L.push("");
        L.push("  Sobran sin coste: el índice solo guarda guía, fecha y pedimento.");
        L.push("  Si alguna de esas te sirve más que la que elegí, dímelo.");
    }
    return L.join("\n");
}

function probarArchivoDeSalidas() {
    const ss = obtenerArchivo();
    const ui = SpreadsheetApp.getUi();
    if (!exigirModoPrueba(ss)) return;

    let lista = urlsDeSalidas();
    if (lista.length === 0) {
        ui.alert("🔎 Probar el histórico de salidas",
                 "No hay ningún vínculo guardado.", ui.ButtonSet.OK);
        return;
    }

    let partes = [];
    for (let i = 0; i < lista.length; i++) {
        let etiqueta = "SALIDAS #" + (i + 1);
        let r = bajarDeOneDrive(lista[i]);

        if (!r || r.error) {
            partes.push("── " + etiqueta + " ──\n❌ No se pudo conectar: " +
                        ((r && r.error) || "sin respuesta"));
            continue;
        }
        let d = "── " + etiqueta + " ──\n" +
                "HTTP " + r.codigo + " · " + (r.texto.length / 1048576).toFixed(1) +
                " MB · parece " + String(r.clase).toUpperCase() + "\n";
        if (r.codigo !== 200 || r.clase !== "csv") {
            partes.push(d + "❌ " + explicarDescargaMala(r.clase));
            continue;
        }
        if (excedeElLimite(r.texto.length)) {
            partes.push(d + "❌ " + avisoDeTamano(r.texto.length));
            continue;
        }

        let lineas = r.texto.split("\n");
        // −1 por la cabecera. Es una cuenta de renglones, no de guías: una fila
        // sin guía válida no entrará.
        d += "Renglones: ~" + Math.max(0, lineas.length - 1).toLocaleString() + "\n";

        let sepDiag = diagnosticoDelSeparador(lineas[0] || "");
        d += sepDiag.texto + "\n";
        if (sepDiag.campos < 2) { partes.push(d + "\n" + AVISO_SIN_PARTIR); continue; }

        let cab = Utilities.parseCsv(lineas[0] || "", sepDiag.sep)[0] || [];
        let cols = detectarColumnasSalida(cab);
        d += "\n" + informeDeColumnasSalida(cab, cols) + "\n";

        if (cols.guia !== -1) {
            // Solo las primeras filas: es una muestra para mirar con los ojos,
            // no una validación del archivo entero.
            let muestra = Utilities.parseCsv(
                lineas.slice(0, 6).join("\n"), sepDiag.sep);
            reiniciarSalidasDescartadas();
            let filas = filasDeSalidas(muestra, cols, etiqueta);
            d += "\n── CÓMO QUEDARÍAN LAS PRIMERAS FILAS ──\n";
            if (filas.length === 0) {
                d += "  ⚠️ Ninguna de las primeras 5 trae una guía válida.\n" +
                     "     Comprueba que la columna que elegí es la correcta.";
            } else {
                filas.forEach(f => {
                    d += "  " + f.guia + "   ·   " + textoFechaSalida(f.fecha) +
                         (f.pedimento ? "   ·   ped. " + f.pedimento : "") + "\n";
                });
                if (salidasDescartadas() > 0) {
                    d += "  (" + salidasDescartadas() + " de esas 5 sin guía válida)";
                }
            }
        }
        partes.push(d);
    }

    partes.push("\nNo se ha importado nada. Esto solo mira.");
    ui.alert("🔎 Probar el histórico de salidas", partes.join("\n\n"), ui.ButtonSet.OK);
}

// =========================================================================
// EL CAMINO RÁPIDO: consultar 174.000 salidas dentro de un escaneo
// =========================================================================
//
// EL PROBLEMA. El índice vive en OTRO archivo y son ~174.000 filas. Abrirlo
// dentro de un escaneo cuesta segundos, y un escaneo entero dura medio. Meterlo
// en CACHE_SISTEMA tampoco vale: el caché se lee ENTERO en cada escaneo, así
// que 174.000 filas más se pagarían en todos, no solo en los que hacen falta.
//
// LO QUE SE HACE. Se guarda la lista COMPRIMIDA EN TEXTO, en una pestaña oculta
// del archivo de operación, repartida en pocas celdas de 45.000 caracteres:
//
//     |1Z0139126764115028:260115|1Z013A440467552595:260803|…
//
// Buscar es un `indexOf` sobre esa cadena. V8 lo resuelve en un par de
// milisegundos sobre megabytes —es búsqueda de texto nativa, no un bucle—, y el
// separador «|…:» hace la coincidencia exacta sin tener que contar posiciones:
// una guía corta no puede colarse dentro de otra más larga.
//
// El texto se lee UNA vez por ejecución y se queda en memoria, igual que el
// mapa de houses. Son ~100 celdas: una sola llamada, no 174.000 filas.
//
// POR QUÉ NO A ANCHO FIJO. Sería un carácter más barato, pero las guías no
// miden todas igual: las 1Z son de 18 y las cortas de lo que sean. Con ancho
// fijo habría que rellenar y contar posiciones, y una guía corta acabaría
// haciendo match dentro del hueco de otra. El separador lo hace imposible.
// =========================================================================

const HOJA_SALIDAS_RAPIDO = "SALIDAS_RAPIDO";
// Por debajo del tope de 50.000 caracteres por celda, con margen.
const CHARS_POR_CELDA_SALIDA = 45000;
const FECHA_SALIDA_DESCONOCIDA = "000000";

// La fecha en seis caracteres: aammdd. No hace falta más —el año 19xx no
// existe en este archivo— y cada carácter se multiplica por 174.000.
function claveFechaSalida(fecha) {
    let d = aFechaInbound(fecha);
    if (!d) return FECHA_SALIDA_DESCONOCIDA;
    let p = n => (n < 10 ? "0" + n : String(n));
    return p(d.getFullYear() % 100) + p(d.getMonth() + 1) + p(d.getDate());
}

function fechaDeClaveSalida(clave) {
    let c = String(clave || "");
    if (c.length !== 6 || c === FECHA_SALIDA_DESCONOCIDA) return null;
    let a = Number(c.substring(0, 2)), m = Number(c.substring(2, 4)),
        d = Number(c.substring(4, 6));
    if (isNaN(a) || isNaN(m) || isNaN(d) || m < 1 || m > 12 || d < 1 || d > 31) return null;
    return new Date(2000 + a, m - 1, d);
}

// De las filas del índice al texto comprimido, ya troceado en celdas.
function empaquetarSalidas(filas) {
    let trozos = [];
    let actual = "";
    (filas || []).forEach(f => {
        let g = claveGuiaHouse(f[0]);
        if (g === "") return;
        let reg = "|" + g + ":" + claveFechaSalida(f[1]);
        // Se corta ANTES de pasarse, nunca a mitad de un registro: un registro
        // partido entre dos celdas se volvería a unir al leer, pero si alguien
        // mira la pestaña vería basura y pensaría que está corrupta.
        if (actual.length + reg.length > CHARS_POR_CELDA_SALIDA) {
            trozos.push([actual]);
            actual = "";
        }
        actual += reg;
    });
    if (actual !== "") trozos.push([actual]);
    return trozos;
}

// La búsqueda. `blob` es el texto ya unido.
//
// El «|» delante y el «:» detrás son lo que hace exacta la coincidencia. Sin
// ellos, buscar una guía corta encontraría cualquier guía larga que la
// contuviera, y eso BLOQUEARÍA un escaneo bueno.
function buscarSalidaEnBlob(blob, guia) {
    let g = claveGuiaHouse(guia);
    if (!blob || g === "") return null;
    let i = blob.indexOf("|" + g + ":");
    if (i === -1) return null;
    return { fecha: fechaDeClaveSalida(blob.substr(i + g.length + 2, 6)),
             pedimento: "" };
}

// -------------------------------------------------------------------------
// EL TEXTO EN LA HOJA
// -------------------------------------------------------------------------

function hojaSalidasRapido(ss, crear) {
    let h = ss.getSheetByName(HOJA_SALIDAS_RAPIDO);
    if (!h && crear) {
        h = ss.insertSheet(HOJA_SALIDAS_RAPIDO);
        h.hideSheet();
    }
    return h;
}

function guardarBlobDeSalidas(ss, filas) {
    let trozos = empaquetarSalidas(filas);
    let h = hojaSalidasRapido(ss, true);
    let maxAntes = h.getMaxRows();
    if (maxAntes > 1) h.getRange(1, 1, maxAntes, 1).clearContent();
    if (trozos.length === 0) return 0;
    asegurarFilas(h, trozos.length + 1);
    h.getRange(1, 1, trozos.length, 1).setValues(trozos);
    return trozos.length;
}

// El texto vive en memoria entre escaneos mientras V8 conserve el proceso, que
// es el mismo truco del mapa de houses. La primera consulta de cada proceso
// paga una llamada; las siguientes son gratis.
let globalBlobSalidas = null;

function olvidarBlobSalidasEnRAM() { globalBlobSalidas = null; }

function leerBlobDeSalidas(ss) {
    if (globalBlobSalidas !== null) return globalBlobSalidas;
    globalBlobSalidas = "";
    try {
        let h = hojaSalidasRapido(ss, false);
        if (!h) return globalBlobSalidas;
        let lr = h.getLastRow();
        if (lr < 1) return globalBlobSalidas;
        globalBlobSalidas = h.getRange(1, 1, lr, 1).getValues()
            .map(f => String(f[0])).join("");
    } catch (err) {
        // Que esto falle NO puede tumbar un escaneo: sin lista, no hay aviso,
        // y el sistema sigue haciendo todo lo demás igual que antes.
        globalBlobSalidas = "";
    }
    return globalBlobSalidas;
}

// LA PUERTA DE ENTRADA para el recálculo. Devuelve null si la guía no salió.
function salidaPreviaDe(ss, guia) {
    try {
        return buscarSalidaEnBlob(leerBlobDeSalidas(ss), guia);
    } catch (err) { return null; }
}

// Reconstruye el texto rápido desde el índice. Lo llama la importación, y
// también un botón: si alguien borra la pestaña oculta, esto la devuelve.
function reconstruirSalidasRapido() {
    const ss = obtenerArchivo();
    const ui = SpreadsheetApp.getUi();
    if (!exigirModoPrueba(ss)) return;
    let filas = leerIndiceSalidas(HOJA_INDICE_SALIDAS);
    let celdas = guardarBlobDeSalidas(ss, filas);
    olvidarBlobSalidasEnRAM();
    ui.alert("⚡ Lista rápida de salidas",
             "Guías: " + filas.length.toLocaleString() + "\n" +
             "Celdas ocupadas: " + celdas + "\n\n" +
             (filas.length === 0
                ? "El índice está vacío: importa el histórico primero."
                : "Ya está activa. Al escanear una guía que salió en los " +
                  "últimos " + diasDeImportacionSalidas() + " días, saldrá el aviso."),
             ui.ButtonSet.OK);
}

// -------------------------------------------------------------------------
// LA SALIDA DE EMERGENCIA
//
// Una devolución legítima es una guía que YA salió y que vuelve a entrar con
// todo el derecho. Sin esto, el aviso la bloquearía para siempre y pararía la
// línea sin forma de seguir. Es lo que convierte un bloqueo en algo que un
// operador puede resolver en el momento.
// -------------------------------------------------------------------------
function autorizarGuiaDeSalida() {
    const ss = obtenerArchivo();
    const ui = SpreadsheetApp.getUi();
    let celda = ss.getActiveSheet().getActiveCell();
    let guia = claveGuiaHouse(celda.getValue());

    if (guia === "") {
        let r = ui.prompt("✅ Autorizar una guía",
            "Colócate en la celda de la guía, o escríbela aquí:",
            ui.ButtonSet.OK_CANCEL);
        if (r.getSelectedButton() !== ui.Button.OK) return;
        guia = claveGuiaHouse(r.getResponseText());
        if (guia === "") return;
    }

    let blob = leerBlobDeSalidas(ss);
    let previa = buscarSalidaEnBlob(blob, guia);
    if (!previa) {
        ui.alert("✅ Autorizar una guía",
                 guia + " no está en la lista de salidas.\nNo estaba " +
                 "bloqueando nada.", ui.ButtonSet.OK);
        return;
    }

    let r = ui.alert("✅ Autorizar una guía",
        guia + "\nSalió el " + textoFechaSalida(previa.fecha) + ".\n\n" +
        "Si es una devolución, la quito de la lista y deja de bloquear.\n\n" +
        "Solo afecta a esta guía, y solo hasta la próxima importación del " +
        "histórico —donde volverá a entrar si sigue ahí—.\n\n¿La autorizo?",
        ui.ButtonSet.YES_NO);
    if (r !== ui.Button.YES) return;

    let i = blob.indexOf("|" + guia + ":");
    let limpio = blob.substring(0, i) + blob.substring(i + guia.length + 8);
    // Se reescribe desde el texto, no desde el índice: así la autorización vale
    // aunque el índice viva en otro archivo al que ahora no se pueda llegar.
    let trozos = [];
    for (let p = 0; p < limpio.length; p += CHARS_POR_CELDA_SALIDA) {
        trozos.push([limpio.substr(p, CHARS_POR_CELDA_SALIDA)]);
    }
    let h = hojaSalidasRapido(ss, true);
    let maxAntes = h.getMaxRows();
    if (maxAntes > 1) h.getRange(1, 1, maxAntes, 1).clearContent();
    if (trozos.length) {
        asegurarFilas(h, trozos.length + 1);
        h.getRange(1, 1, trozos.length, 1).setValues(trozos);
    }
    olvidarBlobSalidasEnRAM();

    ui.alert("✅ Autorizar una guía",
             guia + " autorizada. Usa «🔄 Forzar Actualización» en esa pestaña " +
             "para que se le quite el aviso.", ui.ButtonSet.OK);
}
