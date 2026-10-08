// =========================================================================
// PEDIMENTOS FINALES: LOS PAPELES DE LA UNIDAD CONTRA LO ESCANEADO
// =========================================================================
//
// QUÉ RESUELVE. Antes de que salga una unidad se juntan sus pedimentos
// finales —los papeles que viajan con ella— y hasta ahora se cotejaban a ojo
// contra la pestaña de la unidad. Con quince o veinte pedimentos por unidad,
// un papel que falta o uno que es de otra unidad se escapa con facilidad, y se
// descubre en la aduana.
//
// CÓMO SE USA, en la pestaña «PEDIMENTOS FINALES»:
//
//     A                     B                                  C
//     GLOBAL 1              ✅ UNIDAD CUADRA: 12 pedimentos
//     6116004               ✅ CUADRA · Bultos: 47
//     6116008               ⚠️ CON ERRORES                     2 guías con error: …
//     6116099               ❌ NO ES DE ESTA UNIDAD             Está en GLOBAL 3
//     GLOBAL 2              …
//
//   · Se escribe la UNIDAD —el nombre de su pestaña, o solo un trozo que la
//     distinga: «GLOBAL 1», o las placas— y debajo se escanean sus pedimentos.
//   · Cada pedimento dice si es de esa unidad y qué errores tiene ahí.
//   · La fila de la unidad dice el total y, sobre todo, QUÉ PEDIMENTOS ESTÁN
//     ESCANEADOS EN LA UNIDAD Y NO TIENEN PAPEL. Eso es lo que no se ve
//     mirando la lista: lo que no está en ella.
//
// QUÉ CUENTA COMO ERROR de un pedimento que sí es de la unidad:
//   · el resumen de su fila en la unidad: faltan, sobran, con alerta, 0 bultos;
//   · las guías de su bloque con un estado de «❌» para arriba —duplicada, ya
//     salió, retenida, va en otro pedimento, inválida—;
//   · las guías marcadas «Sin información»;
//   · que esté escaneado TAMBIÉN en otra unidad;
//   · sus referencias que no estén completas según el último cruce de la
//     confronta (pestaña «CONFRONTA REFERENCIAS»).
//
// NO ESCRIBE EN NINGUNA OTRA PESTAÑA. Solo lee la unidad, el caché y el informe
// de la confronta, y contesta en las columnas B y C de la suya. Por eso no toma
// el lock del documento: no puede pisar un escaneo, y así tampoco lo hace
// esperar.
// =========================================================================

// La fila 1 lleva los títulos; se escanea desde la 2.
const FILA_INICIO_FINALES = 2;

const COLOR_FINAL_OK = '#07c369';
const COLOR_FINAL_ERRORES = '#ffc107';
const COLOR_FINAL_AJENO = '#f5c6cb';
const COLOR_FINAL_MAL = '#df5f6b';
const COLOR_FINAL_REPETIDO = '#acacac';
const COLOR_FINAL_NEUTRO = '#FFFFFF';

// Cuántos ejemplos se enseñan de cada error. La columna C se lee de un vistazo:
// con tres se sabe dónde mirar, con treinta ya no se lee nada.
const EJEMPLOS_FINALES = 3;

// ¿Qué pestañas son UNIDADES? Las de salida: todo lo que se escanea como una
// Global, menos el rezago, el histórico y la hoja de los comandos.
function esHojaDeUnidad(nombreHoja) {
    let n = claveHoja(nombreHoja);
    if (!esHojaPrincipal(n)) return false;
    if (n.indexOf("REZAGO") !== -1) return false;
    if (n === claveHoja(nombreHojaHistorico())) return false;
    if (n === "COMANDOS") return false;
    return true;
}

// Para comparar nombres: mayúsculas y un solo espacio entre palabras.
function claveDeUnidad(texto) {
    return claveHoja(texto).replace(/\s+/g, " ");
}

