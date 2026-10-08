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
//     GLOBAL 1              ❌ NO CUADRA · 1 no está · …       SIN PAPEL: 6116010
//     6116004               ✅ ESTÁ EN LA UNIDAD                Patente 6087 · clave T1
//     6116099               ❌ NO ESTÁ EN ESTA UNIDAD
//     GLOBAL 2              …
//
//   · Se escanea (o se escribe) la UNIDAD y debajo sus pedimentos.
//   · Cada pedimento dice si está en la columna A de ESA unidad. Nada más.
//   · La fila de la unidad dice el total y QUÉ PEDIMENTOS ESTÁN EN LA UNIDAD
//     Y NO TIENEN PAPEL. Eso es lo que no se ve mirando la lista: lo que no
//     está en ella.
//
// SOLO LA UNIDAD QUE SE ESCANEA, Y SOLO SUS NÚMEROS DE PEDIMENTO. Se pidió así,
// después de una primera versión que además contaba bultos, miraba las M-S,
// las guías con alerta y la confronta. Todo eso sale de la pestaña de la
// unidad y no del pedimento, y lo que se quiere aquí es cuadrar papeles contra
// números, sin mezclar. Lo de los bultos ya lo dice la propia unidad.
//
// NO ESCRIBE EN NINGUNA OTRA PESTAÑA. Solo lee la columna A de la unidad y
// contesta en B, C y D de la suya. Por eso no toma el lock del documento: no
// puede pisar un escaneo, y así tampoco lo hace esperar.
// =========================================================================

// La fila 1 lleva los títulos; se escanea desde la 2.
const FILA_INICIO_FINALES = 2;

const COLOR_FINAL_OK = '#07c369';
const COLOR_FINAL_ERRORES = '#ffc107';
const COLOR_FINAL_MAL = '#df5f6b';
const COLOR_FINAL_REPETIDO = '#acacac';
const COLOR_FINAL_NEUTRO = '#FFFFFF';

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

// -------------------------------------------------------------------------
// EL CÓDIGO DE BARRAS DEL PEDIMENTO
// -------------------------------------------------------------------------
//
// El código impreso en el pedimento NO trae solo el número. Trae doce datos,
// cada uno terminado en un salto de línea (CR LF):
//
//     6087            patente
//     6114956         número de pedimento   ← lo que se cuadra
//     T1              clave de pedimento
//     UPS891122HV8    RFC
//     0000000000000   …y ocho datos más: acuse de validación, importes, ceros
//
// Según cómo esté configurada la pistola llega de dos maneras, y las dos
// tienen que funcionar:
//
//   · TODO EN UNA CELDA, con los saltos de línea dentro (o sin ellos, pegado).
//   · UNA FILA POR DATO, porque cada salto de línea funciona como un Enter.
//     Es lo más probable con el lector en modo teclado.
//
// En el segundo caso las filas de relleno NO pueden tomarse por lo que no son:
// «T1» o «UPS891122HV8» parecerían nombres de unidad y partirían la lista;
// «6087» o «0000000000000» parecerían pedimentos mal escaneados. Se reconocen
// por su sitio —detrás de una patente y un pedimento— y se marcan como parte
// del código.

// Cuántos datos trae el código DETRÁS del número de pedimento.
const CAMPOS_TRAS_PEDIMENTO = 10;

// Cuántas filas hacia arriba se miran para saber si una fila es relleno de un
// código. Doce datos, con una fila vacía entre cada uno si la pistola manda el
// CR y el LF como dos Enter, y un poco de margen.
const FILAS_ATRAS_CODIGO = 30;

const COLOR_FINAL_RELLENO = '#f1f3f4';

function esPatenteFinal(v) { return /^\d{4}$/.test(String(v || "")); }

// Un RFC: 3 letras (persona moral) o 4 (física), 6 dígitos de fecha y 3 de
// homoclave.
const RE_RFC_FINAL = /^[A-Z&Ñ]{3,4}\d{6}[A-Z0-9]{3}$/;

