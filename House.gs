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
// Columna C, pegada al estado de la B.
//
// No es capricho: el escaneo YA escribe la B, y escribir B y C juntas es la
// MISMA llamada. Ponerla en la D costaría una llamada más en cada escaneo
// —entre 50 y 250 ms sobre los ~500 que tarda— solo para adelantar un dato que
// no decide nada en ese instante. Pegada a la B sale gratis.
//
// La columna C es ENTERA para la house: los totales se mudaron a D1:D3.
//
// Con los totales en la C, una guía escaneada en la fila 2 o 3 no habría
// recibido house nunca —la guardia que protegía los totales la habría saltado—
// y en silencio, que es la peor forma de perder un dato.
const COL_HOUSE = 3;
const FILA_MIN_HOUSE = 1;

// La house de la guía de la PREFORMA (columna O) va en la R.
//
// La O tiene sus propias guías y también necesitan house: en una Global la A es
// lo que llegó físicamente y la O es lo que decía la preforma. Una sola columna
// de house no puede servir a las dos, o la de la O pisaría a la de la A en las
// filas donde ambas tienen guía.
//
// La R está libre, cae justo después del estado de la preforma (P) y antes de
// su hora (S), y sigue dentro de las columnas 1-19 que lee el recorte del
// cierre antes de borrar filas: así una fila con house nunca se borra.
// Lo mismo por el lado de la preforma: la Q entera, con sus totales mudados
// a R1:R2.
const COL_HOUSE_PREFORMA = 17;
const FILA_MIN_HOUSE_PREFORMA = 1;

// Qué pares (guía → house) tiene una pestaña. Las M-S no llevan preforma, así
// que solo tienen el par de la A. Es el mismo criterio con el que se decide si
// una hoja recibe validación en la O y si el caché le reserva columna: si un
// día cambia, tiene que cambiar en un solo sitio.
function paresDeHouse(nombreHoja, maxColumnas) {
    let pares = [{ guia: 1, house: COL_HOUSE, desde: FILA_MIN_HOUSE }];
    if (usaPreforma(claveHoja(nombreHoja)) && maxColumnas >= 15) {
        pares.push({ guia: 15, house: COL_HOUSE_PREFORMA,
                     desde: FILA_MIN_HOUSE_PREFORMA });
    }
    return pares;
}

// ¿Se puede tocar la house de esta fila? Hoy siempre sí: los totales se
// mudaron a la D y la R, así que la C y la Q son enteras para la house. La
// guardia se queda por si algún día vuelve a haber algo intocable arriba.
function filaAdmiteHouse(par, fila) {
    return fila >= ((par && par.desde) ? par.desde : FILA_MIN_HOUSE);
}

// Hasta qué columna hay que leer para cubrir todos los pares. Una sola lectura
// por hoja, no una por par: en este archivo lo que cuesta es el NÚMERO de
// llamadas, no cuántas celdas trae cada una.
function anchoParaHouses(pares) {
    return (pares || []).reduce((m, p) => Math.max(m, p.guia, p.house), 1);
}

function colHousePreforma() { return COL_HOUSE_PREFORMA; }

// Cuántos días de prealerta se quedan en el índice caliente. Una guía que se
// escanea hoy se prealertó hace días o semanas, no hace dos años: el 99 % de
// las búsquedas caen aquí, y cargar el archivo entero cada minuto sería pagar
// decenas de segundos para encontrar algo que estaba en los primeros renglones.
const DIAS_INDICE_CALIENTE = 90;

// Marca de «buscada y no está». Sin ella, una guía que no aparece en el índice
// se reintentaría cada cinco minutos para siempre, y basta UNA guía marcada
// para que cada pasada automática cargue el índice entero —cientos de miles de
// filas— solo para volver a no encontrarla.
//
// Por eso las marcadas SOLO se reintentan en la pasada A MANO, la del botón
// «Poner AHORA las houses que faltan». Que es justo cuando tiene sentido: se
// aprieta después de haber metido las houses que faltaban al índice, y así el
// aviso de «sin house» de la columna B se quita solo sin acordarse de nada más.
const TXT_HOUSE_SIN_DATO = "—";

const PROP_ARCHIVOS_IMPORTADOS = 'HOUSE_ARCHIVOS_IMPORTADOS';

// La URL de OneDrive vive aquí, NO en el código. Este proyecto está en un
// repositorio de git: una URL pegada en el archivo queda en el historial para
// siempre, aunque después se borre de la línea. Y esa URL es, por sí sola, la
// llave del archivo.
const PROP_URL_ONEDRIVE = 'HOUSE_URL_ONEDRIVE';

// -------------------------------------------------------------------------
// EL ÍNDICE VIVE EN SU PROPIO ARCHIVO
//
// Medido en este proyecto: el peso del archivo fija el precio de CADA ida y
// vuelta a la API. Se vio pasar de 87 ms a 53 ms según el archivo adelgazaba, y
// un escaneo hace catorce llamadas.
//
// Un índice de cien mil filas dentro del archivo de operación encarecería TODOS
// los escaneos —medio segundo por escaneo, todo el día— que es exactamente lo
// contrario de lo que este módulo promete. Y el daño no se vería venir: no
// habría ningún error, solo un sistema que se va poniendo lento sin motivo
// aparente, semanas después de tocar nada.
//
// Por eso el índice va en un archivo aparte. Al disparador le da igual pagar
// una apertura más: no está en el camino crítico del escaneo. Al operador no.
const PROP_ID_INDICE = 'HOUSE_ID_ARCHIVO_INDICE';
const NOMBRE_ARCHIVO_INDICE = "WMS · Índice de houses";

// Interruptor explícito para producción. El nombre «PRUEBA» sigue valiendo para
// las copias, pero en el archivo real hay que encenderlo a mano: que un módulo
// empiece a escribir en la columna D de siete operadores tiene que ser una
// decisión consciente, no el efecto de haber pegado un archivo.
// La marca de «encendido» es una PESTAÑA OCULTA, no una propiedad del script.
//
// `onOpen` es un disparador simple y corre sin autorización: hay servicios que
// ahí no están disponibles. Si el menú preguntara por una propiedad del script,
// podría reventar al abrir el archivo —y con él TODO el menú, no solo el
// submenú de houses—. Mirar si existe una pestaña sí funciona siempre.
//
// Además así la marca viaja con el archivo: si alguien duplica la hoja, la
// copia sabe cómo estaba, sin depender de propiedades que no se copian.
const HOJA_MARCA_ACTIVO = "HOUSE_ACTIVO";

// -------------------------------------------------------------------------
// EL PRESUPUESTO DEL DISPARADOR
//
// Google limita el TIEMPO TOTAL de disparadores por cuenta al día. Cuando se
// agota, desactiva los disparadores de la cuenta — incluido el del escaneo. El
// síntoma es demoledor y no señala a su causa: la guía entra en la columna A
// porque la teclea el escáner, y no la procesa nadie.
//
// Cada minuto recorriendo todas las pestañas son ~30 llamadas por vuelta; a
// 150-250 ms cada una en este archivo, entre 2 y 4 HORAS de ejecución al día.
// Eso se come la cuota antes de comer.
//
// Tres frenos, y ninguno le quita utilidad al módulo: la house es dato de
// reporte, que aparezca en cinco minutos en vez de en uno no le importa a
// nadie.
const MINUTOS_ENTRE_RELLENOS = 5;

// El relleno respeta SU PROPIO intervalo aunque lo llame otro disparador.
//
// Asi el actualizador automático puede invitarlo en cada vuelta sin que eso
// obligue a rellenar cada vez: si mañana el actualizador pasa a correr cada
// minuto, las houses siguen yendo a su ritmo. Y para espaciarlas mas basta con
// subir MINUTOS_ENTRE_RELLENOS, sin tocar ningun disparador.
const PROP_TS_RELLENO = 'HOUSE_TS_ULTIMO_RELLENO';

function tocaRellenar(ahora, ultimo, minutos) {
    if (!ultimo) return true;
    return (ahora - ultimo) / 60000 >= (minutos || MINUTOS_ENTRE_RELLENOS);
}

// Solo se mira la COLA de cada hoja. Las houses de arriba ya están puestas: lo
// que acaba de escanearse está abajo, siempre.
const FILAS_A_MIRAR = 500;

// Si una pasada se alarga, se corta y sigue en la siguiente. Más vale rellenar
// la mitad cada vez que agotar la cuota y tumbar el escaneo.
const SEGUNDOS_MAX_RELLENO = 30;

function minutosEntreRellenos() { return MINUTOS_ENTRE_RELLENOS; }
function filasAMirar() { return FILAS_A_MIRAR; }

// Desde qué fila conviene leer una hoja: solo la cola.
function desdeQueFilaMirar(ultimaFila, cuantas) {
    let tramo = cuantas || FILAS_A_MIRAR;
    if (!ultimaFila || ultimaFila < 1) return 1;
    return Math.max(1, ultimaFila - tramo + 1);
}

// ¿A qué pestañas les toca la house? A todas las de operación: las de escaneo,
// los inventarios Y LAS M-S.
//
// Las M-S se quedaban fuera sin querer. Las tres funciones que rellenan
// repetían el mismo criterio a mano —`esHojaPrincipal(x) || esHojaInventario(x)`—
// y `esHojaPrincipal` devuelve false para una M-S por diseño, porque una M-S no
// es una hoja de destino. Ese criterio servía para el caché, no para esto: la
// house es dato de reporte y hace tanta falta en una M-S como en una Global.
//
// Va en UNA función y no en tres copias. Tres sitios decidiendo lo mismo es lo
// que dejó fuera a las M-S sin que nadie lo notara.
function hojaLlevaHouse(nombreHoja) {
    let n = claveHoja(nombreHoja);
    if (esHojaSistema(n)) return false;   // caché, historial, MACHO, plantillas, índice
    return esHojaPrincipal(n) || esHojaInventario(n) || esHojaMS(n);
}

function colHouse() { return COL_HOUSE; }
function textoHouseSinDato() { return TXT_HOUSE_SIN_DATO; }
function diasIndiceCaliente() { return DIAS_INDICE_CALIENTE; }

// -------------------------------------------------------------------------
// EL SEGURO
// -------------------------------------------------------------------------
function esArchivoDePrueba(nombreArchivo) {
    return String(nombreArchivo).trim().toUpperCase().indexOf(MARCA_PRUEBA) !== -1;
}

// El módulo está vivo si el archivo es una copia de pruebas O si alguien lo
// encendió a mano en este archivo.
function moduloActivo(ss) {
    try {
        if (esArchivoDePrueba(ss.getName())) return true;
        return ss.getSheetByName(HOJA_MARCA_ACTIVO) !== null;
    } catch (err) {
        // Ante la duda, apagado. Nunca reventar: quien pregunta puede ser el
        // menú, y el menú lo necesitan siete personas todos los días.
        return false;
    }
}

// Devuelve true si se puede seguir. Si no, avisa y corta.
function exigirModoPrueba(ss) {
    if (moduloActivo(ss)) return true;
    SpreadsheetApp.getUi().alert(
        "🧪 Módulo apagado",
        "El índice de houses está apagado en este archivo.\n\n" +
        "Se enciende solo en copias cuyo nombre lleve PRUEBA. Para usarlo en el " +
        "archivo real, entra en «Activar en este archivo» y léete el aviso.\n\n" +
        "Así ninguna prueba puede tocar la operación por accidente.",
        SpreadsheetApp.getUi().ButtonSet.OK);
    return false;
}

// -------------------------------------------------------------------------
// ENCENDER Y APAGAR EN PRODUCCIÓN
// -------------------------------------------------------------------------
function activarHousesEnEsteArchivo() {
    const ss = obtenerArchivo();
    const ui = SpreadsheetApp.getUi();

    if (esArchivoDePrueba(ss.getName())) {
        ui.alert("🏠 Houses", "Este archivo ya lleva PRUEBA en el nombre: el módulo está " +
                 "encendido siempre aquí.", ui.ButtonSet.OK);
        return;
    }

    let r = ui.alert("🏠 Activar el índice de houses",
        "Vas a encenderlo en «" + ss.getName() + "», que es el archivo con el que " +
        "trabajan los operadores.\n\n" +
        "A partir de ahora:\n" +
        "· El disparador escribirá en la COLUMNA D de las hojas de escaneo.\n" +
        "· Solo escribe en celdas VACÍAS de esa columna.\n\n" +
        "Antes de aceptar, comprueba que la columna D no lleva nada tuyo en " +
        "ninguna pestaña. ¿Sigo?",
        ui.ButtonSet.YES_NO);
    if (r !== ui.Button.YES) return;

    if (!ss.getSheetByName(HOJA_MARCA_ACTIVO)) {
        let marca = ss.insertSheet(HOJA_MARCA_ACTIVO);
        marca.getRange(1, 1).setValue(
            "Esta pestaña es la marca de que el índice de houses está ENCENDIDO en " +
            "este archivo. Borrarla lo apaga. No escribas nada más aquí.");
        marca.hideSheet();
    }
    ui.alert("🏠 Houses", "Encendido.\n\nRecarga la hoja para que aparezca el menú " +
             "completo, y no olvides crear el archivo del índice si aún no lo hiciste.",
             ui.ButtonSet.OK);
}