// ¿Qué es lo que se escribió en una celda de la columna A?
//   pedimento · error (números que no son 7) · comando · unidad · vacío
function tipoDeCeldaFinal(valor) {
    let v = String(valor === undefined || valor === null ? "" : valor).trim().toUpperCase();
    if (v === "") return { tipo: "vacio", valor: v };
    try {
        if (typeof esComandoEnColumnaA === 'function' && esComandoEnColumnaA(v)) {
            return { tipo: "comando", valor: v };
        }
    } catch (err) { /* sigue */ }
    if (/^\d{7}$/.test(v)) return { tipo: "pedimento", valor: v };
    if (/^\d+$/.test(v)) return { tipo: "error", valor: v };
    return { tipo: "unidad", valor: v };
}

// Parte la columna A en bloques: una unidad y los pedimentos de debajo. Lo que
// esté antes de la primera unidad va en un bloque SIN unidad. Puro.
//
// `valoresA` es la columna entera desde la fila 1; los índices que devuelve
// son de esa misma lista (0 = fila 1).
function bloquesDePedimentosFinales(valoresA) {
    let bloques = [];
    let actual = null;
    let n = (valoresA || []).length;
    for (let i = FILA_INICIO_FINALES - 1; i < n; i++) {
        let celda = tipoDeCeldaFinal(Array.isArray(valoresA[i]) ? valoresA[i][0] : valoresA[i]);
        if (celda.tipo === "unidad") {
            if (actual) { actual.hasta = i - 1; bloques.push(actual); }
            actual = { desde: i, hasta: i, filaUnidad: i, unidad: celda.valor, filas: [] };
            continue;
        }
        if (!actual) {
            actual = { desde: i, hasta: i, filaUnidad: -1, unidad: "", filas: [] };
        }
        actual.filas.push({ idx: i, tipo: celda.tipo, valor: celda.valor });
    }
    if (actual) { actual.hasta = n - 1; bloques.push(actual); }
    return bloques;
}

// De lo escrito a la pestaña de verdad. Puro.
//
// Vale el nombre entero o un TROZO QUE LA DISTINGA, entero por palabras:
// «GLOBAL 1» encuentra «GLOBAL 1 20-AE-3H» pero no «GLOBAL 10 …», y las placas
// solas también valen. Si casan varias no se elige: se dice cuáles son.
function resolverUnidad(texto, unidades) {
    let t = claveDeUnidad(texto);
    if (t === "") return { error: "vacia", candidatos: [] };
    let lista = unidades || [];
    let exacta = lista.filter(u => claveDeUnidad(u.nombre) === t);
    if (exacta.length === 1) return { unidad: exacta[0] };
    let porPalabras = lista.filter(u => {
        let c = " " + claveDeUnidad(u.nombre) + " ";
        return c.indexOf(" " + t + " ") !== -1;
    });
    if (porPalabras.length === 1) return { unidad: porPalabras[0] };
    if (porPalabras.length > 1) {
        return { error: "varias", candidatos: porPalabras.map(u => u.nombre) };
    }
    return { error: "ninguna", candidatos: [] };
}

// Los pedimentos de una pestaña de unidad, con el estado de su fila y el de
// cada guía de su bloque. Puro: recibe A:C ya leído.
function pedimentosDeHojaDeUnidad(datos) {
    let mapa = new Map();
    let actual = null;
    (datos || []).forEach((fila, i) => {
        let a = String(fila[0] === undefined || fila[0] === null ? "" : fila[0]).trim().toUpperCase();
        if (a === "") return;
        if (/^\d{7}$/.test(a)) {
            // Un pedimento repetido en la unidad: se queda la PRIMERA fila, y
            // el aviso de repetido ya lo lleva su estado en la columna B.
            if (!mapa.has(a)) {
                mapa.set(a, { fila: i + 1, estado: String(fila[1] || ""), guias: [] });
            }
            actual = mapa.get(a);
            return;
        }
        if (esMarcadorEstructural(a)) { actual = null; return; }
        try { if (esComandoEnColumnaA(a)) return; } catch (err) { /* sigue */ }
        if (!actual) return;
        actual.guias.push({ fila: i + 1, guia: a, estado: String(fila[1] || ""),
                            house: String(fila[2] === undefined || fila[2] === null ? "" : fila[2]).trim() });
    });
    return mapa;
}

// La cabeza del estado de una guía, sin la marca de costal ni el resumen del
// bloque, que son de otra cosa.
function cabezaParaFinales(estado) {
    let t = String(estado || "");
    try { t = sinMarcaCostal(t); } catch (err) { /* sigue */ }
    try { t = cabezaEstado(t); } catch (err) { /* sigue */ }
    return String(t).trim();
}

