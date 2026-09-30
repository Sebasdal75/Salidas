// =========================================================================
// LA HOUSE CONTRA SU PEDIMENTO
// =========================================================================
//
// QUÉ RESUELVE. Hay un archivo aparte —«PEDIMENTOS»— que dice, para cada
// pedimento, QUÉ HOUSES le pertenecen. Una fila por house:
//
//     Fecha proceso | Pedimento | House       | Bultos declarados | …
//     30/9/2026     | 6113854   | 030KG9897CH | 29                | …
//
// Con eso se puede contestar la pregunta que hasta ahora no tenía respuesta:
// este bulto está escaneado bajo el pedimento 6113854, pero ¿es suyo?
//
// El cruce va por HOUSE, no por guía, y eso es lo que lo hace posible: el
// archivo no trae guías, trae houses. La columna C de cada escaneo ya lleva la
// house puesta por el módulo de houses, así que las dos partes hablan el mismo
// idioma sin traducir nada.
//
// DÓNDE SALE EL AVISO. Solo en las hojas de SALIDAS —las de unidad—, no en las
// M-S. Se pidió así, y tiene sentido: la M-S es el paso de antes, donde la
// carga todavía se está juntando y el pedimento puede no estar escrito. El
// error de meter un bulto en el pedimento equivocado se comete al cargar, que
// es donde sale el aviso.
//
// -------------------------------------------------------------------------
// POR QUÉ UN TEXTO EMPAQUETADO Y NO UNA PESTAÑA NORMAL
// -------------------------------------------------------------------------
// Esto se consulta DENTRO del escaneo, una vez por fila. Abrir otro archivo
// ahí cuesta segundos y un escaneo entero dura medio. Meterlo en CACHE_SISTEMA
// tampoco vale: el caché se lee ENTERO en cada escaneo, así que miles de filas
// más se pagarían en todos, no solo en los que hacen falta.
//
// Se guarda comprimido en texto, en una pestaña oculta del propio archivo de
// operación, en pocas celdas grandes:
//
//     |030KG9897CH:6113854|03KA3949CNK:6113854|…
//
// Buscar es un `indexOf` sobre esa cadena, que V8 resuelve en microsegundos, y
// el texto se queda en memoria entre escaneos. Es la misma técnica que ya usa
// el índice de salidas, y por las mismas razones.
// =========================================================================

const HOJA_PEDIMENTOS_RAPIDO = "PEDIMENTOS_RAPIDO";
const HOJA_CONFRONTA_HOUSE = "CONFRONTA HOUSES";
const PROP_ID_PEDIMENTOS = 'PEDIMENTOS_ID_ARCHIVO';

// Caracteres por celda. Bajo a propósito, igual que en el índice de salidas: la
// app móvil de Hojas de cálculo se atraganta con celdas enormes y abre el
// archivo en solo lectura sin decir por qué.
const CHARS_POR_CELDA_PED = 5000;

// Hasta dónde se lee el archivo de pedimentos.
const FILAS_MAX_PEDIMENTOS = 50000;

// El texto del aviso. Se separa para que diga lo mismo en todos los sitios y
// para que cambiarlo sea un solo sitio.
const TXT_HOUSE_OTRO_PED = "❌ HOUSE de otro pedimento: ";
const COLOR_HOUSE_OTRO_PED = '#f5c6cb';

function accesoTxtHouseOtroPed() { return TXT_HOUSE_OTRO_PED; }

// -------------------------------------------------------------------------
// LEER EL ARCHIVO
// -------------------------------------------------------------------------

// Qué columna es cuál. Se busca por NOMBRE y no por posición: el archivo lo
// genera otra herramienta y una columna de más a la izquierda desplazaría todo
// sin que nada fallara —simplemente se leerían los datos equivocados—.
function detectarColumnasPedimentos(cabeceras) {
    let out = { pedimento: -1, house: -1 };
    (cabeceras || []).forEach((c, i) => {
        let n = String(c === undefined || c === null ? "" : c)
                .trim().toUpperCase()
                .replace(/[ÁÀÄÂ]/g, 'A').replace(/[ÉÈËÊ]/g, 'E')
                .replace(/[ÍÌÏÎ]/g, 'I').replace(/[ÓÒÖÔ]/g, 'O')
                .replace(/[ÚÙÜÛ]/g, 'U');
        if (out.pedimento === -1 && n.indexOf("PEDIMENTO") !== -1) out.pedimento = i;
        // «HOUSES LEIDAS» es un CONTADOR, no una house. Sin excluirlo, la
        // columna de la house podría caer en ella y el cruce compararía houses
        // contra el número 29.
        else if (out.house === -1 && n.indexOf("HOUSE") !== -1 &&
                 n.indexOf("LEID") === -1 && n.indexOf("DECLARAD") === -1) {
            out.house = i;
        }
    });
    return out;
}