function desactivarHousesEnEsteArchivo() {
    const ss = obtenerArchivo();
    const ui = SpreadsheetApp.getUi();
    let marca = ss.getSheetByName(HOJA_MARCA_ACTIVO);
    if (marca) ss.deleteSheet(marca);
    quitarTriggerHouse(true);
    ui.alert("🏠 Houses", "Apagado, y el disparador quitado.\n\nLo que ya está escrito " +
             "en la columna D se queda: apagar no borra nada.", ui.ButtonSet.OK);
}

// -------------------------------------------------------------------------
// EL ARCHIVO DEL ÍNDICE
// -------------------------------------------------------------------------

// Devuelve el archivo donde vive el índice. Si no se ha creado uno aparte,
// cae en el archivo actual: sigue funcionando, pero engorda el de operación.
function archivoDelIndice() {
    let id = PropertiesService.getScriptProperties().getProperty(PROP_ID_INDICE);
    if (id) {
        try { return SpreadsheetApp.openById(id); } catch (err) { /* borrado o sin acceso */ }
    }
    return obtenerArchivo();
}

function indiceEstaAparte() {
    let id = PropertiesService.getScriptProperties().getProperty(PROP_ID_INDICE);
    if (!id) return false;
    try { SpreadsheetApp.openById(id); return true; } catch (err) { return false; }
}

