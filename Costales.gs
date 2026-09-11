// =========================================================================
// TRAER LOS COSTALES A LA UNIDAD
// =========================================================================
//
// QUÉ HACE. Un botón que abre el archivo del cuadre de bolsas, busca la pestaña
// de esta unidad y pega sus bloques —pedimento y sus guías— AL FINAL de la
// columna A de la pestaña actual.
//
// POR QUÉ NO HAY QUE TOCAR EL MOTOR. Lo pegado es un bloque de la columna A como
// cualquier otro, así que todo lo demás sale solo: entra al índice del caché,
// recibe su estado en la B, RECIBE SU HOUSE en la C —que es el motivo principal
// de querer esto—, cuenta en los totales y choca como duplicado si esa guía está
// en otra pestaña. Este archivo solo escribe en la columna A; nada más.
//
// EL CUADRE NO SE TOCA. Se abre en modo lectura y no se le escribe ni una celda.
//
// -------------------------------------------------------------------------
// LA FORMA DEL CUADRE
// -------------------------------------------------------------------------
// Cada pestaña del cuadre lleva CINCO pares de columnas, uno por destino:
//
//   A/B  GLOBAL H     C/D  EXCENTO H     E/F  GLOBAL G
//   G/H  EXCENTO G    I/J  ESLAM
//
// En cada par, la columna impar es la guía y la par es el RESUMEN que escribe
// su propio script. El PEDIMENTO encabeza su columna (fila 2) y debajo van sus
// guías, que es la misma dirección que la columna A de este archivo.
//
// De ahí solo se leen las columnas de guías. Los resúmenes, la tabla de totales
// (K:L) y la lista de retenidas (M) NO se traen: se pidió expresamente.
// =========================================================================

// Las cinco columnas de guías del cuadre, 1-based.
const COLS_GUIA_CUADRE = [1, 3, 5, 7, 9];

// Hasta dónde se lee una pestaña del cuadre. Con margen de sobra sobre lo que
// cabe en un día, y acotado para que un archivo con filas basura al final no
// convierta esto en una lectura de cien mil celdas.
const FILAS_MAX_CUADRE = 5000;

const PROP_ID_CUADRE = 'COSTALES_ID_CUADRE';

// El sufijo de la pestaña «hermana». Una unidad puede repartirse en dos
// pestañas del cuadre y las dos tienen que venir.
const SUFIJO_COMPLEMENTO = "COMPLEMENTO";

// -------------------------------------------------------------------------
// EMPAREJAR PESTAÑAS
// -------------------------------------------------------------------------

// Nombre de pestaña comparable, SIN ESPACIOS.
//
// `claveHoja` solo hace trim y toUpperCase, y en este archivo conviven las dos
// formas: la pestaña real se llama «Global1» (sin espacio) mientras que en el
// cuadre se escribe «Global 1». Comparando con `claveHoja` no casarían, el botón
// no encontraría nada, y NO HABRÍA FORMA DE VERLO: los dos nombres se ven
// idénticos en pantalla.
function claveSinEspacios(nombre) {
    return claveHoja(nombre).replace(/\s+/g, "");
}

// El nombre partido en trozos comparables.
//
// Se parte por espacios Y por el salto de letra a número, porque las dos formas
// conviven: la pestaña real de Salidas se llama «Global 1 LG30474 …» y la del
// cuadre «Global1» o «Global 1». Sin partir por ese salto, «GLOBAL1» sería un
// solo trozo y no casaría con [GLOBAL, 1].
//
// Partir en trozos —y no comparar cadenas— es lo que salva el caso de verdad
// peligroso: «GLOBAL1» es prefijo de la cadena «GLOBAL10», así que comparando
// texto pelado la unidad 1 se llevaría los costales de la 10. Como trozos,
// [GLOBAL,1] y [GLOBAL,10] no se parecen en nada.
function trozosDeNombre(nombre) {
    return claveHoja(nombre)
        .replace(/[^A-Z0-9]+/gi, " ")
        .replace(/([A-Z])(\d)/gi, "$1 $2")
        .replace(/(\d)([A-Z])/gi, "$1 $2")
        .split(/\s+/)
        .filter(t => t !== "");
}

