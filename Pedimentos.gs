// =========================================================================
// LA REFERENCIA CONTRA SU PEDIMENTO
// =========================================================================
//
// QUÉ RESUELVE. Hay un archivo aparte —«PEDIMENTOS»— que dice qué guías forman
// cada embarque. Una fila por 1Z:
//
//     House       | Tracking 1Z        | Referencia | Fecha carga | Archivo
//     613V093STND | 1Z613V090403478612 | G26A850642 | 30/9/2026   | Book2.xlsx
//
// EL ARCHIVO NO TRAE EL PEDIMENTO, y eso es lo que define todo lo demás. El
// pedimento sale del ESCANEO: se lee un 1Z debajo de un pedimento, el archivo
// dice de qué referencia es ese 1Z, y a partir de ahí esa referencia va con ese
// pedimento. Todo lo que el archivo diga de esa referencia se puede comprobar
// contra lo que hay escaneado.
//
// LAS DOS PREGUNTAS QUE CONTESTA, que antes no tenían respuesta:
//
//   · ¿este bulto es de este pedimento? Lo es si su referencia está atada a él.
//     Si su referencia está atada a otro, está en el pedimento equivocado.
//   · ¿está COMPLETA la referencia? Si el archivo le da diez piezas, tienen que
//     estar las diez, y tienen que ser esas diez. Ni nueve ni once ni otras.
//
// POR QUÉ SE ATA POR MAYORÍA. Una referencia puede aparecer bajo dos pedimentos
// porque alguien se equivocó en una. Quedándose con la primera que se lee, la
// que manda sería la que esté más arriba en la hoja, que no tiene nada que ver
// con cuál es la buena: si cuarenta y cinco están en un pedimento y cuatro en
// otro, las cuatro son el error. Gana el pedimento donde hay más piezas de esa
// referencia, y el empate se reporta sin elegir.
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
// Se guarda comprimido en texto, en dos pestañas ocultas del propio archivo de
// operación, en pocas celdas grandes:
//
//     REFERENCIAS_RAPIDO   |1Z613V090403478612:G26A850642|613V093STND:G26A…
//     PEDIMENTOS_RAPIDO    |G26A850642:6113854|E26A850271:6113855|…
//
// La primera sale del archivo; la segunda es lo que se APRENDIÓ de los escaneos
// en la última confronta. Las dos se desarman en un Map una vez por ejecución y
// se quedan en memoria entre escaneos. Es la misma técnica que ya usa el índice
// de salidas, y por las mismas razones.
// =========================================================================

const HOJA_PEDIMENTOS_RAPIDO = "PEDIMENTOS_RAPIDO";
const HOJA_REFERENCIAS_RAPIDO = "REFERENCIAS_RAPIDO";
const HOJA_CONFRONTA_HOUSE = "CONFRONTA REFERENCIAS";
const PROP_ID_PEDIMENTOS = 'PEDIMENTOS_ID_ARCHIVO';

// Caracteres por celda. Bajo a propósito, igual que en el índice de salidas: la
// app móvil de Hojas de cálculo se atraganta con celdas enormes y abre el
// archivo en solo lectura sin decir por qué.
const CHARS_POR_CELDA_PED = 5000;

// Hasta dónde se lee el archivo de pedimentos.
const FILAS_MAX_PEDIMENTOS = 50000;

// El texto del aviso. Se separa para que diga lo mismo en todos los sitios y
// para que cambiarlo sea un solo sitio.
const TXT_HOUSE_OTRO_PED = "❌ Esa referencia va en el pedimento ";
const COLOR_HOUSE_OTRO_PED = '#f5c6cb';

function accesoTxtHouseOtroPed() { return TXT_HOUSE_OTRO_PED; }

// -------------------------------------------------------------------------
// LEER EL ARCHIVO
// -------------------------------------------------------------------------

// Qué columna es cuál. Se busca por NOMBRE y no por posición: el archivo lo
// genera otra herramienta y una columna de más a la izquierda desplazaría todo
// sin que nada fallara —simplemente se leerían los datos equivocados—.
function detectarColumnasPedimentos(cabeceras) {
    let out = { pedimento: -1, house: -1, guia: -1, referencia: -1 };
    (cabeceras || []).forEach((c, i) => {
        let n = String(c === undefined || c === null ? "" : c)
                .trim().toUpperCase()
                .replace(/[ÁÀÄÂ]/g, 'A').replace(/[ÉÈËÊ]/g, 'E')
                .replace(/[ÍÌÏÎ]/g, 'I').replace(/[ÓÒÖÔ]/g, 'O')
                .replace(/[ÚÙÜÛ]/g, 'U');
        if (out.pedimento === -1 && n.indexOf("PEDIMENTO") !== -1) out.pedimento = i;
        // La REFERENCIA agrupa las guías de un mismo embarque. Se mira antes que
        // la house porque en algunos archivos la cabecera es «Referencia House»
        // y caería en la otra rama.
        else if (out.referencia === -1 && n.indexOf("REFERENCIA") !== -1) out.referencia = i;
        // El 1Z. «Tracking 1Z» es como lo titula la herramienta que genera esto.
        else if (out.guia === -1 &&
                 (n.indexOf("TRACKING") !== -1 || n.indexOf("GUIA") !== -1 ||
                  n === "1Z" || n.indexOf("RASTREO") !== -1)) {
            out.guia = i;
        }
        // «HOUSES LEIDAS» es un CONTADOR, no una house. Sin excluirlo, la
        // columna de la house podría caer en ella y el cruce compararía houses
        // contra el número 29.
        //
        // «SHIPMENT» es el otro nombre de lo mismo en algunos archivos. Sin esa
        // palabra se leían como «sin las columnas» y la importación fallaba sin
        // decir por qué.
        else if (out.house === -1 &&
                 (n.indexOf("SHIPMENT") !== -1 ||
                  (n.indexOf("HOUSE") !== -1 && n.indexOf("LEID") === -1 &&
                   n.indexOf("DECLARAD") === -1))) {
            out.house = i;
        }
    });
    return out;
}