// El código entero metido en UNA celda. Devuelve {pedimento, patente, clave,
// rfc} o null si no lo es. Puro.
function leerCodigoDePedimento(texto) {
    let t = String(texto === undefined || texto === null ? "" : texto).toUpperCase();
    // Los separadores: saltos de verdad, o escritos como «<CR>» / «<LF>».
    let partes = t.split(/\r\n|\r|\n|<CR>|<LF>/).map(x => x.trim()).filter(x => x !== "");
    if (partes.length < 2) partes = t.trim().split(/\s+/).filter(x => x !== "");
    if (partes.length >= 2 && esPatenteFinal(partes[0]) && /^\d{7}$/.test(partes[1])) {
        return { pedimento: partes[1], patente: partes[0],
                 clave: partes[2] || "", rfc: RE_RFC_FINAL.test(partes[3] || "") ? partes[3] : "" };
    }
    // Pegado, sin separadores: patente, pedimento, clave y RFC seguidos. Se
    // exige el RFC para no confundir con cualquier número largo.
    let m = /^(\d{4})(\d{7})([A-Z0-9]{2})\s*([A-Z&Ñ]{3,4}\d{6}[A-Z0-9]{3})/.exec(t.trim());
    if (m) return { pedimento: m[2], patente: m[1], clave: m[3], rfc: m[4] };
    return null;
}

// ¿Qué es lo que se escribió en una celda de la columna A, mirada SOLA?
//   pedimento · error (números que no son 7) · comando · unidad · vacío
// Que una fila sea relleno de un código lo decide después
// `clasificarFilasFinales`, que mira las de alrededor.
function tipoDeCeldaFinal(valor) {
    let crudo = String(valor === undefined || valor === null ? "" : valor);
    let v = crudo.trim().toUpperCase();
    if (v === "") return { tipo: "vacio", valor: v };
    try {
        if (typeof esComandoEnColumnaA === 'function' && esComandoEnColumnaA(v)) {
            return { tipo: "comando", valor: v };
        }
    } catch (err) { /* sigue */ }
    if (/^\d{7}$/.test(v)) return { tipo: "pedimento", valor: v };
    // El código entero en una celda: se queda con el número de pedimento.
    if (/[\r\n]|<CR>|<LF>/.test(v) || /^\d{11}/.test(v) || /^\d{4}\s+\d{7}(\s|$)/.test(v)) {
        let c = leerCodigoDePedimento(crudo);
        if (c) return { tipo: "pedimento", valor: c.pedimento, patente: c.patente,
                        clave: c.clave, rfc: c.rfc };
    }
    if (/^\d+$/.test(v)) return { tipo: "error", valor: v };
    return { tipo: "unidad", valor: v };
}