// ¿El resumen de la fila del pedimento dice que algo va mal? El resumen
// empieza por «Bultos: N» y lo que importa viene detrás.
function problemaEnResumenDePedimento(estado) {
    let t = String(estado || "").trim();
    if (t === "") return "la fila del pedimento no tiene estado (actualiza la unidad)";
    if (/^(❌|⛔|🛑|⚠️)/.test(t)) return t;
    if (/^Bultos:\s*0(\s|$)/.test(t)) return "sin bultos debajo";
    let corte = t.indexOf("|");
    if (corte === -1) return "";
    let cola = t.substring(corte + 1).trim();
    if (/(❌|⛔|🛑|⚠️)/.test(cola)) return cola;
    return "";
}

// Lo que se sabe de UN pedimento escaneado como papel de una unidad. Puro.
//
// `enUnidad` es lo de `pedimentosDeHojaDeUnidad` para ese pedimento (o null),
// `otras` las OTRAS unidades donde está escaneado, y `refsMal` las referencias
// de ese pedimento que el último cruce no dio por completas.
function evaluarPedimentoFinal(ped, enUnidad, otras, refsMal) {
    let otrasU = (otras || []);
    if (!enUnidad) {
        if (otrasU.length) {
            return { estado: "❌ NO ES DE ESTA UNIDAD", color: COLOR_FINAL_AJENO,
                     detalle: "Está escaneado en " + otrasU.join(", "), cuadra: false, ajeno: true };
        }
        return { estado: "❌ NO ESTÁ ESCANEADO en ninguna unidad", color: COLOR_FINAL_MAL,
                 detalle: "Ese pedimento no aparece en la columna A de ninguna pestaña de unidad",
                 cuadra: false, ajeno: true };
    }

    let errores = [];
    let res = problemaEnResumenDePedimento(enUnidad.estado);
    if (res !== "") errores.push(res);

    let conError = [], sinInfo = 0;
    enUnidad.guias.forEach(g => {
        let cab = cabezaParaFinales(g.estado);
        if (/^(❌|⛔|🛑)/.test(cab)) conError.push("fila " + g.fila + " " + cab);
        let tieneSinInfo = false;
        try { tieneSinInfo = esAvisoSinInfo(g.estado); } catch (err) { tieneSinInfo = false; }
        if (tieneSinInfo) sinInfo++;
    });
    if (conError.length) {
        errores.push(conError.length + (conError.length === 1 ? " guía con error: " : " guías con error: ") +
                     conError.slice(0, EJEMPLOS_FINALES).join("; ") +
                     (conError.length > EJEMPLOS_FINALES ? " …" : ""));
    }
    if (sinInfo) errores.push(sinInfo + (sinInfo === 1 ? " guía" : " guías") + " sin información");
    if (otrasU.length) errores.push("también escaneado en " + otrasU.join(", "));
    (refsMal || []).forEach(r => errores.push("referencia " + r));

    let bultos = "";
    let m = /^Bultos:\s*(\d+)/.exec(String(enUnidad.estado || "").trim());
    if (m) bultos = " · Bultos: " + m[1];

    if (errores.length === 0) {
        return { estado: "✅ CUADRA" + bultos, color: COLOR_FINAL_OK, detalle: "",
                 cuadra: true, ajeno: false };
    }
    return { estado: "⚠️ CON ERRORES" + bultos, color: COLOR_FINAL_ERRORES,
             detalle: errores.join(" · "), cuadra: false, ajeno: false };
}

