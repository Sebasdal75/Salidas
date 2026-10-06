// =========================================================================
// COMANDOS POR CÓDIGO DE BARRAS
// =========================================================================
//
// QUÉ RESUELVE. Para actualizar una pestaña, limpiar lo que ya salió o poner
// las houses había que ir a la computadora y buscar el botón en el menú. En el
// muelle eso son cincuenta metros de ida y vuelta, y por eso no se hace: se
// deja para luego y la unidad sale con el conteo viejo.
//
// El lector ya escribe en la columna A y el disparador de edición ya corre en
// cada escaneo. O sea que la mitad del trabajo estaba hecha: basta reconocer
// unas pocas palabras y, en vez de tratarlas como guía, ejecutar la acción.
//
// -------------------------------------------------------------------------
// POR QUÉ ESTOS CÓDIGOS Y NO OTROS
// -------------------------------------------------------------------------
// Empiezan por «WMS» y NO MIDEN ONCE NI DIECIOCHO caracteres, que son los dos
// largos de una guía. Así, aunque un día fallara la intercepción, lo peor que
// pasaría es que saliera «❌ Guía Inválida» —ruido— y nunca que un comando se
// contara como un bulto.
//
// Solo letras y dígitos, sin símbolos: Code 39 no admite «#» ni «*» dentro del
// dato, y es la simbología que cualquier lector lee sin configurarle nada. Con
// Code 128 valen igual.
//
// -------------------------------------------------------------------------
// LO QUE UN COMANDO NO PUEDE HACER
// -------------------------------------------------------------------------
// NINGUNO ABRE UN DIÁLOGO. Un `ui.alert` dentro de un disparador se queda
// esperando una respuesta que en un teléfono no va a llegar, y con él se queda
// colgado el lock del documento: siete personas escaneando contra un archivo
// bloqueado. Todo se dice con `toast`, que sale igual en la app del móvil.
//
// Y NINGUNO BORRA NADA SIN RED. Los dos que tocan datos —limpiar lo movido—
// son los mismos botones del menú, con sus mismas comprobaciones; aquí solo
// cambia por dónde se llaman.
// =========================================================================

// La celda se vacía ANTES de ejecutar nada. Si la acción tarda o falla, lo que
// no puede pasar es que el comando se quede escrito en la columna A pareciendo
// una guía: ahí lo recogería el siguiente recálculo y lo contaría.
const TXT_COMANDO_OK = "✅ ";

function comandosDeBarras() {
    return [
        {
            codigo: "WMSACT",
            titulo: "Actualizar esta pestaña",
            correr: function (ss) {
                forzarActualizacionHojaActiva();
                return "Pestaña actualizada";
            }
        },
        {
            codigo: "WMSTRAE",
            titulo: "Traer las guías nuevas y cruzar",
            correr: function (ss) {
                if (typeof correrLaConfronta !== 'function') {
                    return "El módulo de pedimentos no está instalado";
                }
                // EL NÚCLEO, no el botón: el botón enseña el informe largo en
                // un diálogo, y un diálogo dentro de un disparador se queda
                // esperando una respuesta que en un teléfono no llega.
                let r = correrLaConfronta(true);
                return r.ok ? r.corto : r.corto;
            }
        },
        {
            codigo: "WMSCRUZA",
            titulo: "Volver a cruzar con lo que ya hay",
            correr: function (ss) {
                if (typeof correrLaConfronta !== 'function') {
                    return "El módulo de pedimentos no está instalado";
                }
                let r = correrLaConfronta(false);
                return r.ok ? r.corto : r.corto;
            }
        },
        {
            codigo: "WMSAPP",
            titulo: "Traer las houses de la app de 1Z",
            correr: function (ss) {
                if (typeof correrTraerDeLaApp !== 'function') {
                    return "El módulo de houses no está instalado";
                }
                // EL NÚCLEO, no el botón. Y es el comando más rápido de los
                // cinco: mira solo la pestaña de la app —lo de hoy— y no el
                // índice entero, así que puede escanearse después de cada
                // lectura sin pensárselo.
                return correrTraerDeLaApp().corto;
            }
        },
        {
            codigo: "WMSHOUSE",
            titulo: "Poner ahora las houses que faltan",
            correr: function (ss) {
                // El NÚCLEO, no el botón: el botón enseña un diálogo y un
                // diálogo dentro de un disparador cuelga el archivo.
                if (typeof rellenarHousesPendientes !== 'function') {
                    return "El módulo de houses no está instalado";
                }
                let seg = (typeof SEGUNDOS_MAX_RELLENO_A_MANO === 'number')
                        ? SEGUNDOS_MAX_RELLENO_A_MANO : 240;
                return String(rellenarHousesPendientes(true, seg) || "sin cambios");
            }
        }
    ];
}

// ¿Lo que se acaba de escribir es un comando? Devuelve el comando o null.
//
// Se compara SIN espacios ni guiones y en mayúsculas, igual que una guía: un
// lector mal configurado puede añadir un espacio al final y nadie entendería
// por qué el código funciona en una tienda y no en otra.
function comandoDeBarras(valor) {
    let v = String(valor === undefined || valor === null ? "" : valor)
            .trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (v === "" || v.indexOf("WMS") !== 0) return null;
    let todos = comandosDeBarras();
    for (let i = 0; i < todos.length; i++) {
        if (todos[i].codigo === v) return todos[i];
    }
    return null;
}

