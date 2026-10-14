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
// Global, menos el rezago y el histórico. (La de los comandos ya es interna,
// así que `esHojaPrincipal` la deja fuera sola.)
function esHojaDeUnidad(nombreHoja) {
    let n = claveHoja(nombreHoja);
    if (!esHojaPrincipal(n)) return false;
    if (n.indexOf("REZAGO") !== -1) return false;
    if (n === claveHoja(nombreHojaHistorico())) return false;
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

// La espera del lock del script para recalcular. Ver `atenderPedimentosFinales`.
const ESPERA_FINALES_INSTALABLE_MS = 30000;
const ESPERA_FINALES_SIMPLE_MS = 8000;

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
    // UN BLOQUE (una tanda de papeles): «BLOQUE», o «BLOQUE 3» si se quiere
    // fijar el número. «TANDA» vale igual. Va ANTES de la unidad: si no, la
    // palabra se tomaría por el nombre de una pestaña.
    let mb = /^(BLOQUE|TANDA)(?:\s*(\d+))?$/.exec(v);
    if (mb) return { tipo: "tanda", valor: v, numero: mb[2] ? Number(mb[2]) : null };
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
            if (empiezaCodigo(m) || cm.tipo === "pedimento" || cm.tipo === "comando" ||
                cm.tipo === "tanda") break;
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

// -------------------------------------------------------------------------
// LOS BLOQUES DE PAPELES (TANDAS)
// -------------------------------------------------------------------------
//
// Los pedimentos finales no llegan todos a la vez: diez, luego cincuenta,
// luego el resto. Para medir esos tiempos, antes de cada tanda se escribe —o
// se escanea— «BLOQUE» en la columna A, debajo de la unidad. Se numeran
// solos (BLOQUE 1, BLOQUE 2…); con «BLOQUE 3» se fija el número y los
// siguientes siguen desde ahí.
//
// La fila del bloque dice cuántos pedimentos trae y en qué horario se
// escanearon, y su hora (columna E) es la de cuándo llegó la tanda. Cada
// pedimento va al registro de tiempos con su bloque.
const COLOR_FINAL_TANDA = '#d9ead3';

// Qué bloque le toca a cada fila: idx → «BLOQUE n». Puro.
function etiquetasDeTandas(filas) {
    let porFila = new Map();
    let actual = "", n = 0;
    (filas || []).forEach(f => {
        if (f.tipo === "tanda") {
            n = f.numero ? f.numero : n + 1;
            actual = "BLOQUE " + n;
            porFila.set(f.idx, actual);
        } else if (f.tipo === "pedimento") {
            porFila.set(f.idx, actual);
        }
    });
    return porFila;
}

function ponerTandas(out, tandas) {
    tandas.forEach((etiqueta, idx) => {
        let r = out.get(idx);
        if (r && !r.esTanda) r.tanda = etiqueta;
    });
}

function horaCorta(d) {
    let dos = x => ("0" + x).slice(-2);
    return dos(d.getHours()) + ":" + dos(d.getMinutes());
}

// LAS ESPERAS DE UN BLOQUE, en palabras. Puro.
//
// SOLO EL HUECO ENTRE TANDAS, del segundo bloque en adelante: cuánto tardó en
// llegar después de TERMINAR el anterior. En el primero no se dice nada.
//
// «Empezó N min después de llegar» se quitó a petición: cada bloque se empieza
// a escanear en cuanto llega, así que salía siempre en 0 y no decía nada.
//
// Si el bloque no tiene hora de llegada, el hueco se mide hasta su primer
// pedimento.
function textoDeEsperaDeBloque(esPrimero, llego, primero, finAnterior, etiquetaAnterior) {
    if (esPrimero) return "";
    let esHora = v => v instanceof Date && !isNaN(v.getTime());
    let partes = [];
    let inicio = esHora(llego) ? llego : primero;
    if (esHora(finAnterior) && esHora(inicio)) {
        partes.push((esHora(llego) ? "llegó " : "empezó ") +
                    Math.max(0, Math.round((inicio - finAnterior) / 60000)) +
                    " min después de terminar el " + etiquetaAnterior);
    }
    return partes.join(" · ");
}

// El resumen de cada fila de bloque, con las horas ya puestas. Puro.
// Devuelve idx → {estado, detalle}.
function resumenDeTandas(bloque, resultados, horas) {
    let out = new Map();
    let filas = (bloque.filas || []).slice().sort((a, b) => a.idx - b.idx);
    let esHora = v => v instanceof Date && !isNaN(v.getTime());
    let anterior = null;   // {etiqueta, fin} del bloque de arriba
    filas.forEach((f, k) => {
        if (f.tipo !== "tanda") return;
        let r = resultados.get(f.idx) || {};
        let miembros = [];
        for (let j = k + 1; j < filas.length && filas[j].tipo !== "tanda"; j++) {
            if (filas[j].tipo !== "pedimento") continue;
            let rr = resultados.get(filas[j].idx) || {};
            // Los repetidos en la lista no son papeles nuevos: no cuentan.
            if (String(rr.estado || "").indexOf("REPETIDO") !== -1) continue;
            miembros.push(filas[j].idx);
        }
        let hs = miembros.map(i => (horas[i - bloque.desde] || [])[0]).filter(esHora)
                         .sort((a, b) => a - b);
        let llego = (horas[f.idx - bloque.desde] || [])[0];
        let estado = "📦 " + (r.tanda || "BLOQUE") + " · " + miembros.length +
                     (miembros.length === 1 ? " pedimento" : " pedimentos");
        if (hs.length) {
            let min = Math.round((hs[hs.length - 1] - hs[0]) / 60000);
            estado += " · " + horaCorta(hs[0]) + " → " + horaCorta(hs[hs.length - 1]) +
                      " (" + min + " min)";
        }
        let espera = textoDeEsperaDeBloque(anterior === null, llego, hs[0],
                                           anterior ? anterior.fin : null,
                                           anterior ? anterior.etiqueta : "");
        let detalle = [esHora(llego) ? "Llegó a las " + horaCorta(llego) : "", espera]
            .filter(x => x !== "").join(" · ");
        out.set(f.idx, { estado: estado, detalle: detalle });
        anterior = { etiqueta: r.tanda || "BLOQUE", fin: hs.length ? hs[hs.length - 1] : null };
    });
    return out;
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
                            rfc: celda.rfc || "", numero: celda.numero || null });
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
    // Los bloques de papeles. Su resumen —cuántos y en qué horario— se pone
    // después, cuando ya se saben las horas: ver `resumenDeTandas`.
    let tandas = etiquetasDeTandas(bloque.filas);
    bloque.filas.forEach(f => {
        if (f.tipo === "tanda") {
            out.set(f.idx, { estado: "📦 " + tandas.get(f.idx), color: COLOR_FINAL_TANDA,
                             detalle: "", esTanda: true, tanda: tandas.get(f.idx) });
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
        ponerTandas(out, tandas);
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

    ponerTandas(out, tandas);
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

// Las horas de la columna E de un bloque. Puro.
//
// LA HORA DE AHORA SOLO SE PONE AL ESCANEAR: a las filas de pedimento que
// están dentro de lo editado (`filaDesde`-`filaHasta`) y que todavía no tienen
// la suya. Un recálculo completo —WMSACT— no pone la suya a nadie. Si lo hiciera,
// los pedimentos escaneados antes de que existiera esta columna saldrían todos
// con la hora del WMSACT, y esa hora inventada es justo la que estropea la
// cuenta de tiempos.
//
// LOS HUECOS SE RELLENAN CON LA DE ARRIBA, como la columna L de los escaneos.
// Un pedimento se queda sin hora cuando Google no llega a procesar SU escaneo
// —se le cae el disparador con muchos a la vez, o se corta—: el siguiente
// escaneo sí recalcula el bloque y su columna B sale bien, pero la hora solo
// la ponía el escaneo de esa misma fila. Ahora cualquier recálculo se la pone:
//   · un pedimento, la de la fila de arriba con hora, dentro del mismo BLOQUE
//     —se escanean seguidos, así que es la más cercana a la de verdad—; si es
//     el primero, la del de abajo;
//   · la fila de un BLOQUE, la de su primer pedimento: se empieza a escanear
//     en cuanto llega.
// Nunca se cruza de un BLOQUE a otro: la hora del anterior diría que el
// siguiente llegó cuando el otro terminó. Y un bloque donde nadie tiene hora
// —lo escaneado antes de la columna— se queda como está.
//
// LA HORA ES DEL PAPEL, NO DE LA FILA. Al escanear en una fila que ya tenía
// hora, se queda solo si es el MISMO pedimento (la columna D dice cuál era) o
// si se puso hace un momento (el mismo escaneo procesado dos veces). Si no, es
// un papel nuevo y lleva la hora de ahora. Antes la hora vieja se quedaba
// siempre: un pedimento escaneado hoy en una fila con una hora de hace dos
// días salía con esa hora, no iba al registro de hoy —el reporte contaba uno
// menos— y su bloque decía «(2882 min)».
//
// UNA HORA VIEJA ENTRE LAS DE HOY TAMBIÉN SE ARREGLA. Dentro de un BLOQUE se
// escanea de arriba abajo en pocos minutos, así que una hora de más de doce
// horas ANTES que la de una fila de arriba es un resto de otro día: se trata
// como un hueco y se rellena. Lo de abajo puede ser más nuevo —un bloque de
// ayer al que hoy se le añadió algo— y eso no se toca.
//
// Y LA FILA DEL BLOQUE CON HORA DE OTRO DÍA, también: una llegada de más de
// doce horas antes que su primer pedimento es la de ayer, que se quedó en la
// fila al reaprovecharla para la misma unidad. Toma la de su primer pedimento
// y el reporte de hoy ya tiene llegada.
//
// Fuera de eso, la hora que ya está NO SE TOCA, aunque se recalcule cien
// veces. Solo se borra si en esa fila, al editarla, ya no queda un pedimento.
//
// `pedimentosAntes` es la columna D de antes, en el formato de `getValues`.
//
// Devuelve las horas en el formato de `getValues`, los índices de las filas a
// las que se les acaba de poner (las que van al registro) y los de TODAS las
// que cambian, que son las únicas que se escriben.
const MS_HORA_RECIENTE_FINALES = 10 * 60000;
const MS_HORA_VIEJA_FINALES = 12 * 3600000;

function horasDelBloque(bloque, resultados, horasAntes, filaDesde, filaHasta, ahora, pedimentosAntes) {
    let esHora = v => v instanceof Date && !isNaN(v.getTime());
    let comoPedimento = v => {
        let t = String(v === undefined || v === null ? "" : v).trim();
        return /^\d{1,7}$/.test(t) ? ("0000000" + t).slice(-7) : t;
    };
    let horas = [], nuevas = [], cambiadas = [], huecos = new Set(), editadas = new Set();
    let d = filaDesde ? filaDesde - 1 : -1;
    let hst = filaDesde ? (filaHasta || filaDesde) - 1 : -2;
    for (let i = bloque.desde; i <= bloque.hasta; i++) {
        let k = i - bloque.desde;
        let antes = (horasAntes[k] || [])[0];
        if (antes === undefined || antes === null) antes = "";
        let r = resultados.get(i) || {};
        // La fila del BLOQUE también lleva hora: es cuándo llegó esa tanda,
        // la mitad de la cuenta de tiempos.
        let llevaHora = !!(r.pedimento || r.esTanda);
        let editada = i >= d && i <= hst;
        if (editada) editadas.add(i);
        if (!llevaHora) {
            if (editada) {
                horas.push([""]);
                if (String(antes).trim() !== "") cambiadas.push(i);
            } else {
                horas.push([antes]);
            }
        } else if (editada) {
            let mismoPapel = esHora(antes) && (
                (!!r.pedimento && comoPedimento(((pedimentosAntes || [])[k] || [])[0]) === r.pedimento) ||
                (esHora(ahora) && Math.abs(ahora - antes) < MS_HORA_RECIENTE_FINALES));
            if (mismoPapel) {
                horas.push([antes]);
            } else {
                horas.push([ahora]);
                nuevas.push(i);
                cambiadas.push(i);
            }
        } else {
            horas.push([antes]);
            // Lo que alguien escribió a mano en la E no se pisa.
            if (String(antes).trim() === "") huecos.add(i);
        }
    }

    // Las horas viejas entre las de hoy, como huecos. Primero los BLOQUES
    // contra su primer pedimento…
    let conHora = (j) => {
        let rj = resultados.get(j) || {};
        return (rj.pedimento || rj.esTanda) && !huecos.has(j) && esHora(horas[j - bloque.desde][0]);
    };
    for (let i = bloque.desde; i <= bloque.hasta; i++) {
        let r = resultados.get(i) || {};
        if (!r.esTanda || editadas.has(i) || !conHora(i)) continue;
        for (let j = i + 1; j <= bloque.hasta && !(resultados.get(j) || {}).esTanda; j++) {
            if (!conHora(j)) continue;
            if (horas[i - bloque.desde][0] < horas[j - bloque.desde][0] - MS_HORA_VIEJA_FINALES) huecos.add(i);
            break;
        }
    }
    // …y luego cada fila contra las de arriba.
    let ultima = null;
    for (let i = bloque.desde; i <= bloque.hasta; i++) {
        let r = resultados.get(i) || {};
        if (r.esTanda) ultima = null;
        if (!(r.pedimento || r.esTanda) || huecos.has(i)) continue;
        let v = horas[i - bloque.desde][0];
        if (!esHora(v)) continue;
        if (ultima && !editadas.has(i) && v < ultima - MS_HORA_VIEJA_FINALES) { huecos.add(i); continue; }
        if (!ultima || v > ultima) ultima = v;
    }

    if (huecos.size) {
        let rellenar = (i, hora) => {
            horas[i - bloque.desde] = [hora];
            nuevas.push(i);
            cambiadas.push(i);
        };
        let arriba = null, sinNadaArriba = [];
        for (let i = bloque.desde; i <= bloque.hasta; i++) {
            let r = resultados.get(i) || {};
            // Cada BLOQUE empieza de cero.
            if (r.esTanda) { arriba = null; sinNadaArriba = []; }
            let v = horas[i - bloque.desde][0];
            if (huecos.has(i)) {
                if (arriba && !r.esTanda) rellenar(i, arriba);
                else sinNadaArriba.push(i);
            } else if (esHora(v)) {
                sinNadaArriba.forEach(k => rellenar(k, v));
                sinNadaArriba = [];
                arriba = v;
            }
        }
        nuevas.sort((a, b) => a - b);
    }
    return { horas: horas, nuevas: nuevas, cambiadas: cambiadas.sort((a, b) => a - b) };
}

// Las filas seguidas, juntas: [3, 4, 5, 9] → [[3, 5], [9, 9]]. Puro.
function tramosSeguidos(indices) {
    let out = [];
    (indices || []).forEach(i => {
        let u = out[out.length - 1];
        if (u && i === u[1] + 1) u[1] = i;
        else out.push([i, i]);
    });
    return out;
}

// ¿La F dice lo mismo que la E? Dos fechas del mismo instante, o las dos
// vacías. Puro.
function mismaHoraFinal(a, b) {
    let esHora = v => v instanceof Date && !isNaN(v.getTime());
    if (esHora(a) || esHora(b)) return esHora(a) && esHora(b) && a.getTime() === b.getTime();
    let t = v => String(v === undefined || v === null ? "" : v).trim();
    return t(a) === t(b);
}

// LOS RECÁLCULOS DE ESTA PESTAÑA VAN DE UNO EN UNO, con el lock del script (no
// el del documento: no frena ningún escaneo).
//
// Y ANTES DE SOLTARLO, TODO A LA HOJA (`flush`). Google guarda lo escrito al
// TERMINAR la ejecución, no al soltar el lock: el escaneo siguiente entraba en
// ese medio segundo, leía la columna E todavía vacía y le volvía a escribir el
// vacío encima. Así se perdían horas de pedimentos que sí se habían escaneado.
//
// Con `obligatorio`, si no hay turno no se hace (el repaso: ya lo hará otro).
// Sin él, se hace igual: un escaneo sin resultado es peor que dos a la vez.
function conTurnoDeFinales(esperaMs, fn, obligatorio) {
    let lock = null;
    try {
        lock = LockService.getScriptLock();
        if (obligatorio) {
            if (!lock.tryLock(esperaMs)) return null;
        } else {
            lock.waitLock(esperaMs);
        }
    } catch (err) {
        if (obligatorio) return null;
        lock = null;
    }
    try {
        return fn();
    } finally {
        try { SpreadsheetApp.flush(); } catch (err) { /* nada */ }
        if (lock) { try { lock.releaseLock(); } catch (err) { /* nada */ } }
    }
}

// Recalcula los bloques de la pestaña. Con `filas` (1-based, inclusive) solo
// los que las tocan; sin él, todos. Con `soloBloques` (los `desde` de cada
// uno), solo esos: es lo que usa el repaso. `ahora` es la hora del escaneo,
// tomada al llegar y no después de esperar el turno.
function recalcularPedimentosFinales(ss, hoja, filaDesde, filaHasta, soloBloques, ahora) {
    let lr = Math.max(hoja.getLastRow(), filaHasta || 0, FILA_INICIO_FINALES);
    let valoresA = hoja.getRange(1, 1, lr, 1).getValues();
    let bloques = bloquesDePedimentosFinales(valoresA);
    if (filaDesde) {
        let d = filaDesde - 1, hst = (filaHasta || filaDesde) - 1;
        // `d - 1` Y NO `d`: también el bloque que acaba JUSTO ENCIMA. Una
        // edición puede mover dónde termina el de arriba —escanear la unidad
        // siguiente, o meter una unidad a mitad de otra— y entonces su última
        // fila cambia de significado: un «6116» que esperaba ser patente pasa
        // a ser un error, y los pedimentos que se fueron al bloque nuevo ya no
        // cuentan en el de arriba. Sin recalcularlo se quedaba con el resultado
        // de antes.
        bloques = bloques.filter(b => b.hasta >= d - 1 && b.desde <= hst);
    }
    if (soloBloques) bloques = bloques.filter(b => soloBloques.has(b.desde));

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

    if (!(ahora instanceof Date)) ahora = new Date();
    // Un recálculo COMPLETO —WMSACT, o el botón del menú— además cuadra la
    // pestaña con el registro: ver `faltanEnRegistro`.
    let completo = !filaDesde && !soloBloques;
    let paraRegistro = [], enLaHoja = [], fallo = null;
    let filaDeRegistro = (b, ev, h, unidadDelBloque, i) => {
        let r = ev.resultados.get(i) || {};
        let f = b.filas.find(x => x.idx === i) || {};
        // Con SU hora, que en un hueco rellenado es la de arriba.
        return [h.horas[i - b.desde][0], unidadDelBloque, r.pedimento || "",
                r.esTanda ? "📦 LLEGÓ EL " + r.tanda : (r.estado || ""),
                f.patente || "", r.tanda || ""];
    };
    // UN BLOQUE QUE FALLA NO SE LLEVA A LOS DEMÁS, y lo suyo va al registro
    // ANTES de escribir la hora en la hoja. Al revés, un error a mitad dejaba
    // la hora puesta y sin apuntar, y como ya tenía hora nadie la volvía a
    // apuntar: la pestaña contaba uno más que el reporte.
    bloques.forEach(b => {
      try {
        let ev = evaluarBloqueFinal(b, unidades, leerUnidad);
        let n = b.hasta - b.desde + 1;
        // La D, la E y la F de una vez: la D dice de qué pedimento era cada
        // hora, la E es la fecha y la hora, y la F la misma hora aparte.
        let def = hoja.getRange(b.desde + 1, COL_HORA_FINALES - 1, n, 3).getValues();
        let h = horasDelBloque(b, ev.resultados, def.map(f => [f[1]]), filaDesde, filaHasta, ahora,
                               def.map(f => [f[0]]));
        let unidadDelBloque = ev.unidad ? ev.unidad.nombre : (b.unidad || "(sin unidad)");
        let nuevas = new Set(h.nuevas);
        h.nuevas.forEach(i => paraRegistro.push(filaDeRegistro(b, ev, h, unidadDelBloque, i)));
        if (completo) {
            for (let i = b.desde; i <= b.hasta; i++) {
                let r = ev.resultados.get(i) || {};
                let v = h.horas[i - b.desde][0];
                if (nuevas.has(i) || !(r.pedimento || r.esTanda)) continue;
                if (!(v instanceof Date) || isNaN(v.getTime())) continue;
                enLaHoja.push(filaDeRegistro(b, ev, h, unidadDelBloque, i));
            }
        }

        let resumenTandas = resumenDeTandas(b, ev.resultados, h.horas);
        let textos = [], colores = [];
        for (let i = b.desde; i <= b.hasta; i++) {
            let r = ev.resultados.get(i) || { estado: "", color: COLOR_FINAL_NEUTRO, detalle: "" };
            if (resumenTandas.has(i)) r = Object.assign({}, r, resumenTandas.get(i));
            // La D lleva SOLO el número de pedimento, limpio. Cuando se escanea
            // el código de barras la columna A trae doce datos (en una celda o
            // en varias filas) y lo que interesa es uno: aquí queda a la vista,
            // listo para copiar o filtrar.
            textos.push([r.estado, r.detalle, r.pedimento || ""]);
            colores.push([r.estado === "" ? COLOR_FINAL_NEUTRO : r.color]);
        }
        hoja.getRange(b.desde + 1, 2, n, 3).setValues(textos);
        hoja.getRange(b.desde + 1, 2, n, 1).setBackgrounds(colores);
        // LA E Y LA F, SOLO DONDE CAMBIAN. Reescribirlas enteras devolvía a la
        // hoja lo que se leyó al empezar, y si mientras tanto otro escaneo
        // había puesto una hora, se borraba. También donde la F no dice lo
        // mismo que la E: así WMSACT la pone en lo escaneado antes de que
        // existiera.
        let aEscribir = new Set(h.cambiadas);
        for (let i = b.desde; i <= b.hasta; i++) {
            if (!mismaHoraFinal(h.horas[i - b.desde][0], def[i - b.desde][2])) aEscribir.add(i);
        }
        tramosSeguidos(Array.from(aEscribir).sort((x, y) => x - y)).forEach(t => {
            hoja.getRange(t[0] + 1, COL_HORA_FINALES, t[1] - t[0] + 1, 2)
                .setValues(h.horas.slice(t[0] - b.desde, t[1] - b.desde + 1).map(x => [x[0], x[0]]));
        });
      } catch (err) { if (!fallo) fallo = err; }
    });
    // AL REGISTRO, las horas que se acaban de poner. Así un pedimento queda
    // apuntado UNA vez, la del escaneo, por muchas veces que se recalcule.
    // Y en un recálculo completo, también lo que la pestaña tiene con hora y
    // el registro no (`faltanEnRegistro`): pase lo que pase en un escaneo, un
    // WMSACT deja la pestaña y el reporte con los mismos pedimentos.
    if (completo && enLaHoja.length && typeof faltanEnRegistro === 'function') {
        // Si no se puede comparar, se apunta al menos lo nuevo.
        try { paraRegistro = paraRegistro.concat(faltanEnRegistro(ss, enLaHoja, paraRegistro)); }
        catch (err) { /* lo arreglará el siguiente WMSACT */ }
    }
    if (paraRegistro.length && typeof anotarEnRegistro === 'function') {
        try {
            anotarEnRegistro(ss, nombreHojaSisTiempos(), cabeceraSisTiempos(), paraRegistro);
        } catch (err) { /* el registro nunca puede tumbar el cuadre */ }
    }
    if (fallo) throw fallo;
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
//
// Y SIEMPRE CON ALGÚN DÍGITO, salvo que sea el nombre entero. Con una sola
// GLOBAL abierta, la palabra «GLOBAL» sola ya la distinguía, y eso era lo que
// se imprimía; al día siguiente se abría la GLOBAL 2 y la etiqueta pasaba a
// decir «hay varias unidades así». El número es lo que hace que la etiqueta
// siga valiendo cuando cambian las demás pestañas.
function codigoCortoDeUnidad(nombre, unidades) {
    let palabras = claveDeUnidad(nombre).split(" ").filter(p => p !== "");
    let objetivo = claveDeUnidad(nombre);
    for (let k = 1; k <= palabras.length; k++) {
        let cand = palabras.slice(0, k).join(" ");
        if (/^\d+$/.test(cand.replace(/\s/g, ""))) continue;
        if (k < palabras.length && !/\d/.test(cand)) continue;
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

// Los códigos de las unidades de hoy, en las columnas G y H de la pestaña.
// Lejos de A:E a propósito: lo que se escanea y lo que se imprime no se
// mezclan. (Estaban en la E y la F; la E pasó a ser la hora.)
const COL_CODIGOS_UNIDAD = 7;

// LA HORA DE CADA PEDIMENTO, en la E. Se pone AL ESCANEARLO y no se vuelve a
// tocar: los papeles llegan por tandas y esta hora es la que dice cuándo llegó
// cada una. Ver `horasDelBloque`.
// LA FECHA Y LA HORA VAN APARTE, a petición: la E con la fecha y la F con
// la hora. Las dos guardan el mismo valor —la fecha y hora entera— con
// distinto formato. La que se lee para todo es la E; la F se escribe siempre
// junto con ella.
const COL_HORA_FINALES = 5;

function escribirCodigosDeUnidades(ss, hoja) {
    let unidades = unidadesDelArchivo(ss);
    let filas = [["PESTAÑA DE LA UNIDAD", "TEXTO DEL CÓDIGO DE BARRAS"]];
    unidades.forEach(u => {
        let c = codigoCortoDeUnidad(u.nombre, unidades);
        filas.push([u.nombre, cabeEnCode39(c) ? c : c + "   (usa Code 128)"]);
    });
    // Y el de los bloques de papeles: se escanea antes de cada tanda.
    filas.push(["(cada nuevo bloque de pedimentos)", "BLOQUE"]);
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
    // LA MUDANZA DE LOS CÓDIGOS. Antes vivían en la E y la F, que ahora son
    // la hora. Se reconocen por su título y se borran: `escribirCodigosDeUnidades`
    // los vuelve a poner en la G y la H. Sin esto, el nombre de una unidad en
    // la E parecería una hora ya puesta.
    if (hoja.getMaxColumns() >= 6 &&
        String(hoja.getRange(1, 5).getValue()).trim() === "PESTAÑA DE LA UNIDAD") {
        hoja.getRange(1, 5, hoja.getMaxRows(), 2).clearContent();
    }
    if (hoja.getMaxColumns() < COL_CODIGOS_UNIDAD + 1) {
        hoja.insertColumnsAfter(hoja.getMaxColumns(), COL_CODIGOS_UNIDAD + 1 - hoja.getMaxColumns());
    }
    hoja.getRange(1, 1, 1, 6)
        .setValues([["UNIDAD Y SUS PEDIMENTOS", "RESULTADO", "ERRORES Y DETALLE", "PEDIMENTO",
                     "FECHA", "HORA"]])
        .setFontWeight("bold");
    hoja.getRange(2, COL_HORA_FINALES, Math.max(hoja.getMaxRows() - 1, 1), 1)
        .setNumberFormat("dd/mm/yyyy");
    hoja.getRange(2, COL_HORA_FINALES + 1, Math.max(hoja.getMaxRows() - 1, 1), 1)
        .setNumberFormat("hh:mm:ss");
    hoja.setColumnWidth(COL_HORA_FINALES, 95);
    hoja.setColumnWidth(COL_HORA_FINALES + 1, 80);
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
function atenderPedimentosFinales(ss, hoja, fila, numFilas, esInstalable) {
    if (fila + numFilas - 1 < FILA_INICIO_FINALES) return;

    if (numFilas === 1 && fila >= FILA_INICIO_FINALES) {
        let desde = Math.max(FILA_INICIO_FINALES, fila - FILAS_ATRAS_CODIGO);
        let ventana = hoja.getRange(desde, 1, fila - desde + 1, 1).getValues();
        let celdas = clasificarFilasFinales(ventana, desde);
        let mia = celdas[celdas.length - 1];
        // EL RFC SÍ RECALCULA: llega DESPUÉS de la fila del pedimento, así que
        // cuando el pedimento se calculó todavía no estaban ni la clave ni el
        // RFC, y su columna C se quedaba en «Patente 6087». Con el RFC ya
        // están los tres datos que se enseñan; un recálculo por papel más, en
        // vez de doce.
        if (mia && mia.tipo === "relleno" && mia.campo !== "RFC") {
            hoja.getRange(fila, 2, 1, 3).setValues([[textoDeRellenoFinal(mia), "", ""]]);
            hoja.getRange(fila, 2).setBackground(COLOR_FINAL_RELLENO);
            return;
        }
    }

    // LA HORA, AL LLEGAR. Con cincuenta papeles en dos minutos los recálculos
    // hacen cola, y tomarla después de esperar el turno la retrasaba.
    let ahora = new Date();
    anotarActividadDeFinales();
    // CUÁNTO SE ESPERA DEPENDE DE QUIÉN LLAMA. El disparador simple tiene
    // treinta segundos EN TOTAL —esperar y trabajar—, y puede haber gastado
    // ya seis esperando al instalable: con 30 de espera aquí, Google lo
    // cortaba a mitad y el escaneo se quedaba sin resultado.
    conTurnoDeFinales(esInstalable ? ESPERA_FINALES_INSTALABLE_MS : ESPERA_FINALES_SIMPLE_MS, () =>
        recalcularPedimentosFinales(ss, hoja, Math.max(fila, FILA_INICIO_FINALES), fila + numFilas - 1,
                                    null, ahora));
}

// EL REPASO DE CINCO MINUTOS PONE LAS HORAS QUE FALTEN. El siguiente escaneo
// ya rellena los huecos de su bloque, pero si el que se perdió fue el último
// del día no habría siguiente. Solo mira si se escaneó aquí en la última media
// hora: si no, no lee nada.
const CLAVE_FINALES_ACTIVIDAD = 'WMS_FINALES_ACTIVIDAD';
const SEGUNDOS_FINALES_ACTIVIDAD = 1800;

function anotarActividadDeFinales() {
    try { CacheService.getScriptCache().put(CLAVE_FINALES_ACTIVIDAD, '1', SEGUNDOS_FINALES_ACTIVIDAD); }
    catch (err) { /* sin marca, lo arregla el siguiente escaneo o WMSACT */ }
}

// Lo que necesita `horasDelBloque` sin leer ninguna unidad: qué filas son
// pedimento y cuáles BLOQUE. Puro.
function filasConHoraDelBloque(bloque) {
    let m = new Map();
    bloque.filas.forEach(f => {
        if (f.tipo === "pedimento") m.set(f.idx, { pedimento: f.valor });
        else if (f.tipo === "tanda") m.set(f.idx, { esTanda: true });
    });
    return m;
}

// Devuelve cuántos bloques tenían horas que poner.
function repasarHorasDeFinales(ss) {
    let hubo = false;
    try { hubo = CacheService.getScriptCache().get(CLAVE_FINALES_ACTIVIDAD) === '1'; }
    catch (err) { hubo = false; }
    if (!hubo) return 0;
    let hoja = null;
    ss.getSheets().forEach(h => { if (!hoja && esHojaPedimentosFinales(h.getName())) hoja = h; });
    if (!hoja) return 0;
    // Si hay un escaneo recalculando, no se le espera: ese ya rellena.
    let n = conTurnoDeFinales(3000, () => {
        let lr = hoja.getLastRow();
        if (lr < FILA_INICIO_FINALES) return 0;
        let valoresA = hoja.getRange(1, 1, lr, 1).getValues();
        let horasE = hoja.getRange(1, COL_HORA_FINALES, lr, 1).getValues();
        let conHuecos = new Set();
        bloquesDePedimentosFinales(valoresA).forEach(b => {
            let h = horasDelBloque(b, filasConHoraDelBloque(b), horasE.slice(b.desde, b.hasta + 1));
            if (h.nuevas.length) conHuecos.add(b.desde);
        });
        if (conHuecos.size) recalcularPedimentosFinales(ss, hoja, null, null, conHuecos);
        return conHuecos.size;
    }, true);
    return n || 0;
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
    let n = conTurnoDeFinales(ESPERA_FINALES_INSTALABLE_MS, () => recalcularPedimentosFinales(ss, hoja));
    try { if (typeof rehacerReporteDeTiempos === 'function') rehacerReporteDeTiempos(ss); }
    catch (err) { /* el reporte nunca puede tumbar el cuadre */ }
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
        "LOS CÓDIGOS DE LAS UNIDADES están en las columnas G y H" +
        (cods > 0 ? " (" + cods + " unidades)" : "") + ". Genera cada uno en " +
        "Code 39 con tu programa de etiquetas de siempre, igual que los WMS. " +
        "Son cortos a propósito —«GLOBAL 1», sin las placas—, así la etiqueta " +
        "sirve todos los días aunque cambie el camión.\n\n" +
        "La columna B dice si cada pedimento ESTÁ en esa unidad, y la D trae el " +
        "número de pedimento limpio. La fila de la unidad dice el total, los que " +
        "NO ESTÁN en la unidad y los que están en la unidad SIN PAPEL.\n\n" +
        "LOS PAPELES POR TANDAS: antes de cada tanda escribe (o escanea) " +
        "«BLOQUE» debajo de la unidad. Se numeran solos; la fila del bloque " +
        "dice cuántos pedimentos trae y en qué horario se escanearon.\n\n" +
        "Las columnas E y F guardan la FECHA y la HORA en que escaneaste cada " +
        "pedimento, y no cambian aunque se recalcule. Si a alguno se le escapa, se le pone la " +
        "del de arriba en cuanto escaneas el siguiente (o con WMSACT, o en el " +
        "repaso de cinco minutos). Cada hora queda apuntada en «" +
        "SIS_TIEMPOS_REGISTRO», que no se borra aunque limpies esta pestaña, y " +
        "«SIS_TIEMPOS_PEDIMENTOS» lo enseña AGRUPADO POR UNIDAD, con cada bloque " +
        "resumido. Ese reporte se pone al día con WMSACT aquí, o solo cada cinco " +
        "minutos.\n\n" +
        "Solo se compara contra la columna A de la unidad que escaneaste: nada " +
        "de bultos ni de M-S.\n\n" +
        (n ? "Revisadas " + n + " unidades." : "Todavía no hay nada escaneado.") +
        "\n\nPara volver a revisar todo: escanea WMSACT en esta pestaña.",
        ui.ButtonSet.OK);
}