// El bloque entero: la fila de la unidad y la de cada pedimento. Puro.
//
// Devuelve `{ resultados: Map(idx → {estado, color, detalle}) }` para TODAS las
// filas del bloque, también las vacías —con estado ""— para que una celda
// borrada no se quede con el resultado de lo que había.
function evaluarBloqueFinal(bloque, unidades, leerUnidad, dondeEsta, refsMalDe) {
    let out = new Map();
    for (let i = bloque.desde; i <= bloque.hasta; i++) {
        out.set(i, { estado: "", color: COLOR_FINAL_NEUTRO, detalle: "" });
    }

    let r = bloque.filaUnidad === -1 ? { error: "sin" } : resolverUnidad(bloque.unidad, unidades);
    if (!r.unidad) {
        if (bloque.filaUnidad !== -1) {
            out.set(bloque.filaUnidad, {
                estado: r.error === "varias" ? "❌ HAY VARIAS UNIDADES ASÍ" : "❌ NO ENCUENTRO ESA UNIDAD",
                color: COLOR_FINAL_MAL,
                detalle: r.error === "varias"
                    ? "Escribe más para distinguirla: " + r.candidatos.join(", ")
                    : "Escribe el nombre de su pestaña (o las placas), por ejemplo «GLOBAL 1»" });
        }
        bloque.filas.forEach(f => {
            if (f.tipo === "pedimento") {
                out.set(f.idx, { estado: bloque.filaUnidad === -1
                                          ? "⚠️ FALTA LA UNIDAD ARRIBA"
                                          : "⚠️ CORRIGE LA UNIDAD DE ARRIBA",
                                 color: COLOR_FINAL_ERRORES,
                                 detalle: "Escribe encima el nombre de la pestaña de la unidad" });
            } else if (f.tipo === "error") {
                out.set(f.idx, filaDeCapturaMalaFinal(f.valor));
            }
        });
        return { resultados: out };
    }

    let unidad = r.unidad;
    let claveU = claveHoja(unidad.nombre);
    let enLaUnidad = leerUnidad(unidad) || new Map();

    let vistos = new Map();       // pedimento -> primera fila de la lista
    let cuadran = 0, conErrores = 0, ajenos = 0, repetidos = 0, malos = 0;
    bloque.filas.forEach(f => {
        if (f.tipo === "error") { out.set(f.idx, filaDeCapturaMalaFinal(f.valor)); malos++; return; }
        if (f.tipo !== "pedimento") return;
        if (vistos.has(f.valor)) {
            repetidos++;
            out.set(f.idx, { estado: "🔄 REPETIDO EN LA LISTA", color: COLOR_FINAL_REPETIDO,
                             detalle: "Ya está en la fila " + (vistos.get(f.valor) + 1) });
            return;
        }
        vistos.set(f.valor, f.idx);
        let otras = ((dondeEsta && dondeEsta.get(f.valor)) || [])
            .filter(u => claveHoja(u) !== claveU);
        let ev = evaluarPedimentoFinal(f.valor, enLaUnidad.get(f.valor) || null, otras,
                                       refsMalDe ? refsMalDe(f.valor) : []);
        if (ev.cuadra) cuadran++;
        else if (ev.ajeno) ajenos++;
        else conErrores++;
        out.set(f.idx, { estado: ev.estado, color: ev.color, detalle: ev.detalle });
    });

    // LO QUE NO ESTÁ EN LA LISTA: escaneado en la unidad y sin papel.
    let sinPapel = [];
    enLaUnidad.forEach((info, ped) => { if (!vistos.has(ped)) sinPapel.push(ped); });

    let partes = [];
    if (conErrores) partes.push("⚠️ " + conErrores + " con errores");
    if (ajenos) partes.push("❌ " + ajenos + " no son de esta unidad");
    if (sinPapel.length) partes.push("⚠️ falta el papel de " + sinPapel.length);
    if (repetidos) partes.push("🔄 " + repetidos + " repetidos");
    if (malos) partes.push("🛑 " + malos + " mal escaneados");

    let total = vistos.size;
    let estadoU, colorU;
    if (total === 0 && sinPapel.length === 0) {
        estadoU = "ℹ️ " + unidad.nombre + ": no tiene pedimentos escaneados";
        colorU = COLOR_FINAL_NEUTRO;
    } else if (partes.length === 0) {
        estadoU = "✅ UNIDAD CUADRA: " + total + " pedimentos";
        colorU = COLOR_FINAL_OK;
    } else {
        estadoU = (ajenos || malos ? "❌ " : "⚠️ ") + "NO CUADRA · " + cuadran + " de " +
                  enLaUnidad.size + " bien · " + partes.join(" · ");
        colorU = (ajenos || malos) ? COLOR_FINAL_MAL : COLOR_FINAL_ERRORES;
    }
    let detalleU = "Pestaña: " + unidad.nombre + " · en la unidad: " + enLaUnidad.size +
                   " · en la lista: " + total;
    if (sinPapel.length) detalleU += " · SIN PAPEL: " + sinPapel.join(", ");
    out.set(bloque.filaUnidad, { estado: estadoU, color: colorU, detalle: detalleU });

    return { resultados: out, sinPapel: sinPapel, cuadran: cuadran, unidad: unidad };
}

