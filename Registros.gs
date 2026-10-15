// =========================================================================
// REGISTROS: LO QUE TIENE QUE QUEDAR APUNTADO
// =========================================================================
//
// Lo que tiene que quedar apuntado para mirarlo después:
//
//   · SIS_TIEMPOS_REGISTRO — cada pedimento final, con la hora en que se
//     escaneó, y la llegada de cada bloque. Solo crece. Los papeles llegan por
//     tandas —diez, luego cincuenta…— y esto es lo que permite medirlas.
//
//   · SIS_TIEMPOS_PEDIMENTOS — el REPORTE que sale del registro, agrupado por
//     día y por unidad, con cada bloque resumido (cuántos, desde, hasta,
//     minutos) y sus pedimentos debajo. Se rehace, no se escribe a mano.
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

// El registro crudo, que solo crece, y el reporte agrupado que sale de él.
//
// El reporte se llama como se llamaba antes el registro, a propósito: es la
// hoja que se mira. El crudo se mudó a SIS_TIEMPOS_REGISTRO; lo que hubiera
// en la vieja se pasa allí solo la primera vez (`mudarRegistroDeTiemposViejo`).
const HOJA_SIS_TIEMPOS = "SIS_TIEMPOS_REGISTRO";
const HOJA_SIS_TIEMPOS_REPORTE = "SIS_TIEMPOS_PEDIMENTOS";
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
    // El reporte agrupado sale de aquí: queda pendiente de rehacer.
    if (nombre === HOJA_SIS_TIEMPOS) marcarReporteDeTiemposPendiente();
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

// -------------------------------------------------------------------------
// EL REPORTE DE TIEMPOS, AGRUPADO POR UNIDAD
// -------------------------------------------------------------------------
//
// El registro va en el orden en que se escanea: con varias unidades a la vez,
// sus pedimentos salen mezclados y no hay forma de leer «cuánto tardó la
// GLOBAL 1». El reporte los junta:
//
//   🚚 GLOBAL 1 20-AE-3H   14/10/2026  10:03   66   10:04   11:20   76   2 bloques
//   📦 BLOQUE 1            14/10/2026  10:03   10   10:04   10:07    3
//      6116004             14/10/2026  10:04                            ✅ ESTÁ EN LA UNIDAD · Patente 6087
//      …
//
// LA FECHA Y LA HORA VAN EN COLUMNAS APARTE, a petición: así se filtra por
// día y se lee la hora sin la fecha delante. Las dos columnas llevan el mismo
// valor con distinto formato; partirlo a mano (medianoche para la fecha)
// saldría un día antes si el script y el archivo tienen zonas horarias
// distintas.
//
// NO SE REHACE EN CADA ESCANEO: sería releer y reescribir días de registro por
// cada papel, y los papeles llegan de cincuenta en cincuenta. Se rehace con
// WMSACT en PEDIMENTOS FINALES, con su botón del menú, y solo en el repaso de
// cinco minutos si entró algo nuevo.
//
// Solo los últimos días: el registro crudo lo guarda todo, pero un reporte de
// meses tardaría en rehacerse y nadie lo lee.
const DIAS_REPORTE_TIEMPOS = 7;
const FILAS_MAX_LEIDAS_TIEMPOS = 6000;
const CABECERA_REPORTE_TIEMPOS = ["UNIDAD / BLOQUE / PEDIMENTO", "FECHA", "HORA", "PEDIMENTOS",
                                  "DESDE", "HASTA", "MINUTOS", "DETALLE"];
const COLOR_REPORTE_UNIDAD = '#c9daf8';
const COLOR_REPORTE_BLOQUE = '#d9ead3';
const CLAVE_TIEMPOS_PENDIENTE = 'WMS_TIEMPOS_PENDIENTE';

function marcarReporteDeTiemposPendiente() {
    try { CacheService.getScriptCache().put(CLAVE_TIEMPOS_PENDIENTE, '1', 21600); } catch (err) { /* el repaso lo rehará igual con WMSACT */ }
}
function reporteDeTiemposPendiente() {
    try { return CacheService.getScriptCache().get(CLAVE_TIEMPOS_PENDIENTE) === '1'; } catch (err) { return false; }
}