// ¿Los trozos de `corta` son el principio de los de `larga`?
function empiezaPorLosTrozos(larga, corta) {
    if (corta.length === 0 || corta.length > larga.length) return false;
    for (let i = 0; i < corta.length; i++) {
        if (larga[i] !== corta[i]) return false;
    }
    return true;
}

// ¿Esta pestaña del cuadre le toca a esta unidad?
//
// La pestaña de Salidas lleva cosas detrás del nombre de la unidad —«Global 1
// LG30474 …»— y la del cuadre no. Así que manda el nombre CORTO: el del cuadre
// tiene que ser el principio del de Salidas, trozo a trozo.
//
// Las FECHAS SE IGNORAN por decisión del usuario: él renombra a mano las
// pestañas del cuadre para que lo que salga ese día se llame como la unidad.
// Y en Salidas la fecha o la placa van DETRÁS, así que sobran solas.
function pestanaDeLaUnidad(nombreCuadre, nombreUnidad) {
    return tipoDePestanaDelCuadre(nombreCuadre, nombreUnidad) !== "";
}

// "" si no es de esta unidad, "principal" o "complemento" si lo es.
function tipoDePestanaDelCuadre(nombreCuadre, nombreUnidad) {
    let u = trozosDeNombre(nombreUnidad);
    let c = trozosDeNombre(nombreCuadre);
    if (u.length === 0 || c.length === 0) return "";

    let esComplemento = c[c.length - 1] === SUFIJO_COMPLEMENTO;
    if (esComplemento) c = c.slice(0, c.length - 1);
    if (c.length === 0) return "";

    return empiezaPorLosTrozos(u, c) ? (esComplemento ? "complemento" : "principal") : "";
}

// Las pestañas del cuadre que hay que traer, en orden: primero la de la unidad
// y después su complemento. Nada más: si el cuadre tiene veinte pestañas, solo
// salen estas dos.
function pestanasACopiar(nombresDelCuadre, nombreUnidad) {
    let principal = [], complemento = [];
    (nombresDelCuadre || []).forEach(n => {
        let t = tipoDePestanaDelCuadre(n, nombreUnidad);
        if (t === "principal") principal.push(n);
        else if (t === "complemento") complemento.push(n);
    });
    return principal.concat(complemento);
}

// -------------------------------------------------------------------------
// LEER LOS BLOQUES
// -------------------------------------------------------------------------

// De la rejilla de una pestaña del cuadre a bloques {pedimento, guias}.
//
// Se recorre columna por columna, y dentro de cada una el pedimento ABRE su
// bloque. Se acepta más de un pedimento por columna aunque hoy solo haya uno:
// soportarlo no cuesta nada y evita que el día que alguien meta dos, sus guías
// se le cuelguen al pedimento equivocado en silencio.
//
// LO QUE ESTÁ MAL ESCRITO TAMBIÉN SE TRAE. Antes se quedaba fuera y solo se
// mencionaba en el diálogo del final, que es un papel que se cierra y se
// olvida: la guía mala seguía en el cuadre, nadie la arreglaba, y el bulto no
// aparecía en ninguna parte. Trayéndola, el motor la pinta «❌ Guía Inválida»
// en rojo en su sitio, y se corrige escribiendo encima como cualquier escaneo.
//
// La fila 1 del cuadre son TÍTULOS («GLOBAL H», «EXCENTO H»…), no escaneos. Los
// escaneos empiezan en la 2. Se salta por número de fila y no dejando que
// `esGuiaUPSValida` los rechace, porque rechazarlos los contaría como valores
// descartados y el informe del final acusaría de basura a los encabezados.
const FILA_INICIO_CUADRE = 2;

// La cabecera del grupo de las que no cuelgan de ningún pedimento.
//
// Lleva «SIN PEDIMENTO» dentro a propósito: `esMarcadorEstructural` reconoce
// eso, así que el motor la trata como cabecera de bloque y no como una captura
// mal escrita. Sin ella, esas guías se colgarían del último pedimento del
// volcado, que no es el suyo.
const MARCA_SIN_PEDIMENTO = "SIN PEDIMENTO (COSTALES)";