// Mira la columna entera —o un trozo— y marca las filas que son relleno de un
// código de pedimento repartido en varias filas. Puro.
//
// `primeraFila` es la fila (1 = la primera de la hoja) de `valoresA[0]`; las
// de antes de FILA_INICIO_FINALES se devuelven como null.
function clasificarFilasFinales(valoresA, primeraFila) {
    let base = primeraFila || 1;
    let n = (valoresA || []).length;
    let celdas = [];
    for (let i = 0; i < n; i++) {
        if (base + i < FILA_INICIO_FINALES) { celdas.push(null); continue; }
        celdas.push(tipoDeCeldaFinal(Array.isArray(valoresA[i]) ? valoresA[i][0] : valoresA[i]));
    }
    let siguienteConDato = (i) => {
        for (let j = i + 1; j < n; j++) if (celdas[j] && celdas[j].tipo !== "vacio") return j;
        return -1;
    };
    // Una patente seguida de un pedimento: ahí empieza un código.
    let empiezaCodigo = (i) => {
        let c = celdas[i];
        if (!c || c.tipo !== "error" || !esPatenteFinal(c.valor)) return false;
        let j = siguienteConDato(i);
        return j !== -1 && celdas[j].tipo === "pedimento" && !celdas[j].patente;
    };
    let relleno = (valor, campo) => ({ tipo: "relleno", valor: valor, campo: campo });

    for (let i = 0; i < n; i++) {
        let c = celdas[i];
        if (!c || c.tipo !== "error" || !esPatenteFinal(c.valor)) continue;
        let j = siguienteConDato(i);
        // La ÚLTIMA fila y es una patente: casi seguro que el resto del código
        // todavía está llegando. Se marca como relleno para no enseñar un error
        // rojo medio segundo antes de que aparezca su pedimento.
        if (j === -1) { celdas[i] = relleno(c.valor, "patente"); continue; }
        if (celdas[j].tipo !== "pedimento" || celdas[j].patente) continue;

        celdas[i] = relleno(c.valor, "patente");
        celdas[j].patente = c.valor;
        let k = j, consumidos = 0;
        while (consumidos < CAMPOS_TRAS_PEDIMENTO) {
            let m = siguienteConDato(k);
            if (m === -1) break;
            let cm = celdas[m];
            // Lo que NUNCA es un dato del código: el siguiente código, un
            // pedimento suelto, un comando, o un nombre con espacios dentro
            // —«GLOBAL 1»—, que es como se escanea una unidad. Los datos del
            // código no llevan espacios dentro.
            if (empiezaCodigo(m) || cm.tipo === "pedimento" || cm.tipo === "comando") break;
            if (cm.tipo === "unidad" && /\s/.test(cm.valor)) break;
            let campo = consumidos === 0 ? "clave" : consumidos === 1 ? "RFC" : "dato";
            if (consumidos === 0) celdas[j].clave = cm.valor;
            if (consumidos === 1 && RE_RFC_FINAL.test(cm.valor)) celdas[j].rfc = cm.valor;
            celdas[m] = relleno(cm.valor, campo);
            consumidos++;
            k = m;
        }
        i = k;
    }
    return celdas;
}

function textoDeRellenoFinal(celda) {
    let campo = celda && celda.campo;
    if (campo === "patente") return "↳ patente (del código del pedimento)";
    if (campo === "clave") return "↳ clave de pedimento";
    if (campo === "RFC") return "↳ RFC";
    return "↳ dato del código del pedimento";
}