// ¿Esta edición es un comando que hay que atender?
//
// SOLO UNA CELDA, SOLO EN LA COLUMNA A, y nunca en una pestaña de sistema. Un
// pegado de varias filas no se mira: si alguien pega una columna entera que
// casualmente lleva un comando dentro, lo que quiere es pegar datos.
function edicionEsComando(nombreHoja, colInicial, numRows, numCols, valor) {
    if (colInicial !== 1 || numRows !== 1 || numCols !== 1) return null;
    if (esHojaSistema(nombreHoja)) return null;
    return comandoDeBarras(valor);
}

// Ejecuta el comando y lo cuenta por `toast`.
//
// SE LLAMA ANTES DE TOMAR EL LOCK, y eso no es un detalle: las acciones son las
// mismas del menú y cada una pide el lock del documento por su cuenta. Llamarlas
// con el lock ya tomado sería un bloqueo contra uno mismo —el archivo entero
// parado hasta que Google corte la ejecución—, que es exactamente el fallo que
// ya costó una tarde con el cierre del día.
function atenderComando(ss, hoja, fila, cmd) {
    // PRIMERO SE VACÍA LA CELDA. Si la acción tarda o revienta, lo que no puede
    // quedar es el comando escrito en la columna A pareciendo una guía.
    try { hoja.getRange(fila, 1).clearContent(); } catch (err) { /* sigue igual */ }

    ss.toast('⏳ ' + cmd.titulo + '…', 'Comando', 10);
    let resultado;
    try {
        resultado = cmd.correr(ss);
    } catch (err) {
        // Un comando que falla tiene que DECIRLO. Callado, el operador se queda
        // mirando una pestaña que no cambió y repitiendo el escaneo.
        ss.toast('❌ ' + cmd.titulo + ': ' + err.message, 'Comando', 15);
        return false;
    }
    ss.toast(TXT_COMANDO_OK + (resultado || cmd.titulo), 'Comando', 8);
    return true;
}

// -------------------------------------------------------------------------
// LA HOJA PARA IMPRIMIR
// -------------------------------------------------------------------------

// Crea una pestaña con los códigos, para generarlos e imprimirlos.
//
// NO DIBUJA EL CÓDIGO DE BARRAS. Dibujarlo pediría o una fuente que hay que
// instalar en cada equipo, o mandar el texto a un servicio de fuera. Lo que
// hace falta de verdad es saber QUÉ TEXTO hay que codificar, y eso cabe en una
// columna: con eso, cualquier generador —el que ya se use para las etiquetas—
// saca la etiqueta en Code 39 o Code 128.
const HOJA_COMANDOS = "COMANDOS";

function prepararHojaDeComandos() {
    const ss = obtenerArchivo();
    const ui = SpreadsheetApp.getUi();

    let hoja = ss.getSheetByName(HOJA_COMANDOS);
    if (!hoja) hoja = ss.insertSheet(HOJA_COMANDOS, ss.getNumSheets());
    hoja.clear();

    let filas = [["QUÉ HACE", "TEXTO DEL CÓDIGO DE BARRAS"]];
    comandosDeBarras().forEach(c => filas.push([c.titulo, c.codigo]));

    hoja.getRange(1, 1, filas.length, 2).setValues(filas);
    hoja.getRange(1, 1, 1, 2).setFontWeight("bold");
    hoja.getRange(2, 2, filas.length - 1, 1)
        .setFontFamily("Courier New").setFontSize(14).setNumberFormat("@");
    hoja.setColumnWidth(1, 320);
    hoja.setColumnWidth(2, 240);

    let nota = hoja.getRange(filas.length + 2, 1);
    nota.setValue(
        "Genera cada código en Code 39 o Code 128 con el mismo programa de " +
        "etiquetas que ya usas. Pégalo donde lo vayas a tener a mano.\n\n" +
        "PARA USARLO: ponte en la pestaña que quieras, en la columna A, y " +
        "escanea el código. La celda se vacía sola y la acción se ejecuta; el " +
        "aviso sale abajo a la derecha.\n\n" +
        "Funciona en la pestaña DONDE ESTÉS: «" + comandosDeBarras()[0].codigo +
        "» actualiza la pestaña en la que estás, no todas.");
    nota.setWrap(true);
    hoja.setRowHeight(filas.length + 2, 120);

    ss.setActiveSheet(hoja);
    ui.alert("🏷️ Comandos por código de barras",
        "Listo. En la pestaña «" + HOJA_COMANDOS + "» tienes el texto de cada " +
        "código.\n\n" +
        "Genera las etiquetas con tu programa de siempre, en Code 39 o Code " +
        "128, y pégalas donde las tengas a mano.\n\n" +
        "Para usarlas: colócate en la columna A de la pestaña que quieras y " +
        "escanea. La celda se vacía sola.",
        ui.ButtonSet.OK);
}