function bloquesDelCuadre(datos) {
    let bloques = [];
    let invalidas = [];      // no son ninguno de los tres formatos válidos
    let sinPedimento = [];   // no cuelgan de ningún pedimento
    if (!datos || datos.length === 0) {
        return { bloques: bloques, invalidas: invalidas, sinPedimento: sinPedimento,
                 sueltas: [], descartadas: 0 };
    }

    COLS_GUIA_CUADRE.forEach(col => {
        let c = col - 1;
        if (c >= (datos[0] || []).length) return;
        let actual = null;

        for (let r = FILA_INICIO_CUADRE - 1; r < datos.length; r++) {
            let bruto = (datos[r] || [])[c];
            if (bruto === "" || bruto === null || bruto === undefined) continue;
            let v = String(bruto).trim().toUpperCase();
            if (v === "") continue;

            if (/^\d{7}$/.test(v)) {
                if (actual && actual.guias.length > 0) bloques.push(actual);
                actual = { pedimento: v, guias: [] };
                continue;
            }
            // Marcadores sueltos del script del cuadre: ni guía ni basura.
            if (esMarcadorEstructural(v)) continue;

            // Se guarda CUÁL era y DÓNDE estaba, además de traerla. Un contador
            // a secas obliga a buscarla a mano en cinco columnas de mil filas.
            if (!esGuiaUPSValida(v)) invalidas.push({ valor: v, fila: r + 1, columna: col });

            if (!actual) {
                sinPedimento.push({ valor: v, fila: r + 1, columna: col });
                continue;
            }
            if (actual.guias.indexOf(v) === -1) actual.guias.push(v);
        }
        if (actual && actual.guias.length > 0) bloques.push(actual);
    });

    // Las sueltas, sin repetir y en el orden en que aparecieron.
    let vistas = new Set();
    let sueltas = [];
    sinPedimento.forEach(d => {
        if (vistas.has(d.valor)) return;
        vistas.add(d.valor);
        sueltas.push(d.valor);
    });

    return { bloques: bloques, invalidas: invalidas, sinPedimento: sinPedimento,
             sueltas: sueltas, descartadas: invalidas.length + sinPedimento.length };
}

// La letra de una columna del cuadre, para poder decir «C7» en vez de «fila 7
// de la tercera columna de guías».
function letraDeColumna(col) {
    let n = Number(col) || 0;
    let s = "";
    while (n > 0) {
        let r = (n - 1) % 26;
        s = String.fromCharCode(65 + r) + s;
        n = Math.floor((n - 1) / 26);
    }
    return s;
}

// El informe de lo que NO se cargó, con nombre y celda.
//
// Se corta a `tope` entradas: un cuadre con doscientas líneas raras haría un
// diálogo que no cabe en la pantalla y que además nadie lee.
function textoDeDescartes(lista, tope) {
    let max = tope || 12;
    let l = lista || [];
    let out = l.slice(0, max).map(d =>
        "   · " + letraDeColumna(d.columna) + d.fila + ":  " + d.valor);
    if (l.length > max) out.push("   …y " + (l.length - max) + " más.");
    return out.join("\n");
}

// -------------------------------------------------------------------------
// QUÉ SE PEGA Y DÓNDE
// -------------------------------------------------------------------------

// Los pedimentos que YA están en la columna A de la unidad.
//
// Es lo que hace el botón idempotente. Sin esto, apretarlo dos veces pega todo
// otra vez y llena la hoja de duplicados de verdad —los de un doble escaneo—,
// que es peor que no haberlo apretado.
function pedimentosYaEnLaHoja(colA) {
    let set = new Set();
    (colA || []).forEach(f => {
        let v = String((f || [])[0]).trim().toUpperCase();
        if (/^\d{7}$/.test(v)) set.add(v);
    });
    return set;
}

