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

// La URL de OneDrive vive aquí, NO en el código. Este proyecto está en un
// repositorio de git: una URL pegada en el archivo queda en el historial para
// siempre, aunque después se borre de la línea. Y esa URL es, por sí sola, la
// llave del archivo.
const PROP_URL_ONEDRIVE = 'HOUSE_URL_ONEDRIVE';

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

// Los acentos fuera antes de comparar cabeceras.
//
// «CSV (delimitado por comas)» guarda en la codificación vieja de Windows, no
// en UTF-8. Al leerlo, una cabecera «GUÍA» llega rota y no casa ni con «GUÍA»
// ni con «GUIA»: el archivo entra bien pero el módulo jura que le falta la
// columna. Comparando sin acentos, el caso bueno y el malo dan lo mismo.
function sinAcentos(txt) {
    return String(txt === undefined || txt === null ? "" : txt)
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Lo mismo por el otro lado: se intenta UTF-8 y, si sale el carácter de
// sustitución —la señal de que el archivo NO era UTF-8—, se reintenta con la
// codificación de Windows. Así un CSV exportado con la opción equivocada se lee
// igual en vez de fallar con un error que apunta al sitio equivocado.
function textoDeArchivo(archivo) {
    let t = archivo.getBlob().getDataAsString();
    if (t.indexOf("�") !== -1) {
        try { t = archivo.getBlob().getDataAsString("windows-1252"); } catch (err) { }
    }
    return normalizarSaltos(t);
}

// Los tres CSV de Excel terminan las líneas de forma distinta, y en el menú de
// «Guardar como» están pegados uno debajo del otro:
//
//   CSV (delimitado por comas)  -> \r\n   el bueno
//   CSV (MS-DOS)                -> \r\n
//   CSV (Macintosh)             -> \r     el que rompe
//
// Con solo \r no hay ni un salto de línea reconocible: el archivo entero
// llegaría como UN renglón, la cabecera se comería todos los datos y la
// importación diría «0 guías» sin dar ninguna pista de por qué. Un clic de
// distancia en un desplegable no debería costar una tarde.
function normalizarSaltos(texto) {
    return String(texto === undefined || texto === null ? "" : texto)
        .replace(/\r\n?/g, "\n");
}

// -------------------------------------------------------------------------
// LOS DOS LÍMITES QUE HAY QUE AVISAR ANTES DE INTENTARLO
// -------------------------------------------------------------------------

// Apps Script no aguanta un CSV de decenas de MB: se queda sin tiempo o sin
// memoria a media pasada de `parseCsv`, y lo que se ve es un error críptico
// SEIS MINUTOS después, sin ninguna pista de que el problema era el tamaño.
//
// El arreglo no es de código, es de export: sacar solo las dos columnas que se
// usan —la guía y la house— en vez del reporte entero. Un inbound completo trae
// pesos, consignatarios, direcciones y fechas que aquí no pintan nada.
const MB_AVISO = 15;
const MB_LIMITE = 45;

// Cuántas líneas se parsean de una vez. `parseCsv` sobre 25 MB de golpe monta
// un array de más de un millón de celdas en memoria; por bloques, el pico se
// queda en lo que ocupe un bloque.
const LINEAS_POR_BLOQUE = 20000;

// Cuántas filas se escriben por `setValues`. Un índice de cientos de miles de
// filas no cabe en una sola llamada.
const FILAS_POR_ESCRITURA = 50000;

function avisoDeTamano(caracteres) {
    let mb = caracteres / (1024 * 1024);
    if (mb < MB_AVISO) return "";
    let cabeza = "El archivo pesa " + mb.toFixed(1) + " MB.\n\n";
    if (mb >= MB_LIMITE) {
        return cabeza +
            "Es demasiado para Apps Script: se quedaría sin tiempo a media lectura.\n\n" +
            "Si ya está reducido a las columnas de guía y house, entonces lo que sobra " +
            "es HISTORIA: exporta solo los últimos meses. Una guía que se escanea hoy " +
            "se prealertó hace días, no hace dos años.";
    }
    return cabeza + "Va a tardar. Si falla, exporta solo los últimos meses en vez de " +
           "toda la historia.";
}

function excedeElLimite(caracteres) {
    return caracteres / (1024 * 1024) >= MB_LIMITE;
}

// SIN FECHA NO HAY REPARTO, Y SIN REPARTO EL DISEÑO SE CAE.
//
// Todo el rendimiento de este módulo se apoya en que el índice caliente sea
// pequeño: es el que el disparador abre CADA MINUTO. El reparto entre caliente
// y frío lo decide la fecha, y sin ella todo se queda en el caliente.
//
// O sea que un archivo de 650.000 filas sin fecha no es «un poco más lento»:
// convierte una carga de un segundo cada minuto en una de medio minuto cada
// minuto, y el disparador se pisaría a sí mismo. Es peor que no tener houses.
const AVISO_SIN_FECHA =
    "⚠️ Este archivo NO trae columna de fecha.\n\n" +
    "Sin fecha, todas las guías se quedan en el índice caliente, que es el que " +
    "se abre cada minuto para rellenar. Con pocos miles no pasa nada; con " +
    "cientos de miles, el disparador no da abasto.\n\n" +
    "Añade al export una columna de fecha (llámala FECHA), o exporta solo los " +
    "últimos meses.";

// Parte el texto en bloques de líneas para no parsear 25 MB de una vez.
//
// La cabecera se repite al principio de cada bloque: así todos se parsean igual
// y quien los reciba puede saltarse siempre la fila 0, sin llevar la cuenta de
// qué bloque era el primero.
//
// Un salto de línea DENTRO de un campo entrecomillado no puede partir un bloque,
// o el CSV quedaría cortado por la mitad y esa fila se perdería. Por eso se
// cuentan las comillas: mientras haya una abierta, el bloque no se cierra.
function bloquesDeLineas(texto, porBloque, cabecera) {
    let lineas = String(texto === undefined || texto === null ? "" : texto).split("\n");
    let limite = porBloque || LINEAS_POR_BLOQUE;
    let bloques = [];
    let actual = [];
    let dentroDeComillas = false;

    for (let i = 0; i < lineas.length; i++) {
        actual.push(lineas[i]);
        if ((lineas[i].match(/"/g) || []).length % 2 === 1) {
            dentroDeComillas = !dentroDeComillas;
        }
        if (actual.length >= limite && !dentroDeComillas) {
            bloques.push(actual.join("\n"));
            actual = [];
        }
    }
    if (actual.length) bloques.push(actual.join("\n"));
    if (cabecera === undefined || cabecera === null) return bloques;
    return bloques.map((b, i) => (i === 0 ? b : cabecera + "\n" + b));
}

// Power Query exporta «Column1, Column2, Column3…» cuando no se promueven los
// encabezados. Las columnas se buscan por NOMBRE a propósito —para no romperse
// en silencio si el reporte cambia de forma—, así que con nombres genéricos no
// hay por dónde agarrar. Decirlo así ahorra buscar el fallo en otro sitio.
function cabecerasGenericas(headers) {
    let hs = (headers || []).map(h => String(h).trim().toUpperCase());
    if (hs.length === 0) return false;
    let genericas = hs.filter(h => /^COLUMN\s*\d+$/.test(h) || h === "").length;
    return genericas >= Math.max(2, Math.ceil(hs.length / 2));
}

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
    let norm = (headers || []).map(h => sinAcentos(String(h).trim().toUpperCase()));
    let buscar = (claves, excluir) => {
        for (let i = 0; i < norm.length; i++) {
            let h = norm[i];
            if (excluir && excluir.some(x => h.indexOf(x) !== -1)) continue;
            if (claves.some(c => h.indexOf(c) !== -1)) return i;
        }
        return -1;
    };
    // Las claves van SIN acentos porque las cabeceras se comparan sin ellos.
    //
    // «CORTA» y «SHIPMENT» son los nombres de la casa: aquí a la house se le
    // llama «guía corta», y en la prealerta viene como «Shipment».
    //
    // CUIDADO CON «CORTA»: «GUIA CORTA» contiene «GUIA». Sin excluirla de la
    // búsqueda de la guía, el módulo tomaría la columna de la HOUSE creyendo que
    // era la del 1Z —y sin avisar, porque una cabecera que dice «guía» parece
    // exactamente lo que se busca—. El índice saldría lleno de houses apuntando
    // a houses y no casaría con ningún escaneo.
    const NO_ES_GUIA = ["HOUSE", "HAWB", "HBL", "CASA", "MASTER", "MAWB",
                        "CORTA", "SHIPMENT"];
    let house = buscar(["HOUSE", "HAWB", "HBL", "CASA", "CORTA", "SHIPMENT"]);

    // La guía se busca en dos rondas, de lo específico a lo genérico. «AWB» a
    // secas es demasiado ancho: casa con «MASTER AWB», que es la guía madre del
    // consolidado y NO es la que se escanea. Si estuviera en la misma ronda que
    // «1Z», ganaría por aparecer antes en el reporte y el índice se llenaría de
    // guías madre —una sola para cientos de bultos—, que nunca casarían con
    // nada. Solo se acepta «AWB» cuando no hay ninguna columna mejor.
    let guia = buscar(["1Z", "TRACKING", "GUIA", "RASTREO"], NO_ES_GUIA);
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

// Lee un CSV entero por bloques y devuelve las filas listas para el índice.
// Es lo que permite tragarse un archivo de decenas de MB sin montar en memoria
// un array de más de un millón de celdas.
function filasDeCsvCompleto(texto, cols, origen) {
    let lineas = texto.split("\n");
    let cabecera = lineas[0] || "";
    let sep = separadorCsv(cabecera);
    let salida = [];
    bloquesDeLineas(texto, LINEAS_POR_BLOQUE, cabecera).forEach(bloque => {
        let datos = Utilities.parseCsv(bloque, sep);
        filasDeInbound(datos, cols, origen).forEach(r => salida.push(r));
    });
    return salida;
}

// Del CSV crudo a filas limpias. Se tira todo lo que no sea una guía válida:
// el reporte trae totales, subtotales y renglones en blanco, y meterlos al
// índice lo engorda sin que sirvan para buscar nada.
function filasDeInbound(datos, cols, origen) {
    let salida = [];
    // La HOUSE es lo único imprescindible. La columna de guía puede no existir:
    // en la prealerta la guía vive dentro del campo de referencias y no tiene
    // columna propia —por eso la macro de VBA hace la búsqueda por «contiene»
    // contra la AD—. Sin guía declarada se barre la fila entera.
    if (!datos || cols.house === -1) return salida;
    let tipo = tipoDeOrigen(origen);
    for (let i = 1; i < datos.length; i++) {
        let fila = datos[i];
        if (!fila) continue;
        let house = String(fila[cols.house] === undefined ? "" : fila[cols.house]).trim();
        if (house === "") continue;
        let fecha = cols.fecha === -1 ? null : aFechaInbound(fila[cols.fecha]);

        // La guía de la columna que toca, y ADEMÁS las que vengan enterradas en
        // cualquier otra celda de la misma fila.
        let guias = [];
        let exacta = cols.guia === -1 ? "" : claveGuiaHouse(fila[cols.guia]);
        if (exacta !== "" && esGuiaUPSValida(exacta)) guias.push(exacta);
        guiasDeFila(fila, cols.guia).forEach(g => {
            if (guias.indexOf(g) === -1) guias.push(g);
        });

        guias.forEach(g => salida.push({
            guia: g, house: house, fecha: fecha, origen: tipo,
            embebida: g !== exacta
        }));
    }
    return salida;
}

// -------------------------------------------------------------------------
// GUÍAS ENTERRADAS EN TEXTO
//
// La macro de prealerta hace DOS búsquedas: primero exacta contra la columna A
// y, si falla, «contiene» contra la AD. O sea que la guía a veces no está sola
// en su celda, sino dentro de un texto más largo —referencias, descripciones,
// varias guías en el mismo renglón—.
//
// Ese «contiene» es lo que hace que la macro tarde: es un bucle dentro de otro
// bucle, 100 millones de comparaciones según su propio comentario, y por eso
// necesita una caché para sobrevivir.
//
// AQUÍ NO SE HACE ASÍ. La búsqueda por «contiene» se resuelve UNA VEZ, al
// importar: se sacan todas las guías que haya en la fila y cada una entra al
// índice por su cuenta. Después, buscar vuelve a ser un Map.get instantáneo.
// El coste se paga una vez al importar en vez de en cada búsqueda, que es toda
// la diferencia entre 100 millones de comparaciones y ninguna.
// -------------------------------------------------------------------------

// Todas las guías 1Z válidas que haya dentro de un texto.
//
// Se limpia el texto de separadores antes de buscar: así una guía partida por
// guiones o espacios se encuentra igual. Dos guías pegadas tampoco se pierden,
// porque el patrón mide 18 caracteres exactos.
function guiasEnTexto(texto) {
    let t = String(texto === undefined || texto === null ? "" : texto)
            .toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (t.length < 18) return [];

    let salida = [];
    let vistas = {};
    let re = /1Z[A-Z0-9]{16}/g;
    let m;
    while ((m = re.exec(t)) !== null) {
        let g = m[0];
        if (!vistas[g] && esGuiaUPSValida(g)) {
            vistas[g] = true;
            salida.push(g);
        }
        // Se avanza UN carácter, no dieciocho: si la ventana de 18 no pasa el
        // dígito verificador, la buena puede empezar una posición más allá.
        // Al concatenar celdas los desfases son normales.
        re.lastIndex = m.index + 1;
    }
    return salida;
}

// Barre la fila entera menos la columna que ya se leyó como guía exacta.
function guiasDeFila(fila, saltarIdx) {
    let salida = [];
    for (let c = 0; c < (fila || []).length; c++) {
        if (c === saltarIdx) continue;
        guiasEnTexto(fila[c]).forEach(g => {
            if (salida.indexOf(g) === -1) salida.push(g);
        });
    }
    return salida;
}

// -------------------------------------------------------------------------
// QUIÉN GANA CUANDO DOS ARCHIVOS NO DICEN LO MISMO
//
// La base son dos archivos distintos, y no valen igual:
//
//   INBOUND    es lo que LLEGÓ.        Es la realidad.
//   PREALERTA  es lo que DIJERON que iba a llegar. Es una promesa.
//
// Si los dos hablan de la misma guía con houses distintas, gana el inbound
// SIEMPRE, sin importar cuál se importara antes. Dejarlo al orden de lectura
// —que es lo que hacía— significaba que la house buena o la mala dependía de
// cómo ordenara Drive la carpeta ese día. Eso no es una regla, es una moneda al
// aire, y el resultado se escribe en la hoja con la que se despacha.
//
// Entre dos archivos del mismo tipo sí gana el primero, y el choque se reporta:
// dos inbounds que se contradicen es un problema del reporte, no algo que este
// módulo pueda resolver eligiendo.
// -------------------------------------------------------------------------
const ORIGEN_DESCONOCIDO = 0;
const ORIGEN_PREALERTA = 1;
const ORIGEN_INBOUND = 2;

function tipoDeOrigen(nombreArchivo) {
    let n = String(nombreArchivo === undefined || nombreArchivo === null ? "" : nombreArchivo)
            .toUpperCase();
    if (n.indexOf("INBOUND") !== -1) return ORIGEN_INBOUND;
    if (n.indexOf("PREALERT") !== -1) return ORIGEN_PREALERTA;
    return ORIGEN_DESCONOCIDO;
}

function nombreDeOrigen(tipo) {
    if (tipo === ORIGEN_INBOUND) return "INBOUND";
    if (tipo === ORIGEN_PREALERTA) return "PREALERTA";
    return "";
}

function origenInbound() { return ORIGEN_INBOUND; }
function origenPrealerta() { return ORIGEN_PREALERTA; }
function origenDesconocido() { return ORIGEN_DESCONOCIDO; }

// La misma normalización que usa el escaneo para la columna A, para que una
// guía escrita con guiones en el reporte case con la escaneada sin ellos.
function claveGuiaHouse(v) {
    return String(v === undefined || v === null ? "" : v)
        .trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// -------------------------------------------------------------------------
// EL ÍNDICE
// -------------------------------------------------------------------------

// Mete las filas nuevas sin duplicar y con una regla clara para los choques.
//
// Una house cambiada sin que nadie lo sepa no se descubre hasta que el bulto
// está en el lugar equivocado, así que ningún choque se resuelve en silencio:
// o gana el inbound —porque es lo que llegó de verdad— o se conserva lo que ya
// estaba y se REPORTA.
//
// Cada fila del índice es [guía, house, fecha, origen]. El origen se guarda
// para poder mirar después de dónde salió una house que no cuadra; sin él, un
// choque solo se puede investigar volviendo a abrir los CSV.
function fusionarEnIndice(existentes, nuevas) {
    let filas = [];
    let porGuia = new Map();
    (existentes || []).forEach(f => {
        let g = claveGuiaHouse(f[0]);
        if (g === "" || porGuia.has(g)) return;
        let fila = [g, String(f[1]).trim(), f[2] === undefined ? "" : f[2],
                    f[3] === undefined ? "" : f[3]];
        porGuia.set(g, fila);
        filas.push(fila);
    });

    let anadidas = 0, corregidas = 0;
    let conflictos = [];
    (nuevas || []).forEach(n => {
        let origen = n.origen === undefined ? ORIGEN_DESCONOCIDO : n.origen;
        let previa = porGuia.get(n.guia);

        if (previa === undefined) {
            let fila = [n.guia, n.house, n.fecha || "", nombreDeOrigen(origen)];
            porGuia.set(n.guia, fila);
            filas.push(fila);
            anadidas++;
            return;
        }
        if (previa[1] === n.house) return;   // dicen lo mismo: nada que hacer

        // El inbound pisa a la prealerta: la prealerta es lo que dijeron que
        // iba a llegar, el inbound es lo que llegó.
        if (origen === ORIGEN_INBOUND && previa[3] !== nombreDeOrigen(ORIGEN_INBOUND)) {
            conflictos.push({ guia: n.guia, viejo: previa[1], nuevo: n.house,
                              resuelto: "gana el inbound" });
            previa[1] = n.house;
            previa[2] = n.fecha || previa[2];
            previa[3] = nombreDeOrigen(origen);
            corregidas++;
            return;
        }

        // Mismo tipo de archivo, o una prealerta contra un inbound: se conserva
        // lo que estaba. Dos inbounds que se contradicen es un problema del
        // reporte, no algo que este módulo pueda resolver eligiendo.
        conflictos.push({ guia: n.guia, viejo: previa[1], nuevo: n.house,
                          resuelto: "se conservó la anterior" });
    });

    return { filas: filas, anadidas: anadidas, corregidas: corregidas,
             conflictos: conflictos };
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
        h.getRange(1, 1, 1, 4).setValues([["GUIA", "HOUSE", "FECHA", "ORIGEN"]]);
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
    // Se lee lo que haya, no cuatro columnas a ciegas: un índice creado antes
    // de que existiera la columna ORIGEN tiene tres, y pedir la cuarta
    // reventaría. Lo que falte se rellena vacío.
    let anchoReal = Math.max(1, Math.min(4, h.getLastColumn()));
    let filas = h.getRange(2, 1, lr - 1, anchoReal).getValues();
    if (anchoReal === 4) return filas;
    return filas.map(f => {
        let completa = f.slice();
        while (completa.length < 4) completa.push("");
        return completa;
    });
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

// La memoria de «esto ya lo importé» va por ID **y fecha de modificación**, no
// solo por ID.
//
// EL FALLO QUE ESTO EVITA: Drive conserva el mismo ID cuando se sube una
// versión nueva encima de un archivo. Y el inbound se actualiza a diario, casi
// siempre reemplazando el de ayer. Con la memoria por ID a secas, el primer
// inbound se importaba y todos los siguientes se saltaban en silencio: el
// índice se quedaría congelado en el día uno mientras la importación seguiría
// diciendo «no había archivos nuevos», que suena a que todo va bien.
function marcaDeArchivo(id, fechaMod) {
    let sello = "";
    if (fechaMod instanceof Date && !isNaN(fechaMod.getTime())) {
        sello = String(fechaMod.getTime());
    } else if (fechaMod !== undefined && fechaMod !== null) {
        sello = String(fechaMod);
    }
    return String(id) + "@" + sello;
}

// Olvida lo importado para que el próximo botón lea la carpeta entera otra vez.
// Reimportar es seguro —el índice no duplica y el inbound sigue mandando— así
// que esto solo cuesta tiempo, nunca datos.
function olvidarArchivosImportados() {
    const ss = obtenerArchivo();
    const ui = SpreadsheetApp.getUi();
    if (!exigirModoPrueba(ss)) return;
    PropertiesService.getScriptProperties().deleteProperty(PROP_ARCHIVOS_IMPORTADOS);
    ui.alert("🔁 Reimportar todo",
             "Listo. La próxima importación volverá a leer todos los CSV de la " +
             "carpeta.\n\nNo se pierde nada: las guías que ya estaban no se duplican.",
             ui.ButtonSet.OK);
}

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
    let nuevas = [], leidos = [], saltados = [], sinCabecera = [], sinTipo = [];
    let sinFecha = [], demasiadoGrandes = [];

    while (archivos.hasNext()) {
        let f = archivos.next();
        let marca = marcaDeArchivo(f.getId(), f.getLastUpdated());
        if (yaImportados.indexOf(marca) !== -1) continue;

        let nombre = f.getName();
        if (!/\.csv$/i.test(nombre)) {
            saltados.push(nombre);
            continue;
        }

        let texto = textoDeArchivo(f);
        if (excedeElLimite(texto.length)) {
            demasiadoGrandes.push(nombre + " (" + (texto.length / 1048576).toFixed(1) + " MB)");
            continue;
        }
        let primeraLinea = texto.split("\n")[0] || "";
        // Solo la cabecera para decidir columnas: no hace falta parsear el
        // archivo entero para saber dónde está cada cosa.
        let datos = Utilities.parseCsv(primeraLinea, separadorCsv(primeraLinea));
        let cols = detectarColumnasInbound(datos[0] || []);
        // Solo la HOUSE es imprescindible. Sin columna de guía se barren las
        // filas enteras buscando 1Z enterradas, que es el caso de la prealerta.
        if (cols.house === -1) {
            sinCabecera.push(nombre);
            continue;
        }

        // El nombre del archivo decide si es inbound o prealerta, y eso decide
        // quién gana un choque. No importa el orden en que Drive devuelva los
        // archivos: la regla la aplica la fusión, no el turno de lectura.
        let deEste = filasDeCsvCompleto(texto, cols, nombre);
        if (tipoDeOrigen(nombre) === ORIGEN_DESCONOCIDO) sinTipo.push(nombre);
        if (cols.fecha === -1) sinFecha.push(nombre);
        deEste.forEach(r => nuevas.push(r));
        leidos.push(marca);
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

    let msg = volcarAlIndice(ss, nuevas);

    PropertiesService.getScriptProperties()
        .setProperty(PROP_ARCHIVOS_IMPORTADOS,
                     yaImportados.concat(leidos).filter(x => x !== "").join(","));

    if (sinCabecera.length) {
        msg += "\n\n⚠️ Sin columnas reconocibles: " + sinCabecera.join(", ");
    }
    if (sinTipo.length) {
        msg += "\n\n⚠️ No sé si son inbound o prealerta (el nombre no lo dice):\n" +
               sinTipo.join(", ") + "\n\n" +
               "Se importaron igual, pero si chocan con otra house NO podrán ganar. " +
               "Ponle al archivo «INBOUND» o «PREALERTA» en el nombre.";
    }
    if (demasiadoGrandes.length) {
        msg += "\n\n❌ Demasiado grandes, NO se leyeron:\n" + demasiadoGrandes.join(", ") +
               "\n\n" + avisoDeTamano(MB_LIMITE * 1048576);
    }
    if (sinFecha.length) {
        msg += "\n\n" + AVISO_SIN_FECHA + "\n\nSin fecha: " + sinFecha.join(", ");
    }
    ui.alert("📥 Importar inbound", msg, ui.ButtonSet.OK);
}

// Fusiona, reparte entre caliente y frío, escribe, y devuelve el resumen.
// Lo comparten la importación desde Drive y la de OneDrive: el índice no sabe
// —ni le importa— de dónde salió el CSV.
function volcarAlIndice(ss, nuevas) {
    let fusion = fusionarEnIndice(leerIndice(ss, HOJA_INDICE_HOUSE)
                                  .concat(leerIndice(ss, HOJA_INDICE_HOUSE_FRIO)), nuevas);
    let particion = particionPorAntiguedad(fusion.filas, new Date(), DIAS_INDICE_CALIENTE);

    escribirIndice(ss, HOJA_INDICE_HOUSE, particion.calientes);
    escribirIndice(ss, HOJA_INDICE_HOUSE_FRIO, particion.frias);

    let embebidas = (nuevas || []).filter(n => n.embebida).length;
    let msg = "Guías leídas del archivo: " + (nuevas || []).length + "\n" +
              (embebidas ? "  · de ellas, " + embebidas + " venían dentro de un texto, " +
                           "no en su columna\n" : "") +
              "Guías nuevas en el índice: " + fusion.anadidas + "\n" +
              "Houses corregidas por el inbound: " + fusion.corregidas + "\n" +
              "Índice caliente (últimos " + DIAS_INDICE_CALIENTE + " días): " +
              particion.calientes.length + "\n" +
              "Archivo frío: " + particion.frias.length;
    if (fusion.conflictos.length) {
        msg += "\n\n⚠️ " + fusion.conflictos.length + " guías con DOS houses distintas:\n" +
               fusion.conflictos.slice(0, 8)
                   .map(c => "  " + c.guia + ": " + c.viejo + " → " + c.nuevo +
                             "  (" + c.resuelto + ")").join("\n");
        if (fusion.conflictos.length > 8) {
            msg += "\n  …y " + (fusion.conflictos.length - 8) + " más.";
        }
        msg += "\n\nLas que dicen «se conservó la anterior» son las que hay que " +
               "revisar a mano: los dos archivos se contradicen y ninguno manda " +
               "sobre el otro.";
    }
    return msg;
}

function escribirIndice(ss, nombre, filas) {
    let h = hojaIndice(ss, nombre, true);
    // Un índice creado antes de que existiera la columna ORIGEN tiene tres
    // columnas, y escribir cuatro en él reventaría.
    if (h.getMaxColumns() < 4) h.insertColumnsAfter(h.getMaxColumns(), 4 - h.getMaxColumns());
    h.getRange(1, 1, 1, 4).setValues([["GUIA", "HOUSE", "FECHA", "ORIGEN"]]);
    let lr = h.getLastRow();
    if (lr > 1) h.getRange(2, 1, lr - 1, 4).clearContent();
    if (filas.length === 0) return;
    asegurarFilas(h, filas.length + 1);
    // Por tramos: un índice de cientos de miles de filas no cabe en un solo
    // setValues.
    for (let i = 0; i < filas.length; i += FILAS_POR_ESCRITURA) {
        let tramo = filas.slice(i, i + FILAS_POR_ESCRITURA);
        h.getRange(2 + i, 1, tramo.length, 4).setValues(tramo);
    }
}

// -------------------------------------------------------------------------
// IMPORTAR DESDE ONEDRIVE
//
// Apps Script no habla OneDrive de forma nativa y `UrlFetchApp` va ANÓNIMO: no
// lleva ninguna identidad de Microsoft. Eso obliga a que el vínculo sea de
// «cualquiera con el vínculo», que es lectura pública. Con «gente de la
// organización» o «personas concretas», Microsoft devuelve una página de inicio
// de sesión en vez del archivo.
//
// «Puede ver» basta para el script —solo lee, nunca escribe— pero no protege
// nada: quien tenga la URL se descarga el archivo. Si se usa este camino, que
// el CSV lleve solo 1Z y HOUSE.
// -------------------------------------------------------------------------

// OneDrive tiene DOS formas de vínculo y no se descargan igual. Meterlas en el
// mismo saco es lo que hace que «el vínculo es correcto» y «no jala» sean
// verdad a la vez.
//
//   Empresarial (SharePoint):  ...sharepoint.com/:x:/g/...   -> &download=1
//   Personal (1drv.ms):        1drv.ms / onedrive.live.com   -> API de shares
//
// En el personal, `download=1` devuelve la página del visor, no el archivo.
function esVinculoPersonal(url) {
    let u = String(url === undefined || url === null ? "" : url).toLowerCase();
    return u.indexOf("1drv.ms") !== -1 || u.indexOf("onedrive.live.com") !== -1;
}

// El vínculo se codifica en base64 «url-safe» y se pide por la API pública de
// compartidos, que sí entrega el contenido.
function urlApiCompartido(b64) {
    return "https://api.onedrive.com/v1.0/shares/u!" + b64 + "/root/content";
}

function base64DeVinculo(url) {
    return Utilities.base64Encode(String(url))
        .replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
}

// Los vínculos de SharePoint llevan escrito a qué apuntan, y saberlo antes de
// descargar ahorra el viaje entero:
//
//   /:x:/  libro de Excel      /:w:/  Word      /:p:/  PowerPoint
//   /:f:/  CARPETA             /:t:/  texto     /:b:/  cualquier otro
//
// Compartir el libro de Excel es lo natural —es el archivo con el que se
// trabaja— pero es justo lo que no sirve: hay que compartir el CSV exportado.
function queApuntaElVinculo(url) {
    let u = String(url === undefined || url === null ? "" : url).toLowerCase();
    if (u.indexOf("/:x:/") !== -1) return "excel";
    if (u.indexOf("/:f:/") !== -1) return "carpeta";
    if (u.indexOf("/:w:/") !== -1) return "word";
    if (u.indexOf("/:p:/") !== -1) return "powerpoint";
    if (u.indexOf("/:t:/") !== -1 || u.indexOf("/:b:/") !== -1) return "archivo";
    return "";
}

function avisoDelTipoDeVinculo(url) {
    let tipo = queApuntaElVinculo(url);
    if (tipo === "excel") {
        return "⚠️ Este vínculo apunta a un LIBRO DE EXCEL (la marca «/:x:/» de la " +
               "URL lo dice). Aunque la descarga funcionara, llegaría el binario de " +
               "Excel y no se puede leer. Exporta a CSV y comparte el vínculo del CSV.";
    }
    if (tipo === "carpeta") {
        return "⚠️ Este vínculo apunta a una CARPETA (la marca «/:f:/»), no a un " +
               "archivo. Comparte el CSV concreto.";
    }
    if (tipo === "word" || tipo === "powerpoint") {
        return "⚠️ Este vínculo no apunta a una hoja de cálculo ni a un CSV.";
    }
    return "";
}

// El segundo intento para SharePoint, cuando `download=1` devuelve la página
// puente en vez del archivo.
//
// Un vínculo de compartir tiene esta forma:
//   https://TENANT/:t:/g/personal/USUARIO/TOKEN?e=xxx
// y SharePoint también sirve el mismo archivo por la ruta de descarga directa:
//   https://TENANT/personal/USUARIO/_layouts/15/download.aspx?share=TOKEN
//
// Esa segunda no pasa por el visor web, que es lo que mete el rodeo de la
// cookie y el JavaScript. Devuelve "" si la URL no tiene esta forma.
function urlDescargaAlternativa(url) {
    let u = String(url === undefined || url === null ? "" : url).trim();
    let m = u.match(/^(https?:\/\/[^/]+)\/:[a-z]:\/[a-z]+\/(personal\/[^/]+)\/([^/?#]+)/i);
    if (!m) return "";
    return m[1] + "/" + m[2] + "/_layouts/15/download.aspx?share=" + m[3];
}

function urlDescargaOneDrive(url) {
    let u = String(url === undefined || url === null ? "" : url).trim();
    if (u === "") return "";
    if (esVinculoPersonal(u)) return urlApiCompartido(base64DeVinculo(u));
    if (/[?&]download=1/.test(u)) return u;
    return u + (u.indexOf("?") === -1 ? "?download=1" : "&download=1");
}

// LA PROTECCIÓN QUE NO PUEDE FALTAR: si el vínculo no es público, Microsoft
// responde 200 con una página de inicio de sesión. Sin comprobarlo, esa página
// entraría a `parseCsv` y la importación diría «0 guías nuevas» tan tranquila,
// como si la base estuviera vacía. Un fallo que no se nota es peor que uno que
// revienta.
function pareceLoginHtml(texto) {
    let t = String(texto === undefined || texto === null ? "" : texto).trim();
    if (t === "") return false;
    if (t.charAt(0) === "<") return true;
    let cabeza = t.substring(0, 1000).toUpperCase();
    return cabeza.indexOf("<!DOCTYPE") !== -1 || cabeza.indexOf("<HTML") !== -1;
}

// Un .xlsx es un ZIP: empieza por «PK». Un .xls viejo empieza por la firma OLE.
//
// Este es el caso que se pasa por alto: al compartir, lo natural es compartir
// EL LIBRO DE EXCEL, no un CSV. Entonces baja un binario, `parseCsv` lo
// convierte en basura y el error que sale es «no reconozco sus columnas» —que
// manda a buscar el problema en las cabeceras, donde no está—. Decir «esto es
// un Excel, exporta a CSV» ahorra la tarde entera.
function pareceExcelBinario(texto) {
    let t = String(texto === undefined || texto === null ? "" : texto);
    if (t.length < 2) return false;
    if (t.charAt(0) === "P" && t.charAt(1) === "K") return true;       // .xlsx (zip)
    return t.charCodeAt(0) === 0xD0 && t.charCodeAt(1) === 0xCF;       // .xls (OLE)
}

// Clasifica lo que llegó ANTES de intentar interpretarlo. Cada respuesta lleva
// a un consejo distinto, y ese es el punto: «no jala» no se puede arreglar,
// «esto es un Excel» sí.
function clasificarDescarga(texto) {
    let t = String(texto === undefined || texto === null ? "" : texto);
    if (t.trim() === "") return "vacio";
    if (pareceExcelBinario(t)) return "excel";
    if (pareceLoginHtml(t)) return "html";
    return "csv";
}

// Baja el archivo probando los dos caminos. Devuelve lo que consiga y por dónde
// lo consiguió, para que el diagnóstico pueda decirlo.
function bajarDeOneDrive(url) {
    let intentos = [{ via: "download=1", url: urlDescargaOneDrive(url) }];
    let alterna = urlDescargaAlternativa(url);
    if (alterna) intentos.push({ via: "download.aspx", url: alterna });

    let ultimo = null;
    for (let i = 0; i < intentos.length; i++) {
        let r;
        try {
            r = UrlFetchApp.fetch(intentos[i].url,
                                  { muteHttpExceptions: true, followRedirects: true });
        } catch (err) {
            ultimo = { via: intentos[i].via, url: intentos[i].url, error: String(err) };
            continue;
        }
        let texto = "";
        try { texto = normalizarSaltos(r.getContentText()); } catch (err) { texto = ""; }
        let cabeceras = r.getAllHeaders() || {};
        let res = {
            via: intentos[i].via,
            url: intentos[i].url,
            codigo: r.getResponseCode(),
            tipo: cabeceras['Content-Type'] || cabeceras['content-type'] || "(sin tipo)",
            texto: texto,
            clase: clasificarDescarga(texto)
        };
        if (res.codigo === 200 && res.clase === "csv") return res;   // servido
        ultimo = res;
    }
    return ultimo;
}

function explicarDescargaMala(clase) {
    if (clase === "excel") {
        return "Lo que bajó es un LIBRO DE EXCEL, no un CSV.\n\n" +
               "El vínculo apunta al .xlsx. Apps Script no puede leerlo: por dentro " +
               "es un archivo comprimido, no texto.\n\n" +
               "En Excel: Archivo → Guardar como → CSV UTF-8, sube ESE a OneDrive y " +
               "comparte el vínculo del CSV.\n\nNo se importó nada.";
    }
    if (clase === "html") {
        return "Lo que llegó es una página web, no un archivo.\n\n" +
               "Casi siempre es la de inicio de sesión: el script entra ANÓNIMO, sin " +
               "cuenta de Microsoft. También pasa si el vínculo apunta a una CARPETA " +
               "en vez de a un archivo, o si caducó.\n\n" +
               "Usa «Probar el vínculo» para ver qué respondió Microsoft.\n\n" +
               "No se importó nada.";
    }
    return "El archivo llegó vacío.\n\nRevisa que el vínculo apunte al archivo bueno " +
           "y que no esté vacío en OneDrive.\n\nNo se importó nada.";
}

// El diagnóstico: dice EXACTAMENTE qué respondió Microsoft en vez de dejarte
// adivinando. Es lo que convierte un «no jala» en algo que se puede arreglar.
function probarVinculoOneDrive() {
    const ss = obtenerArchivo();
    const ui = SpreadsheetApp.getUi();
    if (!exigirModoPrueba(ss)) return;

    let url = PropertiesService.getScriptProperties().getProperty(PROP_URL_ONEDRIVE);
    if (!url) {
        ui.alert("🔎 Probar el vínculo", "No hay vínculo guardado.", ui.ButtonSet.OK);
        return;
    }

    // El aviso del tipo va ANTES de descargar: si el vínculo apunta a un libro
    // de Excel o a una carpeta, el viaje sobra.
    let avisoTipo = avisoDelTipoDeVinculo(url);
    let r = bajarDeOneDrive(url);
    if (!r) {
        ui.alert("🔎 Probar el vínculo", "No se pudo intentar la descarga.", ui.ButtonSet.OK);
        return;
    }
    if (r.error) {
        ui.alert("🔎 Probar el vínculo",
                 "URL usada:\n" + r.url + "\n\nNi siquiera se pudo conectar:\n\n" + r.error,
                 ui.ButtonSet.OK);
        return;
    }

    let muestra = r.texto.substring(0, 200).replace(/[\r\n]+/g, " ⏎ ");
    ui.alert("🔎 Probar el vínculo",
        (avisoTipo ? avisoTipo + "\n\n" : "") +
        "Camino usado: " + r.via + "\n" +
        "URL usada:\n" + r.url + "\n\n" +
        "Código HTTP: " + r.codigo + "\n" +
        "Tipo de contenido: " + r.tipo + "\n" +
        "Tamaño: " + r.texto.length + " caracteres\n" +
        "Lo que parece ser: " + r.clase.toUpperCase() + "\n\n" +
        "Primeros 200 caracteres:\n" + (muestra || "(nada)") + "\n\n" +
        (r.clase === "csv"
            ? (excedeElLimite(r.texto.length)
                ? "❌ " + avisoDeTamano(r.texto.length)
                : (avisoDeTamano(r.texto.length) ? "⚠️ " + avisoDeTamano(r.texto.length) + "\n\n" : "") +
                  (cabecerasGenericas(Utilities.parseCsv(
                        r.texto.split(/\n/).slice(0, 2).join("\n"),
                        separadorCsv(r.texto.split(/\n/)[0] || ""))[0])
                    ? "❌ Las cabeceras son genéricas («Column1, Column2…»): el CSV salió " +
                      "de Power Query sin promover los encabezados. La primera fila tiene " +
                      "que decir GUIA y HOUSE."
                    : "✅ Esto sí se puede importar."))
            : "❌ " + explicarDescargaMala(r.clase)),
        ui.ButtonSet.OK);
}

function configurarUrlOneDrive() {
    const ss = obtenerArchivo();
    const ui = SpreadsheetApp.getUi();
    if (!exigirModoPrueba(ss)) return;

    let actual = PropertiesService.getScriptProperties().getProperty(PROP_URL_ONEDRIVE);
    let r = ui.prompt("🔗 Vínculo de OneDrive",
        "Pega el vínculo para compartir del CSV.\n\n" +
        "Tiene que ser de «Cualquiera con el vínculo» — con «puede ver» basta.\n" +
        "Si lo restringes a tu organización, el script recibe una página de " +
        "inicio de sesión en vez del archivo.\n\n" +
        "⚠️ Ese vínculo es la llave del archivo: que el CSV lleve solo 1Z y HOUSE.\n\n" +
        (actual ? "Ahora mismo hay uno guardado. Deja vacío para borrarlo." : ""),
        ui.ButtonSet.OK_CANCEL);
    if (r.getSelectedButton() !== ui.Button.OK) return;

    let url = r.getResponseText().trim();
    if (url === "") {
        PropertiesService.getScriptProperties().deleteProperty(PROP_URL_ONEDRIVE);
        ui.alert("🔗 Vínculo", "Borrado.", ui.ButtonSet.OK);
        return;
    }
    PropertiesService.getScriptProperties().setProperty(PROP_URL_ONEDRIVE, url);
    ui.alert("🔗 Vínculo", "Guardado en las propiedades del script, fuera del código.",
             ui.ButtonSet.OK);
}

function importarInboundDesdeOneDrive() {
    const ss = obtenerArchivo();
    const ui = SpreadsheetApp.getUi();
    if (!exigirModoPrueba(ss)) return;

    let url = PropertiesService.getScriptProperties().getProperty(PROP_URL_ONEDRIVE);
    if (!url) {
        ui.alert("☁️ OneDrive", "No hay vínculo guardado.\n\nUsa «Configurar vínculo de " +
                 "OneDrive» primero.", ui.ButtonSet.OK);
        return;
    }

    let r = bajarDeOneDrive(url);
    if (!r || r.error) {
        ui.alert("☁️ OneDrive", "No se pudo descargar:\n\n" +
                 ((r && r.error) || "sin respuesta"), ui.ButtonSet.OK);
        return;
    }
    if (r.codigo !== 200) {
        ui.alert("☁️ OneDrive", "Microsoft respondió " + r.codigo +
                 ".\n\nRevisa que el vínculo siga vivo.", ui.ButtonSet.OK);
        return;
    }
    if (r.clase !== "csv") {
        ui.alert("☁️ OneDrive",
                 explicarDescargaMala(r.clase) + "\n\n" +
                 (avisoDelTipoDeVinculo(url) || "") +
                 "\n\nUsa «Probar el vínculo» para ver el detalle.", ui.ButtonSet.OK);
        return;
    }
    let texto = r.texto;

    // El tamaño se mira ANTES de parsear: si no va a caber, decirlo ahora vale
    // mucho más que un error de tiempo agotado dentro de seis minutos.
    if (excedeElLimite(texto.length)) {
        ui.alert("☁️ OneDrive", avisoDeTamano(texto.length), ui.ButtonSet.OK);
        return;
    }

    let primeraLinea = texto.split("\n")[0] || "";
    let datos = Utilities.parseCsv(primeraLinea, separadorCsv(primeraLinea));
    let cols = detectarColumnasInbound(datos[0] || []);
    if (cols.house === -1) {
        ui.alert("☁️ OneDrive",
                 (cabecerasGenericas(datos[0]) ?
                    "El CSV salió de Power Query SIN promover los encabezados: la " +
                    "primera fila dice «Column1, Column2, Column3…» en vez de los " +
                    "nombres reales.\n\nEn Power Query, «Usar la primera fila como " +
                    "encabezado», y vuelve a exportar.\n\n"
                  : "El archivo llegó bien, pero no encuentro la columna de la HOUSE.\n\n") +
                 "Cabeceras encontradas: " + (datos[0] || []).slice(0, 12).join(" | ") + "\n\n" +
                 "Necesito una que se llame HOUSE, HAWB, HBL o CASA. La de la guía es " +
                 "opcional: si no está, busco las 1Z dentro del texto de cada fila.",
                 ui.ButtonSet.OK);
        return;
    }

    // El tipo se saca de la propia URL, que suele llevar el nombre del archivo.
    // Si no se reconoce, esas houses no podrán ganar un choque: es preferible a
    // dejar que una prealerta pise a un inbound por accidente.
    let resumen = volcarAlIndice(ss, filasDeCsvCompleto(texto, cols, url));
    if (cols.fecha === -1) resumen += "\n\n" + AVISO_SIN_FECHA;
    if (tipoDeOrigen(url) === ORIGEN_DESCONOCIDO) {
        resumen += "\n\n⚠️ No sé si este archivo es inbound o prealerta: la URL no lo " +
                   "dice. Sus houses no podrán corregir a otras si chocan.";
    }
    ui.alert("☁️ OneDrive", resumen, ui.ButtonSet.OK);
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