// Parte la columna A en bloques: una unidad y los pedimentos de debajo. Lo que
// esté antes de la primera unidad va en un bloque SIN unidad. Puro.
//
// `valoresA` es la columna entera desde la fila 1; los índices que devuelve
// son de esa misma lista (0 = fila 1).
function bloquesDePedimentosFinales(valoresA) {
    let bloques = [];
    let actual = null;
    let celdas = clasificarFilasFinales(valoresA, 1);
    let n = celdas.length;
    for (let i = FILA_INICIO_FINALES - 1; i < n; i++) {
        let celda = celdas[i];
        if (!celda) continue;
        if (celda.tipo === "unidad") {
            if (actual) { actual.hasta = i - 1; bloques.push(actual); }
            actual = { desde: i, hasta: i, filaUnidad: i, unidad: celda.valor, filas: [] };
            continue;
        }
        if (!actual) {
            actual = { desde: i, hasta: i, filaUnidad: -1, unidad: "", filas: [] };
        }
        actual.filas.push({ idx: i, tipo: celda.tipo, valor: celda.valor, campo: celda.campo,
                            patente: celda.patente || "", clave: celda.clave || "",
                            rfc: celda.rfc || "" });
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

// Los pedimentos de una pestaña de unidad: los 7 dígitos de su columna A, con
// la fila donde está cada uno. Puro. De la unidad no hace falta nada más.
function pedimentosDeLaUnidad(valoresA) {
    let m = new Map();
    (valoresA || []).forEach((f, i) => {
        let v = Array.isArray(f) ? f[0] : f;
        let a = String(v === undefined || v === null ? "" : v).trim();
        if (/^\d{7}$/.test(a) && !m.has(a)) m.set(a, i + 1);
    });
    return m;
}

// Lo que trae el código de barras del pedimento, para la columna C.
function textoDelCodigoFinal(f) {
    if (!f || !f.patente) return "";
    return "Patente " + f.patente + (f.clave ? " · clave " + f.clave : "") +
           (f.rfc ? " · " + f.rfc : "");
}

// El bloque entero: la fila de la unidad y la de cada pedimento. Puro.
//
// Devuelve `{ resultados: Map(idx → {estado, color, detalle, pedimento}) }`
// para TODAS las filas del bloque, también las vacías —con estado ""— para
// que una celda borrada no se quede con el resultado de lo que había.
function evaluarBloqueFinal(bloque, unidades, leerUnidad) {
    let out = new Map();
    for (let i = bloque.desde; i <= bloque.hasta; i++) {
        out.set(i, { estado: "", color: COLOR_FINAL_NEUTRO, detalle: "" });
    }
    // Las filas de relleno de un código se dicen como tales y no cuentan para
    // nada más.
    bloque.filas.forEach(f => {
        if (f.tipo === "relleno") {
            out.set(f.idx, { estado: textoDeRellenoFinal(f), color: COLOR_FINAL_RELLENO, detalle: "" });
        }
    });

    let r = bloque.filaUnidad === -1 ? { error: "sin" } : resolverUnidad(bloque.unidad, unidades);
    if (!r.unidad) {
        if (bloque.filaUnidad !== -1) {
            out.set(bloque.filaUnidad, {
                estado: r.error === "varias" ? "❌ HAY VARIAS UNIDADES ASÍ" : "❌ NO ENCUENTRO ESA UNIDAD",
                color: COLOR_FINAL_MAL,
                detalle: r.error === "varias"
                    ? "Escribe más para distinguirla: " + r.candidatos.join(", ")
                    : "Escanea el código de la unidad o escribe el nombre de su pestaña, por ejemplo «GLOBAL 1»" });
        }
        bloque.filas.forEach(f => {
            if (f.tipo === "pedimento") {
                out.set(f.idx, { pedimento: f.valor, estado: bloque.filaUnidad === -1
                                          ? "⚠️ FALTA LA UNIDAD ARRIBA"
                                          : "⚠️ CORRIGE LA UNIDAD DE ARRIBA",
                                 color: COLOR_FINAL_ERRORES,
                                 detalle: "Escanea encima el código de la unidad" });
            } else if (f.tipo === "error") {
                out.set(f.idx, filaDeCapturaMalaFinal(f.valor));
            }
        });
        return { resultados: out };
    }

    let unidad = r.unidad;
    let enLaUnidad = leerUnidad(unidad) || new Map();

    let vistos = new Map();       // pedimento -> primera fila de la lista
    let estan = 0, noEstan = [], repetidos = 0, malos = 0;
    bloque.filas.forEach(f => {
        if (f.tipo === "error") { out.set(f.idx, filaDeCapturaMalaFinal(f.valor)); malos++; return; }
        if (f.tipo !== "pedimento") return;
        if (vistos.has(f.valor)) {
            repetidos++;
            out.set(f.idx, { estado: "🔄 REPETIDO EN LA LISTA", color: COLOR_FINAL_REPETIDO,
                             pedimento: f.valor,
                             detalle: "Ya está en la fila " + (vistos.get(f.valor) + 1) });
            return;
        }
        vistos.set(f.valor, f.idx);
        let delCodigo = textoDelCodigoFinal(f);
        if (enLaUnidad.has(f.valor)) {
            estan++;
            out.set(f.idx, { estado: "✅ ESTÁ EN LA UNIDAD", color: COLOR_FINAL_OK,
                             detalle: delCodigo, pedimento: f.valor });
        } else {
            noEstan.push(f.valor);
            out.set(f.idx, { estado: "❌ NO ESTÁ EN ESTA UNIDAD", color: COLOR_FINAL_MAL,
                             detalle: ["No está en la columna A de " + unidad.nombre, delCodigo]
                                 .filter(x => x !== "").join(" · "),
                             pedimento: f.valor });
        }
    });

    // LO QUE NO ESTÁ EN LA LISTA: en la unidad y sin papel.
    let sinPapel = [];
    enLaUnidad.forEach((fila, ped) => { if (!vistos.has(ped)) sinPapel.push(ped); });

    let partes = [];
    if (noEstan.length) partes.push(noEstan.length + (noEstan.length === 1 ? " no está" : " no están") + " en la unidad");
    if (sinPapel.length) partes.push("falta el papel de " + sinPapel.length);
    if (repetidos) partes.push(repetidos + (repetidos === 1 ? " repetido" : " repetidos"));
    if (malos) partes.push(malos + " mal escaneado" + (malos === 1 ? "" : "s"));

    let total = vistos.size;
    let estadoU, colorU;
    if (total === 0 && sinPapel.length === 0) {
        estadoU = "ℹ️ " + unidad.nombre + ": no tiene pedimentos escaneados";
        colorU = COLOR_FINAL_NEUTRO;
    } else if (partes.length === 0) {
        estadoU = "✅ UNIDAD CUADRA: " + total + (total === 1 ? " pedimento" : " pedimentos");
        colorU = COLOR_FINAL_OK;
    } else {
        estadoU = "❌ NO CUADRA · " + partes.join(" · ");
        colorU = COLOR_FINAL_MAL;
    }
    let detalleU = "Pestaña: " + unidad.nombre + " · en la unidad: " + enLaUnidad.size +
                   " · en la lista: " + total;
    if (noEstan.length) detalleU += " · NO ESTÁN EN LA UNIDAD: " + noEstan.join(", ");
    if (sinPapel.length) detalleU += " · SIN PAPEL: " + sinPapel.join(", ");
    out.set(bloque.filaUnidad, { estado: estadoU, color: colorU, detalle: detalleU });

    return { resultados: out, sinPapel: sinPapel, noEstan: noEstan, estan: estan, unidad: unidad };
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
    let leidas = new Map();
    // Solo la columna A de la unidad: es lo único que se compara.
    let leerUnidad = (u) => {
        let k = claveHoja(u.nombre);
        if (!leidas.has(k)) {
            let lrU = u.hoja.getLastRow();
            leidas.set(k, lrU < 1 ? new Map()
                                  : pedimentosDeLaUnidad(u.hoja.getRange(1, 1, lrU, 1).getValues()));
        }
        return leidas.get(k);
    };

    bloques.forEach(b => {
        let ev = evaluarBloqueFinal(b, unidades, leerUnidad);
        let n = b.hasta - b.desde + 1;
        let textos = [], colores = [];
        for (let i = b.desde; i <= b.hasta; i++) {
            let r = ev.resultados.get(i) || { estado: "", color: COLOR_FINAL_NEUTRO, detalle: "" };
            // La D lleva SOLO el número de pedimento, limpio. Cuando se escanea
            // el código de barras la columna A trae doce datos (en una celda o
            // en varias filas) y lo que interesa es uno: aquí queda a la vista,
            // listo para copiar o filtrar.
            textos.push([r.estado, r.detalle, r.pedimento || ""]);
            colores.push([r.estado === "" ? COLOR_FINAL_NEUTRO : r.color]);
        }
        hoja.getRange(b.desde + 1, 2, n, 3).setValues(textos);
        hoja.getRange(b.desde + 1, 2, n, 1).setBackgrounds(colores);
    });
    return bloques.filter(b => b.filaUnidad !== -1).length;
}

// -------------------------------------------------------------------------
// LA UNIDAD POR CÓDIGO DE BARRAS
// -------------------------------------------------------------------------
//
// La pistola escribe en la celda el texto del código, y un texto en la columna
// A ya es una unidad. Así que escanear la unidad funciona igual que teclearla:
// lo único que hace falta es saber QUÉ TEXTO poner en cada etiqueta.
//
// EL CÓDIGO MÁS CORTO QUE LA DISTINGA, y no el nombre entero. La pestaña lleva
// las placas —«GLOBAL 1 20-AE-3H»— y las placas cambian con cada camión: con el
// nombre entero habría que imprimir etiquetas nuevas cada día. «GLOBAL 1»
// encuentra igual la pestaña de hoy, y la etiqueta sirve siempre mientras haya
// una sola GLOBAL 1 a la vez.
//
// Nunca solo dígitos: eso se leería como un pedimento.
function codigoCortoDeUnidad(nombre, unidades) {
    let palabras = claveDeUnidad(nombre).split(" ").filter(p => p !== "");
    let objetivo = claveDeUnidad(nombre);
    for (let k = 1; k <= palabras.length; k++) {
        let cand = palabras.slice(0, k).join(" ");
        if (/^\d+$/.test(cand.replace(/\s/g, ""))) continue;
        let r = resolverUnidad(cand, unidades);
        if (r.unidad && claveDeUnidad(r.unidad.nombre) === objetivo) return cand;
    }
    return objetivo;
}

// ¿Se puede poner tal cual en Code 39? Es la simbología que cualquier lector
// lee sin configurarle nada, pero solo admite mayúsculas, dígitos, espacio y
// - . $ / + %.
function cabeEnCode39(texto) {
    return /^[A-Z0-9 \-.$\/+%]+$/.test(String(texto || ""));
}

// Los códigos de las unidades de hoy, en las columnas E y F de la pestaña.
// Lejos de A:C a propósito: lo que se escanea y lo que se imprime no se mezclan.
const COL_CODIGOS_UNIDAD = 5;

function escribirCodigosDeUnidades(ss, hoja) {
    let unidades = unidadesDelArchivo(ss);
    let filas = [["PESTAÑA DE LA UNIDAD", "TEXTO DEL CÓDIGO DE BARRAS"]];
    unidades.forEach(u => {
        let c = codigoCortoDeUnidad(u.nombre, unidades);
        filas.push([u.nombre, cabeEnCode39(c) ? c : c + "   (usa Code 128)"]);
    });
    let maxFilas = hoja.getMaxRows();
    if (maxFilas > 0) hoja.getRange(1, COL_CODIGOS_UNIDAD, maxFilas, 2).clearContent();
    if (hoja.getMaxRows() < filas.length + 1) {
        hoja.insertRowsAfter(hoja.getMaxRows(), filas.length + 1 - hoja.getMaxRows());
    }
    hoja.getRange(1, COL_CODIGOS_UNIDAD, filas.length, 2).setValues(filas);
    hoja.getRange(1, COL_CODIGOS_UNIDAD, 1, 2).setFontWeight("bold");
    if (filas.length > 1) {
        hoja.getRange(2, COL_CODIGOS_UNIDAD + 1, filas.length - 1, 1)
            .setFontFamily("Courier New").setFontSize(14).setNumberFormat("@");
    }
    return filas.length - 1;
}

// Los títulos y el formato de las columnas que se escriben. Se puede llamar las
// veces que haga falta: no toca nada de lo escaneado.
function ponerTitulosFinales(hoja) {
    hoja.getRange(1, 1, 1, 4)
        .setValues([["UNIDAD Y SUS PEDIMENTOS", "RESULTADO", "ERRORES Y DETALLE", "PEDIMENTO"]])
        .setFontWeight("bold");
    // COMO TEXTO, la A y la D: un número que empiece por cero perdería el
    // cero al convertirse en número, y dejaría de tener siete dígitos.
    let filas = hoja.getMaxRows();
    hoja.getRange(1, 1, filas, 1).setNumberFormat("@");
    hoja.getRange(1, 4, filas, 1).setNumberFormat("@");
    hoja.setColumnWidth(4, 110);
}

// Lo llama `procesarEdicion` cuando se escribe en la columna A de esta pestaña.
//
// UNA FILA DE RELLENO NO RECALCULA NADA. Un código de barras repartido en
// filas son doce ediciones seguidas, y recalcular el bloque en cada una serían
// doce lecturas de la unidad para un solo papel: con veinte papeles por unidad,
// minutos de cola. El relleno no cambia el resultado de nadie, así que solo se
// le pone su etiqueta; el recálculo lo hace la fila del pedimento.
//
// Los recálculos van EN FILA (lock del script, no el del documento: no frena
// ningún escaneo). Sin eso, dos escaneos seguidos corrían a la vez y el que
// terminaba último podía escribir un resumen leído antes que el otro.
function atenderPedimentosFinales(ss, hoja, fila, numFilas) {
    if (fila + numFilas - 1 < FILA_INICIO_FINALES) return;

    if (numFilas === 1 && fila >= FILA_INICIO_FINALES) {
        let desde = Math.max(FILA_INICIO_FINALES, fila - FILAS_ATRAS_CODIGO);
        let ventana = hoja.getRange(desde, 1, fila - desde + 1, 1).getValues();
        let celdas = clasificarFilasFinales(ventana, desde);
        let mia = celdas[celdas.length - 1];
        if (mia && mia.tipo === "relleno") {
            hoja.getRange(fila, 2, 1, 3).setValues([[textoDeRellenoFinal(mia), "", ""]]);
            hoja.getRange(fila, 2).setBackground(COLOR_FINAL_RELLENO);
            return;
        }
    }

    let lock = null;
    try { lock = LockService.getScriptLock(); lock.waitLock(30000); }
    catch (err) { lock = null; }   // sin lock, se recalcula igual
    try {
        recalcularPedimentosFinales(ss, hoja, Math.max(fila, FILA_INICIO_FINALES), fila + numFilas - 1);
    } finally {
        if (lock) { try { lock.releaseLock(); } catch (err) { /* nada */ } }
    }
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
        hoja.setFrozenRows(1);
        hoja.setColumnWidth(1, 200);
        hoja.setColumnWidth(2, 340);
        hoja.setColumnWidth(3, 620);
        creada = true;
    }
    // También en una pestaña que ya existía: así le aparece la columna D.
    ponerTitulosFinales(hoja);
    if (hoja.getMaxColumns() < COL_CODIGOS_UNIDAD + 1) {
        hoja.insertColumnsAfter(hoja.getMaxColumns(), COL_CODIGOS_UNIDAD + 1 - hoja.getMaxColumns());
    }
    let cods = 0;
    try { cods = escribirCodigosDeUnidades(ss, hoja); } catch (err) { cods = -1; }
    hoja.setColumnWidth(COL_CODIGOS_UNIDAD, 220);
    hoja.setColumnWidth(COL_CODIGOS_UNIDAD + 1, 260);
    let n = recalcularPedimentosFinales(ss, hoja);
    ss.setActiveSheet(hoja);
    ui.alert("🧾 Pedimentos finales",
        (creada ? "Pestaña «" + NOMBRE + "» creada.\n\n" : "") +
        "CÓMO SE USA:\n" +
        "   1. En la columna A ESCANEA EL CÓDIGO DE LA UNIDAD (o escribe su " +
        "nombre: «GLOBAL 1», o las placas).\n" +
        "   2. Debajo, escanea el CÓDIGO DE BARRAS de cada pedimento final. " +
        "Trae doce datos y la pistola puede repartirlos en varias filas: no " +
        "pasa nada, se reconoce el número de pedimento y el resto sale como " +
        "«↳ dato del código». También vale teclear los 7 dígitos.\n" +
        "   3. Para la siguiente unidad, escanea su código y sigue debajo.\n\n" +
        "LOS CÓDIGOS DE LAS UNIDADES están en las columnas E y F" +
        (cods > 0 ? " (" + cods + " unidades)" : "") + ". Genera cada uno en " +
        "Code 39 con tu programa de etiquetas de siempre, igual que los WMS. " +
        "Son cortos a propósito —«GLOBAL 1», sin las placas—, así la etiqueta " +
        "sirve todos los días aunque cambie el camión.\n\n" +
        "La columna B dice si cada pedimento ESTÁ en esa unidad, y la D trae el " +
        "número de pedimento limpio. La fila de la unidad dice el total, los que " +
        "NO ESTÁN en la unidad y los que están en la unidad SIN PAPEL.\n\n" +
        "Solo se compara contra la columna A de la unidad que escaneaste: nada " +
        "de bultos ni de M-S.\n\n" +
        (n ? "Revisadas " + n + " unidades." : "Todavía no hay nada escaneado.") +
        "\n\nPara volver a revisar todo: escanea WMSACT en esta pestaña.",
        ui.ButtonSet.OK);
}