// Todo lo que ya hay escrito en la columna A, sea lo que sea.
//
// Hace falta aparte de los pedimentos por las guías SUELTAS: como no cuelgan de
// ninguno, el salto por pedimento no las cubre y apretar el botón dos veces las
// pegaría otra vez. Se comparan una a una contra lo que ya hay.
function valoresYaEnLaHoja(colA) {
    let set = new Set();
    (colA || []).forEach(f => {
        let v = String((f || [])[0]).trim().toUpperCase();
        if (v !== "") set.add(v);
    });
    return set;
}

// Arma lo que se va a escribir: un renglón en blanco y después los bloques,
// pegados uno tras otro.
//
// UN SOLO renglón en blanco, antes del primero. Entre bloques NO, porque el
// pedimento ya abre bloque por sí mismo y un hueco de más solo alarga la hoja.
//
// Las que no cuelgan de ningún pedimento van AL FINAL, bajo su cabecera. Van
// aparte y no pegadas al último bloque porque colgarlas de un pedimento que no
// es el suyo es peor que dejarlas sueltas: se contarían como bultos de él.
//
// Devuelve {filas, pegados, saltados, sueltas}: `saltados` son los pedimentos
// que ya estaban, y hay que decirlos en vez de callarlos —si alguien esperaba
// ver un bloque y no aparece, tiene que saber por qué—.
function filasParaPegar(bloques, yaEstan, sueltas, valoresYaEstan) {
    let filas = [];
    let pegados = [], saltados = [], sueltasPegadas = [];

    (bloques || []).forEach(b => {
        if (yaEstan && yaEstan.has(b.pedimento)) { saltados.push(b.pedimento); return; }
        if (filas.length === 0) filas.push([""]);      // el único hueco
        filas.push([b.pedimento]);
        b.guias.forEach(g => filas.push([g]));
        pegados.push(b.pedimento);
    });

    (sueltas || []).forEach(g => {
        if (valoresYaEstan && valoresYaEstan.has(g)) return;
        sueltasPegadas.push(g);
    });

    if (sueltasPegadas.length > 0) {
        if (filas.length === 0) filas.push([""]);
        filas.push([MARCA_SIN_PEDIMENTO]);
        sueltasPegadas.forEach(g => filas.push([g]));
    }

    return { filas: filas, pegados: pegados, saltados: saltados,
             sueltas: sueltasPegadas };
}

// -------------------------------------------------------------------------
// EL VÍNCULO AL ARCHIVO DEL CUADRE
// -------------------------------------------------------------------------

// El ID va en una propiedad, no en el código.
//
// Mismo criterio que los vínculos de OneDrive: este proyecto está en un
// repositorio de git, y un identificador pegado aquí queda en el historial para
// siempre. Además el cuadre puede cambiar de archivo el año que viene, y
// entonces esto sería una línea de código en vez de un botón.
function idDelCuadre() {
    try {
        return PropertiesService.getScriptProperties().getProperty(PROP_ID_CUADRE) || "";
    } catch (err) { return ""; }
}

// Saca el ID de una URL de Sheets, o acepta el ID pelado.
function idDesdeUrl(texto) {
    let t = String(texto === undefined || texto === null ? "" : texto).trim();
    if (t === "") return "";
    let m = t.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
    if (m) return m[1];
    // Un ID suelto: son largos y sin barras. Exigir eso evita guardar por error
    // media URL, que fallaría después con un mensaje que no dice nada.
    if (/^[a-zA-Z0-9_-]{20,}$/.test(t)) return t;
    return "";
}