// La misma normalización que usa la columna A de los escaneos, para que una
// guía escrita con guiones en el archivo case con la escaneada sin ellos.
function claveHousePed(v) {
    return String(v === undefined || v === null ? "" : v)
        .trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// De la rejilla del archivo a lo que hace falta para trabajar.
//
// Devuelve TRES cosas:
//
//   · `entradas`: pares {clave, referencia}. SE INDEXA POR LAS DOS COSAS, por
//     el 1Z y por la house, porque según la pestaña puede faltar una u otra:
//     el 1Z está en la columna A desde el instante del escaneo, la house la
//     pone un relleno que tarda hasta cinco minutos. No chocan entre ellas —un
//     1Z son dieciocho caracteres y empieza por «1Z», una house once—.
//   · `porReferencia`: referencia → la lista de sus 1Z. Es lo que permite
//     contestar «si la referencia tiene diez piezas, ¿están las diez?».
//   · `contradicciones`: la misma clave en dos referencias. Gana la primera y
//     se reporta; elegir en silencio es lo que haría que el aviso acusara al
//     bulto bueno.
//
// Puro, para poder probarlo: decidir mal aquí no da error, da un informe que
// acusa a bultos buenos o absuelve a los malos, y eso solo se ve comparando
// papeles a mano.
function referenciasDelArchivo(datos, cols) {
    let entradas = [];
    let porClave = new Map();
    let porReferencia = new Map();
    let contradicciones = [];
    if (!datos || !cols || cols.referencia === -1 ||
        (cols.guia === -1 && cols.house === -1)) {
        return { entradas: entradas, porReferencia: porReferencia,
                 contradicciones: contradicciones };
    }

    let anota = (clave, ref, fila) => {
        if (clave === "") return;
        if (porClave.has(clave)) {
            if (porClave.get(clave) !== ref) {
                contradicciones.push({ clave: clave, primero: porClave.get(clave),
                                       segundo: ref, fila: fila });
            }
            return;
        }
        porClave.set(clave, ref);
        entradas.push({ clave: clave, referencia: ref });
    };

    for (let i = 1; i < datos.length; i++) {
        let fila = datos[i];
        if (!fila) continue;
        let ref = claveHousePed(fila[cols.referencia]);
        if (ref === "") continue;
        // La fila de cabecera puede repetirse a media hoja cuando el archivo se
        // arma pegando exportaciones: «Referencia» no es una referencia.
        if (ref === "REFERENCIA") continue;

        let g = cols.guia === -1 ? "" : claveHousePed(fila[cols.guia]);
        let h = cols.house === -1 ? "" : claveHousePed(fila[cols.house]);
        if (g === "" && h === "") continue;

        // La LISTA de la referencia se lleva por 1Z, que es un bulto. Con la
        // house serían menos piezas de las que hay: una house cubre varias.
        let pieza = g !== "" ? g : h;
        if (!porReferencia.has(ref)) porReferencia.set(ref, []);
        if (porReferencia.get(ref).indexOf(pieza) === -1) {
            porReferencia.get(ref).push(pieza);
        }

        anota(g, ref, i + 1);
        anota(h, ref, i + 1);
    }
    return { entradas: entradas, porReferencia: porReferencia,
             contradicciones: contradicciones };
}

// -------------------------------------------------------------------------
// EL TEXTO EMPAQUETADO
// -------------------------------------------------------------------------

// El empaquetado, genérico: una lista de {clave, valor} a celdas de texto. Está
// en su propia función para que el corte de celdas —que es la parte delicada—
// viva en un solo sitio.
function empaquetarClaveValor(pares) {
    let trozos = [];
    let actual = "";
    (pares || []).forEach(p => {
        let reg = "|" + p.clave + ":" + p.valor;
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

function empaquetarClaveReferencia(entradas) {
    return empaquetarClaveValor((entradas || [])
        .map(e => ({ clave: e.clave, valor: e.referencia })));
}

function empaquetarAtaduras(atadura) {
    let pares = [];
    (atadura || new Map()).forEach((ped, ref) => pares.push({ clave: ref, valor: ped }));
    return empaquetarClaveValor(pares);
}

// El valor que el texto le da a esta clave, o "" si no la conoce.
//
// El «|» delante y el «:» detrás son lo que hace exacta la coincidencia. Sin
// ellos, buscar una house encontraría cualquier otra que la contuviera, y eso
// acusaría a un bulto bueno de estar en el pedimento equivocado.
function pedimentoDeHouseEnBlob(blob, clave) {
    let h = claveHousePed(clave);
    if (h === "" || !blob) return "";
    let i = blob.indexOf("|" + h + ":");
    if (i === -1) return "";
    let desde = i + h.length + 2;
    let fin = blob.indexOf("|", desde);
    return blob.substring(desde, fin === -1 ? blob.length : fin);
}

// El texto desarmado en un Map, para consultarlo dentro del escaneo.
//
// POR QUÉ UN MAP Y NO EL `indexOf`. El archivo trae DOS claves por fila, así
// que con decenas de miles de guías el texto son megabytes. Un `indexOf` sobre
// megabytes tarda alrededor de un milisegundo, y una hoja de dos mil renglones
// lo llamaría dos mil veces: dos segundos por recálculo, sobre un escaneo que
// dura medio. Desarmarlo una vez cuesta una pasada y deja las consultas en
// tiempo constante.
//
// Puro, para poder probarlo sin hablar con Sheets.
function mapaDesdeBlobPedimentos(blob) {
    let m = new Map();
    String(blob === undefined || blob === null ? "" : blob)
        .split("|").forEach(reg => {
            if (reg === "") return;
            let c = reg.indexOf(":");
            if (c === -1) return;
            let k = reg.substring(0, c);
            if (k !== "" && !m.has(k)) m.set(k, reg.substring(c + 1));
        });
    return m;
}

function hojaDeTextoRapido(ss, nombre, crear) {
    let h = ss.getSheetByName(nombre);
    if (!h && crear) {
        h = ss.insertSheet(nombre);
        h.hideSheet();
    }
    return h;
}

function hojaHousePedimentoRapido(ss, crear) {
    return hojaDeTextoRapido(ss, HOJA_PEDIMENTOS_RAPIDO, crear);
}

function guardarTextoRapido(ss, nombre, trozos) {
    let h = hojaDeTextoRapido(ss, nombre, true);
    let maxAntes = h.getMaxRows();
    if (maxAntes > 0) h.getRange(1, 1, maxAntes, 1).clearContent();
    if (trozos.length === 0) return 0;
    asegurarFilas(h, trozos.length + 1);
    h.getRange(1, 1, trozos.length, 1).setValues(trozos);
    return trozos.length;
}

function guardarBlobReferencias(ss, entradas) {
    return guardarTextoRapido(ss, HOJA_REFERENCIAS_RAPIDO,
                              empaquetarClaveReferencia(entradas));
}

function guardarBlobAtaduras(ss, atadura) {
    return guardarTextoRapido(ss, HOJA_PEDIMENTOS_RAPIDO,
                              empaquetarAtaduras(atadura));
}

function leerTextoRapido(ss, nombre) {
    try {
        let h = hojaDeTextoRapido(ss, nombre, false);
        if (!h) return "";
        let lr = h.getLastRow();
        if (lr < 1) return "";
        return h.getRange(1, 1, lr, 1).getValues().map(f => String(f[0])).join("");
    } catch (err) {
        // Que esto falle NO puede tumbar un escaneo: sin lista no hay aviso, y
        // el sistema sigue haciendo todo lo demás igual que antes.
        return "";
    }
}

// Los mapas viven en memoria entre escaneos mientras V8 conserve el proceso. La
// primera consulta de cada proceso paga una llamada; las siguientes son gratis.
//
// OJO CON EL NOMBRE DE ESTAS VARIABLES. Una se llamaba `globalBlobPedimentos` y
// Salidas.gs ya tenía una así. En Apps Script todos los archivos comparten el
// mismo ámbito, así que dos `let` con el mismo nombre no son dos variables: son
// un ERROR DE SINTAXIS que tumba el proyecto ENTERO al cargar. Y el síntoma no
// dice nada: desaparece el menú «📦 Opciones Avanzadas» completo, sin ningún
// error a la vista, como si alguien lo hubiera borrado.
let globalMapaRefDeGuia = null;
let globalMapaPedDeRef = null;

function olvidarBlobPedimentosDeHouseEnRAM() {
    globalMapaRefDeGuia = null;
    globalMapaPedDeRef = null;
}

// clave —1Z o house— → su referencia, según el archivo.
function mapaReferenciasParaEscaneo(ss) {
    if (globalMapaRefDeGuia === null) {
        globalMapaRefDeGuia = mapaDesdeBlobPedimentos(
            leerTextoRapido(ss, HOJA_REFERENCIAS_RAPIDO));
    }
    return globalMapaRefDeGuia;
}

// referencia → su pedimento, según lo aprendido en la última confronta.
function mapaAtadurasParaEscaneo(ss) {
    if (globalMapaPedDeRef === null) {
        globalMapaPedDeRef = mapaDesdeBlobPedimentos(
            leerTextoRapido(ss, HOJA_PEDIMENTOS_RAPIDO));
    }
    return globalMapaPedDeRef;
}

// -------------------------------------------------------------------------
// EL AVISO
// -------------------------------------------------------------------------

// ¿Este bulto pertenece al pedimento del bloque donde está escaneado?
//
// LA CADENA ES: el 1Z dice su referencia, y la referencia dice su pedimento. Se
// pregunta primero por el 1Z y, si el archivo no lo conoce, por la house.
//
// LA ATADURA SALE DE LA ÚLTIMA CONFRONTA, no del archivo: el archivo no trae
// pedimentos. O sea que el aviso vale para lo que ya estaba atado la última vez
// que se apretó el botón. Una referencia que se empieza hoy no avisa hasta la
// primera confronta, y eso es correcto: todavía no hay nada con qué
// contradecirla.
//
// Devuelve "" cuando cuadra O cuando no hay forma de saberlo. Lo que no se
// puede comprobar no se denuncia: una columna llena de avisos dudosos deja de
// leerse, y con ella se pierden los que sí eran de verdad.
function avisoDeHouseContraPedimento(ss, house, pedBloque, guia) {
    // Sin pedimento en el bloque no hay contra qué comparar. De eso ya avisa
    // «FALTA EL PEDIMENTO», con su propio texto.
    let p = String(pedBloque === undefined || pedBloque === null ? "" : pedBloque).trim();
    if (!/^\d{7}$/.test(p)) return "";

    let g = claveHousePed(guia);
    let h = claveHousePed(house);
    if (g === "" && h === "") return "";

    try {
        let refs = mapaReferenciasParaEscaneo(ss);
        if (!refs || refs.size === 0) return "";
        // El archivo no conoce ni el 1Z ni la house: puede ser de otro día o de
        // una importación que todavía no se ha hecho. Callar es lo correcto.
        let ref = (g !== "" && refs.get(g)) || (h !== "" && refs.get(h)) || "";
        if (ref === "") return "";

        let suyo = mapaAtadurasParaEscaneo(ss).get(ref) || "";
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
        "Pega la URL del archivo que lleva las guías con su referencia:",
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
             "Vinculado: " + nombre + "\n\nAhora usa «🔎 Confrontar con los pedimentos».",
             ui.ButtonSet.OK);
}

// Lee el archivo entero y deja el texto listo para consultar en el escaneo.
// EL NÚCLEO DE LA IMPORTACIÓN, sin diálogos.
//
// Se separa de la función del menú porque la confronta también lo necesita: sin
// esto habría que apretar dos botones en orden, y el día que alguien se saltara
// el primero la confronta contestaría con el archivo de la semana pasada sin
// que nada lo dijera.
function traerPedimentosDelArchivo(ss) {
    let id = idDelArchivoPedimentos();
    if (id === "") {
        return { ok: false, error: "No hay ningún archivo vinculado.\n\nUsa " +
                 "«🔗 Vincular el archivo de pedimentos» primero." };
    }

    let libro;
    try { libro = SpreadsheetApp.openById(id); }
    catch (err) { return { ok: false, error: "No pude abrirlo:\n" + err }; }

    // SE ELIGE LA PESTAÑA CON MÁS DATOS, NO LA PRIMERA QUE PASE.
    //
    // El archivo trae dos hojas que se parecen —«GUIAS_1Z» y «PEDIMENTO_1Z»— y
    // una de las dos puede estar vacía o a medias. Con «la primera que pase»
    // todo dependía del orden de las pestañas, y el día que alguien las
    // reordenara la importación habría empezado a traer menos sin que nada
    // fallara ni lo dijera. Gana la que más filas útiles produce.
    let mejor = null;
    let hojasMiradas = [];
    libro.getSheets().forEach(h => {
        let lr = Math.min(Math.max(h.getLastRow(), 1), FILAS_MAX_PEDIMENTOS);
        let lc = Math.max(h.getLastColumn(), 1);
        if (lr < 2) { hojasMiradas.push("   · " + h.getName() + ": vacía"); return; }
        let rejilla = h.getRange(1, 1, lr, lc).getValues();
        let c = detectarColumnasPedimentos(rejilla[0]);

        let tiene = [];
        if (c.referencia !== -1) tiene.push("referencia");
        if (c.guia !== -1) tiene.push("1Z");
        if (c.house !== -1) tiene.push("house");

        // Hace falta la referencia y algo con lo que reconocer el bulto.
        if (c.referencia === -1 || (c.guia === -1 && c.house === -1)) {
            hojasMiradas.push("   · " + h.getName() + ": " +
                (tiene.length ? tiene.join(" + ") : "ninguna columna conocida") +
                "  ← no sirve");
            return;
        }

        let r = referenciasDelArchivo(rejilla, c);
        hojasMiradas.push("   · " + h.getName() + ": " + tiene.join(" + ") +
            " · " + r.porReferencia.size + " referencias, " +
            r.entradas.length + " claves");
        if (r.entradas.length === 0) return;
        if (!mejor || r.entradas.length > mejor.r.entradas.length) {
            mejor = { r: r, cols: c, nombreHoja: h.getName() };
        }
    });

    if (!mejor) {
        return { ok: false, error:
            "No encontré una pestaña con la columna «Referencia» y alguna de " +
            "«Tracking 1Z» o «House» CON DATOS en " + libro.getName() +
            ".\n\nMiré:\n" + hojasMiradas.join("\n") };
    }

    let celdas = guardarBlobReferencias(ss, mejor.r.entradas);
    olvidarBlobPedimentosDeHouseEnRAM();

    return { ok: true, entradas: mejor.r.entradas,
             porReferencia: mejor.r.porReferencia,
             contradicciones: mejor.r.contradicciones,
             celdas: celdas, cols: mejor.cols,
             nombreHoja: mejor.nombreHoja, libro: libro,
             hojasMiradas: hojasMiradas };
}

// El resumen de lo que se trajo, en palabras. Se comparte entre los dos
// botones para que digan lo mismo.
function resumenDeImportacionPedimentos(r) {
    let piezas = 0;
    r.porReferencia.forEach(lista => { piezas += lista.length; });

    let msg = (r.deCarpeta
        ? "De la carpeta «" + r.nombreHoja + "»:\n" +
          "   · " + (r.archivos.length ? r.archivos.length + " archivo" +
                     (r.archivos.length === 1 ? "" : "s") + " nuevo" +
                     (r.archivos.length === 1 ? "" : "s") + ": " + r.archivos.join(", ")
                   : "ningún archivo nuevo") + "\n" +
          "   · " + r.piezasNuevas.toLocaleString() + " claves nuevas" +
          (r.antes ? " (ya había " + r.antes.toLocaleString() + ")" : "") + "\n"
        : "Del archivo «" + r.nombreHoja + "» de " + r.libro.getName() + ":\n") +
              "   · " + r.porReferencia.size.toLocaleString() + " referencias\n" +
              "   · " + piezas.toLocaleString() + " piezas\n" +
              "   · " + r.entradas.length.toLocaleString() + " claves (1Z + house)";

    if (r.deCarpeta && r.quedan) {
        msg += "\n\n⏳ Quedan más archivos por leer: vuelve a apretar el botón. " +
               "Se leen " + MAX_ARCHIVOS_GUIAS + " por pasada para no agotar los " +
               "seis minutos que Google da por ejecución.";
    }
    if (r.deCarpeta && r.problemas && r.problemas.length) {
        msg += "\n\n⚠️ " + r.problemas.length + " archivo" +
               (r.problemas.length === 1 ? "" : "s") + " que no pude leer:\n   · " +
               r.problemas.slice(0, 6).join("\n   · ");
        if (r.problemas.length > 6) {
            msg += "\n   …y " + (r.problemas.length - 6) + " más.";
        }
        msg += "\n\nEsos NO quedan apuntados: se corrigen y entran solos en la " +
               "siguiente pasada.";
    }

    if (r.contradicciones.length) {
        msg += "\n\n⚠️ " + r.contradicciones.length + " guías salen en DOS " +
               "referencias distintas EN EL ARCHIVO. Se quedó la primera:\n" +
               r.contradicciones.slice(0, 8)
                   .map(x => "   · " + x.clave + ": " + x.primero + " / " + x.segundo)
                   .join("\n");
        if (r.contradicciones.length > 8) {
            msg += "\n   …y " + (r.contradicciones.length - 8) + " más.";
        }
        msg += "\n\nEso es una contradicción del archivo, no del escaneo.";
    }
    return msg;
}

// El botón de solo importar. Sirve para refrescar la lista sin pagar el
// recorrido de todas las pestañas que hace la confronta.
function importarPedimentos() {
    const ss = obtenerArchivo();
    const ui = SpreadsheetApp.getUi();

    let r = traerLasGuias(ss);
    if (!r.ok) { ui.alert("📥 Importar los pedimentos", r.error, ui.ButtonSet.OK); return; }

    ui.alert("📥 Importar los pedimentos",
        "Listo.\n\n" + resumenDeImportacionPedimentos(r) + "\n\n" +
        "   · " + r.celdas + " celdas de lista rápida\n\n" +
        "Esto trae QUÉ GUÍAS forman cada referencia. El pedimento de cada " +
        "referencia se aprende de los escaneos, y eso lo hace «🔎 Confrontar " +
        "con los pedimentos».",
        ui.ButtonSet.OK);
}

// =========================================================================
// LEER LAS GUÍAS DIRECTAMENTE DE LA CARPETA DE DRIVE
// =========================================================================
//
// QUÉ SE QUITA DE EN MEDIO. Hasta ahora el Excel de guías pasaba por otro
// archivo —el de los pedimentos, con su OCR— y de ahí se jalaba aquí. Ese paso
// ya no hace falta: de todo lo que produce aquel archivo, esto solo necesita
// QUÉ 1Z FORMAN CADA REFERENCIA, y eso está en el propio Excel. El pedimento no
// se le pide a nadie, se aprende de los escaneos.
//
// LO QUE NO SE TRAE, Y ES A PROPÓSITO: el OCR de las fotos de pedimentos. La
// cuota de tiempo de disparadores es POR CUENTA, no por archivo, y al agotarse
// Google apaga TODOS los disparadores de esa cuenta —el del escaneo también—.
// Este archivo ya gasta unas dos horas y media al día solo con el relleno de
// houses cada cinco minutos. Un OCR encima dejaría al muelle sin escanear a
// media tarde, y el síntoma sería «dejó de funcionar» sin ningún error.
//
// SE ACUMULA, NO SE REEMPLAZA. Cada archivo se lee UNA vez: su ID queda
// apuntado y no se vuelve a mirar. Reemplazar la lista entera con el último
// Excel borraría las referencias de los días anteriores, que siguen vivas en el
// muelle mientras no salgan.
// =========================================================================

const PROP_CARPETA_GUIAS = 'PEDIMENTOS_CARPETA_PENDIENTES';
const PROP_CARPETA_GUIAS_HECHAS = 'PEDIMENTOS_CARPETA_PROCESADOS';

// Dónde se apunta qué archivos ya se leyeron. Es lo que hace que pasar dos
// veces el mismo Excel no cueste nada y no duplique nada.
const HOJA_ARCHIVOS_GUIAS = "GUIAS_LEIDAS";

// Cuántos archivos por pasada. Cada uno que no sea nativo hay que convertirlo, y
// una conversión tarda segundos: sin tope, una carpeta con cien Excel agotaría
// los seis minutos de ejecución y no se guardaría nada de nada.
const MAX_ARCHIVOS_GUIAS = 20;

function tiposDeArchivoDeGuias() {
    return ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'application/vnd.ms-excel',
            'application/vnd.google-apps.spreadsheet',
            'text/csv',
            'text/plain',              // un CSV subido a veces llega así
            'text/tab-separated-values',
            'application/octet-stream',// y a veces sin tipo ninguno
            'application/vnd.ms-excel.sheet.macroEnabled.12'];
}

// ¿Este archivo puede ser una lista de guías?
//
// SE MIRA EL TIPO Y TAMBIÉN EL NOMBRE, y hace falta: Drive etiqueta el mismo
// .xlsx de maneras distintas según cómo llegue —subido, sincronizado, copiado
// de otro Drive— y con un .csv es peor todavía, que a veces llega como
// «text/plain» y a veces sin tipo. Filtrando solo por tipo, el archivo estaba
// delante y el sistema decía que no había ninguno.
function pareceArchivoDeGuias(nombre, tipo) {
    if (tiposDeArchivoDeGuias().indexOf(String(tipo)) !== -1) return true;
    return /\.(xlsx|xlsm|xls|csv|tsv)$/i.test(String(nombre === undefined ? "" : nombre));
}

// Lo que se enseña cuando no sale nada: TODO lo que hay en la carpeta, con su
// tipo y el motivo por el que se saltó. Un «no encontré nada» a secas obliga a
// adivinar, y lo que se adivina primero —«la carpeta está mal»— casi nunca es.
function motivoDeSaltarse(nombre, tipo, yaLeido) {
    if (tipo === 'application/vnd.google-apps.shortcut') {
        return "es un ACCESO DIRECTO, no el archivo: mete el archivo de verdad";
    }
    if (tipo === 'application/vnd.google-apps.folder') return "es una carpeta";
    if (yaLeido) return "ya se leyó antes (no se vuelve a leer)";
    if (!pareceArchivoDeGuias(nombre, tipo)) return "no es un Excel ni un CSV";
    return "";
}

// El id de una carpeta de Drive a partir de su URL. Es otro formato que el de
// una hoja de cálculo —«/folders/» en vez de «/d/»— así que no sirve el
// recortador de siempre.
function idDeCarpetaDesdeUrl(texto) {
    let t = String(texto === undefined || texto === null ? "" : texto).trim();
    if (t === "") return "";
    let m = t.match(/\/folders\/([a-zA-Z0-9_-]{10,})/);
    if (m) return m[1];
    m = t.match(/[?&]id=([a-zA-Z0-9_-]{10,})/);
    if (m) return m[1];
    // Pegado a pelo, sin URL alrededor.
    if (/^[a-zA-Z0-9_-]{10,}$/.test(t)) return t;
    return "";
}

function idCarpetaDeGuias() {
    try {
        return PropertiesService.getScriptProperties()
               .getProperty(PROP_CARPETA_GUIAS) || "";
    } catch (err) { return ""; }
}

function idCarpetaDeGuiasHechas() {
    try {
        return PropertiesService.getScriptProperties()
               .getProperty(PROP_CARPETA_GUIAS_HECHAS) || "";
    } catch (err) { return ""; }
}

// Los IDs van a Script Properties y NUNCA al código. Este repositorio está en
// git, y el id de una carpeta es por sí solo la llave para abrirla.
function vincularCarpetaDeGuias() {
    const ui = SpreadsheetApp.getUi();

    let r = ui.prompt("📁 Carpeta de las guías",
        (idCarpetaDeGuias() === "" ? "No hay ninguna carpeta configurada."
                                   : "Ahora mismo:\n" + idCarpetaDeGuias()) + "\n\n" +
        "Pega la URL de la carpeta «POR PROCESAR», donde dejas el Excel de " +
        "guías (House / Tracking 1Z / Referencia):",
        ui.ButtonSet.OK_CANCEL);
    if (r.getSelectedButton() !== ui.Button.OK) return;

    let id = idDeCarpetaDesdeUrl(r.getResponseText());
    if (id === "") {
        ui.alert("📁 Carpeta de las guías",
                 "Eso no parece una carpeta de Drive.", ui.ButtonSet.OK);
        return;
    }
    // Se comprueba AQUÍ que se puede abrir, no el día que alguien importa en el
    // muelle. Un vínculo que no sirve tiene que fallar al guardarlo.
    let nombre = "";
    try { nombre = DriveApp.getFolderById(id).getName(); }
    catch (err) {
        ui.alert("📁 Carpeta de las guías",
            "No pude abrirla:\n" + err + "\n\n" +
            "Comprueba que esta cuenta tenga acceso a esa carpeta.", ui.ButtonSet.OK);
        return;
    }

    let r2 = ui.prompt("📁 Carpeta de las guías",
        "Carpeta de entrada: " + nombre + "\n\n" +
        "Ahora pega la URL de la carpeta «PROCESADOS», adonde se moverán los " +
        "archivos ya leídos.\n\nDéjalo VACÍO si prefieres que no se mueva nada: " +
        "cada archivo se lee una sola vez igual, porque su id queda apuntado.",
        ui.ButtonSet.OK_CANCEL);
    if (r2.getSelectedButton() !== ui.Button.OK) return;

    let idHechas = idDeCarpetaDesdeUrl(r2.getResponseText());
    let nombreHechas = "";
    if (idHechas !== "") {
        try { nombreHechas = DriveApp.getFolderById(idHechas).getName(); }
        catch (err) {
            ui.alert("📁 Carpeta de las guías",
                "La de PROCESADOS no pude abrirla:\n" + err, ui.ButtonSet.OK);
            return;
        }
    }

    let props = PropertiesService.getScriptProperties();
    props.setProperty(PROP_CARPETA_GUIAS, id);
    props.setProperty(PROP_CARPETA_GUIAS_HECHAS, idHechas);

    ui.alert("📁 Carpeta de las guías",
        "Listo.\n\n   · Entrada: " + nombre + "\n" +
        "   · Procesados: " + (nombreHechas === "" ? "(no se mueve nada)" : nombreHechas) +
        "\n\nDeja ahí el Excel de guías y aprieta «🔎 Confrontar con los " +
        "pedimentos». Cada archivo se lee UNA vez: pasarlo dos veces no " +
        "duplica nada.\n\n" +
        "Vale un .xlsx, un .csv o una hoja de Google. No hay que activar nada: " +
        "el Excel se convierte con los permisos que este archivo ya tiene.",
        ui.ButtonSet.OK);
}

// -------------------------------------------------------------------------
// QUÉ ARCHIVOS YA SE LEYERON
// -------------------------------------------------------------------------

function archivosYaLeidos(ss) {
    let set = new Set();
    let h = hojaDeTextoRapido(ss, HOJA_ARCHIVOS_GUIAS, false);
    if (!h) return set;
    let lr = h.getLastRow();
    if (lr < 1) return set;
    h.getRange(1, 1, lr, 1).getValues().forEach(f => {
        let v = String(f[0] === undefined ? "" : f[0]).trim();
        if (v !== "") set.add(v);
    });
    return set;
}

function apuntarArchivosLeidos(ss, ids) {
    if (!ids || ids.length === 0) return 0;
    let h = hojaDeTextoRapido(ss, HOJA_ARCHIVOS_GUIAS, true);
    let desde = h.getLastRow() + 1;
    asegurarFilas(h, desde + ids.length);
    // SE AÑADE AL FINAL, no se reescribe la columna entera: es el mismo
    // invariante que protege la columna A de los escaneos. Entre leer y
    // escribir cabe otra ejecución, y devolver la copia leída la borraría.
    h.getRange(desde, 1, ids.length, 1).setValues(ids.map(x => [x]));
    return ids.length;
}

// -------------------------------------------------------------------------
// LEER UN ARCHIVO
// -------------------------------------------------------------------------

// Un .xlsx hay que convertirlo, y convertir necesita el servicio avanzado de
// Drive. Un CSV se lee a pelo y una hoja de Google se abre directamente: esos
// dos caminos funcionan aunque nadie haya activado nada, y por eso se intentan
// antes de pedir el servicio.
function filasDeArchivoDeGuias(archivo) {
    let tipo = archivo.getMimeType();

    let nombre = archivo.getName();

    // EL CAMINO SE ELIGE POR TIPO **Y** POR NOMBRE. Un CSV subido llega unas
    // veces como «text/csv», otras como «text/plain» y otras sin tipo ninguno;
    // yendo solo por el tipo, esos acababan en el convertidor de Excel y
    // fallaban con un error de Google que no decía nada de esto.
    if (tipo === 'text/csv' || tipo === 'text/tab-separated-values' ||
        /\.(csv|tsv)$/i.test(nombre)) {
        let texto = archivo.getBlob().getDataAsString();
        let sep = /\.tsv$/i.test(nombre) || tipo === 'text/tab-separated-values' ? "\t" : ",";
        return { rejillas: [Utilities.parseCsv(texto, sep)], temporal: "" };
    }
    if (tipo === 'application/vnd.google-apps.spreadsheet') {
        let libro = SpreadsheetApp.openById(archivo.getId());
        return { rejillas: libro.getSheets().map(h => h.getDataRange().getValues()),
                 temporal: "" };
    }

    // UN EXCEL HAY QUE CONVERTIRLO. Ver `convertirAHojaDeCalculo`.
    let idTemporal = convertirAHojaDeCalculo(archivo);
    let libro = SpreadsheetApp.openById(idTemporal);
    return { rejillas: libro.getSheets().map(h => h.getDataRange().getValues()),
             temporal: idTemporal };
}

// Convierte un .xlsx en una hoja de cálculo temporal y devuelve su id.
//
// POR QUÉ NO SE PIDE ACTIVAR EL «DRIVE API». Activar un servicio avanzado
// cambia los permisos del proyecto, y eso obliga a VOLVER A AUTORIZAR. Mientras
// no se autorice, los disparadores instalados se quedan parados —y uno de ellos
// es el del escaneo—. En un archivo con siete operadores en el muelle, eso es
// una parada de trabajo a cambio de un convertidor.
//
// Y no hace falta: convertir es una llamada a la API de Drive, y los DOS
// permisos que necesita ya los tiene este proyecto desde antes. `UrlFetchApp`
// lo usa House.gs para bajar el inbound, y el permiso de Drive con escritura lo
// usan Salidas.gs y House.gs con `DriveApp`. O sea que se puede llamar a la API
// a pelo, con el token del propio script, sin añadir ni un permiso nuevo.
//
// SE USA `copy` Y NO `create`, y es lo que lo hace simple: copiar un archivo
// pidiendo otro tipo lo convierte por el camino, y es un POST con tres líneas
// de JSON. Subir el contenido con `create` obliga a armar a mano un cuerpo
// multipart con sus fronteras, que es de las cosas que se rompen en silencio.
//
// Si el servicio avanzado SÍ está puesto se usa ese, que es una llamada menos.
function convertirAHojaDeCalculo(archivo) {
    const TIPO_HOJA = 'application/vnd.google-apps.spreadsheet';
    let nombre = 'tmp_guias_' + archivo.getName();

    if (typeof Drive !== 'undefined' && Drive.Files && Drive.Files.copy) {
        try {
            let c = Drive.Files.copy({ name: nombre, mimeType: TIPO_HOJA },
                                     archivo.getId());
            if (c && c.id) return c.id;
        } catch (err) {
            // Que el servicio avanzado falle no puede cerrar el camino: se
            // sigue por la API a pelo, que es la que funciona siempre.
        }
    }

    let url = "https://www.googleapis.com/drive/v3/files/" + archivo.getId() +
              "/copy?supportsAllDrives=true&fields=id";
    let r;
    try {
        r = UrlFetchApp.fetch(url, {
            method: 'post',
            contentType: 'application/json',
            headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
            payload: JSON.stringify({ name: nombre, mimeType: TIPO_HOJA }),
            muteHttpExceptions: true
        });
    } catch (err) {
        throw new Error("no pude llamar a Drive para convertirlo (" +
            err.message + "). Guárdalo como CSV y se lee sin convertir nada.");
    }

    let codigo = r.getResponseCode();
    if (codigo >= 300) {
        let detalle = String(r.getContentText()).substring(0, 300);
        // El 403 y el 401 son de permisos; los demás son del archivo. Se separan
        // porque lo que hay que hacer es distinto y confundirlos cuesta una
        // tarde.
        throw new Error("Drive no dejó convertirlo (HTTP " + codigo + "). " +
            (codigo === 401 || codigo === 403
                ? "Es un problema de permisos: abre el editor de Apps Script y " +
                  "ejecuta cualquier función una vez para volver a autorizar. " +
                  "O guárdalo como CSV, que no necesita convertirse."
                : "Guárdalo como CSV y se lee sin convertir nada.") +
            "\n      Drive dijo: " + detalle);
    }

    let id = "";
    try { id = JSON.parse(r.getContentText()).id || ""; } catch (err) { id = ""; }
    if (id === "") {
        throw new Error("Drive contestó que sí pero sin decir qué archivo creó. " +
                        "Guárdalo como CSV.");
    }
    return id;
}

// LA CABECERA NO SIEMPRE ESTÁ EN LA FILA 1. Un archivo exportado a mano suele
// traer un título encima, y exigir la primera fila haría fallar la lectura sin
// decir por qué. Se buscan las columnas en las primeras filas.
const FILAS_A_MIRAR_CABECERA = 10;

function cabeceraDeGuiasEn(rejilla) {
    for (let i = 0; i < Math.min(FILAS_A_MIRAR_CABECERA, (rejilla || []).length); i++) {
        let c = detectarColumnasPedimentos(rejilla[i]);
        if (c.referencia !== -1 && (c.guia !== -1 || c.house !== -1)) {
            return { fila: i, cols: c };
        }
    }
    return null;
}

// De un archivo a la lista de piezas. Puro salvo por la lectura, para poder
// probar la parte que decide.
function piezasDeRejillaDeGuias(rejilla) {
    let cab = cabeceraDeGuiasEn(rejilla);
    if (!cab) return null;
    // `referenciasDelArchivo` salta la primera fila, así que se le pasa la
    // rejilla recortada desde la cabecera.
    return referenciasDelArchivo(rejilla.slice(cab.fila), cab.cols);
}

// -------------------------------------------------------------------------
// EL NÚCLEO
// -------------------------------------------------------------------------

// Lee los archivos nuevos de la carpeta y los SUMA a lo que ya había.
//
// Devuelve la misma forma que `traerPedimentosDelArchivo`, para que la
// confronta no tenga que saber de dónde salieron los datos.
function traerGuiasDeLaCarpeta(ss) {
    let idCarpeta = idCarpetaDeGuias();
    if (idCarpeta === "") {
        return { ok: false, error: "No hay ninguna carpeta configurada.\n\nUsa " +
                 "«📁 Vincular la carpeta de las guías» primero." };
    }

    let carpeta;
    try { carpeta = DriveApp.getFolderById(idCarpeta); }
    catch (err) { return { ok: false, error: "No pude abrir la carpeta:\n" + err }; }

    let hechas = null;
    let idHechas = idCarpetaDeGuiasHechas();
    if (idHechas !== "") {
        try { hechas = DriveApp.getFolderById(idHechas); } catch (err) { hechas = null; }
    }

    // LO QUE YA HABÍA. Se parte de ahí y se suma: un Excel nuevo trae el
    // embarque de hoy, no el de ayer, y reemplazar borraría las referencias que
    // siguen vivas en el muelle.
    let acumulado = mapaDesdeBlobPedimentos(leerTextoRapido(ss, HOJA_REFERENCIAS_RAPIDO));
    let antes = acumulado.size;
    let yaLeidos = archivosYaLeidos(ss);

    let mirados = [], nuevosIds = [], problemas = [], inventario = [];
    let quedan = false, piezasNuevas = 0, invalidas = 0;

    let it = carpeta.getFiles();
    while (it.hasNext()) {
        let archivo = it.next();
        let nombre = archivo.getName();
        let tipo = archivo.getMimeType();
        let motivo = motivoDeSaltarse(nombre, tipo, yaLeidos.has(archivo.getId()));
        if (motivo !== "") {
            if (inventario.length < 30) {
                inventario.push(nombre + "  —  " + motivo);
            }
            continue;
        }
        if (mirados.length >= MAX_ARCHIVOS_GUIAS) { quedan = true; break; }

        let temporal = "";
        try {
            let leido = filasDeArchivoDeGuias(archivo);
            temporal = leido.temporal;

            let encontro = false;
            leido.rejillas.forEach(rejilla => {
                let r = piezasDeRejillaDeGuias(rejilla);
                if (!r || r.entradas.length === 0) return;
                encontro = true;
                invalidas += r.contradicciones.length;
                r.entradas.forEach(e => {
                    if (acumulado.has(e.clave)) return;
                    acumulado.set(e.clave, e.referencia);
                    piezasNuevas++;
                });
            });

            if (!encontro) {
                problemas.push(nombre + ": lo abrí bien, pero en sus " +
                    leido.rejillas.length + " pestaña(s) no encontré una fila de " +
                    "encabezados con «Referencia» y «Tracking 1Z» (se miran las " +
                    FILAS_A_MIRAR_CABECERA + " primeras filas de cada una)");
            } else {
                mirados.push(nombre);
                nuevosIds.push(archivo.getId());
                // SE APUNTA Y DESPUÉS SE MUEVE, en ese orden. Si mover falla
                // —permisos, carpeta borrada— el archivo se queda donde está
                // pero ya no se vuelve a leer, así que nada se duplica.
                if (hechas) { try { archivo.moveTo(hechas); } catch (err) { /* da igual */ } }
            }
        } catch (err) {
            // UN ARCHIVO MALO NO PARA LOS DEMÁS, y tampoco se apunta como
            // leído: se corrige y en la siguiente pasada entra solo.
            problemas.push(nombre + ": " + err.message);
        } finally {
            if (temporal !== "") {
                try { DriveApp.getFileById(temporal).setTrashed(true); } catch (err) { /* limpieza */ }
            }
        }
    }

    if (acumulado.size === 0) {
        let msg = "No pude sacar ninguna guía de la carpeta «" +
                  carpeta.getName() + "».\n\n";
        if (problemas.length) {
            msg += "LO QUE INTENTÉ LEER:\n   · " + problemas.join("\n   · ") + "\n\n";
        }
        if (inventario.length) {
            msg += "LO QUE HAY EN LA CARPETA Y ME SALTÉ:\n   · " +
                   inventario.join("\n   · ") + "\n\n";
        }
        if (!problemas.length && !inventario.length) {
            msg += "La carpeta está VACÍA para esta cuenta.\n\n" +
                   "Las dos causas de siempre: el archivo está en una SUBCARPETA " +
                   "—aquí solo se mira la carpeta que diste, no lo que cuelga de " +
                   "ella— o la carpeta que vinculaste no es la que crees. " +
                   "Comprueba la URL con «📁 Vincular la carpeta de las guías».";
        }
        return { ok: false, error: msg };
    }

    let entradas = [];
    acumulado.forEach((ref, clave) => entradas.push({ clave: clave, referencia: ref }));
    let celdas = guardarBlobReferencias(ss, entradas);
    apuntarArchivosLeidos(ss, nuevosIds);
    olvidarBlobPedimentosDeHouseEnRAM();

    return { ok: true, entradas: entradas,
             porReferencia: referenciasDesdeMapa(acumulado),
             contradicciones: [],
             celdas: celdas, cols: null,
             nombreHoja: carpeta.getName(), libro: null,
             deCarpeta: true, archivos: mirados, problemas: problemas,
             quedan: quedan, piezasNuevas: piezasNuevas, antes: antes };
}

// referencia → sus 1Z, sacado del mapa acumulado.
//
// SOLO LOS 1Z, no las houses. El mapa lleva las dos cosas —hacen falta las dos
// para encontrar la referencia de una fila— pero la LISTA de la referencia es
// de bultos, y una house cubre varios: contándolas saldrían menos piezas de las
// que hay y el «faltan tres» sería mentira.
function referenciasDesdeMapa(mapa) {
    let out = new Map();
    (mapa || new Map()).forEach((ref, clave) => {
        if (!/^1Z[A-Z0-9]{16}$/.test(clave)) return;
        if (!out.has(ref)) out.set(ref, []);
        out.get(ref).push(clave);
    });
    return out;
}

// De dónde se traen las guías: de la carpeta si hay una configurada, y si no
// del archivo vinculado. Los dos caminos siguen vivos a propósito, para poder
// cambiarse sin perder nada y volver atrás si algo sale mal.
function traerLasGuias(ss) {
    if (idCarpetaDeGuias() !== "") return traerGuiasDeLaCarpeta(ss);
    return traerPedimentosDelArchivo(ss);
}

// -------------------------------------------------------------------------
// LA CONFRONTA
// -------------------------------------------------------------------------

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

// Lo que hay escaneado, por pedimento y por bulto.
//
// Se lee la columna A —el 1Z, y de paso de qué bloque es cada fila— y la C, que
// es donde vive la house.
//
// SE INDEXA POR EL 1Z, NO POR LA HOUSE, y esa es la diferencia que hace útil
// este informe. Una house cubre varios bultos: con ella por clave, tres guías
// de la misma house se contaban como una sola y las otras dos no aparecían en
// ningún sitio. El 1Z es uno por bulto, que es lo que se carga.
function housesEscaneadasPorPedimento(ss) {
    let porPedimento = new Map();   // pedimento -> Map(1Z -> {hoja, fila, house})
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

            let g = claveHousePed(a);
            if (g === "") continue;
            let h = claveHousePed(datos[i][2]);
            if (!porPedimento.has(pedActual)) porPedimento.set(pedActual, new Map());
            let m = porPedimento.get(pedActual);
            if (!m.has(g)) m.set(g, { hoja: hoja.getName(), fila: i + 1, house: h });
        }
    });
    return porPedimento;
}

