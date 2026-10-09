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

const TXT_COMANDO_OK = "✅ ";

// La columna de la hora de la columna A —la L— en las tres familias de
// pestañas: Globales, M-S e inventarios. Ver `aplicarCambiosOptimizado`.
const COL_HORA_DE_A = 12;

// ¿HAY UN COMANDO CORRIENDO AHORA MISMO?
//
// Esto existe por un detalle que no se ve venir: varios comandos RECALCULAN la
// hoja, y ese recálculo corre mientras el código sigue escrito en la columna A.
// O sea que el propio comando se encuentra a sí mismo y escribe «COMANDO SIN
// TERMINAR» sobre algo que está funcionando perfectamente. El operario ve un
// mensaje de alarma y medio segundo después todo correcto, y ya no se fía de
// ninguno de los dos.
//
// Es una variable normal y basta con eso: el recálculo que dispara el comando
// ocurre DENTRO de la misma ejecución, así que la ve. Un código que se quedó de
// una ejecución anterior —la que se cortó— se mira desde otra ejecución, donde
// esto vale `false`, y ahí el aviso sí sale. La misma comprobación distingue
// «está corriendo» de «se quedó colgado» sin guardar nada en ningún sitio.
let globalComandoEnCurso = false;

function hayComandoEnCurso() { return globalComandoEnCurso === true; }

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
                return correrLaConfronta(true).corto;
            }
        },
        {
            codigo: "WMSCRUZA",
            titulo: "Volver a cruzar con lo que ya hay",
            correr: function (ss) {
                if (typeof correrLaConfronta !== 'function') {
                    return "El módulo de pedimentos no está instalado";
                }
                return correrLaConfronta(false).corto;
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
            titulo: "Poner las houses de esta pestaña",
            correr: function (ss, hoja) {
                // SOLO LA PESTAÑA DONDE SE ESCANEA. Quien escanea esto está
                // delante de UNA unidad esperando; recorrer las quince
                // pestañas es hacerle esperar por las otras catorce. Para
                // todas está el botón del menú.
                //
                // El NÚCLEO, no el botón: el botón enseña un diálogo y un
                // diálogo dentro de un disparador cuelga el archivo.
                if (typeof correrRellenoDeHouses !== 'function') {
                    return "El módulo de houses no está instalado";
                }
                return correrRellenoDeHouses(hoja ? hoja.getName() : "").corto;
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

// Las pestañas de sistema donde SÍ se admite un comando: los INFORMES.
//
// Son las únicas de sistema donde escanear no puede costar nada. Un informe se
// borra entero y se vuelve a escribir cada vez que se genera, así que la celda
// que ocupe el comando no guarda nada que haga falta —y encima es donde uno
// está mirando cuando quiere volver a cruzar, que es justo el momento de
// escanear «WMSCRUZA»—.
//
// LAS DEMÁS SE QUEDAN FUERA, y cada una por su motivo:
//   · CACHE_SISTEMA, SIS_* y los índices: el motor. Escribir ahí a mano es
//     corromper datos que nadie va a saber reconstruir.
//   · MACHO y SIN INFORMACIÓN: listas TECLEADAS A MANO. El comando se borra
//     solo al atenderlo, así que escanear encima de un renglón escrito lo
//     borraría, y en esas dos pestañas no hay forma de saber qué había.
function esHojaDeInforme(nombreHoja) {
    let n = claveHoja(nombreHoja);
    // Y la de pedimentos finales: ahí se escanea WMSACT para volver a cuadrarla
    // entera.
    return n.indexOf("CONFRONTA") === 0 || n.indexOf("ERRORES_") === 0 ||
           esHojaPedimentosFinales(n);
}

// ¿Esta edición es un comando que hay que atender?
//
// SOLO UNA CELDA Y SOLO EN LA COLUMNA A. Un pegado de varias filas no se mira:
// si alguien pega una columna entera que casualmente lleva un comando dentro,
// lo que quiere es pegar datos.
function edicionEsComando(nombreHoja, colInicial, numRows, numCols, valor) {
    if (colInicial !== 1 || numRows !== 1 || numCols !== 1) return null;
    if (esHojaSistema(nombreHoja) && !esHojaDeInforme(nombreHoja)) return null;
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
    // EL CÓDIGO SE QUEDA A LA VISTA MIENTRAS CORRE, y se borra al terminar.
    //
    // Antes se borraba antes de empezar, por miedo a que una ejecución cortada
    // lo dejara escrito en la columna A pareciendo una guía. Pero eso se lleva
    // por delante lo único que el operario ve: escanea, la celda se vacía al
    // instante y durante medio minuto no pasa nada visible. Desde el muelle eso
    // es indistinguible de que no haya funcionado, y lo que se hace entonces es
    // volver a escanear.
    //
    // El miedo estaba bien, pero la respuesta no era esta: ahora, si la celda
    // se queda con el código, la columna B dice «⏳ COMANDO SIN TERMINAR ·
    // borra esta celda» —ver `textoCapturaInvalida`—. Ya no hay misterio que
    // evitar, así que no hace falta pagar el precio de borrar a ciegas.
    try {
        hoja.getRange(fila, 2).setValue("⏳ " + cmd.titulo + "…");
    } catch (err) { /* el aviso de la B es un extra, no puede parar nada */ }

    ss.toast('⏳ ' + cmd.titulo + '…', 'Comando', 30);

    let resultado, fallo = "";
    globalComandoEnCurso = true;
    try {
        // Se pasa la HOJA donde se escaneó: hay comandos que trabajan solo
        // sobre esa. Los que no la usan, la ignoran.
        resultado = cmd.correr(ss, hoja);
    } catch (err) {
        fallo = err.message;
    } finally {
        // En `finally`: si la acción revienta, la marca no puede quedarse
        // puesta o el resto de la ejecución creería que sigue corriendo.
        globalComandoEnCurso = false;
    }

    // SE LIMPIA PASE LO QUE PASE, incluso si la acción falló: el comando ya se
    // atendió y dejarlo escrito haría que el siguiente recálculo lo mirara.
    //
    // PERO SOLO SI LA FILA SIGUE SIENDO LA DEL COMANDO. Hay comandos que
    // REHACEN la pestaña donde se escanean: WMSCRUZA en «CONFRONTA
    // REFERENCIAS» la borra y la vuelve a escribir entera. Limpiar a ciegas la
    // A, la B y la L de esa fila se llevaba la referencia y el pedimento de una
    // línea del informe recién hecho —y la L ahí es la columna FILA del
    // detalle—. Si la A ya no dice el comando, esa fila es de otro y no se toca.
    let sigueAhi = false;
    try { sigueAhi = !!comandoDeBarras(hoja.getRange(fila, 1).getValue()); }
    catch (err) { sigueAhi = false; }
    if (sigueAhi) {
        try { hoja.getRange(fila, 1, 1, 2).clearContent(); } catch (err) { /* sigue */ }
        // Y LA HORA, en la columna L. El recálculo ya no se la pone a un
        // comando, pero una hora estampada antes de ese arreglo se quedaría
        // sola en una fila vacía. En los informes la L es otra cosa, y ahí no.
        if (!esHojaDeInforme(hoja.getName())) {
            try { hoja.getRange(fila, COL_HORA_DE_A).clearContent(); } catch (err) { /* sigue */ }
        }
    }

    if (fallo !== "") {
        // Un comando que falla tiene que DECIRLO. Callado, el operador se queda
        // mirando una pestaña que no cambió y repitiendo el escaneo.
        ss.toast('❌ ' + cmd.titulo + ': ' + fallo, 'Comando', 20);
        return false;
    }
    ss.toast(TXT_COMANDO_OK + (resultado || cmd.titulo), 'Comando', 10);
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