function vincularArchivoDeCostales() {
    const ss = obtenerArchivo();
    const ui = SpreadsheetApp.getUi();

    let actual = idDelCuadre();
    let r = ui.prompt("🔗 Archivo de costales",
        (actual === "" ? "No hay ninguno vinculado todavía."
                       : "Vinculado ahora:\n" + actual) + "\n\n" +
        "Pega la URL del archivo del cuadre de bolsas:",
        ui.ButtonSet.OK_CANCEL);
    if (r.getSelectedButton() !== ui.Button.OK) return;

    let id = idDesdeUrl(r.getResponseText());
    if (id === "") {
        ui.alert("🔗 Archivo de costales",
                 "Eso no parece una URL de Hojas de cálculo.", ui.ButtonSet.OK);
        return;
    }

    // Se comprueba AQUÍ que se puede abrir, no el día que alguien aprieta el
    // botón en el muelle. Un vínculo que no sirve tiene que fallar al guardarlo.
    let nombre = "";
    try { nombre = SpreadsheetApp.openById(id).getName(); }
    catch (err) {
        ui.alert("🔗 Archivo de costales",
            "No pude abrirlo:\n" + err + "\n\n" +
            "Comprueba que esta cuenta tenga acceso a ese archivo.", ui.ButtonSet.OK);
        return;
    }

    PropertiesService.getScriptProperties().setProperty(PROP_ID_CUADRE, id);
    ui.alert("🔗 Archivo de costales",
             "Vinculado: " + nombre + "\n\nYa puedes usar «📦 Traer los costales " +
             "de esta unidad».", ui.ButtonSet.OK);
}

// -------------------------------------------------------------------------
// EL BOTÓN
// -------------------------------------------------------------------------