function minutosEntre(a, b) { return Math.round((b - a) / 60000); }
function esFechaValida(v) { return v instanceof Date && !isNaN(v.getTime()); }
function claveDeDia(d) { return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); }
function numeroDeBloque(etiqueta) {
    let m = /(\d+)/.exec(String(etiqueta || ""));
    return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

// Del registro crudo al reporte. Puro.
//
// `filas` son las del registro: [fecha, unidad, pedimento, resultado, patente,
// bloque]. Las de llegada de un bloque traen el pedimento vacío. Devuelve las
// filas del reporte (8 columnas, ver CABECERA_REPORTE_TIEMPOS) y el tipo de
// cada una, para pintarlas.
function construirReporteDeTiempos(filas, desde) {
    let dias = new Map();   // clave de día → Map(unidad → grupo)
    (filas || []).forEach(f => {
        let fecha = f[0];
        if (!esFechaValida(fecha) || (desde && fecha < desde)) return;
        let unidad = String(f[1] || "(sin unidad)").trim() || "(sin unidad)";
        let ped = String(f[2] === undefined || f[2] === null ? "" : f[2]).trim();
        let bloque = String(f[5] || "").trim() || "(sin bloque)";
        let kd = claveDeDia(fecha);
        if (!dias.has(kd)) dias.set(kd, new Map());
        let porUnidad = dias.get(kd);
        if (!porUnidad.has(unidad)) {
            porUnidad.set(unidad, { unidad: unidad, primera: fecha, bloques: new Map(), vistos: new Set() });
        }
        let g = porUnidad.get(unidad);
        if (fecha < g.primera) g.primera = fecha;
        if (!g.bloques.has(bloque)) g.bloques.set(bloque, { etiqueta: bloque, llego: null, peds: [] });
        let b = g.bloques.get(bloque);
        if (ped === "") {
            // La llegada del bloque. Si se apuntó dos veces, vale la primera.
            if (!b.llego || fecha < b.llego) b.llego = fecha;
            return;
        }
        // Un pedimento escaneado dos veces en la misma unidad el mismo día
        // cuenta una: vale la primera hora, que es cuando llegó el papel.
        if (g.vistos.has(ped)) return;
        g.vistos.add(ped);
        b.peds.push({ ped: ped, hora: fecha, resultado: String(f[3] || ""), patente: String(f[4] || "") });
    });

    let out = [], tipos = [];
    Array.from(dias.keys()).sort((a, b) => b - a).forEach(kd => {
        let grupos = Array.from(dias.get(kd).values()).sort((a, b) => a.primera - b.primera);
        grupos.forEach(g => {
            // LOS BLOQUES POR TIEMPO, NO POR NÚMERO. Se pidió así: el número es
            // el orden en la pestaña, y la pestaña se arregla a mano —un BLOQUE
            // metido después encima de papeles que ya estaban—. Lo que se quiere
            // medir es cuándo pasó cada tanda. Cada bloque empieza en lo primero
            // que se ve de él: su llegada o su primer papel, lo que fue antes.
            // Los que no tienen ninguna hora van al final, por número.
            let inicioDe = (b) => {
                let horas = b.peds.map(p => p.hora.getTime());
                if (b.llego) horas.push(b.llego.getTime());
                return horas.length ? Math.min.apply(null, horas) : Infinity;
            };
            let bloques = Array.from(g.bloques.values())
                .sort((a, b) => (inicioDe(a) - inicioDe(b)) ||
                                (numeroDeBloque(a.etiqueta) - numeroDeBloque(b.etiqueta)));
            let todas = [];
            bloques.forEach(b => b.peds.forEach(p => todas.push(p.hora)));
            todas.sort((a, b) => a - b);
            let total = todas.length;
            let conBloque = bloques.filter(b => b.etiqueta !== "(sin bloque)").length;
            out.push(["🚚 " + g.unidad, g.primera, g.primera, total,
                      total ? todas[0] : "", total ? todas[total - 1] : "",
                      total ? minutosEntre(todas[0], todas[total - 1]) : "",
                      conBloque ? conBloque + (conBloque === 1 ? " bloque" : " bloques") : ""]);
            tipos.push("unidad");
            let anterior = null;   // {etiqueta, fin} del bloque de arriba
            bloques.forEach(b => {
                let hs = b.peds.map(p => p.hora).sort((a, c) => a - c);
                let n = hs.length;
                // La misma frase que la pestaña: nada en el primero, y del
                // segundo en adelante el hueco con el anterior. Ver
                // `textoDeEsperaDeBloque`.
                let espera = (typeof textoDeEsperaDeBloque === 'function')
                    ? textoDeEsperaDeBloque(anterior === null, b.llego, hs[0],
                                            anterior ? anterior.fin : null,
                                            anterior ? anterior.etiqueta : "")
                    : "";
                out.push(["📦 " + b.etiqueta, b.llego || "", b.llego || "", n,
                          n ? hs[0] : "", n ? hs[n - 1] : "", n ? minutosEntre(hs[0], hs[n - 1]) : "",
                          espera]);
                anterior = { etiqueta: b.etiqueta, fin: n ? hs[n - 1] : null };
                tipos.push("bloque");
                b.peds.slice().sort((a, c) => a.hora - c.hora).forEach(p => {
                    out.push(["   " + p.ped, p.hora, p.hora, "", "", "", "",
                              p.resultado + (p.patente ? " · Patente " + p.patente : "")]);
                    tipos.push("pedimento");
                });
            });
            out.push(["", "", "", "", "", "", "", ""]);
            tipos.push("vacia");
        });
    });
    return { filas: out, tipos: tipos };
}

// EL REGISTRO, CUADRADO CON LA PESTAÑA. Lo hace el recálculo completo
// («🔄 Forzar Actualización» en PEDIMENTOS FINALES, o WMSACT).
//
// LO QUE LA PESTAÑA TIENE Y EL REGISTRO NO. La hora de un pedimento y su fila
// en el registro se escriben en el mismo escaneo, pero pueden separarse:
// Google corta una ejecución a mitad, o —antes del arreglo del turno— otro
// escaneo pisaba la hora. Si la hoja se queda con la hora y el registro sin la
// fila, ningún escaneo posterior la vuelve a apuntar (ya tiene hora), y el
// reporte cuenta uno menos que la pestaña: pasó con 54 contra 53. Se devuelve
// para apuntarlo.
//
// EL BLOQUE QUE DICE LA PESTAÑA MANDA. El registro guarda el bloque que tenía
// cada pedimento AL ESCANEARLO. Si el BLOQUE se escribió o se metió después,
// encima de pedimentos ya escaneados, el registro se quedaba con «sin bloque»
// —o con el número de antes— aunque en la pestaña estuvieran debajo de su
// BLOQUE: pasó con la A1 76-AZ-8E, «BLOQUE 1, BLOQUE 2 y sin bloque». Aquí se
// corrige en el registro. Los pedimentos se reconocen por día, unidad y
// número; las llegadas de un bloque, por su hora exacta. Si un pedimento está
// dos veces en la pestaña, manda el de más arriba, que es el que cuenta.
//
// Se compara por día, unidad y pedimento (y por bloque en las llegadas), que
// es como agrupa el reporte. `yaVan` son filas que se van a apuntar ahora.
//
// SOLO LO QUE SE PUEDE COMPROBAR: lo de la última semana —lo que enseña el
// reporte— y nada anterior a lo más viejo que se leyó del registro. Sin ese
// tope, con un registro más largo que lo que se lee, lo viejo se apuntaría
// otra vez en cada recálculo.
//
// Escribe en el registro, así que se llama con el turno de la pestaña tomado
// (`conTurnoDeFinales`): los escaneos que apuntan también lo toman.
function pedimentoDeRegistro(v) {
    let ped = String(v === undefined || v === null ? "" : v).trim();
    return /^\d{1,7}$/.test(ped) ? ("0000000" + ped).slice(-7) : ped;
}
function unidadDeRegistro(v) { return String(v || "").trim().toUpperCase(); }

function claveDeTiempo(f) {
    let fecha = (f || [])[0];
    if (!esFechaValida(fecha)) return "";
    let ped = pedimentoDeRegistro(f[2]);
    return claveDeDia(fecha) + "|" + unidadDeRegistro(f[1]) + "|" + ped + "|" +
           (ped === "" ? String(f[5] || "").trim().toUpperCase() : "");
}

function cuadrarRegistroConLaHoja(ss, filas, yaVan) {
    let desde = new Date();
    desde.setHours(0, 0, 0, 0);
    desde.setDate(desde.getDate() - (DIAS_REPORTE_TIEMPOS - 1));
    let reg = ss.getSheetByName(HOJA_SIS_TIEMPOS);
    let leidas = [], desdeFila = 2;
    if (reg && reg.getLastRow() > 1) {
        let lr = reg.getLastRow();
        desdeFila = Math.max(2, lr - FILAS_MAX_LEIDAS_TIEMPOS + 1);
        leidas = reg.getRange(desdeFila, 1, lr - desdeFila + 1, CABECERA_SIS_TIEMPOS.length).getValues();
        if (desdeFila > 2) {
            let fechas = leidas.map(f => f[0]).filter(esFechaValida);
            let masVieja = fechas.length ? new Date(Math.min.apply(null, fechas.map(d => d.getTime()))) : new Date();
            if (masVieja > desde) desde = masVieja;
        }
    }
    let base = f => claveDeDia(f[0]) + "|" + unidadDeRegistro(f[1]) + "|";
    let segundo = d => Math.round(d.getTime() / 1000);
    let apuntar = (m, k, i) => { if (!m.has(k)) m.set(k, []); m.get(k).push(i); };
    let hay = new Set(), pedimentos = new Map(), llegadas = new Map();
    leidas.forEach((f, i) => {
        let c = claveDeTiempo(f);
        if (c === "") return;
        hay.add(c);
        let ped = pedimentoDeRegistro(f[2]);
        if (ped !== "") apuntar(pedimentos, base(f) + ped, i);
        else apuntar(llegadas, base(f) + segundo(f[0]), i);
    });
    (yaVan || []).forEach(f => hay.add(claveDeTiempo(f)));

    let out = [], vistos = new Set(), cambiaBloque = false, cambiaTexto = false;
    (filas || []).forEach(f => {
        if (!esFechaValida(f[0]) || f[0] < desde) return;
        let ped = pedimentoDeRegistro(f[2]);
        let tanda = String(f[5] || "").trim();
        let enRegistro;
        if (ped !== "") {
            let c = base(f) + ped;
            if (vistos.has(c)) return;
            vistos.add(c);
            enRegistro = pedimentos.get(c);
        } else {
            enRegistro = llegadas.get(base(f) + segundo(f[0]));
        }
        if (enRegistro) {
            enRegistro.forEach(i => {
                if (String(leidas[i][5] || "").trim() !== tanda) { leidas[i][5] = tanda; cambiaBloque = true; }
                let texto = "📦 LLEGÓ EL " + tanda;
                if (ped === "" && tanda !== "" && String(leidas[i][3] || "") !== texto) {
                    leidas[i][3] = texto;
                    cambiaTexto = true;
                }
            });
            return;
        }
        let k = claveDeTiempo(f);
        if (k === "" || hay.has(k)) return;
        hay.add(k);
        out.push(f);
    });
    if (cambiaBloque) {
        reg.getRange(desdeFila, 6, leidas.length, 1).setValues(leidas.map(f => [f[5]]));
        marcarReporteDeTiemposPendiente();
    }
    if (cambiaTexto) reg.getRange(desdeFila, 4, leidas.length, 1).setValues(leidas.map(f => [f[3]]));
    return out;
}

// Lo que había en SIS_TIEMPOS_PEDIMENTOS cuando todavía era el registro crudo
// se pasa al registro nuevo, UNA vez. Se reconoce por sus títulos.
function mudarRegistroDeTiemposViejo(ss) {
    let vieja = ss.getSheetByName(HOJA_SIS_TIEMPOS_REPORTE);
    if (!vieja || vieja.getLastRow() < 1 || vieja.getMaxColumns() < 4) return 0;
    if (String(vieja.getRange(1, 4).getValue()).trim() !== "RESULTADO AL ESCANEARLO") return 0;
    let lr = vieja.getLastRow();
    let ancho = Math.min(vieja.getMaxColumns(), CABECERA_SIS_TIEMPOS.length);
    let datos = lr > 1 ? vieja.getRange(2, 1, lr - 1, ancho).getValues() : [];
    // Las de antes de la columna BLOQUE traen una menos: se completan vacías.
    datos = datos.filter(f => esFechaValida(f[0])).map(f => {
        let c = f.slice();
        while (c.length < CABECERA_SIS_TIEMPOS.length) c.push("");
        return c;
    });
    if (datos.length) anotarEnRegistro(ss, HOJA_SIS_TIEMPOS, CABECERA_SIS_TIEMPOS, datos);
    vieja.clear();
    return datos.length;
}

// Rehace el reporte. Devuelve cuántas filas escribió.
function rehacerReporteDeTiempos(ss) {
    try { mudarRegistroDeTiemposViejo(ss); } catch (err) { /* se intentará la próxima vez */ }
    let reg = ss.getSheetByName(HOJA_SIS_TIEMPOS);
    let filas = [];
    if (reg && reg.getLastRow() > 1) {
        let lr = reg.getLastRow();
        let desdeFila = Math.max(2, lr - FILAS_MAX_LEIDAS_TIEMPOS + 1);
        filas = reg.getRange(desdeFila, 1, lr - desdeFila + 1, CABECERA_SIS_TIEMPOS.length).getValues();
    }
    let desde = new Date();
    desde.setHours(0, 0, 0, 0);
    desde.setDate(desde.getDate() - (DIAS_REPORTE_TIEMPOS - 1));
    let r = construirReporteDeTiempos(filas, desde);

    let h = ss.getSheetByName(HOJA_SIS_TIEMPOS_REPORTE);
    if (!h) h = ss.insertSheet(HOJA_SIS_TIEMPOS_REPORTE, ss.getNumSheets());
    h.clear();
    let ancho = CABECERA_REPORTE_TIEMPOS.length;
    h.getRange(1, 1, 1, ancho).setValues([CABECERA_REPORTE_TIEMPOS]).setFontWeight("bold");
    h.setFrozenRows(1);
    if (r.filas.length) {
        if (h.getMaxRows() < r.filas.length + 1) {
            h.insertRowsAfter(h.getMaxRows(), r.filas.length + 1 - h.getMaxRows());
        }
        h.getRange(2, 1, r.filas.length, ancho).setValues(r.filas);
        h.getRange(2, 2, r.filas.length, 1).setNumberFormat("dd/mm/yyyy");
        h.getRange(2, 3, r.filas.length, 1).setNumberFormat("hh:mm");
        h.getRange(2, 5, r.filas.length, 2).setNumberFormat("hh:mm");
        // LOS NÚMEROS, COMO NÚMEROS. La columna de los pedimentos salía en
        // «00:00»: se quedó con el formato de hora de cuando ahí iban las
        // horas, y un 19 con formato de hora es «00:00».
        h.getRange(2, 4, r.filas.length, 1).setNumberFormat("0");
        h.getRange(2, 7, r.filas.length, 1).setNumberFormat("0");
        h.getRange(2, 1, r.filas.length, ancho).setBackgrounds(r.tipos.map(t => {
            let c = t === "unidad" ? COLOR_REPORTE_UNIDAD : t === "bloque" ? COLOR_REPORTE_BLOQUE : '#ffffff';
            return new Array(ancho).fill(c);
        }));
    }
    try { CacheService.getScriptCache().remove(CLAVE_TIEMPOS_PENDIENTE); } catch (err) { /* nada */ }
    return r.filas.length;
}