// ATAR CADA REFERENCIA A SU PEDIMENTO, que es la regla que se pidió: se lee un
// 1Z debajo de un pedimento y, como el archivo dice de qué referencia es, esa
// referencia va con ese pedimento.
//
// GANA EL PEDIMENTO CON MÁS PIEZAS DE ESA REFERENCIA. Quedándose con el primero
// que se lee, la que mandaría sería la fila que esté más arriba, que no tiene
// nada que ver con cuál es la buena: si cuarenta y cinco piezas están en un
// pedimento y cuatro en otro, las cuatro son el error, y son las que tienen que
// salir marcadas.
//
// EL EMPATE NO SE ROMPE. Con la mitad en cada uno no hay forma de saber cuál es
// el bueno, y elegir al azar acusaría a la mitad de los bultos buenos. Esa
// referencia se deja SIN ATAR y se reporta como repartida, para que lo decida
// una persona.
//
// Puro, para poder probarlo.
function atarReferenciasAPedimentos(refDeClave, escaneado) {
    let cuenta = new Map();     // referencia -> Map(pedimento -> piezas)
    (escaneado || new Map()).forEach((bultos, ped) => {
        bultos.forEach((info, g) => {
            let ref = (refDeClave && refDeClave.get(g)) ||
                      (info.house && refDeClave && refDeClave.get(info.house)) || "";
            if (ref === "") return;
            if (!cuenta.has(ref)) cuenta.set(ref, new Map());
            let m = cuenta.get(ref);
            m.set(ped, (m.get(ped) || 0) + 1);
        });
    });

    let atadura = new Map();
    let repartidas = [];
    cuenta.forEach((porPed, ref) => {
        let mejorPed = "", mejorN = 0, empate = false, total = 0;
        porPed.forEach((n, ped) => {
            total += n;
            if (n > mejorN) { mejorN = n; mejorPed = ped; empate = false; }
            else if (n === mejorN) empate = true;
        });
        if (porPed.size > 1) {
            let detalle = [];
            porPed.forEach((n, ped) => detalle.push({ pedimento: ped, piezas: n }));
            detalle.sort((a, b) => b.piezas - a.piezas);
            repartidas.push({ referencia: ref, total: total, empate: empate,
                              detalle: detalle });
        }
        if (!empate) atadura.set(ref, mejorPed);
    });
    return { atadura: atadura, cuenta: cuenta, repartidas: repartidas };
}