function crearArchivoDelIndice() {
    const ss = obtenerArchivo();
    const ui = SpreadsheetApp.getUi();
    if (!exigirModoPrueba(ss)) return;

    if (indiceEstaAparte()) {
        let r = ui.alert("📇 Archivo del índice",
            "Ya hay uno:\n" + archivoDelIndice().getUrl() + "\n\n¿Crear otro nuevo? " +
            "El índice actual se quedaría huérfano y habría que reimportar.",
            ui.ButtonSet.YES_NO);
        if (r !== ui.Button.YES) return;
    }

    let nuevo = SpreadsheetApp.create(NOMBRE_ARCHIVO_INDICE);
    PropertiesService.getScriptProperties().setProperty(PROP_ID_INDICE, nuevo.getId());
    ui.alert("📇 Archivo del índice",
        "Creado:\n" + nuevo.getUrl() + "\n\n" +
        "El índice vive ahí y NO engorda el archivo de operación, que es lo que " +
        "encarecería cada escaneo.\n\nNo lo borres ni lo muevas fuera de tu Drive. " +
        "Ahora importa los CSV.", ui.ButtonSet.OK);
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
            "Google corta las descargas en 50 MB, así que este techo NO es cosa mía: " +
            "subir el umbral solo movería el fallo a un sitio peor.\n\n" +
            "Y lo que sobra aquí no son columnas, es HISTORIA. Filtra la consulta de " +
            "Power Query a los últimos 6 meses y exporta eso. Una guía que se escanea " +
            "hoy se prealertó hace días, no hace dos años, así que no pierdes ninguna " +
            "búsqueda real — y el archivo completo sigue en Excel para tus macros.";
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

const AVISO_SIN_PARTIR =
    "❌ No supe partir este archivo en columnas.\n\n" +
    "El separador no es coma, ni punto y coma, ni tabulador, así que cada " +
    "renglón entero cae en una sola celda. Si lo importara, la «house» de cada " +
    "guía sería el renglón completo —que es exactamente lo que corrompió el " +
    "índice—.\n\n" +
    "Vuelve a exportarlo desde Excel con «Guardar como → CSV (delimitado por " +
    "comas)».";

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
// ¿La cabecera se partió en columnas, o quedó entera en una sola celda?
//
// ESTE ES EL FALLO QUE CORROMPIÓ EL ÍNDICE. Si el separador real del archivo no
// es coma, punto y coma ni tabulador —un archivo separado por espacios, por
// ejemplo—, `separadorCsv` cae en la coma por descarte y `parseCsv` devuelve UNA
// columna con el renglón entero dentro. Y entonces pasa lo peor que podía pasar:
// esa única cabecera dice «Fecha Guia Guia corta», contiene la palabra «CORTA»,
// y `detectarColumnasInbound` la elige como columna de la house. A partir de ahí
// cada «house» es el renglón completo del CSV, y esas 18.610 houses inventadas
// pisaron a las buenas sin que nada avisara.
//
// Una cabecera de un solo campo NO es una cabecera: es un archivo que no se supo
// partir. Se rechaza el archivo entero, que es lo honesto —importar medio bien
// es peor que no importar—.
function cabeceraSinPartir(headers) {
    return (headers || []).length < 2;
}

function separadorCsv(primeraLinea) {
    let linea = String(primeraLinea);
    let comas = (linea.match(/,/g) || []).length;
    let puntoYComa = (linea.match(/;/g) || []).length;
    let tabs = (linea.match(/\t/g) || []).length;
    if (tabs > comas && tabs > puntoYComa) return "\t";
    return puntoYComa > comas ? ";" : ",";
}

function nombreDelSeparador(sep) {
    if (sep === "\t") return "tabulador";
    if (sep === ";") return "punto y coma";
    if (sep === ",") return "coma";
    return "«" + String(sep) + "»";
}

// Cuántos campos daría CADA separador candidato en esta línea.
//
// Es lo que convierte «no sé por qué lee mal el archivo» en «este archivo no
// tiene ni una coma». Si los tres devuelven 1, no hay separador que valga y el
// archivo no se puede partir: eso hay que verlo de un vistazo, no deducirlo.
function conteoDeSeparadores(linea) {
    let l = String(linea === undefined || linea === null ? "" : linea);
    return {
        coma: (l.match(/,/g) || []).length + 1,
        puntoYComa: (l.match(/;/g) || []).length + 1,
        tabulador: (l.match(/\t/g) || []).length + 1
    };
}

// El renglón del diagnóstico: qué separador se eligió, cuántos campos da, y qué
// daría cada uno de los otros.
function diagnosticoDelSeparador(linea) {
    let c = conteoDeSeparadores(linea);
    let sep = separadorCsv(linea);
    let elegido = sep === "\t" ? c.tabulador : (sep === ";" ? c.puntoYComa : c.coma);
    let texto = "Separador: " + nombreDelSeparador(sep) + " → " + elegido + " campo" +
                (elegido === 1 ? "" : "s") + "\n" +
                "  (con coma: " + c.coma + " · con punto y coma: " + c.puntoYComa +
                " · con tabulador: " + c.tabulador + ")";
    if (elegido < 2) {
        texto += "\n  ❌ NINGÚN separador parte este archivo. Por eso el renglón " +
                 "entero acaba dentro de una sola celda.";
    }
    return { sep: sep, campos: elegido, texto: texto };
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

    // LA TRAMPA DE EXCEL: si la celda no está formateada como fecha, el CSV no
    // lleva «27/08/2026» sino «46261» —los días transcurridos desde el
    // 30/12/1899—. Sin entenderlo, esa fila contaría como «sin fecha», se
    // quedaría en el índice caliente Y NO LO DIRÍA. Basta con que una persona
    // toque el formato de una columna para que el reparto caliente/frío deje de
    // funcionar en silencio.
    //
    // El rango acota el riesgo: de 1970 a 2079. Un número de cinco cifras que
    // no sea una fecha (un peso, un consecutivo) queda fuera por arriba o por
    // abajo en la mayoría de los casos, y equivocarse aquí solo mueve una fila
    // entre caliente y frío, nunca cambia una house.
    if (/^\d+([.,]\d+)?$/.test(s)) {
        let serie = Math.floor(Number(s.replace(",", ".")));
        if (serie >= 25569 && serie <= 65000) {
            return new Date(Date.UTC(1899, 11, 30) + serie * 86400000);
        }
    }

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
// Cuántas houses se descartaron en la última lectura por no parecer houses.
let globalHousesDescartadas = 0;
function housesDescartadas() { return globalHousesDescartadas; }
function reiniciarHousesDescartadas() { globalHousesDescartadas = 0; }

function filasDeInbound(datos, cols, origen) {
    let salida = [];
    let descartadas = 0;
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
        if (houseSospechosa(house)) { descartadas++; continue; }
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
    globalHousesDescartadas += descartadas;
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

// ¿Esto que dice ser una house lo es de verdad?
//
// LO QUE ESTO PARA: cuando un CSV se lee con el separador equivocado, la fila
// entera cae en una sola celda. `guiasEnTexto` rescata las guías de ahí —bien—
// pero el valor tomado como house es el renglón completo: «13/08/2026
// 1Z08E27V0411529440 08E27V7LNM3». Eso entró al índice como si fuera una house
// y PISÓ 18.610 houses buenas antes de que nadie lo viera.
//
// Una house de verdad es un código corto. Si dentro hay una guía 1Z, o una
// fecha, o mide más que cualquier house real, no es una house: es un renglón
// mal partido. Ante la duda se descarta, porque una house inventada acaba
// pegada a un bulto.
const LARGO_MAX_HOUSE = 40;

// LO QUE EL TRANSPORTISTA ESCRIBE CUANDO NO SABE.
//
// «SHIPMENT NOT ON FILE» no es una house: es la forma que tiene el sistema de
// origen de decir «todavía no tengo ese embarque». Entraba al índice como si
// fuera un número bueno, se pegaba en la columna C, y a partir de ahí la guía
// SÍ tenía house —una house que no existe— así que el relleno automático no
// volvía a buscarla nunca. La house de verdad, cuando llegaba al día
// siguiente, ya no tenía quien la reclamara.
//
// Se comparan las letras solas, sin espacios ni signos: el mismo texto llega
// unas veces con guiones y otras con dobles espacios.
const TEXTOS_SIN_HOUSE = [
    "SHIPMENTNOTONFILE", "NOTONFILE", "NOTFOUND", "NODATA",
    "NOHOUSE", "NA", "N/A", "NULL", "NONE", "PENDING", "PENDIENTE"
];

function esTextoDeSinHouse(valor) {
    let h = String(valor === undefined || valor === null ? "" : valor)
            .toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (h === "") return false;
    return TEXTOS_SIN_HOUSE.some(t => h === t.replace(/[^A-Z0-9]/g, ''));
}

function houseSospechosa(valor) {
    let h = String(valor === undefined || valor === null ? "" : valor).trim();
    if (h === "") return true;
    if (h.length > LARGO_MAX_HOUSE) return true;
    // Un «no lo tengo» del transportista, no una house.
    if (esTextoDeSinHouse(h)) return true;
    // Una guía dentro: la fila se partió mal.
    if (/1Z[A-Z0-9]{16}/i.test(h.replace(/[^A-Za-z0-9]/g, ""))) return true;
    // Una fecha dentro: lo mismo.
    if (/\d{1,4}[-\/]\d{1,2}[-\/]\d{1,4}/.test(h)) return true;
    return false;
}

// =========================================================================
// ¿LA HOUSE CORRESPONDE A SU GUÍA?
// =========================================================================
//
// Una guía UPS es «1Z» + SEIS caracteres de número de embarcador + el resto. Y
// la house que le toca empieza por esos mismos seis:
//
//     1ZA2F338 042893 4294   ->   A2F338 CFPBS
//     1ZY829R5 663875 6858   ->   Y829R5 FKLCV
//     1ZY68V48 D94781 2881   ->   Y68V48 HK3XR
//
// Las guías CORTAS no tienen embarcador que mirar: ahí la house ES la guía.
//
//     V0399301629            ->   V0399301629
//
// Sirve para cazar el desastre silencioso de este módulo: una fila del CSV que
// se lee corrida por una columna le pone a cada guía la house de la de al lado.
// Nada falla, nada avisa, y cada bulto sale etiquetado con la house de otro.
const LARGO_EMBARCADOR = 6;

// Los seis caracteres del embarcador, o "" si esta guía no los tiene.
function embarcadorDeGuia(guia) {
    let g = claveGuiaHouse(guia);
    if (g.length !== 18 || g.indexOf("1Z") !== 0) return "";
    return g.substring(2, 2 + LARGO_EMBARCADOR);
}

// "" si cuadra O si no hay forma de saberlo; el motivo si no cuadra.
//
// EL «NO HAY FORMA DE SABERLO» DEVUELVE "" A PROPÓSITO. Lo que no se puede
// comprobar no se denuncia: un informe con mil líneas dudosas no lo lee nadie,
// y entonces tampoco se leen las veinte que sí eran de verdad.
function houseNoCuadra(guia, house) {
    let g = claveGuiaHouse(guia);
    let h = claveGuiaHouse(house);
    if (g === "" || h === "") return "";
    // Un «no lo tengo» no es un descuadre: es una house que no se cargó, y de
    // eso ya se encarga `houseSospechosa`. Contarlo aquí sería decir dos veces
    // lo mismo con dos nombres.
    if (esTextoDeSinHouse(house)) return "";

    let emb = embarcadorDeGuia(g);
    if (emb !== "") {
        return h.indexOf(emb) === 0 ? ""
             : "la house debería empezar por «" + emb + "»";
    }

    // Guía corta: la house es ella misma.
    if (/^[A-Z0-9]{11}$/.test(g)) {
        return h === g ? "" : "una guía corta lleva su mismo número como house";
    }

    return "";
}

// ¿Esta celda contiene una guía a la que ponerle house? Devuelve la guía
// normalizada, o "" si no lo es.
//
// EL MARCADOR HAY QUE MIRARLO ANTES DE NORMALIZAR. `claveGuiaHouse` quita los
// espacios, así que «SIN PEDIMENTO» se convierte en «SINPEDIMENTO» —doce
// caracteres, sin espacios— y `esGuiaUPSValida` lo acepta como guía corta,
// porque para ella cualquier cosa de más de siete caracteres lo es. Los
// separadores de bloque acabarían pidiendo house, y peor: su house no se
// borraría nunca por creerlos guías buenas.
function esGuiaParaHouse(valorCrudo) {
    let crudo = String(valorCrudo === undefined || valorCrudo === null ? "" : valorCrudo).trim();
    if (crudo === "") return "";
    if (esMarcadorEstructural(crudo)) return "";
    let g = claveGuiaHouse(crudo);
    if (g === "" || !esGuiaUPSValida(g)) return "";
    return g;
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
function celdasPorLlenar(datos, par, filaInicial, reintentarMarcadas) {
    let colGuia = (par && par.guia ? par.guia : 1) - 1;
    let idx = (par && par.house ? par.house : COL_HOUSE) - 1;
    let base = filaInicial || 1;
    let salida = [];
    for (let i = 0; i < (datos || []).length; i++) {
        let fila = datos[i];
        if (!fila) continue;
        if (!filaAdmiteHouse(par, base + i)) continue;
        let guia = esGuiaParaHouse(fila[colGuia]);
        if (guia === "") continue;
        let house = String(fila[idx] === undefined ? "" : fila[idx]).trim();
        // LAS QUE LLEVAN EL MARCADOR «—» TAMBIÉN VUELVEN A BUSCARSE.
        //
        // Antes no: una vez escrito el marcador, esa celda se daba por resuelta
        // para siempre y solo «Reintentar las no encontradas» la desbloqueaba.
        // Eso obligaba a acordarse de un botón, y con el aviso de «sin house»
        // en la columna B el olvido se nota: el bulto sigue marcado como parado
        // aunque su house ya esté en el índice.
        //
        // Volver a mirarlas no cuesta nada: el índice ya está en un Map y el
        // recorrido de filas ya se hace igual. Lo que sí costaría es
        // REESCRIBIR el marcador encima del marcador en cada pasada, y por eso
        // van marcadas como `reintento`: si siguen sin aparecer, no se tocan.
        // Solo en la pasada a mano. En la automática una sola guía marcada
        // obligaría a cargar el índice entero cada cinco minutos.
        let esReintento = reintentarMarcadas && (house === marcaDeSinHouse());
        if (house !== "" && !esReintento) continue;
        // `base` importa: cuando solo se lee la cola de la hoja, el índice del
        // array ya no es la fila. Confundirlos escribiría houses 400 filas más
        // arriba, encima de guías que no son.
        salida.push({ fila: base + i, guia: guia, reintento: esReintento });
    }
    return salida;
}

// Filas cuya house sobra: la celda tiene house pero la guía de su par ya no es
// una guía —la borraron, o dejaron un marcador de bloque—.
//
// SIN ESTO, EL FALLO ES SILENCIOSO Y GRAVE. La house se quedaría huérfana; y si
// alguien escanea otra guía en esa misma fila, el relleno la salta —solo
// escribe en celdas vacías— y el renglón acaba enseñando la house de OTRA guía.
// Nadie lo nota mirando la hoja, y con eso se despacha.
function celdasPorBorrar(datos, par, filaInicial) {
    let colGuia = (par && par.guia ? par.guia : 1) - 1;
    let idx = (par && par.house ? par.house : COL_HOUSE) - 1;
    let base = filaInicial || 1;
    let salida = [];
    for (let i = 0; i < (datos || []).length; i++) {
        let fila = datos[i];
        if (!fila) continue;
        if (!filaAdmiteHouse(par, base + i)) continue;
        let house = String(fila[idx] === undefined ? "" : fila[idx]).trim();
        if (house === "") continue;
        if (esGuiaParaHouse(fila[colGuia]) !== "") continue;
        salida.push({ fila: base + i });
    }
    return salida;
}

// Filas donde la house escrita NO es la que el índice da para esa guía.
//
// Es el otro lado del mismo problema: si sobrescriben una guía por otra, la
// celda de house no queda vacía, así que el relleno normal nunca la tocaría.
// Solo se corrige cuando el índice sabe una house DISTINTA — nunca se borra por
// no encontrarla, porque una house puede haber salido del archivo frío, que el
// disparador no abre. Vaciarla ahí la borraría cada cinco minutos.
function celdasPorCorregir(datos, par, filaInicial, mapa) {
    let colGuia = (par && par.guia ? par.guia : 1) - 1;
    let idx = (par && par.house ? par.house : COL_HOUSE) - 1;
    let base = filaInicial || 1;
    let salida = [];
    if (!mapa) return salida;
    for (let i = 0; i < (datos || []).length; i++) {
        let fila = datos[i];
        if (!fila) continue;
        if (!filaAdmiteHouse(par, base + i)) continue;
        let house = String(fila[idx] === undefined ? "" : fila[idx]).trim();
        if (house === "" || house === TXT_HOUSE_SIN_DATO) continue;
        let guia = esGuiaParaHouse(fila[colGuia]);
        if (guia === "") continue;
        let buena = mapa.get(guia);
        if (buena && buena !== house) salida.push({ fila: base + i, valor: buena });
    }
    return salida;
}

// Todos los pares guía → house que YA están escritos en la hoja.
//
// El mapa del caché no puede llenarse solo con lo que el relleno acaba de
// resolver: las houses que ya estaban puestas nunca pasarían por ahí, y el mapa
// se quedaría vacío para siempre —que es justo lo que pasó—. Se cosechan de la
// hoja, que es donde están, y no cuesta ninguna lectura: `datos` ya está leído.
function paresGuiaHouseEnHoja(datos, par, filaInicial) {
    let colGuia = (par && par.guia ? par.guia : 1) - 1;
    let idx = (par && par.house ? par.house : COL_HOUSE) - 1;
    let base = filaInicial || 1;
    let salida = [];
    for (let i = 0; i < (datos || []).length; i++) {
        let fila = datos[i];
        if (!fila) continue;
        if (!filaAdmiteHouse(par, base + i)) continue;
        let house = String(fila[idx] === undefined ? "" : fila[idx]).trim();
        if (house === "" || house === TXT_HOUSE_SIN_DATO) continue;
        let guia = esGuiaParaHouse(fila[colGuia]);
        if (guia === "") continue;
        salida.push({ guia: guia, house: house });
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

// Ojo: el `ss` que se pasa NO se usa. El índice vive en su propio archivo
// (ver PROP_ID_INDICE), y meterlo en el de operación encarecería cada escaneo.
function hojaIndice(ss, nombre, crear) {
    let libro = archivoDelIndice();
    let h = libro.getSheetByName(nombre);
    if (!h && crear) {
        h = libro.insertSheet(nombre);
        h.getRange(1, 1, 1, 4).setValues([["GUIA", "HOUSE", "FECHA", "ORIGEN"]]);
        h.setFrozenRows(1);
        // Se oculta solo si comparte archivo con la operación: en su propio
        // archivo estorba menos verlo que no poder revisarlo.
        if (!indiceEstaAparte()) h.hideSheet();
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
    let sinFecha = [], demasiadoGrandes = [], sinPartir = [];
    reiniciarHousesDescartadas();

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
        if (cabeceraSinPartir(datos[0] || [])) {
            sinPartir.push(nombre + "\n" + diagnosticoDelSeparador(primeraLinea).texto);
            continue;
        }
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
                                       sinCabecera.join(", ") : "") +
                 (sinPartir.length ? "\n\n" + AVISO_SIN_PARTIR + "\n\n" +
                                     sinPartir.join(", ") : ""),
                 ui.ButtonSet.OK);
        return;
    }

    let msg = volcarAlIndice(ss, nuevas);

    if (sinPartir.length) {
        msg += "\n\n" + AVISO_SIN_PARTIR + "\n\nNO se importaron: " + sinPartir.join(", ");
    }

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
// =========================================================================
// AÑADIR SOLO LAS NUEVAS
// =========================================================================
//
// `volcarAlIndice` REESCRIBE el índice entero: lee las dos hojas, fusiona,
// vuelve a repartir por antigüedad y las borra y las escribe de cero. Con
// doscientas mil filas eso son minutos cada vez que entra un CSV, aunque el CSV
// traiga cuatro guías nuevas.
//
// Este camino solo AÑADE al final. Sigue leyendo el índice —hace falta para
// saber cuáles ya están— pero leer es barato: lo caro es borrar y reescribir.
//
// LO QUE SE PIERDE, Y HAY QUE SABERLO: una guía que YA está no se toca. Con la
// fusión completa, un inbound podía corregir la house que había puesto una
// prealerta; aquí no, porque corregirla obliga a reescribir. Las que llegan con
// otra house se cuentan y se dicen, para poder arreglarlas con el camino largo
// si hace falta.
function separarLasNuevas(mapaExistente, nuevas) {
    let filas = [], yaEstaban = 0, conflictos = [];
    let vistas = new Set();

    (nuevas || []).forEach(n => {
        let g = claveGuiaHouse(n.guia);
        if (g === "") return;

        if (mapaExistente && mapaExistente.has(g)) {
            yaEstaban++;
            let previa = String(mapaExistente.get(g)).trim();
            let ahora = String(n.house === undefined ? "" : n.house).trim();
            // La que ya está gana, pero si dicen cosas distintas hay que
            // decirlo: callarlo dejaría al índice con una house que el archivo
            // nuevo contradice y nadie se enteraría hasta el muelle.
            if (previa !== ahora) conflictos.push({ guia: g, viejo: previa, nuevo: ahora });
            return;
        }
        // Repetida dentro del propio archivo: la primera manda y la segunda ni
        // se cuenta como «ya estaba», porque no estaba: acaba de entrar.
        if (vistas.has(g)) return;
        vistas.add(g);

        let origen = n.origen === undefined ? ORIGEN_DESCONOCIDO : n.origen;
        filas.push([g, n.house, n.fecha || "", nombreDeOrigen(origen)]);
    });

    return { filas: filas, yaEstaban: yaEstaban, conflictos: conflictos };
}

// Pega filas al FINAL de una hoja de índice, sin tocar lo que ya hay.
function anexarFilasAlIndice(ss, nombre, filas) {
    if (!filas || filas.length === 0) return 0;
    let h = hojaIndice(ss, nombre, true);
    if (h.getMaxColumns() < 4) h.insertColumnsAfter(h.getMaxColumns(), 4 - h.getMaxColumns());

    // `getLastRow` puede ser 0 en una hoja recién creada: la cabecera la pone
    // `hojaIndice`, pero si alguien la borró hay que no escribir encima de ella.
    let desde = Math.max(h.getLastRow(), 1) + 1;
    asegurarFilas(h, desde + filas.length);
    // Por tramos: un CSV grande no cabe en un solo setValues.
    for (let i = 0; i < filas.length; i += FILAS_POR_ESCRITURA) {
        let tramo = filas.slice(i, i + FILAS_POR_ESCRITURA);
        h.getRange(desde + i, 1, tramo.length, 4).setValues(tramo);
    }
    return filas.length;
}

function anexarAlIndice(ss, nuevas) {
    // Se leen LAS DOS. Mirar solo el caliente metería otra vez todo lo que ya
    // está en el frío, que es justo lo que más pesa.
    let mapa = new Map();
    [HOJA_INDICE_HOUSE, HOJA_INDICE_HOUSE_FRIO].forEach(nombre => {
        leerIndice(ss, nombre).forEach(f => {
            let g = claveGuiaHouse(f[0]);
            if (g !== "" && !mapa.has(g)) mapa.set(g, String(f[1]).trim());
        });
    });

    let r = separarLasNuevas(mapa, nuevas);
    // Todo lo nuevo va al CALIENTE, y no hace falta mirar su fecha: si acaba de
    // llegar es de ahora. Al frío lo baja el camino largo cuando envejezca.
    anexarFilasAlIndice(ss, HOJA_INDICE_HOUSE, r.filas);

    let msg = "Guías leídas del archivo: " + (nuevas || []).length + "\n" +
              "  · añadidas al índice: " + r.filas.length + "\n" +
              "  · ya estaban: " + r.yaEstaban + "\n" +
              "Índice: " + (mapa.size + r.filas.length) + " guías en total";

    let tiradas = typeof housesDescartadas === 'function' ? housesDescartadas() : 0;
    if (tiradas > 0) {
        msg += "\n\n🚫 " + tiradas + " filas descartadas: lo que traían como house " +
               "no lo parecía (demasiado largo, con una guía dentro o con una fecha).";
    }

    let reintentar = limpiarMarcasNoEncontradas(ss);
    if (reintentar > 0) {
        msg += "\n\n🔁 " + reintentar + " guías marcadas como «no está» vuelven a la " +
               "cola: el relleno les buscará house con estos datos nuevos.";
    }

    if (r.conflictos.length) {
        msg += "\n\n⚠️ " + r.conflictos.length + " guías llegan con una house " +
               "DISTINTA de la que ya tenían. Este camino NO las corrige —para eso " +
               "hay que reescribir el índice—, así que se quedaron como estaban:\n" +
               r.conflictos.slice(0, 8)
                   .map(c => "  " + c.guia + ": " + c.viejo + " → " + c.nuevo).join("\n");
        if (r.conflictos.length > 8) msg += "\n  …y " + (r.conflictos.length - 8) + " más.";
        msg += "\n\nSi hay que hacerles caso, usa «☁️ Importar inbound desde OneDrive», " +
               "que sí fusiona.";
    }

    try { olvidarMapaHouseEnRAM(); } catch (err) { /* puede no existir */ }
    return msg;
}

function volcarAlIndice(ss, nuevas) {
    let fusion = fusionarEnIndice(leerIndice(ss, HOJA_INDICE_HOUSE)
                                  .concat(leerIndice(ss, HOJA_INDICE_HOUSE_FRIO)), nuevas);
    let particion = particionPorAntiguedad(fusion.filas, new Date(), DIAS_INDICE_CALIENTE);

    escribirIndice(ss, HOJA_INDICE_HOUSE, particion.calientes);
    escribirIndice(ss, HOJA_INDICE_HOUSE_FRIO, particion.frias);

    let embebidas = (nuevas || []).filter(n => n.embebida).length;
    let conFecha = (nuevas || []).filter(n => n.fecha).length;
    let msg = "Guías leídas del archivo: " + (nuevas || []).length + "\n" +
              "  · con fecha reconocida: " + conFecha + "\n" +
              (embebidas ? "  · de ellas, " + embebidas + " venían dentro de un texto, " +
                           "no en su columna\n" : "") +
              "Guías nuevas en el índice: " + fusion.anadidas + "\n" +
              "Houses corregidas por el inbound: " + fusion.corregidas + "\n" +
              "Índice caliente (últimos " + DIAS_INDICE_CALIENTE + " días): " +
              particion.calientes.length + "\n" +
              "Archivo frío: " + particion.frias.length;
    // Descartes: filas cuyo campo «house» no parecía una house. Se dice siempre
    // que las haya, porque un número alto aquí significa que el archivo se está
    // leyendo mal y hay que mirarlo, no que el filtro esté haciendo su trabajo.
    let tiradas = typeof housesDescartadas === 'function' ? housesDescartadas() : 0;
    if (tiradas > 0) {
        msg += "\n\n🚫 " + tiradas + " filas descartadas: lo que traían como house " +
               "no lo parecía (demasiado largo, con una guía dentro o con una fecha).";
        if (tiradas > (nuevas || []).length / 4) {
            msg += "\n\nSon demasiadas. Ese archivo se está leyendo mal —casi seguro " +
                   "el separador—. Vuelve a exportarlo como CSV delimitado por comas.";
        }
    }
    // Que la columna de fecha exista no basta: si Excel la exportó en un formato
    // que no se entiende, todas caen en el caliente y el disparador se ahoga sin
    // que nada lo diga. Este contador es lo que hace visible ese caso.
    let total = (nuevas || []).length;
    if (total > 0 && conFecha < total / 2) {
        msg += "\n\n⚠️ Solo " + conFecha + " de " + total + " guías traen una fecha " +
               "que se entienda. Las demás se quedan en el índice CALIENTE, que se " +
               "abre cada minuto.\n\n" +
               "Suele ser que la columna de fecha no está formateada como fecha en " +
               "Excel y sale como número o como texto raro. Dale formato de fecha y " +
               "vuelve a exportar.";
    }
    // Datos nuevos hacen falsas las marcas de «no está»: se limpian aquí, no en
    // un botón que hay que acordarse de pulsar dos veces al día.
    let reintentar = limpiarMarcasNoEncontradas(ss);
    if (reintentar > 0) {
        msg += "\n\n🔁 " + reintentar + " guías marcadas como «no está» vuelven a la " +
               "cola: el disparador les buscará house con estos datos nuevos.";
    }

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
        // OJO: SharePoint pone «/:x:/» a TODO lo que abre con Excel, y un CSV
        // abre con Excel. La marca NO distingue un .xlsx de un .csv, así que
        // esto es una sospecha, no un hecho. Quien la use tiene que callarla en
        // cuanto el contenido descargado se reconozca como CSV, o acusa de
        // Excel a un archivo perfectamente bueno.
        return "⚠️ Este vínculo PODRÍA apuntar a un libro de Excel (la marca «/:x:/» de " +
               "la URL). Ojo: esa marca la lleva también un CSV, así que puede ser una " +
               "falsa alarma; lo que manda es lo que baje.";
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

    let lista = urlsDeOneDrive();
    if (lista.length === 0) {
        ui.alert("🔎 Probar el vínculo", "No hay ningún vínculo guardado.", ui.ButtonSet.OK);
        return;
    }

    let partes = [];
    lista.forEach(entrada => {
        let etiqueta = nombreDeOrigen(entrada.tipo) || "SIN ETIQUETA";
        let avisoTipo = avisoDelTipoDeVinculo(entrada.url);
        let r = bajarDeOneDrive(entrada.url);

        if (!r || r.error) {
            partes.push("── " + etiqueta + " ──\n❌ No se pudo conectar:\n" +
                        ((r && r.error) || "sin respuesta"));
            return;
        }

        let detalle = "── " + etiqueta + " ──\n" +
            (avisoTipo ? avisoTipo + "\n" : "") +
            "Camino: " + r.via + "\n" +
            "HTTP " + r.codigo + " · " + r.tipo + "\n" +
            "Tamaño: " + (r.texto.length / 1048576).toFixed(1) + " MB\n" +
            "Parece ser: " + r.clase.toUpperCase() + "\n";

        if (r.clase !== "csv") {
            partes.push(detalle + "❌ " + explicarDescargaMala(r.clase));
            return;
        }
        if (excedeElLimite(r.texto.length)) {
            partes.push(detalle + "❌ " + avisoDeTamano(r.texto.length));
            return;
        }

        // Con la cabecera basta para saber si el archivo va a servir: qué
        // columnas trae y si hay fecha, que es lo que decide el reparto entre el
        // índice caliente y el frío.
        let primeraLinea = r.texto.split("\n")[0] || "";
        // El separador ANTES que nada: si el archivo no se parte, todo lo que
        // venga después es ruido —las «cabeceras» serían el renglón entero—.
        let sepDiag = diagnosticoDelSeparador(primeraLinea);
        detalle += sepDiag.texto + "\n" +
                   "Cabecera cruda: " + primeraLinea.trim().slice(0, 90) + "\n";
        if (sepDiag.campos < 2) {
            partes.push(detalle + "\n" + AVISO_SIN_PARTIR);
            return;
        }

        let cab = Utilities.parseCsv(primeraLinea, sepDiag.sep)[0] || [];
        let cols = detectarColumnasInbound(cab);
        detalle += "Cabeceras: " + cab.slice(0, 8).join(" | ") + "\n" +
                   "Guía: " + (cols.guia === -1 ? "(ninguna; buscaré las 1Z en el texto)"
                                                : cab[cols.guia]) + "\n" +
                   "House: " + (cols.house === -1 ? "❌ NO LA ENCUENTRO" : cab[cols.house]) + "\n" +
                   "Fecha: " + (cols.fecha === -1 ? "⚠️ ninguna" : cab[cols.fecha]) + "\n";

        if (cols.house === -1) {
            partes.push(detalle + "❌ Sin columna de house no se puede importar." +
                (cabecerasGenericas(cab) ? " Las cabeceras son genéricas: promueve los " +
                 "encabezados en Power Query." : ""));
            return;
        }
        if (cols.fecha === -1) {
            partes.push(detalle + "⚠️ Se puede importar, pero sin fecha todo cae en el " +
                        "índice caliente.");
            return;
        }
        partes.push(detalle + "✅ Listo para importar.");
    });

    ui.alert("🔎 Probar los vínculos", partes.join("\n\n"), ui.ButtonSet.OK);
}

function parsearUrlsGuardadas(txt) {
    return String(txt === undefined || txt === null ? "" : txt).split("\n")
        .map(l => l.trim()).filter(l => l !== "")
        .map(l => {
            let corte = l.indexOf("|");
            if (corte === -1) return { tipo: ORIGEN_DESCONOCIDO, url: l };
            let etq = l.substring(0, corte).trim().toUpperCase();
            return {
                tipo: etq === "INBOUND" ? ORIGEN_INBOUND
                    : etq === "PREALERTA" ? ORIGEN_PREALERTA : ORIGEN_DESCONOCIDO,
                url: l.substring(corte + 1).trim()
            };
        })
        .filter(e => e.url !== "");
}

function serializarUrlsGuardadas(lista) {
    return (lista || []).map(e => nombreDeOrigen(e.tipo) + "|" + e.url).join("\n");
}

function urlsDeOneDrive() {
    return parsearUrlsGuardadas(
        PropertiesService.getScriptProperties().getProperty(PROP_URL_ONEDRIVE));
}

function quitarUrlsOneDrive() {
    const ss = obtenerArchivo();
    const ui = SpreadsheetApp.getUi();
    if (!exigirModoPrueba(ss)) return;
    PropertiesService.getScriptProperties().deleteProperty(PROP_URL_ONEDRIVE);
    ui.alert("🔗 Vínculos", "Borrados todos.", ui.ButtonSet.OK);
}

function configurarUrlOneDrive() {
    const ss = obtenerArchivo();
    const ui = SpreadsheetApp.getUi();
    if (!exigirModoPrueba(ss)) return;

    let lista = urlsDeOneDrive();
    let resumen = lista.length === 0 ? "No hay ninguno guardado todavía."
        : "Guardados ahora (" + lista.length + "):\n" +
          lista.map(e => "  · " + (nombreDeOrigen(e.tipo) || "SIN ETIQUETA")).join("\n");

    let r = ui.prompt("🔗 Añadir vínculo de OneDrive",
        "Pega el vínculo para compartir de UN CSV. Se AÑADE a los que ya hay, " +
        "así que puedes guardar el inbound y la prealerta.\n\n" +
        "Tiene que ser de «Cualquiera con el vínculo» — con «puede ver» basta.\n\n" +
        resumen,
        ui.ButtonSet.OK_CANCEL);
    if (r.getSelectedButton() !== ui.Button.OK) return;

    let url = r.getResponseText().trim();
    if (url === "") {
        ui.alert("🔗 Vínculo", "No pegaste nada. No se cambió nada.\n\n" +
                 "Para borrar los guardados usa «Quitar los vínculos».", ui.ButtonSet.OK);
        return;
    }

    // La etiqueta se pregunta porque la URL de descarga es un token y NO lleva
    // el nombre del archivo dentro. Sin ella los dos entrarían como
    // «desconocido» y ninguno podría corregir al otro: la regla de que el
    // inbound manda sobre la prealerta se quedaría muerta y en silencio.
    let esInbound = ui.alert("🔗 ¿Qué archivo es?",
        "¿Este vínculo es el INBOUND?\n\n" +
        "Sí = INBOUND (lo que llegó de verdad; corrige a la prealerta)\n" +
        "No = PREALERTA (lo que dijeron que iba a llegar)",
        ui.ButtonSet.YES_NO);

    lista = lista.filter(e => e.url !== url);
    lista.push({ tipo: esInbound === ui.Button.YES ? ORIGEN_INBOUND : ORIGEN_PREALERTA,
                 url: url });
    PropertiesService.getScriptProperties()
        .setProperty(PROP_URL_ONEDRIVE, serializarUrlsGuardadas(lista));

    ui.alert("🔗 Vínculo",
             "Guardado como " + nombreDeOrigen(lista[lista.length - 1].tipo) +
             ".\n\nVínculos guardados: " + lista.length +
             "\n\nEstán en las propiedades del script, fuera del código.",
             ui.ButtonSet.OK);
}

// Los dos botones bajan y leen EXACTAMENTE igual; lo único que cambia es qué
// se hace con lo leído. Duplicar el cuerpo habría sido garantizar que un día se
// arregle un fallo de descarga en uno y no en el otro.
function importarInboundDesdeOneDrive() { bajarInboundDeOneDrive(false); }
function anexarInboundDesdeOneDrive()   { bajarInboundDeOneDrive(true); }

function bajarInboundDeOneDrive(soloNuevas) {
    const ss = obtenerArchivo();
    const ui = SpreadsheetApp.getUi();
    if (!exigirModoPrueba(ss)) return;

    let lista = urlsDeOneDrive();
    if (lista.length === 0) {
        ui.alert("☁️ OneDrive", "No hay ningún vínculo guardado.\n\nUsa «Añadir " +
                 "vínculo de OneDrive» primero.", ui.ButtonSet.OK);
        return;
    }

    // Se bajan TODOS y se fusionan de una sola vez. Importarlos por separado
    // daría el mismo resultado -la regla del inbound no depende del orden- pero
    // así el resumen sale junto y el índice se reescribe una vez en vez de dos.
    let nuevas = [], problemas = [], sinFecha = [];
    reiniciarHousesDescartadas();
    for (let i = 0; i < lista.length; i++) {
        let etiqueta = nombreDeOrigen(lista[i].tipo) || "SIN ETIQUETA";
        let r = bajarDeOneDrive(lista[i].url);

        if (!r || r.error) {
            problemas.push(etiqueta + ": no se pudo descargar (" +
                           ((r && r.error) || "sin respuesta") + ")");
            continue;
        }
        if (r.codigo !== 200) {
            problemas.push(etiqueta + ": Microsoft respondió " + r.codigo);
            continue;
        }
        if (r.clase !== "csv") {
            problemas.push(etiqueta + ": lo que bajó no es un CSV, parece " + r.clase);
            continue;
        }
        if (excedeElLimite(r.texto.length)) {
            problemas.push(etiqueta + ": " + (r.texto.length / 1048576).toFixed(1) +
                           " MB, demasiado grande");
            continue;
        }

        let primeraLinea = r.texto.split("\n")[0] || "";
        let datos = Utilities.parseCsv(primeraLinea, separadorCsv(primeraLinea));
        if (cabeceraSinPartir(datos[0] || [])) {
            problemas.push(etiqueta + ": " + AVISO_SIN_PARTIR + "\n" +
                           diagnosticoDelSeparador(primeraLinea).texto +
                           "\nCabecera cruda: " + primeraLinea.trim().slice(0, 90));
            continue;
        }
        let cols = detectarColumnasInbound(datos[0] || []);
        if (cols.house === -1) {
            problemas.push(etiqueta + ": no encuentro la columna de la house" +
                (cabecerasGenericas(datos[0]) ? " (las cabeceras son «Column1, Column2…»: " +
                 "promueve los encabezados en Power Query)" : "") +
                ". Cabeceras: " + (datos[0] || []).slice(0, 8).join(" | "));
            continue;
        }
        if (cols.fecha === -1) sinFecha.push(etiqueta);

        // El tipo va por la etiqueta que se eligió al guardar el vínculo, no por
        // la URL: la de descarga es un token y no lleva el nombre del archivo.
        filasDeCsvCompleto(r.texto, cols, nombreDeOrigen(lista[i].tipo))
            .forEach(f => nuevas.push(f));
    }

    if (nuevas.length === 0) {
        ui.alert("☁️ OneDrive", "No se pudo leer ningún archivo.\n\n" +
                 problemas.join("\n\n"), ui.ButtonSet.OK);
        return;
    }

    let resumen = soloNuevas ? anexarAlIndice(ss, nuevas) : volcarAlIndice(ss, nuevas);
    resumen = "Archivos leídos: " + (lista.length - problemas.length) + " de " +
              lista.length + "\n\n" + resumen;
    // El aviso de las fechas solo pinta en el camino largo: es el que reparte
    // entre caliente y frío según la fecha. El corto lo mete todo en caliente
    // porque acaba de llegar, así que la fecha ahí no decide nada.
    if (!soloNuevas && sinFecha.length) {
        resumen += "\n\n" + AVISO_SIN_FECHA + "\n\nSin fecha: " + sinFecha.join(", ");
    }
    if (problemas.length) resumen += "\n\n❌ Con problemas:\n" + problemas.join("\n");
    ui.alert(soloNuevas ? "⚡ Añadir solo las nuevas" : "☁️ OneDrive",
             resumen, ui.ButtonSet.OK);
}

// `segundosMax` acota lo que puede tardar una pasada. El disparador usa el
// presupuesto corto de siempre —si se pasa, Google le come la cuota del día y
// apaga TODOS los disparadores de la cuenta, el del escaneo incluido—. Pero una
// pasada pedida a mano desde el menú no gasta cuota de disparadores y tiene seis
// minutos de reloj, así que puede permitirse terminar el archivo entero en vez
// de cortarse a los treinta segundos y dejar houses sin poner sin avisar.
function rellenarHousesPendientes(forzar, segundosMax) {
    const ss = obtenerArchivo();
    const presupuesto = segundosMax || SEGUNDOS_MAX_RELLENO;

    // Puede llamarlo el actualizador automático en cada una de sus vueltas; el
    // intervalo lo pone este módulo, no quien lo invoca.
    if (!forzar) {
        let ultimo = 0;
        try {
            ultimo = Number(PropertiesService.getScriptProperties()
                            .getProperty(PROP_TS_RELLENO) || 0);
        } catch (err) { ultimo = 0; }
        if (!tocaRellenar(Date.now(), ultimo, MINUTOS_ENTRE_RELLENOS)) return;
    }
    try {
        PropertiesService.getScriptProperties()
            .setProperty(PROP_TS_RELLENO, String(Date.now()));
    } catch (err) { /* marcar la hora nunca puede tumbar el relleno */ }

    // `moduloActivo`, NO `esArchivoDePrueba`: en el archivo real el módulo se
    // enciende con el interruptor, no por el nombre. Mirar el nombre aquí hacía
    // que el disparador se saliera en la primera línea en producción —y sin
    // decir nada, porque un disparador no puede mostrar avisos—. El síntoma era
    // «el automático no rellena» sin ningún error en ningún sitio.
    if (!moduloActivo(ss)) return anotarRelleno("apagado en este archivo");

    // PRIMERO la comprobación barata. El índice no se abre hasta saber que hay
    // algo que rellenar, y casi todas las pasadas no lo hay.
    //
    // Y solo se lee la COLA de cada hoja: lo que acaba de escanearse está
    // abajo, siempre, y las houses de arriba ya están puestas. Leer la hoja
    // entera cada vez era lo que disparaba la cuota de disparadores.
    let arranque = Date.now();
    let cortadoPorTiempo = false;
    let pendientes = [];
    let cosechados = [];
    let hojas = ss.getSheets();
    for (let h = 0; h < hojas.length; h++) {
        if ((Date.now() - arranque) / 1000 > presupuesto) {
            cortadoPorTiempo = true;
            break;
        }
        let hoja = hojas[h];
        let clave = claveHoja(hoja.getName());
        if (!hojaLlevaHouse(clave)) continue;
        let lr = hoja.getLastRow();
        if (lr < 1) continue;
        let pares = paresDeHouse(clave, hoja.getMaxColumns());

        // SE LEE LA HOJA ENTERA, NO SOLO LA COLA.
        //
        // Leer solo el final servía para RELLENAR —lo que acaba de escanearse
        // está abajo, siempre— pero es un error para BORRAR: una house huérfana
        // se queda donde estaba su guía, que puede ser cualquier fila. Con la
        // cola, las de arriba no las veía nadie y se quedaban ahí para siempre,
        // esperando a que alguien escanee encima y herede una house ajena.
        //
        // Y no cuesta lo que parece: es UNA llamada igual que antes, solo que
        // trae más celdas. Lo que disparaba la cuota era la frecuencia —cada
        // minuto—, no el tamaño de cada lectura; con cinco minutos y el
        // presupuesto de tiempo ya está acotado.
        let desde = 1;
        let datos = hoja.getRange(desde, 1, lr, anchoParaHouses(pares)).getValues();
        pares.forEach(par => {
            // Se cosecha SIEMPRE, tenga o no pendientes: las hojas que ya están
            // completas son precisamente las que tienen houses que guardar.
            paresGuiaHouseEnHoja(datos, par, desde).forEach(p => cosechados.push(p));

            let faltan = celdasPorLlenar(datos, par, desde, !!forzar);
            let sobran = celdasPorBorrar(datos, par, desde);
            if (faltan.length || sobran.length) {
                pendientes.push({ hoja: hoja, col: par.house, par: par, datos: datos,
                                  desde: desde, faltan: faltan, sobran: sobran });
            }
        });
    }
    if (pendientes.length === 0) return anotarRelleno("nada que rellenar");

    // Borrar las huérfanas NO necesita el índice, así que va primero y ocurre
    // aunque no se haya importado nada todavía. Una house sin guía es un dato
    // falso esperando a que alguien escanee encima.
    let borradas = 0;
    pendientes.forEach(p => {
        if (!p.sobran.length) return;
        let items = p.sobran.map(f => ({ fila: f.fila, valor: "" }));
        borradas += items.length;
        bloquesContiguos(items).forEach(b => {
            p.hoja.getRange(b.fila, p.col, b.valores.length, 1).setValues(b.valores);
        });
    });

    // La cosecha va al caché SIEMPRE, aunque no haya nada que rellenar: es lo
    // que hace que el próximo escaneo de esas guías tenga la house al instante.
    let enCacheYa = 0;
    try { enCacheYa = guardarHousesEnCache(ss, cosechados); } catch (err) { enCacheYa = 0; }

    let faltanTotal = pendientes.reduce((n, p) => n + p.faltan.length, 0);
    if (faltanTotal === 0) {
        return anotarRelleno("houses huérfanas borradas: " + borradas +
                      " · houses en caché: " + (enCacheYa || cosechados.length));
    }

    let indice = leerIndice(ss, HOJA_INDICE_HOUSE);
    if (indice.length === 0) {
        return anotarRelleno("HAY " + faltanTotal + " GUÍAS ESPERANDO PERO EL ÍNDICE ESTÁ " +
                      "VACÍO: falta importar · huérfanas borradas: " + borradas);
    }
    let mapa = mapaDeIndice(indice);

    let puestas = 0, sinDato = 0, corregidas = 0;
    pendientes.forEach(p => {
        let items = [];
        p.faltan.forEach(f => {
            let house = mapa.get(f.guia);
            // Sigue sin estar Y ya llevaba el marcador: no se escribe nada.
            // Reescribir «—» encima de «—» es una escritura por fila y por
            // pasada, cada cinco minutos, para dejar la celda como estaba.
            if (!house && f.reintento) { sinDato++; return; }
            if (house) puestas++; else sinDato++;
            items.push({ fila: f.fila, valor: house || TXT_HOUSE_SIN_DATO });
        });

        // Y las que están puestas pero ya no corresponden a su guía: pasa cuando
        // sobrescriben una guía por otra. La celda no queda vacía, así que el
        // relleno normal nunca la tocaría y el renglón enseñaría la house de la
        // guía anterior.
        celdasPorCorregir(p.datos, p.par, p.desde, mapa).forEach(c => {
            items.push(c);
            corregidas++;
        });

        bloquesContiguos(items).forEach(b => {
            p.hoja.getRange(b.fila, p.col, b.valores.length, 1).setValues(b.valores);
        });
    });
    // Lo que se acaba de resolver se guarda en el caché, para que el SIGUIENTE
    // escaneo de esa guía —el de salida, normalmente— la tenga al instante y
    // sin abrir nada. Es lo que hace que la house salga con el ✅ Ok.
    let paraCache = cosechados.slice();
    pendientes.forEach(p => p.faltan.forEach(f => {
        let h = mapa.get(f.guia);
        if (h) paraCache.push({ guia: f.guia, house: h });
    }));
    let enCache = 0;
    try { enCache = guardarHousesEnCache(ss, paraCache); } catch (err) { enCache = 0; }

    let segundos = (Date.now() - arranque) / 1000;
    try {
        PropertiesService.getScriptProperties()
            .setProperty(PROP_SEG_RELLENO, segundos.toFixed(1));
    } catch (err) { /* medir nunca puede tumbar el relleno */ }
    return anotarRelleno("houses puestas: " + puestas + " · sin dato: " + sinDato +
                  " · huérfanas borradas: " + borradas +
                  " · corregidas: " + corregidas +
                  " · houses en caché: " + enCache +
                  " · índice: " + indice.length + " guías" +
                  (cortadoPorTiempo ? " · CORTADO por tiempo, sigue en la próxima" : "") +
                  " · " + segundos.toFixed(1) + " s");
}

// -------------------------------------------------------------------------
// QUE EL DISPARADOR NO SEA MUDO
//
// Un disparador no puede mostrar avisos, así que cuando no hace lo que se
// espera no hay NADA que mirar: ni error, ni mensaje, ni rastro. Eso ya costó
// una tarde una vez —el guardia miraba el nombre del archivo en vez del
// interruptor y se salía en la primera línea—. Dejando anotado qué hizo en cada
// pasada, la próxima vez la respuesta está a un clic.
// -------------------------------------------------------------------------
const PROP_ULTIMO_RELLENO = 'HOUSE_ULTIMO_RELLENO';

// Cuánto tardó la última pasada, en segundos. Sirve para enseñar el consumo
// diario de cuota EN NÚMEROS, que es lo único que impide volver a poner un
// disparador cada minuto «a ver si va más rápido».
const PROP_SEG_RELLENO = 'HOUSE_SEG_ULTIMO_RELLENO';

// Minutos de cuota al día que costaría este relleno a un ritmo dado.
// Google apaga TODOS los disparadores de la cuenta al agotarse la cuota, y el
// del escaneo es uno de ellos: pasarse aquí no ralentiza las houses, para la
// operación.
function minutosDeCuotaAlDia(segundosPorPasada, minutosEntrePasadas) {
    if (!segundosPorPasada || !minutosEntrePasadas) return 0;
    let pasadas = (24 * 60) / minutosEntrePasadas;
    return (pasadas * segundosPorPasada) / 60;
}

// Devuelve el mismo texto que anota, para que quien lo llame a mano pueda
// enseñarlo. El disparador lo ignora, como siempre: es mudo por naturaleza y
// esta nota es lo único que deja de rastro.
function anotarRelleno(texto) {
    try {
        PropertiesService.getScriptProperties().setProperty(PROP_ULTIMO_RELLENO,
            Utilities.formatDate(new Date(), Session.getScriptTimeZone(),
                                 "dd/MM HH:mm:ss") + " — " + texto);
    } catch (err) { /* anotar nunca puede tumbar el relleno */ }
    return texto;
}

// El coste en cuota, en números, para que no haya que fiarse de nadie.
function textoDeCuota() {
    let seg = Number(PropertiesService.getScriptProperties()
                     .getProperty(PROP_SEG_RELLENO) || 0);
    if (!seg) return "Todavía no hay una medida de cuánto tarda una pasada.";

    let cada5 = minutosDeCuotaAlDia(seg, 5);
    let cada1 = minutosDeCuotaAlDia(seg, 1);
    return "Coste en cuota de disparadores:\n" +
        "  · cada 5 min (como está): ~" + Math.round(cada5) + " min/día\n" +
        "  · cada 1 min: ~" + Math.round(cada1) + " min/día (" +
        (cada1 / 60).toFixed(1) + " h)\n\n" +
        "Google apaga TODOS los disparadores de la cuenta al agotarse la cuota " +
        "diaria, y el del escaneo es uno de ellos. Pasarse aquí no ralentiza las " +
        "houses: para la operación.";
}

function estadoDelRelleno() {
    const ui = SpreadsheetApp.getUi();
    let ultimo = PropertiesService.getScriptProperties().getProperty(PROP_ULTIMO_RELLENO);
    let hayTrigger = ScriptApp.getProjectTriggers()
        .some(t => t.getHandlerFunction() === 'rellenarHousesPendientes');

    ui.alert("🩺 Estado del relleno automático",
        "Disparador instalado: " + (hayTrigger ? "SÍ" : "NO — actívalo en «Rellenar solo, " +
        "cada minuto»") + "\n\n" +
        "Índice en archivo aparte: " + (indiceEstaAparte() ? "SÍ" : "NO (vive en este " +
        "archivo y lo engorda)") + "\n\n" +
        "Última pasada:\n" + (ultimo || "ninguna todavía. Si el disparador está " +
        "instalado, espera un minuto y vuelve a mirar.") + "\n\n" + textoDeCuota(),
        ui.ButtonSet.OK);
}

// EL BOTÓN: poner AHORA las houses que falten, sin esperar al automático.
//
// Es la misma pasada que corre sola cada cinco minutos, no una copia: dos
// implementaciones del mismo relleno acabarían divergiendo el día que se toque
// una sola, y esta escribe en la columna que ve el operador.
//
// Dos diferencias, y las dos a propósito:
//
//   · SE SALTA EL RELOJ. La pasada automática no hace nada si la anterior fue
//     hace menos de cinco minutos. Aquí eso sería absurdo: si alguien aprieta un
//     botón es justamente porque quiere que pase AHORA.
//
//   · TIENE MÁS TIEMPO. La automática se corta a los treinta segundos para no
//     comerse la cuota de disparadores —si se agota, Google apaga TODOS los de
//     la cuenta, y el del escaneo es uno de ellos—. Una pasada de menú no gasta
//     esa cuota y tiene seis minutos de reloj, así que puede terminar el archivo
//     entero en vez de dejar houses sin poner sin avisar.
const SEGUNDOS_MAX_RELLENO_A_MANO = 240;

// Accesores para el banco de pruebas: las constantes con `const` no salen del
// eval con el que carga este archivo, las funciones sí.
function accesoSegundosAMano() { return SEGUNDOS_MAX_RELLENO_A_MANO; }
function accesoSegundosAutomatico() { return SEGUNDOS_MAX_RELLENO; }

function rellenarHousesAhora() {
    const ss = obtenerArchivo();
    const ui = SpreadsheetApp.getUi();

    if (!moduloActivo(ss)) {
        ui.alert("🏠 Poner las houses que faltan",
                 "El módulo de houses está apagado en este archivo.", ui.ButtonSet.OK);
        return;
    }

    ss.toast('⏳ Buscando las houses que faltan. No cierres el archivo.', 'Houses', 20);

    let resumen = "";
    try {
        resumen = rellenarHousesPendientes(true, SEGUNDOS_MAX_RELLENO_A_MANO) || "";
    } catch (err) {
        ui.alert("🏠 Poner las houses que faltan", "Falló:\n" + err, ui.ButtonSet.OK);
        return;
    }

    // El texto crudo de la pasada ya dice los números. Lo que se añade aquí es
    // QUÉ HACER con ellos, que es lo que no se deduce solo: «sin dato» no es un
    // fallo del relleno, son guías que todavía no están en el índice.
    let msg = resumen === "" ? "No hubo nada que hacer." : resumen;
    if (resumen.indexOf("sin dato") !== -1 && resumen.indexOf("sin dato: 0") === -1) {
        msg += "\n\n«Sin dato» son guías que NO están en el índice: llevan «" +
               TXT_HOUSE_SIN_DATO + "» y no es un fallo del relleno. Importa el " +
               "inbound del día, o búscalas en el archivo frío con «🏠 Buscar las " +
               "que faltan».";
    }
    if (resumen.indexOf("ÍNDICE ESTÁ VACÍO") !== -1) {
        msg += "\n\nNo hay nada importado todavía: usa «☁️ Importar inbound desde " +
               "OneDrive» primero.";
    }
    if (resumen.indexOf("CORTADO por tiempo") !== -1) {
        msg += "\n\nQuedó a medias por tiempo. Vuelve a apretarlo: sigue por donde " +
               "se quedó.";
    }
    ui.alert("🏠 Poner las houses que faltan", msg, ui.ButtonSet.OK);
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
        if (!hojaLlevaHouse(clave)) return;
        let lr = hoja.getLastRow();
        if (lr < 1) return;
        let pares = paresDeHouse(clave, hoja.getMaxColumns());
        let datos = hoja.getRange(1, 1, lr, anchoParaHouses(pares)).getValues();
        pares.forEach(par => {
            let items = [];
            for (let i = 0; i < datos.length; i++) {
                let guia = esGuiaParaHouse(datos[i][par.guia - 1]);
                let actual = String(datos[i][par.house - 1]).trim();
                if (guia === "") continue;
                if (actual !== "" && actual !== TXT_HOUSE_SIN_DATO) continue;
                let house = mapa.get(guia);
                if (house) { items.push({ fila: i + 1, valor: house }); encontradas++; }
                else siguenSinAparecer++;
            }
            bloquesContiguos(items).forEach(b => {
                hoja.getRange(b.fila, par.house, b.valores.length, 1).setValues(b.valores);
            });
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
// Borra las marcas de «buscada y no está» y devuelve cuántas quitó.
//
// SE LLAMA SOLA DESPUÉS DE CADA IMPORTACIÓN, y esa es la parte importante.
//
// Los datos no llegan de una vez: la prealerta por la mañana, el inbound por la
// tarde. Una guía escaneada a las nueve todavía no está en ningún archivo, se
// marca «no está», y la marca existe justamente para no volver a cargar el
// índice entero cada minuto buscando algo que no aparece.
//
// Pero cuando entra un archivo NUEVO, esa marca deja de ser cierta: hay datos
// que antes no había. Sin limpiarla, la house de esa guía no aparecería nunca
// —el índice ya la tiene y la hoja sigue diciendo «—»— y el operador tendría
// que acordarse de pulsar «Reintentar» dos veces al día. Eso se olvida el
// primer día, y el fallo resultante es mudo.
function limpiarMarcasNoEncontradas(ss) {
    let limpiadas = 0;
    ss.getSheets().forEach(hoja => {
        let clave = claveHoja(hoja.getName());
        if (!hojaLlevaHouse(clave)) return;
        let lr = hoja.getLastRow();
        if (lr < 1) return;
        paresDeHouse(clave, hoja.getMaxColumns()).forEach(par => {
            let col = hoja.getRange(1, par.house, lr, 1).getValues();
            let items = [];
            for (let i = 0; i < col.length; i++) {
                if (String(col[i][0]).trim() === TXT_HOUSE_SIN_DATO) {
                    items.push({ fila: i + 1, valor: "" });
                    limpiadas++;
                }
            }
            bloquesContiguos(items).forEach(b => {
                hoja.getRange(b.fila, par.house, b.valores.length, 1).setValues(b.valores);
            });
        });
    });
    return limpiadas;
}

// -------------------------------------------------------------------------
// LA HOUSE VIAJA EN EL CACHÉ
//
// El caché se lee ENTERO en cada escaneo y ya está en memoria cuando llega la
// guía. Si lleva la house consigo, ponerla no cuesta ni una llamada: es un
// `Map.get`.
//
// La versión anterior de esto abría el archivo del índice y leía 45.000 filas
// DENTRO del escaneo. O tardaba segundos, o fallaba y devolvía vacío —y la
// house no salía al instante—. Era exactamente lo que este módulo lleva desde
// el primer día prometiendo no hacer.
//
// Son DOS columnas en total, no una por pestaña: una lista plana guía → house
// de lo que está vivo ahora mismo. Empiezan por «__» a propósito, y eso las
// protege de dos cosas a la vez:
//   · el podado de columnas huérfanas no las borra (no son de ninguna hoja);
//   · el índice de duplicados NO las mira, porque solo indexa las que acaban
//     en «_FISICO». Y eso importa: una house cubre decenas de guías, así que
//     si entrara al índice cada bulto de la misma house saldría repetido.
// -------------------------------------------------------------------------
const HEADER_HOUSE_GUIA = "__HOUSE_GUIA";
const HEADER_HOUSE_VALOR = "__HOUSE_VALOR";

function encabezadosDelMapaHouse() {
    return [HEADER_HOUSE_GUIA, HEADER_HOUSE_VALOR];
}

// Lee el mapa que ya viene dentro del caché. Cero llamadas: `cacheInfo` es lo
// que el escaneo acaba de cargar de todas formas.
function mapaHouseDelCache(cacheInfo) {
    let m = new Map();
    if (!cacheInfo || !cacheInfo.headers || !cacheInfo.data) return m;
    let cg = cacheInfo.headers.indexOf(HEADER_HOUSE_GUIA);
    let cv = cacheInfo.headers.indexOf(HEADER_HOUSE_VALOR);
    if (cg === -1 || cv === -1) return m;
    for (let r = 1; r < cacheInfo.data.length; r++) {
        let fila = cacheInfo.data[r];
        if (!fila) continue;
        let g = claveGuiaHouse(fila[cg]);
        if (g === "") continue;
        let h = String(fila[cv] === undefined ? "" : fila[cv]).trim();
        if (h !== "") m.set(g, h);
    }
    return m;
}

// Lo que usa el escaneo. NO abre nada: si el caché aún no trae el mapa,
// devuelve vacío y la house la pondrá el relleno de fondo.
//
// Se construye UNA vez por ejecución, no una por celda. Un pegado de 300
// renglones llamaba aquí 300 veces y rehacía el Map entero cada vez: miles de
// entradas recorridas por cada fila pegada, para obtener siempre lo mismo.
let globalMapaHouseCache = null;

function mapaHouseParaEscaneo(cacheInfo) {
    if (globalMapaHouseCache === null) {
        globalMapaHouseCache = mapaHouseDelCache(cacheInfo);
    }
    return globalMapaHouseCache;
}

// El caché en RAM se descarta al empezar cada edición; este mapa sale de ahí,
// así que tiene que caducar con él o serviría houses de la edición anterior.
function olvidarMapaHouseEnRAM() {
    globalMapaHouseCache = null;
}

// Mete en el caché los pares que se acaban de resolver, para que el SIGUIENTE
// escaneo de esa guía —el de salida, normalmente— la tenga al instante.
//
// Se fusiona con lo que ya había y se reescriben las dos columnas enteras. Son
// columnas del sistema, no de operación: aquí no aplica la regla de no
// reescribir un rango, porque nadie más las toca.
function guardarHousesEnCache(ss, pares) {
    let cacheSheet = ss.getSheetByName("CACHE_SISTEMA");
    if (!cacheSheet) return 0;

    // Se REEMPLAZA, no se acumula. `pares` trae todo lo que hay vivo en las
    // hojas, así que una guía que ya no está desaparece sola del mapa. Acumular
    // lo dejaría crecer sin fin, y el caché es justo lo que no puede engordar:
    // se lee entero en CADA escaneo.
    let mapa = new Map();
    (pares || []).forEach(p => {
        if (p && p.guia && p.house) mapa.set(p.guia, p.house);
    });

    let headers = cacheSheet.getRange(1, 1, 1, cacheSheet.getMaxColumns()).getValues()[0];
    let cg = columnaDeHeader(cacheSheet, headers, HEADER_HOUSE_GUIA);
    let cv = columnaDeHeader(cacheSheet, headers, HEADER_HOUSE_VALOR);
    if (cg === -1 || cv === -1) return 0;

    let lr = cacheSheet.getLastRow();
    let previas = 0;
    if (lr > 1) {
        let ancho = Math.abs(cv - cg) + 1;
        let dg = cg < cv ? 0 : ancho - 1;
        let dv = cg < cv ? ancho - 1 : 0;
        let previos = cacheSheet.getRange(2, Math.min(cg, cv), lr - 1, ancho).getValues();
        let iguales = true;
        let vistas = new Set();
        previos.forEach(f => {
            let g = claveGuiaHouse(f[dg]);
            if (g === "") return;
            previas++;
            vistas.add(g);
            if (mapa.get(g) !== String(f[dv]).trim()) iguales = false;
        });
        // Nada que hacer si ya está exactamente igual: escribir cada cinco
        // minutos lo mismo solo gasta cuota.
        if (iguales && vistas.size === mapa.size) return 0;
    }

    let filas = [];
    mapa.forEach((h, g) => filas.push({ g: g, h: h }));
    asegurarFilas(cacheSheet, filas.length + 1);

    // El alto cubre también lo que había antes, para BORRAR lo que ya no toca.
    let alto = Math.max(filas.length, previas, 1);
    let colG = [], colV = [];
    for (let i = 0; i < alto; i++) {
        colG.push([i < filas.length ? filas[i].g : ""]);
        colV.push([i < filas.length ? filas[i].h : ""]);
    }
    cacheSheet.getRange(2, cg, alto, 1).setValues(colG);
    cacheSheet.getRange(2, cv, alto, 1).setValues(colV);
    return filas.length;
}

// -------------------------------------------------------------------------
// MIGRACIÓN: de la D y la R a la C y la Q
// -------------------------------------------------------------------------
function moverHousesDeColumna() {
    const ss = obtenerArchivo();
    const ui = SpreadsheetApp.getUi();
    if (!exigirModoPrueba(ss)) return;

    let r = ui.alert("↔️ Mover las houses a la C",
        "Las houses vivían en la D (y en la R para la preforma). Ahora van en la " +
        "C y la Q, pegadas a su estado, para que el escaneo las escriba sin " +
        "coste.\n\nEsto MUEVE lo que haya en la D a la C, y lo de la R a la Q, en " +
        "todas las pestañas. Solo escribe donde la C esté vacía.\n\n¿Sigo?",
        ui.ButtonSet.YES_NO);
    if (r !== ui.Button.YES) return;

    const VIEJAS = [{ de: 4, a: COL_HOUSE, desde: FILA_MIN_HOUSE },
                    { de: 18, a: COL_HOUSE_PREFORMA, desde: FILA_MIN_HOUSE_PREFORMA }];
    let movidas = 0, chocaron = 0;

    ss.getSheets().forEach(hoja => {
        let clave = claveHoja(hoja.getName());
        if (!hojaLlevaHouse(clave)) return;
        let lr = hoja.getLastRow();
        if (lr < 1) return;
        let ancho = hoja.getMaxColumns();

        VIEJAS.forEach(m => {
            if (m.de > ancho) return;
            let viejas = hoja.getRange(1, m.de, lr, 1).getValues();
            let nuevas = hoja.getRange(1, m.a, lr, 1).getValues();
            let aPoner = [], aVaciar = [];
            for (let i = 0; i < viejas.length; i++) {
                let v = String(viejas[i][0]).trim();
                if (v === "") continue;
                if (i + 1 < m.desde) continue;
                // Si la nueva ya tiene algo, NO se pisa: se avisa y se deja.
                if (String(nuevas[i][0]).trim() !== "") { chocaron++; continue; }
                aPoner.push({ fila: i + 1, valor: v });
                aVaciar.push({ fila: i + 1, valor: "" });
                movidas++;
            }
            bloquesContiguos(aPoner).forEach(b =>
                hoja.getRange(b.fila, m.a, b.valores.length, 1).setValues(b.valores));
            bloquesContiguos(aVaciar).forEach(b =>
                hoja.getRange(b.fila, m.de, b.valores.length, 1).setValues(b.valores));
        });
    });

    ui.alert("↔️ Mover las houses",
        "Movidas: " + movidas + "\n" +
        (chocaron ? "No se movieron " + chocaron + " porque la celda destino ya " +
                    "tenía algo. Míralas antes de borrar la D.\n\n" : "") +
        "Comprueba la C y, cuando estés conforme, borra a mano lo que quede en la D.",
        ui.ButtonSet.OK);
}

// Limpia la house de las filas cuya guía ya no está, DESDE EL RECÁLCULO.
//
// Es donde tiene que ir. El recálculo ya limpia el estado y la hora cuando se
// vacía una fila; la house es un dato más de esa fila y tiene que seguir la
// misma suerte, en el mismo instante. Dejarlo al disparador de cada cinco
// minutos abría una ventana en la que la fila enseñaba una house sin guía, y
// si alguien escaneaba ahí dentro heredaba la house de la anterior.
//
// No cuesta ni una lectura: `datosMasivos` ya es la hoja entera, leída para
// recalcular. Solo escribe cuando de verdad hay algo que borrar.
function limpiarHousesEnRecalculo(hoja, nombreHoja, datosMasivos) {
    if (!datosMasivos || datosMasivos.length === 0) return 0;
    let ancho = datosMasivos[0] ? datosMasivos[0].length : 0;
    let total = 0;

    paresDeHouse(nombreHoja, ancho).forEach(par => {
        if (par.house > ancho || par.guia > ancho) return;
        let items = [];
        for (let i = 0; i < datosMasivos.length; i++) {
            let fila = datosMasivos[i];
            if (!fila) continue;
            if (!filaAdmiteHouse(par, i + 1)) continue;
            let house = String(fila[par.house - 1] === undefined ? "" : fila[par.house - 1]).trim();
            if (house === "") continue;
            if (esGuiaParaHouse(fila[par.guia - 1]) !== "") continue;
            items.push({ fila: i + 1, valor: "" });
        }
        if (!items.length) return;
        total += items.length;
        bloquesContiguos(items).forEach(b => {
            hoja.getRange(b.fila, par.house, b.valores.length, 1).setValues(b.valores);
        });
    });
    return total;
}

// Botón: hacerlo ahora mismo, sin esperar al disparador.
function limpiarHousesHuerfanasAhora() {
    const ss = obtenerArchivo();
    const ui = SpreadsheetApp.getUi();
    if (!exigirModoPrueba(ss)) return;

    let borradas = 0, hojasTocadas = 0;
    ss.getSheets().forEach(hoja => {
        let clave = claveHoja(hoja.getName());
        if (!hojaLlevaHouse(clave)) return;
        let lr = hoja.getLastRow();
        if (lr < 1) return;
        let pares = paresDeHouse(clave, hoja.getMaxColumns());
        let datos = hoja.getRange(1, 1, lr, anchoParaHouses(pares)).getValues();
        let algo = false;
        pares.forEach(par => {
            let sobran = celdasPorBorrar(datos, par, 1);
            if (!sobran.length) return;
            algo = true;
            borradas += sobran.length;
            bloquesContiguos(sobran.map(f => ({ fila: f.fila, valor: "" }))).forEach(b => {
                hoja.getRange(b.fila, par.house, b.valores.length, 1).setValues(b.valores);
            });
        });
        if (algo) hojasTocadas++;
    });

    ui.alert("🧽 Houses huérfanas",
        "Borradas: " + borradas + "\nEn " + hojasTocadas + " pestañas.\n\n" +
        (borradas === 0
            ? "No había ninguna house sin su guía."
            : "Eran houses cuya guía ya no está. Se quitan porque, si alguien " +
              "escanea otra guía en esa fila, heredaría la house de la anterior."),
        ui.ButtonSet.OK);
}

// -------------------------------------------------------------------------
// REPARAR: sacar del índice lo que nunca debió entrar
//
// `houseSospechosa` impide que la basura vuelva a entrar, pero NO limpia la que
// ya está: `volcarAlIndice` fusiona, no reconstruye, así que reimportar deja las
// houses malas donde están. Esto es lo que las quita.
//
// Se quitan del índice Y de las pestañas, porque el disparador ya las escribió
// en la columna de la house. Quitarlas de la hoja no pierde nada: la guía sigue
// ahí y el relleno vuelve a buscarle house con los datos buenos.
//
// LO QUE ESTO NO PUEDE HACER: devolver la house buena que la basura pisó. Esa se
// perdió al sobrescribirla. Hay que reimportar el archivo bueno después —el
// menú «♻️ Reimportar todos los CSV» y otra importación—.
// -------------------------------------------------------------------------
function filasSinBasura(filas) {
    let limpias = [], tiradas = 0;
    (filas || []).forEach(f => {
        if (houseSospechosa(f[1])) { tiradas++; return; }
        limpias.push(f);
    });
    return { limpias: limpias, tiradas: tiradas };
}

// =========================================================================
// EL INFORME DE HOUSES QUE NO CUADRAN
// =========================================================================
//
// Vive en el ARCHIVO DEL ÍNDICE, no en el de operación, y no es por orden: el
// de operación lo tienen abierto siete personas todo el día y cada pestaña que
// se le añade es peso en cada escaneo. El informe se mira de vez en cuando, no
// cada minuto.
const HOJA_ERRORES_HOUSE = "ERRORES_HOUSE";

// Tope de líneas del informe. Si el CSV entró corrido, TODAS las filas
// descuadran: escribir doscientas mil sería tardar diez minutos para decir algo
// que ya se ve en las primeras veinte.
const MAX_ERRORES_HOUSE = 3000;

// Las parejas que no cuadran, de una lista de filas del índice.
//
// Puro, sin hablar con Sheets, para poder probarlo: la regla de qué cuadra y
// qué no es justo lo que, si se equivoca, no da error —devuelve un informe
// vacío o uno lleno de falsos— y eso solo se ve contándolo a mano.
function descuadresDeIndice(filas, cual) {
    let salida = [];
    (filas || []).forEach(f => {
        let guia = String((f || [])[0] === undefined ? "" : f[0]).trim();
        let house = String((f || [])[1] === undefined ? "" : f[1]).trim();
        if (guia === "" || house === "") return;
        let motivo = houseNoCuadra(guia, house);
        if (motivo === "") return;
        salida.push([guia, house, embarcadorDeGuia(guia), motivo,
                     String(f[2] === undefined ? "" : f[2]),
                     String(f[3] === undefined ? "" : f[3]),
                     cual || ""]);
    });
    return salida;
}

function revisarHousesContraSuGuia() {
    const ss = obtenerArchivo();
    const ui = SpreadsheetApp.getUi();

    let todos = [];
    let revisadas = 0;
    [HOJA_INDICE_HOUSE, HOJA_INDICE_HOUSE_FRIO].forEach(nombre => {
        let filas = leerIndice(ss, nombre);
        revisadas += filas.length;
        descuadresDeIndice(filas, nombre).forEach(d => todos.push(d));
    });

    if (revisadas === 0) {
        ui.alert("🔎 Houses contra su guía",
                 "El índice está vacío. Importa primero.", ui.ButtonSet.OK);
        return;
    }

    const archivo = archivoDelIndice();
    let hoja = archivo.getSheetByName(HOJA_ERRORES_HOUSE);
    if (!hoja) hoja = archivo.insertSheet(HOJA_ERRORES_HOUSE, archivo.getNumSheets());

    // Se borra y se rehace: un informe es una foto de AHORA. Acumular dejaría
    // dentro los descuadres ya corregidos y nadie sabría cuáles siguen vivos.
    hoja.clear();
    let cabecera = [["GUIA", "HOUSE", "DEBERÍA EMPEZAR POR", "QUÉ PASA",
                     "FECHA", "ORIGEN", "ÍNDICE"]];
    hoja.getRange(1, 1, 1, 7).setValues(cabecera);
    hoja.getRange(1, 1, 1, 7).setFontWeight("bold");

    let recortado = todos.length > MAX_ERRORES_HOUSE;
    let aEscribir = recortado ? todos.slice(0, MAX_ERRORES_HOUSE) : todos;
    if (aEscribir.length > 0) {
        asegurarFilas(hoja, aEscribir.length + 2);
        hoja.getRange(2, 1, aEscribir.length, 7).setValues(aEscribir);
    }
    archivo.setActiveSheet(hoja);

    let msg = "Revisé " + revisadas.toLocaleString() + " renglones del índice.\n\n";
    if (todos.length === 0) {
        msg += "✅ Todas las houses cuadran con su guía.\n\n" +
               "La regla: una guía «1Z» + seis caracteres de embarcador lleva " +
               "una house que empieza por esos mismos seis. Una guía corta lleva " +
               "su propio número.";
    } else {
        msg += "⚠️ " + todos.length.toLocaleString() + " no cuadran" +
               (recortado ? " (se escribieron las primeras " + MAX_ERRORES_HOUSE + ")" : "") +
               ".\n\nEstán en la pestaña «" + HOJA_ERRORES_HOUSE + "» de " +
               archivo.getName() + ".\n\n" +
               "Si son MUCHAS de golpe, sospecha del CSV antes que de las " +
               "houses: una columna corrida le pone a cada guía la house de la " +
               "de al lado, y entonces no cuadra ninguna.";
    }
    ui.alert("🔎 Houses contra su guía", msg, ui.ButtonSet.OK);
}

// =========================================================================
// 1Z REPETIDOS EN EL ÍNDICE
// =========================================================================
//
// `fusionarEnIndice` ya se queda con una sola fila por guía, así que un índice
// importado con el código de hoy no debería traerlos. Los que hay vienen de
// antes de esa regla, o de pegar a mano.
//
// NO SE BORRAN TODOS LOS REPETIDOS: solo los que DICEN LO MISMO. Si la misma
// guía aparece con DOS houses distintas eso no es un duplicado, es una
// contradicción, y elegir una en silencio es exactamente lo que no se puede
// hacer aquí: una house cambiada sin que nadie lo sepa no se descubre hasta que
// el bulto está en el lugar equivocado. Esas se quedan las dos y se reportan.
//
// Devuelve {limpias, quitadas, conflictos}.
function quitarGuiasRepetidas(filas) {
    let primeraDe = new Map();   // guía -> la fila que se queda
    let casasDe = new Map();     // guía -> Set de houses distintas vistas
    let orden = [];
    let conflictos = [];

    (filas || []).forEach(f => {
        let g = claveGuiaHouse((f || [])[0]);
        if (g === "") { orden.push({ suelta: f }); return; }
        let house = String((f || [])[1] === undefined ? "" : f[1]).trim();
        let clave = claveGuiaHouse(house);

        if (!primeraDe.has(g)) {
            let fila = [g, house, f[2] === undefined ? "" : f[2],
                        f[3] === undefined ? "" : f[3]];
            primeraDe.set(g, fila);
            casasDe.set(g, new Set([clave]));
            orden.push({ guia: g });
            return;
        }

        casasDe.get(g).add(clave);

        // SE RESCATA LO QUE LA PRIMERA NO TRAÍA. Quedarse con la primera a
        // secas perdería la fecha o el origen si la repetida sí los tenía, y
        // el origen es lo único que permite investigar después de dónde salió
        // una house que no cuadra.
        let queda = primeraDe.get(g);
        if (String(queda[2]).trim() === "" && f[2] !== undefined) queda[2] = f[2];
        if (String(queda[3]).trim() === "" && f[3] !== undefined) queda[3] = f[3];
    });

    let limpias = [];
    let quitadas = 0;
    let vistas = new Set();
    orden.forEach(o => {
        if (o.suelta !== undefined) { limpias.push(o.suelta); return; }
        if (vistas.has(o.guia)) return;
        vistas.add(o.guia);
        limpias.push(primeraDe.get(o.guia));
    });

    quitadas = (filas || []).length - limpias.length;

    casasDe.forEach((set, g) => {
        if (set.size <= 1) return;
        conflictos.push({ guia: g, houses: Array.from(set) });
    });

    return { limpias: limpias, quitadas: quitadas, conflictos: conflictos };
}

function quitarRepetidosDelIndice() {
    const ss = obtenerArchivo();
    const ui = SpreadsheetApp.getUi();

    let previo = {};
    let totalPrevio = 0;
    [HOJA_INDICE_HOUSE, HOJA_INDICE_HOUSE_FRIO].forEach(nombre => {
        previo[nombre] = leerIndice(ss, nombre);
        totalPrevio += previo[nombre].length;
    });

    if (totalPrevio === 0) {
        ui.alert("🧹 1Z repetidos", "El índice está vacío.", ui.ButtonSet.OK);
        return;
    }

    // Se cuenta ANTES de preguntar: decir «voy a quitar 0» y hacer que alguien
    // confirme una operación que no hace nada es perder su tiempo dos veces.
    let plan = {};
    let aQuitar = 0, conflictos = [];
    [HOJA_INDICE_HOUSE, HOJA_INDICE_HOUSE_FRIO].forEach(nombre => {
        plan[nombre] = quitarGuiasRepetidas(previo[nombre]);
        aQuitar += plan[nombre].quitadas;
        plan[nombre].conflictos.forEach(c => conflictos.push(c));
    });

    if (aQuitar === 0) {
        ui.alert("🧹 1Z repetidos",
            "No hay ninguna guía repetida con la misma house en las " +
            totalPrevio.toLocaleString() + " del índice." +
            (conflictos.length
                ? "\n\n⚠️ Pero " + conflictos.length + " guías aparecen con " +
                  "houses DISTINTAS. Esas no se tocan: elegir una en silencio " +
                  "es lo que hace que un bulto acabe en el sitio equivocado.\n\n" +
                  conflictos.slice(0, 10).map(c => "   · " + c.guia + ": " +
                      c.houses.join(" / ")).join("\n")
                : ""),
            ui.ButtonSet.OK);
        return;
    }

    let r = ui.alert("🧹 1Z repetidos",
        "Voy a quitar " + aQuitar.toLocaleString() + " renglones repetidos de " +
        totalPrevio.toLocaleString() + ".\n\n" +
        "Solo los que DICEN LO MISMO: misma guía y misma house. De cada grupo " +
        "se queda uno, y se le rescata la fecha y el origen si la primera fila " +
        "no los traía.\n\n" +
        (conflictos.length
            ? "⚠️ " + conflictos.length + " guías salen con houses DISTINTAS. " +
              "Esas NO se tocan: se quedan las dos y te las digo al final.\n\n"
            : "") +
        "¿Sigo?", ui.ButtonSet.YES_NO);
    if (r !== ui.Button.YES) return;

    [HOJA_INDICE_HOUSE, HOJA_INDICE_HOUSE_FRIO].forEach(nombre => {
        if (plan[nombre].quitadas === 0) return;
        escribirIndice(ss, nombre, plan[nombre].limpias);
    });

    // El caché lleva su propia copia guía → house: se olvida para que la
    // próxima búsqueda salga del índice ya limpio.
    try { olvidarMapaHouseEnRAM(); } catch (err) { /* puede no existir */ }

    let msg = "Listo.\n\n   · " + aQuitar.toLocaleString() + " renglones " +
              "repetidos quitados\n   · quedan " +
              (totalPrevio - aQuitar).toLocaleString() + "\n";
    if (conflictos.length) {
        msg += "\n⚠️ Estas " + conflictos.length + " guías siguen dos veces " +
               "porque tienen houses DISTINTAS. Hay que mirarlas a mano:\n" +
               conflictos.slice(0, 20).map(c => "   · " + c.guia + ": " +
                   c.houses.join(" / ")).join("\n") +
               (conflictos.length > 20 ? "\n   …y " + (conflictos.length - 20) + " más." : "");
    }
    ui.alert("🧹 1Z repetidos", msg, ui.ButtonSet.OK);
}

function repararIndiceHouse() {
    const ss = obtenerArchivo();
    const ui = SpreadsheetApp.getUi();
    if (!exigirModoPrueba(ss)) return;

    let r = ui.alert("🧹 Reparar el índice",
        "Voy a quitar del índice todas las houses que no parezcan houses " +
        "—las que traen un renglón entero dentro— y a borrarlas también de las " +
        "pestañas.\n\n" +
        "Las guías NO se pierden: se quedan sin house y el relleno se la vuelve " +
        "a buscar. Pero la house buena que la basura pisó solo vuelve " +
        "reimportando el archivo.\n\n¿Sigo?", ui.ButtonSet.YES_NO);
    if (r !== ui.Button.YES) return;

    let tiradasIndice = 0;
    [HOJA_INDICE_HOUSE, HOJA_INDICE_HOUSE_FRIO].forEach(nombre => {
        let filas = leerIndice(ss, nombre);
        if (!filas.length) return;
        let limpio = filasSinBasura(filas);
        if (limpio.tiradas === 0) return;
        tiradasIndice += limpio.tiradas;
        escribirIndice(ss, nombre, limpio.limpias);
    });

    let borradasHoja = 0;
    ss.getSheets().forEach(hoja => {
        let clave = claveHoja(hoja.getName());
        if (!hojaLlevaHouse(clave)) return;
        let lr = hoja.getLastRow();
        if (lr < 1) return;
        paresDeHouse(clave, hoja.getMaxColumns()).forEach(par => {
            let col = hoja.getRange(1, par.house, lr, 1).getValues();
            let items = [];
            for (let i = 0; i < col.length; i++) {
                let v = String(col[i][0]).trim();
                if (v === "" || !houseSospechosa(v)) continue;
                items.push({ fila: i + 1, valor: "" });
                borradasHoja++;
            }
            bloquesContiguos(items).forEach(b => {
                hoja.getRange(b.fila, par.house, b.valores.length, 1).setValues(b.valores);
            });
        });
    });

    // El caché lleva su propia copia guía → house. Se olvida para que el próximo
    // escaneo no siga pegando la basura desde la memoria.
    try { if (typeof olvidarMapaHouseEnRAM === 'function') olvidarMapaHouseEnRAM(); }
    catch (err) { /* el caché se rehace solo en la siguiente vuelta */ }

    ui.alert("🧹 Reparar el índice",
        "Quitadas del índice: " + tiradasIndice + "\n" +
        "Borradas de las pestañas: " + borradasHoja + "\n\n" +
        (tiradasIndice === 0 && borradasHoja === 0
            ? "No había ninguna house con pinta de renglón mal partido."
            : "Ahora vuelve a importar para recuperar las houses buenas que la " +
              "basura había pisado:\n" +
              "  · desde OneDrive: «☁️ Importar inbound desde OneDrive» y ya está, " +
              "los vínculos se bajan enteros cada vez.\n" +
              "  · desde Drive: primero «♻️ Reimportar todos los CSV», porque si no " +
              "se salta los archivos que ya leyó."),
        ui.ButtonSet.OK);
}

function reintentarHousesNoEncontradas() {
    const ss = obtenerArchivo();
    const ui = SpreadsheetApp.getUi();
    if (!exigirModoPrueba(ss)) return;
    let limpiadas = limpiarMarcasNoEncontradas(ss);
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

    // Si la red de seguridad ya corre, el relleno viaja con ella y NO hace falta
    // un disparador propio. Google limita el tiempo total de disparadores por
    // cuenta al día y al agotarse los desactiva todos —incluido el del escaneo—:
    // dos despertares cada cinco minutos para el mismo viaje es pagar doble.
    let yaHayActualizador = ScriptApp.getProjectTriggers()
        .some(t => t.getHandlerFunction() === 'actualizadorAutomaticoGlobal');

    quitarTriggerHouse(true);

    if (yaHayActualizador) {
        ui.alert("🏠 Houses",
            "No hace falta un disparador aparte: el relleno ya viaja con el " +
            "actualizador automático, que corre cada 5 minutos.\n\n" +
            "Así Google cuenta UN disparador en vez de dos. Si se agota la cuota " +
            "diaria de disparadores, Google los desactiva todos — incluido el del " +
            "escaneo.\n\n" +
            "Para espaciar las houses sin tocar disparadores, sube " +
            "MINUTOS_ENTRE_RELLENOS en House.gs (ahora " + MINUTOS_ENTRE_RELLENOS +
            ").", ui.ButtonSet.OK);
        return;
    }

    ScriptApp.newTrigger('rellenarHousesPendientes').timeBased()
        .everyMinutes(MINUTOS_ENTRE_RELLENOS).create();
    ui.alert("🏠 Houses",
        "Listo: las houses se rellenarán solas cada " + MINUTOS_ENTRE_RELLENOS +
        " minutos.\n\nSi instalas el trigger avanzado, este disparador sobra: el " +
        "relleno viajará con el actualizador automático y Google contará uno en " +
        "vez de dos.", ui.ButtonSet.OK);
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