// La misma normalización que usa la columna C de los escaneos, para que una
// house escrita con guiones en el archivo case con la que puso el relleno.
function claveHousePed(v) {
    return String(v === undefined || v === null ? "" : v)
        .trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// De la rejilla del archivo a pares {house, pedimento}.
//
// Puro, para poder probarlo: decidir mal aquí no da error, da un cruce que
// acusa de «otro pedimento» a bultos que están bien, y eso solo se ve
// comparando papeles a mano.
function paresDeArchivoPedimentos(datos, cols) {
    let salida = [];
    let vistas = new Set();
    let repetidas = [];
    if (!datos || !cols || cols.house === -1 || cols.pedimento === -1) {
        return { pares: salida, repetidas: repetidas };
    }

    for (let i = 1; i < datos.length; i++) {
        let fila = datos[i];
        if (!fila) continue;
        let h = claveHousePed(fila[cols.house]);
        let p = String(fila[cols.pedimento] === undefined ? "" : fila[cols.pedimento]).trim();
        if (h === "" || !/^\d{7}$/.test(p)) continue;

        // LA MISMA HOUSE EN DOS PEDIMENTOS es una contradicción del archivo, no
        // un dato. Gana la primera y se reporta: elegir en silencio es lo que
        // haría que el aviso acusara al bulto bueno.
        if (vistas.has(h)) {
            let previa = salida.find(x => x.house === h);
            if (previa && previa.pedimento !== p) {
                repetidas.push({ house: h, primero: previa.pedimento, segundo: p });
            }
            continue;
        }
        vistas.add(h);
        salida.push({ house: h, pedimento: p });
    }
    return { pares: salida, repetidas: repetidas };
}

// -------------------------------------------------------------------------
// EL TEXTO EMPAQUETADO
// -------------------------------------------------------------------------

function empaquetarHousePedimento(pares) {
    let trozos = [];
    let actual = "";
    (pares || []).forEach(p => {
        let reg = "|" + p.house + ":" + p.pedimento;
        // Se corta ANTES de pasarse, nunca a mitad de un registro: uno partido
        // entre dos celdas se volvería a unir al leer, pero quien mire la
        // pestaña vería basura y pensaría que está corrupta.
        if (actual.length + reg.length > CHARS_POR_CELDA_PED) {
            trozos.push([actual]);
            actual = "";
        }
        actual += reg;
    });
    if (actual !== "") trozos.push([actual]);
    return trozos;
}

// El pedimento que el archivo le da a esta house, o "" si no la conoce.
//
// El «|» delante y el «:» detrás son lo que hace exacta la coincidencia. Sin
// ellos, buscar una house encontraría cualquier otra que la contuviera, y eso
// acusaría a un bulto bueno de estar en el pedimento equivocado.
function pedimentoDeHouseEnBlob(blob, house) {
    let h = claveHousePed(house);
    if (h === "" || !blob) return "";
    let i = blob.indexOf("|" + h + ":");
    if (i === -1) return "";
    let desde = i + h.length + 2;
    let fin = blob.indexOf("|", desde);
    return blob.substring(desde, fin === -1 ? blob.length : fin);
}

function hojaHousePedimentoRapido(ss, crear) {
    let h = ss.getSheetByName(HOJA_PEDIMENTOS_RAPIDO);
    if (!h && crear) {
        h = ss.insertSheet(HOJA_PEDIMENTOS_RAPIDO);
        h.hideSheet();
    }
    return h;
}

function guardarBlobHousePedimento(ss, pares) {
    let trozos = empaquetarHousePedimento(pares);
    let h = hojaHousePedimentoRapido(ss, true);
    let maxAntes = h.getMaxRows();
    if (maxAntes > 0) h.getRange(1, 1, maxAntes, 1).clearContent();
    if (trozos.length === 0) return 0;
    asegurarFilas(h, trozos.length + 1);
    h.getRange(1, 1, trozos.length, 1).setValues(trozos);
    return trozos.length;
}

// El texto vive en memoria entre escaneos mientras V8 conserve el proceso. La
// primera consulta de cada proceso paga una llamada; las siguientes son gratis.
// OJO CON EL NOMBRE DE ESTA VARIABLE. Se llamaba `globalBlobPedimentos` y
// Salidas.gs ya tenía una así. En Apps Script todos los archivos comparten el
// mismo ámbito, así que dos `let` con el mismo nombre no son dos variables: son
// un ERROR DE SINTAXIS que tumba el proyecto ENTERO al cargar. Y el síntoma no
// dice nada: desaparece el menú «📦 Opciones Avanzadas» completo, sin ningún
// error a la vista, como si alguien lo hubiera borrado.
let globalBlobHousePed = null;
function olvidarBlobPedimentosDeHouseEnRAM() { globalBlobHousePed = null; }

function leerBlobHousePedimento(ss) {
    if (globalBlobHousePed !== null) return globalBlobHousePed;
    globalBlobHousePed = "";
    try {
        let h = hojaHousePedimentoRapido(ss, false);
        if (!h) return globalBlobHousePed;
        let lr = h.getLastRow();
        if (lr < 1) return globalBlobHousePed;
        globalBlobHousePed = h.getRange(1, 1, lr, 1).getValues()
            .map(f => String(f[0])).join("");
    } catch (err) {
        // Que esto falle NO puede tumbar un escaneo: sin lista no hay aviso, y
        // el sistema sigue haciendo todo lo demás igual que antes.
        globalBlobHousePed = "";
    }
    return globalBlobHousePed;
}

// -------------------------------------------------------------------------
// EL AVISO
// -------------------------------------------------------------------------

// ¿Esta house pertenece al pedimento del bloque donde está escaneada?
//
// Devuelve "" cuando cuadra O cuando no hay forma de saberlo. Lo que no se
// puede comprobar no se denuncia: una columna llena de avisos dudosos deja de
// leerse, y con ella se pierden los que sí eran de verdad.
function avisoDeHouseContraPedimento(ss, house, pedBloque) {
    let h = claveHousePed(house);
    if (h === "") return "";
    // Sin pedimento en el bloque no hay contra qué comparar. De eso ya avisa
    // «FALTA EL PEDIMENTO», con su propio texto.
    let p = String(pedBloque === undefined || pedBloque === null ? "" : pedBloque).trim();
    if (!/^\d{7}$/.test(p)) return "";

    try {
        let suyo = pedimentoDeHouseEnBlob(leerBlobHousePedimento(ss), h);
        // El archivo no conoce esa house: puede ser de otro día o de una
        // importación que todavía no se ha hecho. Callar es lo correcto.
        if (suyo === "") return "";
        return suyo === p ? "" : TXT_HOUSE_OTRO_PED + suyo;
    } catch (err) { return ""; }
}

// -------------------------------------------------------------------------
// EL VÍNCULO Y LA IMPORTACIÓN
// -------------------------------------------------------------------------

function idDelArchivoPedimentos() {
    try {
        return PropertiesService.getScriptProperties()
               .getProperty(PROP_ID_PEDIMENTOS) || "";
    } catch (err) { return ""; }
}

function vincularArchivoDePedimentos() {
    const ss = obtenerArchivo();
    const ui = SpreadsheetApp.getUi();

    let actual = idDelArchivoPedimentos();
    let r = ui.prompt("🔗 Archivo de pedimentos",
        (actual === "" ? "No hay ninguno vinculado todavía."
                       : "Vinculado ahora:\n" + actual) + "\n\n" +
        "Pega la URL del archivo que lleva el pedimento y sus houses:",
        ui.ButtonSet.OK_CANCEL);
    if (r.getSelectedButton() !== ui.Button.OK) return;

    // Se reutiliza el lector de URLs de costales: el formato de un enlace de
    // Hojas de cálculo es el mismo y tener dos copias del mismo recortador
    // garantiza que un día se arregle en una y no en la otra.
    let id = (typeof idDesdeUrl === 'function') ? idDesdeUrl(r.getResponseText()) : "";
    if (id === "") {
        ui.alert("🔗 Archivo de pedimentos",
                 "Eso no parece una URL de Hojas de cálculo.", ui.ButtonSet.OK);
        return;
    }

    // Se comprueba AQUÍ que se puede abrir, no el día que alguien importa en el
    // muelle. Un vínculo que no sirve tiene que fallar al guardarlo.
    let nombre = "";
    try { nombre = SpreadsheetApp.openById(id).getName(); }
    catch (err) {
        ui.alert("🔗 Archivo de pedimentos",
            "No pude abrirlo:\n" + err + "\n\n" +
            "Comprueba que esta cuenta tenga acceso a ese archivo.", ui.ButtonSet.OK);
        return;
    }

    PropertiesService.getScriptProperties().setProperty(PROP_ID_PEDIMENTOS, id);
    ui.alert("🔗 Archivo de pedimentos",
             "Vinculado: " + nombre + "\n\nAhora usa «📥 Importar los pedimentos».",
             ui.ButtonSet.OK);
}

// Lee el archivo entero y deja el texto listo para consultar en el escaneo.
// EL NÚCLEO DE LA IMPORTACIÓN, sin diálogos.
//
// Se separa de la función del menú porque la confronta también lo necesita: sin
// esto habría que apretar dos botones en orden, y el día que alguien se saltara
// el primero la confronta contestaría con los pedimentos de la semana pasada
// sin que nada lo dijera.
//
// Devuelve {ok, error, pares, repetidas, celdas, nombreHoja, libro}.
function traerPedimentosDelArchivo(ss) {
    let id = idDelArchivoPedimentos();
    if (id === "") {
        return { ok: false, error: "No hay ningún archivo vinculado.\n\nUsa " +
                 "«🔗 Vincular el archivo de pedimentos» primero." };
    }

    let libro;
    try { libro = SpreadsheetApp.openById(id); }
    catch (err) { return { ok: false, error: "No pude abrirlo:\n" + err }; }

    // La primera pestaña que tenga las dos columnas. Un archivo generado por
    // otra herramienta suele traer una hoja vacía delante, y exigir la primera
    // haría fallar la importación sin decir por qué.
    let cols = null, datos = null, nombreHoja = "";
    let hojasMiradas = [];
    libro.getSheets().forEach(h => {
        if (cols) return;
        let lr = Math.min(Math.max(h.getLastRow(), 1), FILAS_MAX_PEDIMENTOS);
        let lc = Math.max(h.getLastColumn(), 1);
        if (lr < 2) { hojasMiradas.push(h.getName() + " (vacía)"); return; }
        let rejilla = h.getRange(1, 1, lr, lc).getValues();
        let c = detectarColumnasPedimentos(rejilla[0]);
        hojasMiradas.push(h.getName() +
            (c.house !== -1 && c.pedimento !== -1 ? " ✅" : " (sin las columnas)"));
        if (c.house === -1 || c.pedimento === -1) return;
        cols = c; datos = rejilla; nombreHoja = h.getName();
    });

    if (!cols) {
        return { ok: false, error:
            "No encontré una pestaña con las columnas «Pedimento» y «House» en " +
            libro.getName() + ".\n\nMiré:\n" + hojasMiradas.join("\n") };
    }

    let r = paresDeArchivoPedimentos(datos, cols);
    if (r.pares.length === 0) {
        return { ok: false, error:
            "La pestaña «" + nombreHoja + "» tiene las columnas pero ninguna fila " +
            "con una house y un pedimento de 7 dígitos." };
    }

    let celdas = guardarBlobHousePedimento(ss, r.pares);
    olvidarBlobPedimentosDeHouseEnRAM();

    return { ok: true, pares: r.pares, repetidas: r.repetidas, celdas: celdas,
             nombreHoja: nombreHoja, libro: libro };
}

// El resumen de lo que se trajo, en palabras. Se comparte entre los dos
// botones para que digan lo mismo.
function resumenDeImportacionPedimentos(r) {
    let peds = new Set(r.pares.map(p => p.pedimento));
    let msg = "Del archivo «" + r.nombreHoja + "» de " + r.libro.getName() + ":\n" +
              "   · " + r.pares.length.toLocaleString() + " houses\n" +
              "   · " + peds.size.toLocaleString() + " pedimentos distintos";
    if (r.repetidas.length) {
        msg += "\n\n⚠️ " + r.repetidas.length + " houses salen en DOS pedimentos " +
               "distintos EN EL ARCHIVO. Se quedó la primera de cada una:\n" +
               r.repetidas.slice(0, 8)
                   .map(c => "   · " + c.house + ": " + c.primero + " / " + c.segundo)
                   .join("\n");
        if (r.repetidas.length > 8) msg += "\n   …y " + (r.repetidas.length - 8) + " más.";
        msg += "\n\nEso es una contradicción del archivo, no del escaneo.";
    }
    return msg;
}

// El botón de solo importar. Sirve para refrescar el aviso de la columna B sin
// pagar el recorrido de todas las pestañas que hace la confronta.
function importarPedimentos() {
    const ss = obtenerArchivo();
    const ui = SpreadsheetApp.getUi();

    let r = traerPedimentosDelArchivo(ss);
    if (!r.ok) { ui.alert("📥 Importar los pedimentos", r.error, ui.ButtonSet.OK); return; }

    ui.alert("📥 Importar los pedimentos",
        "Listo.\n\n" + resumenDeImportacionPedimentos(r) + "\n\n" +
        "   · " + r.celdas + " celdas de lista rápida\n\n" +
        "A partir de ahora, al escanear en una hoja de SALIDAS, si la house de " +
        "un bulto pertenece a otro pedimento la columna B lo dirá.",
        ui.ButtonSet.OK);
}

// -------------------------------------------------------------------------
// LA CONFRONTA: QUÉ FALTA Y QUÉ SOBRA
// -------------------------------------------------------------------------

// Lo que hay escaneado, por pedimento y por house.
//
// Se lee la columna A —para saber de qué bloque es cada fila— y la C, que es
// donde vive la house. Solo de las hojas de SALIDAS: las M-S son el paso de
// antes y ahí la carga todavía se está juntando.
function housesEscaneadasPorPedimento(ss) {
    let porPedimento = new Map();   // pedimento -> Map(house -> {hoja, fila})
    ss.getSheets().forEach(hoja => {
        let n = claveHoja(hoja.getName());
        if (!esHojaDeSalidasParaConfronta(n)) return;
        let lr = hoja.getLastRow();
        if (lr < 1) return;

        let datos = hoja.getRange(1, 1, lr, 3).getValues();
        let pedActual = "";
        for (let i = 0; i < datos.length; i++) {
            let a = String(datos[i][0]).trim().toUpperCase();
            if (/^\d{7}$/.test(a)) { pedActual = a; continue; }
            if (esMarcadorEstructural(a)) { pedActual = ""; continue; }
            if (a === "" || pedActual === "") continue;

            let h = claveHousePed(datos[i][2]);
            if (h === "") continue;
            if (!porPedimento.has(pedActual)) porPedimento.set(pedActual, new Map());
            let m = porPedimento.get(pedActual);
            if (!m.has(h)) m.set(h, { hoja: hoja.getName(), fila: i + 1, guia: a });
        }
    });
    return porPedimento;
}

// Qué pestañas entran en la confronta.
//
// Las de unidad, que es donde se carga. Fuera las M-S —se pidió así—, fuera los
// inventarios y fuera el rezago, que lleva su propio ritmo y su propia columna O.
function esHojaDeSalidasParaConfronta(nombreHoja) {
    let n = claveHoja(nombreHoja);
    if (esHojaSistema(n) || esHojaInterna(n)) return false;
    if (esHojaMS(n) || esHojaInventario(n)) return false;
    if (n.indexOf("REZAGO") !== -1) return false;
    return esHojaPrincipal(n);
}

// El cruce, puro. `delArchivo` son los pares {house, pedimento}; `escaneado` es
// el Map de arriba.
//
// EN EL INFORME SOLO SALE LO QUE ESTÁ ESCANEADO Y ESTÁ MAL. Dos cosas:
//
//   · la house es de OTRO pedimento según el archivo;
//   · la house SOBRA, el archivo no la tiene en ninguno.
//
// LO QUE NO SALE, Y ES DELIBERADO:
//
//   · las que cuadran. Son la inmensa mayoría y ahogarían a las veinte que
//     importan; un informe que hay que filtrar para leerlo no se lee.
//   · las que FALTAN por escanear. Se pidió quitarlas: el informe es de lo que
//     está en el muelle, no de lo que todavía no ha llegado.
//   · los pedimentos que el archivo no conoce. Sin el archivo no hay contra qué
//     comparar, así que no se puede decir que esté mal: solo que no se sabe.
//
// Se separa de lo que habla con Sheets porque es la parte que, si se equivoca,
// no falla: da un informe que acusa a bultos buenos o absuelve a los malos, y
// eso solo se ve comparando papeles a mano.
function confrontarHouses(delArchivo, escaneado) {
    let lineas = [];
    let resumen = new Map();   // pedimento -> {revisadas, malas, sobran}

    // house -> su pedimento según el archivo.
    let pedDeHouse = new Map();
    let pedimentosDelArchivo = new Set();
    (delArchivo || []).forEach(p => {
        if (!pedDeHouse.has(p.house)) pedDeHouse.set(p.house, p.pedimento);
        pedimentosDelArchivo.add(p.pedimento);
    });

    (escaneado || new Map()).forEach((mapaHouses, ped) => {
        // SOLO LOS PEDIMENTOS QUE ESTÁN EN EL ARCHIVO. De los demás no se puede
        // opinar, y opinar igualmente llenaría el informe de filas que no son
        // un error sino una falta de datos.
        if (!pedimentosDelArchivo.has(ped)) return;

        let malas = 0, sobran = 0, revisadas = 0;
        mapaHouses.forEach((info, h) => {
            revisadas++;
            let suyo = pedDeHouse.get(h);

            if (suyo === ped) return;   // cuadra: no se dice nada

            if (suyo) {
                malas++;
                lineas.push([ped, h, "❌ Es del pedimento " + suyo,
                             info.hoja, info.fila, info.guia]);
            } else {
                sobran++;
                lineas.push([ped, h, "⚠️ SOBRA: el archivo no tiene esta house",
                             info.hoja, info.fila, info.guia]);
            }
        });

        resumen.set(ped, { revisadas: revisadas, malas: malas, sobran: sobran });
    });

    return { lineas: lineas, resumen: resumen };
}

function confrontarPedimentosConEscaneos() {
    const ss = obtenerArchivo();
    const ui = SpreadsheetApp.getUi();

    ss.toast('⏳ Trayendo el archivo de pedimentos…', 'Confronta', 10);
    let imp = traerPedimentosDelArchivo(ss);
    if (!imp.ok) { ui.alert("🔎 Confrontar houses", imp.error, ui.ButtonSet.OK); return; }

    // Se cruza contra lo que ACABA de traerse, no contra el texto empaquetado.
    // Volver a leer el blob que se acaba de escribir sería pagar una lectura
    // para obtener lo que ya está en memoria, y abre la puerta a que los dos
    // digan cosas distintas.
    ss.toast('⏳ Leyendo los escaneos…', 'Confronta', 20);
    let escaneado = housesEscaneadasPorPedimento(ss);
    let r = confrontarHouses(imp.pares, escaneado);

    let hoja = ss.getSheetByName(HOJA_CONFRONTA_HOUSE);
    if (!hoja) hoja = ss.insertSheet(HOJA_CONFRONTA_HOUSE, ss.getNumSheets());
    hoja.clear();
    hoja.getRange(1, 1, 1, 6)
        .setValues([["PEDIMENTO", "HOUSE", "ESTADO", "PESTAÑA", "FILA", "GUÍA"]])
        .setFontWeight("bold");
    if (r.lineas.length > 0) {
        asegurarFilas(hoja, r.lineas.length + 2);
        hoja.getRange(2, 1, r.lineas.length, 6).setValues(r.lineas);
    }
    hoja.setFrozenRows(1);
    ss.setActiveSheet(hoja);

    let totMalas = 0, totSobran = 0, totRevisadas = 0;
    r.resumen.forEach(v => {
        totMalas += v.malas; totSobran += v.sobran; totRevisadas += v.revisadas;
    });

    ui.alert("🔎 Confrontar houses",
        resumenDeImportacionPedimentos(imp) + "\n\n" +
        "── EL CRUCE ──\n" +
        "   · " + r.resumen.size + " pedimentos del archivo encontrados en los escaneos\n" +
        "   · " + totRevisadas + " houses revisadas\n" +
        "   · ❌ " + totMalas + " son de OTRO pedimento\n" +
        "   · ⚠️ " + totSobran + " sobran (el archivo no las tiene)\n\n" +
        (r.lineas.length === 0
            ? "✅ Todo cuadra. La pestaña «" + HOJA_CONFRONTA_HOUSE + "» queda vacía."
            : "Las " + r.lineas.length + " que están mal salen en la pestaña «" +
              HOJA_CONFRONTA_HOUSE + "», con su pestaña y su fila.") + "\n\n" +
        "En el informe SOLO sale lo que está escaneado y está mal. Las que " +
        "cuadran no salen, ni las que faltan por escanear.",
        ui.ButtonSet.OK);
}