// El cruce, puro. Comprueba las DOS cosas que se pidieron:
//
//   · que lo escaneado bajo un pedimento sea de una referencia atada a ÉL;
//   · que la referencia esté COMPLETA: si el archivo le da diez piezas, que
//     estén las diez y que sean esas diez.
//
// SOLO SE MIRAN LAS REFERENCIAS QUE ESTÁN ATADAS, o sea las que tienen al menos
// un bulto escaneado. De una referencia que todavía no ha llegado no se puede
// decir que falte: no se ha empezado.
//
// Cada línea sale [PEDIMENTO, REFERENCIA, ESTADO, PESTAÑA, FILA, GUÍA].
function confrontarHouses(porReferencia, refDeClave, escaneado, atado) {
    let lineas = [];
    let resumen = new Map();   // pedimento -> {revisadas, malas, faltan, sobran}
    let atadura = (atado && atado.atadura) || new Map();

    let anota = (ped, campo) => {
        if (!resumen.has(ped)) {
            resumen.set(ped, { revisadas: 0, malas: 0, faltan: 0, sobran: 0 });
        }
        resumen.get(ped)[campo]++;
    };

    // 1. LO ESCANEADO. Cada bulto contra la atadura de su referencia.
    let escaneadasPorRef = new Map();   // referencia -> Set(1Z escaneados en SU pedimento)
    (escaneado || new Map()).forEach((bultos, ped) => {
        bultos.forEach((info, g) => {
            let ref = (refDeClave && refDeClave.get(g)) ||
                      (info.house && refDeClave && refDeClave.get(info.house)) || "";

            // El archivo no conoce este bulto. Solo se denuncia si el pedimento
            // tiene alguna referencia atada: si no, no hay nada contra qué
            // comparar y el informe se llenaría de filas que no son un error
            // sino una falta de datos.
            if (ref === "") {
                let conocido = false;
                atadura.forEach(p => { if (p === ped) conocido = true; });
                if (!conocido) return;
                anota(ped, 'revisadas');
                anota(ped, 'sobran');
                lineas.push([ped, "", "⚠️ SOBRA: el archivo no tiene este 1Z",
                             info.hoja, info.fila, g]);
                return;
            }

            anota(ped, 'revisadas');
            let suyo = atadura.get(ref) || "";
            if (suyo === "" || suyo === ped) {
                if (!escaneadasPorRef.has(ref)) escaneadasPorRef.set(ref, new Set());
                escaneadasPorRef.get(ref).add(g);
                return;
            }
            anota(ped, 'malas');
            lineas.push([ped, ref, "❌ Esa referencia va en el pedimento " + suyo,
                         info.hoja, info.fila, g]);
        });
    });

    // 2. LO QUE FALTA. De cada referencia atada, las piezas que el archivo tiene
    //    y no aparecen escaneadas en su pedimento. Es la mitad de la pregunta
    //    que se pidió: «si la referencia tiene diez piezas, que sean diez».
    atadura.forEach((ped, ref) => {
        let delArchivo = (porReferencia && porReferencia.get(ref)) || [];
        let estan = escaneadasPorRef.get(ref) || new Set();
        delArchivo.forEach(g => {
            if (estan.has(g)) return;
            anota(ped, 'faltan');
            lineas.push([ped, ref, "🔻 FALTA: el archivo la tiene y no está escaneada",
                         "", "", g]);
        });
    });

    return { lineas: lineas, resumen: resumen, atadura: atadura,
             repartidas: (atado && atado.repartidas) || [] };
}