function traerCostalesDeEstaUnidad() {
    const ui = SpreadsheetApp.getUi();
    const ssActivo = SpreadsheetApp.getActiveSpreadsheet();
    const nombreUnidad = ssActivo.getActiveSheet().getName();

    if (esHojaSistema(claveHoja(nombreUnidad))) {
        ui.alert("📦 Costales", "Esta pestaña es del sistema. Colócate en la " +
                 "unidad a la que quieres traer los costales.", ui.ButtonSet.OK);
        return;
    }

    let id = idDelCuadre();
    if (id === "") {
        ui.alert("📦 Costales",
                 "No hay ningún archivo de costales vinculado.\n\n" +
                 "Usa «🔗 Vincular el archivo de costales» primero.", ui.ButtonSet.OK);
        return;
    }

    // Abrir el cuadre va FUERA del lock: es lo más lento de todo esto y no toca
    // nada de este archivo. Tener el lock tomado mientras se espera a otro
    // Sheets bloquearía los escaneos de siete personas sin motivo.
    let cuadre;
    try { cuadre = SpreadsheetApp.openById(id); }
    catch (err) {
        ui.alert("📦 Costales", "No pude abrir el archivo de costales:\n" + err,
                 ui.ButtonSet.OK);
        return;
    }

    let nombres = cuadre.getSheets().map(h => h.getName());
    let aCopiar = pestanasACopiar(nombres, nombreUnidad);
    if (aCopiar.length === 0) {
        // Se dice QUÉ se buscó y QUÉ hay. Un «no encontré nada» a secas deja al
        // usuario mirando dos listas de nombres casi iguales.
        ui.alert("📦 Costales",
            "No encontré ninguna pestaña para «" + nombreUnidad + "» en " +
            cuadre.getName() + ".\n\n" +
            "Busqué «" + nombreUnidad + "» y «" + nombreUnidad + " complemento» " +
            "(sin distinguir espacios ni mayúsculas).\n\n" +
            "Pestañas que hay ahí:\n" + nombres.slice(0, 20).join("\n") +
            (nombres.length > 20 ? "\n…y " + (nombres.length - 20) + " más." : ""),
            ui.ButtonSet.OK);
        return;
    }

    // Leer las pestañas del cuadre, también fuera del lock.
    let bloques = [], invalidas = [], sinPedimento = [], sueltas = [], leidas = [];
    try {
        aCopiar.forEach(n => {
            let h = cuadre.getSheetByName(n);
            if (!h) return;
            let lr = Math.min(Math.max(h.getLastRow(), 1), FILAS_MAX_CUADRE);
            let lc = Math.max(h.getLastColumn(), 1);
            let ancho = Math.min(lc, COLS_GUIA_CUADRE[COLS_GUIA_CUADRE.length - 1]);
            let datos = h.getRange(1, 1, lr, ancho).getValues();
            let r = bloquesDelCuadre(datos);
            r.bloques.forEach(b => bloques.push(b));
            r.sueltas.forEach(g => { if (sueltas.indexOf(g) === -1) sueltas.push(g); });
            // La pestaña se nombra en cada aviso: con la principal y su
            // complemento leídas juntas, «C7» a secas sería ambiguo.
            r.invalidas.forEach(d => invalidas.push({ valor: d.valor, fila: d.fila,
                columna: d.columna, hoja: n }));
            r.sinPedimento.forEach(d => sinPedimento.push({ valor: d.valor, fila: d.fila,
                columna: d.columna, hoja: n }));
            leidas.push(n);
        });
    } catch (err) {
        ui.alert("📦 Costales", "Fallo leyendo el cuadre:\n" + err, ui.ButtonSet.OK);
        return;
    }

    if (bloques.length === 0 && sueltas.length === 0) {
        ui.alert("📦 Costales",
            "Leí " + leidas.join(", ") + " y esas columnas están vacías.",
            ui.ButtonSet.OK);
        return;
    }

    let totalGuias = bloques.reduce((n, b) => n + b.guias.length, 0) + sueltas.length;
    let aviso = "De " + leidas.join(" + ") + " voy a traer:\n\n" +
        "   · " + bloques.length + " pedimentos\n" +
        "   · " + totalGuias + " renglones de guía\n";
    if (invalidas.length) {
        aviso += "   · de esos, " + invalidas.length + " están MAL ESCRITOS y se " +
                 "traen igual, marcados en rojo para corregirlos aquí\n";
    }
    if (sueltas.length) {
        aviso += "   · y " + sueltas.length + " sin pedimento, que van al final " +
                 "bajo «" + MARCA_SIN_PEDIMENTO + "»\n";
    }
    aviso += "\nSe pegan al FINAL de «" + nombreUnidad + "», detrás de un renglón " +
             "en blanco. El archivo de costales NO se toca.\n\n" +
             "Los pedimentos que ya estén en esta pestaña se saltan.\n\n¿Sigo?";
    let r = ui.alert("📦 Costales", aviso, ui.ButtonSet.YES_NO);
    if (r !== ui.Button.YES) return;

    // A PARTIR DE AQUÍ SÍ, CON EL LOCK. Se escribe en la columna A, que es
    // columna de captura: hacerlo mientras alguien escanea es la única forma de
    // perder un escaneo en este sistema.
    let resultado = null;
    conLock(ss => {
        let hoja = ss.getSheetByName(nombreUnidad);
        if (!hoja) { resultado = { error: "La pestaña ya no existe." }; return; }

        // El último dato se lee DENTRO del lock: entre la confirmación y este
        // punto puede haber entrado un escaneo más.
        let lr = Math.max(hoja.getLastRow(), 0);
        let colA = lr > 0 ? hoja.getRange(1, 1, lr, 1).getValues() : [];
        let plan = filasParaPegar(bloques, pedimentosYaEnLaHoja(colA),
                                  sueltas, valoresYaEnLaHoja(colA));

        // Marcar TODAS las guías leídas del cuadre, no solo las que se pegan
        // ahora, y ANTES de decidir si hay algo que pegar.
        //
        // Incluir las saltadas es lo que arregla el caso de después de
        // «Reconstruir caché completo», que borra la hoja del caché y con ella
        // esta columna: al volver a apretar el botón no se pega nada —ya está
        // todo— pero las marcas vuelven a su sitio. Si solo se marcara lo
        // pegado, esas filas se quedarían para siempre pareciendo escaneos.
        let todasLasGuias = [];
        bloques.forEach(b => b.guias.forEach(g => todasLasGuias.push(g)));
        sueltas.forEach(g => todasLasGuias.push(g));
        guardarCostalesEnCache(ss, todasLasGuias);

        if (plan.filas.length === 0) {
            // Aun sin pegar nada hay que recalcular: las marcas que se acaban de
            // reponer no salen en la columna B hasta que alguien repinte.
            invalidarCacheRAM();
            recalcularHoja(hoja, ss, getCacheData(ss), null, false, false);
            resultado = { nada: true, saltados: plan.saltados };
            return;
        }

        let desde = lr + 1;
        asegurarFilas(hoja, desde + plan.filas.length + MARGEN_FILAS);
        hoja.getRange(desde, 1, plan.filas.length, 1).setValues(plan.filas);

        // El script escribiendo NO dispara onEdit, así que el recálculo hay que
        // pedirlo. Sin esto las guías se quedan sin estado y la red de seguridad
        // tardaría hasta cinco minutos en recogerlas.
        actualizarFotografiaMental(hoja, ss);
        invalidarCacheRAM();
        let cacheInfo = getCacheData(ss);
        recalcularHoja(hoja, ss, cacheInfo, null, false, false);
        // Si alguien aprieta el botón sobre un inventario, las guías nuevas
        // tienen que bajar a las pestañas que las esperan. Es el mismo remate
        // que hace «Forzar Actualización»; sin él quedarían solo aquí.
        if (esHojaInventario(claveHoja(nombreUnidad))) {
            sincronizarInventariosAfectados(ss, cacheInfo, null, claveHoja(nombreUnidad));
        }

        resultado = { pegados: plan.pegados, saltados: plan.saltados,
                      sueltas: plan.sueltas, filas: plan.filas.length, desde: desde };
    });

    if (!resultado) { ui.alert("📦 Costales", "No se pudo tomar el archivo. Inténtalo otra vez.", ui.ButtonSet.OK); return; }
    if (resultado.error) { ui.alert("📦 Costales", resultado.error, ui.ButtonSet.OK); return; }

    // El aviso de lo que viene mal escrito va en las DOS salidas, la de «no pegué
    // nada» y la de «listo». Dice DÓNDE estaba en el cuadre —«C7»— porque
    // arreglarlo del todo pide tocar también el cuadre, no solo esta hoja.
    let ojo = "";
    if (invalidas.length) {
        ojo += "\n🚫 MAL ESCRITAS en el cuadre (" + invalidas.length + "). Están " +
               "pegadas aquí y marcadas en rojo; en el cuadre siguen mal:\n" +
               textoDeDescartes(invalidas) + "\n";
    }
    if (sinPedimento.length) {
        ojo += "\n❓ SIN PEDIMENTO en el cuadre (" + sinPedimento.length + "). Van " +
               "al final, bajo «" + MARCA_SIN_PEDIMENTO + "»:\n" +
               textoDeDescartes(sinPedimento) + "\n";
    }
    ojo += "\nRecuerda los tres formatos: 7 dígitos el pedimento, 11 dígitos la " +
           "guía corta, 18 caracteres la 1Z. Cualquier otra cosa sale en rojo.\n";

    if (resultado.nada) {
        ui.alert("📦 Costales",
            "No se pegó nada: esos " + resultado.saltados.length + " pedimentos ya " +
            "estaban en esta pestaña.\n\n" + resultado.saltados.join(", ") + "\n" +
            ojo,
            ui.ButtonSet.OK);
        return;
    }

    let msg = "Listo.\n\n" +
        "   · " + resultado.pegados.length + " pedimentos pegados desde la fila " +
        resultado.desde + "\n" +
        "   · " + (resultado.filas - 1) + " renglones en total\n";
    if (resultado.sueltas.length) {
        msg += "   · " + resultado.sueltas.length + " sin pedimento, al final\n";
    }
    if (resultado.saltados.length) {
        msg += "\n⏭️ Saltados por estar ya en la hoja (" + resultado.saltados.length +
               "):\n" + resultado.saltados.join(", ") + "\n";
    }
    msg += ojo;
    msg += "\nEstas filas salen marcadas como «" + TXT_COSTAL + "» en la columna B, " +
           "para que no se confundan con un escaneo de esta unidad. Si además " +
           "están repetidas o retenidas, el aviso sale detrás de la marca.\n";
    // Que nadie piense que falló: la house de estas guías NO sale al instante.
    msg += "\nLas HOUSE no aparecen de inmediato: al escanear salen del caché en " +
           "el momento, pero estas las escribió el script. Las pone el relleno " +
           "automático en el próximo minuto.";
    ui.alert("📦 Costales", msg, ui.ButtonSet.OK);
}