function filaDeCapturaMalaFinal(valor) {
    let v = String(valor || "");
    return { estado: "🛑 EL PEDIMENTO LLEVA 7 DÍGITOS", color: COLOR_FINAL_MAL,
             detalle: "Se leyó «" + v + "» (" + v.length + "). Vuelve a escanearlo" };
}

// -------------------------------------------------------------------------
// LO QUE HABLA CON SHEETS
// -------------------------------------------------------------------------

function unidadesDelArchivo(ss) {
    let out = [];
    ss.getSheets().forEach(h => {
        let nombre = h.getName();
        if (esHojaDeUnidad(nombre)) out.push({ nombre: nombre, hoja: h });
    });
    return out;
}

// Dónde está escaneado cada pedimento, sacado del CACHÉ: tiene la columna A de
// todas las pestañas en una sola lectura, y abrir quince unidades para
// preguntar lo mismo costaría quince.
function dondeEstaCadaPedimento(ss, unidades) {
    let donde = new Map();
    let info = null;
    try { info = getCacheData(ss); } catch (err) { info = null; }
    if (!info || !info.headers || !info.data) return donde;
    let nombrePorClave = new Map();
    (unidades || []).forEach(u => nombrePorClave.set(claveHoja(u.nombre), u.nombre));
    info.headers.forEach((h, c) => {
        let t = String(h || "");
        if (!/_FISICO$/.test(t)) return;
        let clave = t.substring(0, t.length - "_FISICO".length);
        if (!nombrePorClave.has(clave)) return;
        let nombre = nombrePorClave.get(clave);
        for (let r = 1; r < info.data.length; r++) {
            let v = String((info.data[r] || [])[c] || "").trim();
            if (!/^\d{7}$/.test(v)) continue;
            if (!donde.has(v)) donde.set(v, []);
            if (donde.get(v).indexOf(nombre) === -1) donde.get(v).push(nombre);
        }
    });
    return donde;
}

// Las referencias que el último cruce NO dio por completas, por pedimento.
function referenciasMalPorPedimento(ss) {
    let m = new Map();
    let h = null;
    try {
        if (typeof nombreHojaConfronta !== 'function') return m;
        h = ss.getSheetByName(nombreHojaConfronta());
    } catch (err) { h = null; }
    if (!h) return m;
    let lr = h.getLastRow();
    if (lr < 2) return m;
    h.getRange(2, 1, lr - 1, 6).getValues().forEach(f => {
        let ref = String(f[0] || "").trim(), ped = String(f[1] || "").trim();
        let estado = String(f[5] || "").trim();
        if (ref === "" || ped === "" || estado === "" || estado.indexOf("✅") === 0) return;
        if (!m.has(ped)) m.set(ped, []);
        m.get(ped).push(ref + " " + estado);
    });
    return m;
}