// Cuántas piezas tiene cada referencia atada y cuántas hay escaneadas. Es la
// tabla que contesta de un vistazo «¿está completa?».
function cuadroDeReferencias(porReferencia, atado) {
    let filas = [];
    let atadura = (atado && atado.atadura) || new Map();
    let cuenta = (atado && atado.cuenta) || new Map();
    atadura.forEach((ped, ref) => {
        let delArchivo = (porReferencia && porReferencia.get(ref) || []).length;
        let enSuPed = (cuenta.get(ref) && cuenta.get(ref).get(ped)) || 0;
        let total = 0;
        if (cuenta.get(ref)) cuenta.get(ref).forEach(n => { total += n; });
        filas.push([ref, ped, delArchivo, enSuPed, total - enSuPed,
                    delArchivo === enSuPed && total === enSuPed
                        ? "✅ COMPLETA"
                        : (enSuPed > delArchivo ? "⚠️ SOBRAN PIEZAS"
                                                : "🔻 FALTAN " + (delArchivo - enSuPed))]);
    });
    filas.sort((a, b) => String(a[1]).localeCompare(String(b[1])) ||
                         String(a[0]).localeCompare(String(b[0])));
    return filas;
}

function confrontarPedimentosConEscaneos() {
    const ss = obtenerArchivo();
    const ui = SpreadsheetApp.getUi();

    ss.toast('⏳ Trayendo las guías…', 'Confronta', 10);
    let imp = traerLasGuias(ss);
    if (!imp.ok) {
        ui.alert("🔎 Confrontar con los pedimentos", imp.error, ui.ButtonSet.OK);
        return;
    }

    // Se cruza contra lo que ACABA de traerse, no contra el texto empaquetado.
    // Volver a leer lo que se acaba de escribir sería pagar una lectura para
    // obtener lo que ya está en memoria, y abre la puerta a que los dos digan
    // cosas distintas.
    ss.toast('⏳ Leyendo los escaneos…', 'Confronta', 20);
    let refDeClave = new Map();
    imp.entradas.forEach(e => refDeClave.set(e.clave, e.referencia));

    let escaneado = housesEscaneadasPorPedimento(ss);
    let atado = atarReferenciasAPedimentos(refDeClave, escaneado);
    let r = confrontarHouses(imp.porReferencia, refDeClave, escaneado, atado);

    // LA ATADURA SE GUARDA para que el aviso de la columna B salga al instante
    // en el siguiente escaneo. Sin esto, lo aprendido aquí se perdía al acabar
    // la función y el aviso nunca tenía con qué comparar.
    let celdasAtadura = 0;
    try { celdasAtadura = guardarBlobAtaduras(ss, atado.atadura); }
    catch (err) { celdasAtadura = 0; }
    olvidarBlobPedimentosDeHouseEnRAM();

    let cuadro = cuadroDeReferencias(imp.porReferencia, atado);

    let hoja = ss.getSheetByName(HOJA_CONFRONTA_HOUSE);
    if (!hoja) hoja = ss.insertSheet(HOJA_CONFRONTA_HOUSE, ss.getNumSheets());
    hoja.clear();

    // EL CUADRO PRIMERO, en las columnas A-F: es el resumen que se mira de un
    // vistazo. El detalle de lo que está mal va a la derecha, separado, para que
    // una lista larga de faltantes no empuje al cuadro fuera de la pantalla.
    hoja.getRange(1, 1, 1, 6)
        .setValues([["REFERENCIA", "VA EN EL PEDIMENTO", "PIEZAS DEL ARCHIVO",
                     "ESCANEADAS AHÍ", "EN OTRO PEDIMENTO", "ESTADO"]])
        .setFontWeight("bold");
    if (cuadro.length > 0) {
        asegurarFilas(hoja, cuadro.length + 2);
        hoja.getRange(2, 1, cuadro.length, 6).setValues(cuadro);
    }

    const COL_DETALLE = 8;
    asegurarColumnas(hoja, COL_DETALLE + 5);
    hoja.getRange(1, COL_DETALLE, 1, 6)
        .setValues([["PEDIMENTO", "REFERENCIA", "ESTADO", "PESTAÑA", "FILA", "GUÍA"]])
        .setFontWeight("bold");
    if (r.lineas.length > 0) {
        asegurarFilas(hoja, Math.max(cuadro.length, r.lineas.length) + 2);
        hoja.getRange(2, COL_DETALLE, r.lineas.length, 6).setValues(r.lineas);
    }
    hoja.setFrozenRows(1);
    ss.setActiveSheet(hoja);

    let totMalas = 0, totFaltan = 0, totSobran = 0, totRevisadas = 0;
    r.resumen.forEach(v => {
        totMalas += v.malas; totFaltan += v.faltan;
        totSobran += v.sobran; totRevisadas += v.revisadas;
    });
    let completas = cuadro.filter(f => String(f[5]).indexOf("✅") === 0).length;

    let msg = resumenDeImportacionPedimentos(imp) + "\n\n" +
        "── EL CRUCE ──\n" +
        "   · " + r.atadura.size + " referencias atadas a un pedimento\n" +
        "   · ✅ " + completas + " completas\n" +
        "   · " + totRevisadas + " bultos revisados\n" +
        "   · ❌ " + totMalas + " en el pedimento equivocado\n" +
        "   · 🔻 " + totFaltan + " piezas del archivo sin escanear\n" +
        "   · ⚠️ " + totSobran + " escaneadas que el archivo no tiene";

    if (r.repartidas.length) {
        msg += "\n\n⚠️ " + r.repartidas.length + " referencias aparecen en VARIOS " +
               "pedimentos:\n" +
               r.repartidas.slice(0, 6).map(x =>
                   "   · " + x.referencia + ": " +
                   x.detalle.map(d => d.pedimento + " (" + d.piezas + ")").join(" / ") +
                   (x.empate ? "  ← EMPATE, sin atar" : "")).join("\n");
        if (r.repartidas.length > 6) {
            msg += "\n   …y " + (r.repartidas.length - 6) + " más.";
        }
        msg += "\n\nGana el pedimento con más piezas. En un empate no se elige: " +
               "lo decide una persona.";
    }

    msg += "\n\nEn la pestaña «" + HOJA_CONFRONTA_HOUSE + "»: el cuadro por " +
           "referencia a la izquierda, y el detalle de lo que está mal a la " +
           "derecha, con su pestaña y su fila.\n\n" +
           "A partir de ahora, al escanear en una hoja de SALIDAS, un 1Z cuya " +
           "referencia esté atada a otro pedimento lo dirá en la columna B.";
    if (celdasAtadura === 0 && r.atadura.size > 0) {
        msg += "\n\n⚠️ No pude guardar las ataduras: el aviso de la columna B " +
               "no saldrá hasta la próxima confronta.";
    }

    ui.alert("🔎 Confrontar con los pedimentos", msg, ui.ButtonSet.OK);
}