// Recalcula los bloques de la pestaña. Con `filas` (1-based, inclusive) solo
// los que las tocan; sin él, todos.
function recalcularPedimentosFinales(ss, hoja, filaDesde, filaHasta) {
    let lr = Math.max(hoja.getLastRow(), filaHasta || 0, FILA_INICIO_FINALES);
    let valoresA = hoja.getRange(1, 1, lr, 1).getValues();
    let bloques = bloquesDePedimentosFinales(valoresA);
    if (filaDesde) {
        let d = filaDesde - 1, hst = (filaHasta || filaDesde) - 1;
        bloques = bloques.filter(b => b.hasta >= d && b.desde <= hst);
    }

    // Se lee HASTA LA FILA EDITADA aunque esté vacía (`lr` la incluye): así
    // una celda recién borrada al final entra en su bloque y se le quita el
    // resultado de lo que había.
    if (bloques.length === 0) return 0;

    let unidades = unidadesDelArchivo(ss);
    let donde = dondeEstaCadaPedimento(ss, unidades);
    let refsMal = referenciasMalPorPedimento(ss);
    let leidas = new Map();
    let leerUnidad = (u) => {
        let k = claveHoja(u.nombre);
        if (!leidas.has(k)) {
            let lrU = u.hoja.getLastRow();
            leidas.set(k, lrU < 1 ? new Map()
                                  : pedimentosDeHojaDeUnidad(u.hoja.getRange(1, 1, lrU, 3).getValues()));
        }
        return leidas.get(k);
    };

    bloques.forEach(b => {
        let ev = evaluarBloqueFinal(b, unidades, leerUnidad, donde, ped => refsMal.get(ped) || []);
        let n = b.hasta - b.desde + 1;
        let textos = [], colores = [];
        for (let i = b.desde; i <= b.hasta; i++) {
            let r = ev.resultados.get(i) || { estado: "", color: COLOR_FINAL_NEUTRO, detalle: "" };
            textos.push([r.estado, r.detalle]);
            colores.push([r.estado === "" ? COLOR_FINAL_NEUTRO : r.color]);
        }
        hoja.getRange(b.desde + 1, 2, n, 2).setValues(textos);
        hoja.getRange(b.desde + 1, 2, n, 1).setBackgrounds(colores);
    });
    return bloques.filter(b => b.filaUnidad !== -1).length;
}

// Lo llama `procesarEdicion` cuando se escribe en la columna A de esta pestaña.
function atenderPedimentosFinales(ss, hoja, fila, numFilas) {
    if (fila + numFilas - 1 < FILA_INICIO_FINALES) return;
    recalcularPedimentosFinales(ss, hoja, Math.max(fila, FILA_INICIO_FINALES), fila + numFilas - 1);
}

// El botón: crea la pestaña si no está y la revisa entera.
function prepararPedimentosFinales() {
    const ss = obtenerArchivo();
    const ui = SpreadsheetApp.getUi();
    const NOMBRE = nombreHojaPedimentosFinales();
    let hoja = null;
    ss.getSheets().forEach(h => { if (esHojaPedimentosFinales(h.getName())) hoja = h; });
    let creada = false;
    if (!hoja) {
        hoja = ss.insertSheet(NOMBRE, ss.getNumSheets());
        hoja.getRange(1, 1, 1, 3)
            .setValues([["UNIDAD Y SUS PEDIMENTOS", "RESULTADO", "ERRORES Y DETALLE"]])
            .setFontWeight("bold");
        hoja.setFrozenRows(1);
        hoja.setColumnWidth(1, 200);
        hoja.setColumnWidth(2, 340);
        hoja.setColumnWidth(3, 620);
        // COMO TEXTO: un pedimento que empiece por cero perdería el cero al
        // convertirse en número, y dejaría de tener siete dígitos.
        hoja.getRange(1, 1, hoja.getMaxRows(), 1).setNumberFormat("@");
        creada = true;
    }
    let n = recalcularPedimentosFinales(ss, hoja);
    ss.setActiveSheet(hoja);
    ui.alert("🧾 Pedimentos finales",
        (creada ? "Pestaña «" + NOMBRE + "» creada.\n\n" : "") +
        "CÓMO SE USA:\n" +
        "   1. En la columna A escribe la UNIDAD: el nombre de su pestaña, o un " +
        "trozo que la distinga («GLOBAL 1», o las placas).\n" +
        "   2. Debajo, escanea sus pedimentos finales, uno por fila.\n" +
        "   3. Para la siguiente unidad, escribe su nombre y sigue debajo.\n\n" +
        "La columna B dice si cada pedimento CUADRA con esa unidad, y la C qué " +
        "errores tiene ahí. La fila de la unidad dice el total y qué pedimentos " +
        "están escaneados en la unidad SIN PAPEL.\n\n" +
        "Las referencias se miran según el último cruce de la confronta.\n\n" +
        (n ? "Revisadas " + n + " unidades." : "Todavía no hay nada escaneado.") +
        "\n\nPara volver a revisar todo: escanea WMSACT en esta pestaña.",
        ui.ButtonSet.OK);
}
