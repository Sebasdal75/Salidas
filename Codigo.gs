// =========================================================================
// WMS SOBRE GOOGLE SHEETS — MOTOR DE ESCANEO
//
// Arquitectura: caché híbrido (hoja oculta CACHE_SISTEMA + índice en RAM),
// escrituras siempre en lote, y tres dominios aislados entre sí:
//   · GLOBALES / REZAGO / AGA  -> cruzan Físico (col A) contra Preforma (col O)
//   · M-S ...                  -> cruzan solo contra otras M-S
//   · INVENTARIOS              -> cruzan SOLO contra otros inventarios
//
// Regla de oro: ninguna llamada a la API de Sheets dentro de un bucle.
// =========================================================================

// Opcional: ID del archivo. Solo hace falta para los triggers por tiempo,
// donde getActiveSpreadsheet() puede devolver null.
const ID_ARCHIVO = '';

// Hojas internas del motor. Nunca se escanean y NUNCA reciben el volcado de la
// columna M: la M de CACHE_SISTEMA guarda datos de caché, no la lista FEMAD.
const HOJAS_INTERNAS = ["CACHE_SISTEMA", "HISTORIAL_BORRADOS"];

// Hoja origen de la lista FEMAD (guías retenidas por la Guardia Nacional).
// Su columna M alimenta la validación de datos y los colores del resto de
// pestañas; se edita una vez al día y algún añadido suelto.
const HOJA_MACHO = "MACHO";

const PROP_TRIGGER = 'TRIGGER_EDICION_INSTALADO';

// =========================================================================
// COLORES DE LA COLUMNA A
//
// Los pinta el script para poder retirar el formato condicional, que Google
// reevalúa en cada cambio y frena tanto al script como al navegador.
// Mientras el formato condicional siga puesto, él manda y esto no se ve:
// se puede pegar el código y quitar las reglas después, sin prisa.
//
// Poner COLOREAR_COLUMNA_A en false devuelve el control al formato condicional.
// =========================================================================
const COLOREAR_COLUMNA_A = true;

// Avisar cuando el mismo pedimento aparece en dos pestañas del mismo tipo (dos
// M-S, o dos destinos). Nunca entre una M-S y su destino: eso es el flujo
// normal. Poner en false si un pedimento puede repartirse entre dos pestañas.
const DETECTAR_PEDIMENTO_REPETIDO_ENTRE_PESTANAS = true;

// La columna O (preforma) conserva su esquema por bloques según la letra de
// la columna N, y encima recibe los dos colores de la A:
//   pedimento → azul, repetido (pedimento o guía) → rojo.
// Poner en false para dejar la O exactamente como estaba.
const COLOREAR_PEDIMENTO_Y_DUP_EN_O = true;

const COLOR_A_PEDIMENTO = "#178ccc";  // pedimento (7 dígitos) → azul
const COLOR_A_GUIA      = "#00ff00";  // guía válida → verde (el mismo de la columna O)
const COLOR_A_DUPLICADO = "#df5f6b";  // duplicada → rojo
const COLOR_A_UBICACION = "#a4c2f4";  // ubicación IW en inventarios → azul claro
const COLOR_A_NEUTRO    = "#ffffff";  // fila vacía o sin clasificar

// Color de bloque de la columna O según la letra de la columna N del pedimento.
function colorBloqueO(letraN) {
    let l = String(letraN).trim().toLowerCase();
    if (l === "a") return "#35ec09";
    if (l === "b") return "#ff00ff";
    if (l === "c") return "#39b1b9";
    return "#00ff00";
}

// Guías repetidas dentro de la columna O de la misma hoja.
//
// Devuelve un Map: fila repetida -> { ped, idx } de su PRIMERA aparición, para
// poder pintar las DOS y decir en qué pedimento quedó la otra, igual que en la
// columna A. Se trabaja sobre los bloques ya construidos en vez de recorrer la
// columna a mano, porque el pedimento no está siempre en el mismo sitio: en las
// hojas normales cierra el bloque por debajo de sus guías y en las de rezago lo
// abre por arriba.
//
// Los marcadores estructurales se saltan: se repiten de forma legítima.
function repetidasEnPreforma(bloquesPreforma) {
    let out = new Map();
    let vistas = new Map();
    bloquesPreforma.forEach(bloque => {
        bloque.guias.forEach((g, k) => {
            if (esMarcadorEstructural(g)) return;
            let idx = bloque.filasGuias[k];
            let previa = vistas.get(g);
            if (previa) out.set(idx, previa);
            else vistas.set(g, { ped: bloque.pedimento, idx: idx });
        });
    });
    return out;
}

// Decide el color de una celda de la columna A a partir del valor y su estado.
function colorColumnaA(valor, estado) {
    let v = String(valor).trim().toUpperCase();
    if (v === "") return COLOR_A_NEUTRO;

    // Duplicada en cualquiera de sus formas: entre hojas, entre pedimentos, o la
    // primera de la pareja marcada con "⚠️ DUPLICADO (repetida en...)". Se busca
    // la raíz sin distinguir mayúsculas para que ningún texto se escape.
    let e = String(estado).toUpperCase();
    if (e.indexOf("DUPLICAD") !== -1) return COLOR_A_DUPLICADO;

    if (v.startsWith("IW")) return COLOR_A_UBICACION;
    if (/^\d{7}$/.test(v)) return COLOR_A_PEDIMENTO;
    if (esMarcadorEstructural(v)) return COLOR_A_NEUTRO;
    if (esGuiaUPSValida(v)) return COLOR_A_GUIA;
    return COLOR_A_DUPLICADO;   // guía inválida: también en rojo
}

// Variables globales de memoria (sobreviven entre escaneos dentro de una
// misma ejecución del motor V8).
let globalCacheData = null;
let globalCacheHeaders = null;
let globalCacheMap = null; // Índice O(1) con soporte para múltiples ubicaciones por guía
let globalUsuario = null;
let globalTriggerInstalable = null;

// =========================================================================
// NORMALIZACIÓN DE NOMBRES DE HOJA
// Todo el sistema (headers del caché, comparaciones, clasificación) usa la
// clave normalizada. Nunca comparar contra hoja.getName() en crudo.
// =========================================================================
function claveHoja(nombre) {
    return String(nombre).trim().toUpperCase();
}

// Motor: caché e historial. Ni se escanean ni reciben la columna M.
function esHojaInterna(nombreHoja) {
    let n = claveHoja(nombreHoja);
    return HOJAS_INTERNAS.indexOf(n) !== -1 || n.indexOf("HISTORIAL") !== -1;
}

// Cualquier pestaña con "MACHO" en el nombre: o es la lista FEMAD, o es una
// plantilla de inventario. Ninguna se escanea ni entra al índice de duplicados,
// pero las plantillas SÍ reciben el volcado de la columna M (las copias que
// salgan de ellas ya vienen con la validación puesta).
function esHojaMacho(nombreHoja) {
    return claveHoja(nombreHoja).indexOf("MACHO") !== -1;
}

// "De sistema" = todo lo que el motor de escaneo debe ignorar.
function esHojaSistema(nombreHoja) {
    return esHojaInterna(nombreHoja) || esHojaMacho(nombreHoja);
}

function esHojaMS(nombreHoja) {
    let n = claveHoja(nombreHoja);
    return n.startsWith("M-S ") || n.startsWith("SIMPLES") || n.startsWith("MULTIPLES");
}

// El tipo de una M-S lo decide el operador al elegir la pestaña. No se
// puede deducir de las guías: con guías cortas no hay nada que distinga un T1
// de un global, y con guías 1Z el prefijo del embarcador tampoco lo dice.
function tipoMS(nombreHoja) {
    let n = claveHoja(nombreHoja);
    // Solo abreviatura para que la celda no se alargue. NO lleva ninguna regla
    // de comportamiento asociada: esta hoja es una M-S como cualquier otra.
    if (n.indexOf("CUENTAS ESPECIALES") !== -1) return "M-S CTAS ESP";
    if (n.indexOf("A1") !== -1) return "M-S A1";
    if (n.indexOf("SEGUIMIENTOS") !== -1) return "M-S SEGUIMIENTOS";
    if (n.startsWith("M-S GLOBALES") || n.startsWith("MULTIPLES")) return "M-S GLOBALES";
    if (n.startsWith("M-S T1") || n.startsWith("SIMPLES")) return "M-S T1";
    return n;
}

function esHojaInventario(nombreHoja) {
    return claveHoja(nombreHoja).indexOf("INVENTARIO") !== -1;
}

function esHojaPrincipal(nombreHoja) {
    let n = claveHoja(nombreHoja);
    if (esHojaSistema(n)) return false;
    if (esHojaInventario(n)) return false;
    if (esHojaMS(n)) return false;
    return true;
}

// Textos que el propio script escribe en la columna A como separadores de
// bloque. NO son guías: si se tratan como tales cuentan como bultos, entran al
// índice del caché y acaban marcándose como duplicados entre pestañas.
function esMarcadorEstructural(v) {
    let s = String(v).trim().toUpperCase();
    if (s === "") return false;
    // "COSTALES" y "FIN" se quedan reconocidos aunque su proceso ya no exista:
    // si queda texto suelto de antes en alguna hoja, sigue siendo neutro en vez
    // de convertirse de golpe en "❌ Guía Inválida".
    return s === "COSTALES" || s === "FIN" || s === "SIN_CABECERA" || s.indexOf("SIN PEDIMENTO") !== -1;
}

// Una fila de columna A es cabecera de bloque si es un pedimento de 7 dígitos
// o uno de esos marcadores.
function esCabeceraBloque(v) {
    return /^\d{7}$/.test(String(v).trim()) || esMarcadorEstructural(v);
}

function asegurarColumnas(hoja, minimo) {
    let max = hoja.getMaxColumns();
    if (max < minimo) hoja.insertColumnsAfter(max, minimo - max);
}

function asegurarFilas(hoja, minimo) {
    let max = hoja.getMaxRows();
    if (max < minimo) hoja.insertRowsAfter(max, (minimo - max) + 100);
}

function invalidarCacheRAM() {
    globalCacheData = null;
    globalCacheHeaders = null;
    globalCacheMap = null;
}

function obtenerArchivo() {
    let ss = SpreadsheetApp.getActiveSpreadsheet();
    if (!ss && ID_ARCHIVO) ss = SpreadsheetApp.openById(ID_ARCHIVO);
    if (!ss) throw new Error('No se pudo resolver el archivo. Rellena ID_ARCHIVO en el script.');
    return ss;
}

// Quién hizo la edición, para el historial.
//
// getActiveUser() devuelve al editor, pero entre cuentas de consumidor
// (@gmail.com) distintas devuelve cadena vacía: Google no deja identificar a
// otro usuario.
//
// getEffectiveUser() es el usuario bajo cuya autoridad corre el script:
//   · en un trigger SIMPLE     -> es el propio editor, así que sirve;
//   · en un trigger INSTALABLE -> es quien lo instaló, NO quien editó.
//
// Por eso el respaldo solo se usa con el trigger simple. En un instalable
// atribuiría cada borrado al instalador, y un nombre equivocado en una
// auditoría es peor que ningún nombre.
function obtenerUsuarioActual() {
    if (globalUsuario !== null) return globalUsuario;

    let email = "";
    try { email = Session.getActiveUser().getEmail() || ""; } catch (err) { email = ""; }

    if (email === "" && !triggerInstalableActivo()) {
        try { email = Session.getEffectiveUser().getEmail() || ""; } catch (err) { email = ""; }
    }

    globalUsuario = email !== "" ? email : "(no identificado)";
    return globalUsuario;
}

// =========================================================================
// PUNTOS DE ENTRADA DE EDICIÓN
//
// onEdit  -> trigger simple (límite 30 s, sin identidad del editor)
// alEditar -> trigger instalable (límite 6 min, sí identifica al editor)
//
// Si el instalable está activo, el simple se aparta para no duplicar trabajo.
// =========================================================================
function onEdit(e) {
    if (triggerInstalableActivo()) return;
    procesarEdicion(e);
}

function alEditar(e) {
    procesarEdicion(e);
}

function triggerInstalableActivo() {
    if (globalTriggerInstalable === null) {
        try {
            globalTriggerInstalable = PropertiesService.getScriptProperties().getProperty(PROP_TRIGGER) === '1';
        } catch (err) {
            globalTriggerInstalable = false;
        }
    }
    return globalTriggerInstalable;
}

function instalarTriggerAvanzado() {
    const ss = obtenerArchivo();
    ScriptApp.getProjectTriggers().forEach(t => {
        if (t.getHandlerFunction() === 'alEditar') ScriptApp.deleteTrigger(t);
    });
    ScriptApp.newTrigger('alEditar').forSpreadsheet(ss).onEdit().create();
    PropertiesService.getScriptProperties().setProperty(PROP_TRIGGER, '1');
    globalTriggerInstalable = true;

    // Red de seguridad: recoge los escaneos que se perdieron por lock ocupado.
    ScriptApp.getProjectTriggers().forEach(t => {
        if (t.getHandlerFunction() === 'actualizadorAutomaticoGlobal') ScriptApp.deleteTrigger(t);
    });
    ScriptApp.newTrigger('actualizadorAutomaticoGlobal').timeBased().everyMinutes(5).create();

    ss.toast('✅ Trigger avanzado activo (6 min de límite y usuario en el historial) + repaso automático cada 5 min.', 'Listo', 8);
}

// =========================================================================
// CIERRE DEL DÍA
// =========================================================================
// Agrupa las tareas de mantenimiento del cierre en un solo paso.
//
// NO vacía las hojas de escaneo: eso se hace a mano, a propósito. Borrar el
// trabajo del día es una decisión del operador y no algo que deba esconderse
// dentro de un botón de mantenimiento.
function cierreDelDia() {
  const ss = obtenerArchivo();
  const ui = SpreadsheetApp.getUi();

  const hojaHist = ss.getSheetByName("HISTORIAL_BORRADOS");
  const filasHist = hojaHist ? Math.max(hojaHist.getLastRow() - 1, 0) : 0;

  let resp = ui.alert("🌙 Cierre del día",
      "Se va a hacer el mantenimiento del cierre:\n\n" +
      "   · Vaciar HISTORIAL_BORRADOS  (" + filasHist + " registros)\n" +
      "   · Podar del caché las pestañas renombradas o borradas\n" +
      "   · Reconstruir el caché desde cero\n\n" +
      "Las hojas de escaneo NO se tocan: eso lo vacías tú a mano.\n\n" +
      "¿Continuar?", ui.ButtonSet.YES_NO);
  if (resp !== ui.Button.YES) return;

  let podadas = 0;
  conLock(archivo => {
      limpiarHistorialDiario();
      podadas = podarCacheHuerfano(archivo);
      archivo.getSheets().forEach(h => {
          let n = claveHoja(h.getName());
          if (!esHojaSistema(n) && !esHojaInterna(n)) actualizarFotografiaMental(h, archivo);
      });
      invalidarCacheRAM();
      getCacheData(archivo);
  });

  ui.alert("🌙 Cierre del día",
      "Listo.\n\n" +
      "   · " + filasHist + " registros de historial borrados\n" +
      "   · " + podadas + " columnas huérfanas podadas del caché\n" +
      "   · Caché reconstruido\n\n" +
      "Las hojas de escaneo siguen como estaban.", ui.ButtonSet.OK);
}

// =========================================================================
// LIMPIEZA AUTOMÁTICA DEL HISTORIAL
// =========================================================================
// Hora a la que se vacía HISTORIAL_BORRADOS, en formato 24 h. El trigger corre
// dentro de esa hora, no en el minuto exacto: Google no garantiza el minuto.
const HORA_LIMPIEZA_HISTORIAL = 22;

// Vacía el historial dejando la fila de encabezados. Solo borra CONTENIDO
// (clearContent), nunca la fila ni el formato, así que los encabezados, los
// anchos y cualquier validación siguen intactos.
function limpiarHistorialDiario() {
  const ss = obtenerArchivo();
  const hoja = ss.getSheetByName("HISTORIAL_BORRADOS");
  if (!hoja) return 0;

  let lr = hoja.getLastRow();
  if (lr < 2) return 0;   // solo encabezados

  let lc = Math.max(hoja.getLastColumn(), 1);
  hoja.getRange(2, 1, lr - 1, lc).clearContent();
  return lr - 1;
}

// La misma limpieza, pero pedida a mano desde el menú y con confirmación: es
// una borrada de un registro de auditoría, no algo que deba pasar por descuido.
function limpiarHistorialAhora() {
  const ui = SpreadsheetApp.getUi();
  const ss = obtenerArchivo();
  const hoja = ss.getSheetByName("HISTORIAL_BORRADOS");

  if (!hoja || hoja.getLastRow() < 2) {
    ui.alert("🧾 Historial", "El historial ya está vacío.", ui.ButtonSet.OK);
    return;
  }

  let n = hoja.getLastRow() - 1;
  let resp = ui.alert("🧾 Vaciar historial",
      "Se van a borrar " + n + " registros de HISTORIAL_BORRADOS.\n\n" +
      "Esto no se puede deshacer desde el menú (sí desde el historial de\n" +
      "versiones de Google: Archivo → Historial de versiones).\n\n¿Continuar?",
      ui.ButtonSet.YES_NO);
  if (resp !== ui.Button.YES) return;

  let borrados = limpiarHistorialDiario();
  ss.toast("✅ Historial vaciado (" + borrados + " registros).", "Listo", 5);
}

function instalarLimpiezaHistorial() {
  const ss = obtenerArchivo();
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'limpiarHistorialDiario') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('limpiarHistorialDiario')
           .timeBased().atHour(HORA_LIMPIEZA_HISTORIAL).everyDays(1).create();

  ss.toast('✅ El historial se vaciará solo cada día alrededor de las ' +
           HORA_LIMPIEZA_HISTORIAL + ':00. Para cambiar la hora, edita ' +
           'HORA_LIMPIEZA_HISTORIAL al inicio del código y vuelve a instalarlo.',
           'Limpieza automática activa', 8);
}

function quitarLimpiezaHistorial() {
  const ss = obtenerArchivo();
  let n = 0;
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'limpiarHistorialDiario') { ScriptApp.deleteTrigger(t); n++; }
  });
  ss.toast(n > 0 ? '✅ Limpieza automática desactivada.' : 'ℹ️ No estaba activa.', 'Historial', 5);
}

// Trigger SIMPLE para el escaneo + red de seguridad por tiempo.
//
// Es la única combinación en la que el historial puede decir QUIÉN borró algo:
// un trigger simple corre bajo la identidad de quien editó, así que
// Session.getEffectiveUser() devuelve a esa persona. El instalable corre bajo
// quien lo instaló, y ahí el nombre sería siempre el mismo — peor que ninguno.
//
// Lo que se pierde frente al avanzado: el límite baja de 6 minutos a 30
// segundos por escaneo. Con los tiempos actuales (~1 s) sobra de largo; solo
// sería un problema en hojas enormes.
//
// El repaso automático cada 5 minutos SÍ se conserva: es un trigger por tiempo
// aparte y no depende del de edición.
function instalarTriggerConUsuario() {
  const ss = obtenerArchivo();

  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'alEditar') ScriptApp.deleteTrigger(t);
  });
  PropertiesService.getScriptProperties().deleteProperty(PROP_TRIGGER);
  globalTriggerInstalable = false;

  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'actualizadorAutomaticoGlobal') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('actualizadorAutomaticoGlobal').timeBased().everyMinutes(5).create();

  ss.toast('✅ Escaneo con trigger simple: el historial ya registra quién borra. ' +
           'Límite de 30 s por escaneo + repaso automático cada 5 min.', 'Listo', 8);
}

function desinstalarTriggerAvanzado() {
    const ss = obtenerArchivo();
    ScriptApp.getProjectTriggers().forEach(t => {
        if (t.getHandlerFunction() === 'alEditar' ||
            t.getHandlerFunction() === 'actualizadorAutomaticoGlobal') ScriptApp.deleteTrigger(t);
    });
    PropertiesService.getScriptProperties().deleteProperty(PROP_TRIGGER);
    globalTriggerInstalable = false;
    ss.toast('↩️ Se volvió al trigger simple.', 'Listo', 6);
}

// =========================================================================
// MOTOR PRINCIPAL DE EDICIÓN
// =========================================================================
function procesarEdicion(e) {
  if (!e || !e.source) return;

  const hoja = e.source.getActiveSheet();
  const celda = e.range;
  const colInicial = celda.getColumn();
  const filaInicial = celda.getRow();
  const numRows = celda.getNumRows();
  const numCols = celda.getNumColumns();
  const nombreHoja = claveHoja(hoja.getName());

  // Descartes baratos ANTES de pedir el lock: así los escaneos no compiten
  // con ediciones irrelevantes.
  // Quedan solo tres columnas de captura. Salieron la Q (17) con los costales
  // y la D (4) con la marca "T1", que eran sus únicos usos. Los totales de
  // C1:C3 y Q1:Q2 los sigue escribiendo el recálculo, que no depende de que
  // nadie edite esas columnas.
  const colsValidas = [1, 14, 15];
  let tocaValida = false;
  for (let c = 0; c < numCols; c++) {
      if (colsValidas.indexOf(colInicial + c) !== -1) tocaValida = true;
  }
  const tocaMacho = (nombreHoja === HOJA_MACHO && colInicial <= 13 && (colInicial + numCols - 1) >= 13);
  if (!tocaValida && !tocaMacho) return;
  if (esHojaSistema(nombreHoja) && !tocaMacho) return;

  const lock = LockService.getDocumentLock();
  if (!intentarLock(lock)) {
      // No se pudo entrar. Dejamos marca visible en vez de perder el escaneo
      // en silencio: el operador ve que esa fila no quedó validada.
      marcarPendiente(hoja, filaInicial, numRows, colInicial, numCols);
      return;
  }

  try {
    // =====================================================================
    // SINCRONIZACIÓN MAESTRA DE HOJA "MACHO" (columna M)
    // =====================================================================
    if (tocaMacho) {
        sincronizarMacho(hoja, e.source);
        e.source.toast('✅ Columna M sincronizada en todas las pestañas', 'Sincronización MACHO', 4);
        if (numCols === 1 && colInicial === 13) return;
    }
    if (!tocaValida) return;

    let valoresEditados = celda.getValues();
    let huboCambiosRelevantes = false;
    let esModoInventario = esHojaInventario(nombreHoja);

    // El caché en RAM se descarta al empezar cada edición.
    //
    // Las variables globales de V8 pueden sobrevivir de una ejecución a la
    // siguiente cuando Google reutiliza la instancia. Eso hacía que un operador
    // que escanea seguido en la misma pestaña se quedara con una foto vieja del
    // resto del archivo: las guías que otro acababa de meter en una M-S no
    // estaban en su copia, y salían como «⚠️ Sobra (Ajena)» / «Sin registrar en
    // M-S». Era justo lo que arreglaba «Forzar Actualización», que sí invalida.
    //
    // Dentro de UNA ejecución el caché se sigue reutilizando, que es donde de
    // verdad importaba (recalcular varias pestañas sin releerlo cada vez).
    invalidarCacheRAM();
    // Sin envolver: getCacheData ya se mide por dentro, y un perf aquí fuera
    // sumaría dos veces lo mismo y descuadraría el renglón de "resto".
    let cacheInfo = getCacheData(e.source);

    let batchUpdates = [];
    let filasHistorial = [];
  
    const tocaColA = (colInicial <= 1 && colInicial + numCols - 1 >= 1);
    const tocaColO = (colInicial <= 15 && colInicial + numCols - 1 >= 15);

    // Lecturas de apoyo en bloque (una sola llamada cada una), nunca dentro del bucle.
    // Una sola lectura para las tres columnas de apoyo (B=2, L=12, P=16) en
    // vez de tres llamadas. En este archivo cada ida y vuelta a la API cuesta
    // cientos de milisegundos, así que lo que importa es el NÚMERO de llamadas,
    // no cuántas celdas trae cada una.
    let anchoHoja = hoja.getMaxColumns();
    let colFinApoyo = (tocaColO && anchoHoja >= 16) ? 16 : 12;
    let apoyo = (tocaColA || (tocaColO && anchoHoja >= 16))
        ? hoja.getRange(filaInicial, 2, numRows, colFinApoyo - 1).getValues() : null;
    // Índices dentro de `apoyo`: col 2 -> 0, col 12 -> 10, col 16 -> 14.
    let valsEstadoB = apoyo;                      // [r][0]
    let valsC12     = apoyo;                      // [r][10]
    let valsEstadoP = (colFinApoyo === 16) ? apoyo : null;   // [r][14]

    for (let r = 0; r < numRows; r++) {
        for (let c = 0; c < numCols; c++) {
            let filaActual = filaInicial + r;
            let colActual = colInicial + c;

            if (colsValidas.indexOf(colActual) === -1 || filaActual < 1) continue;

            let valRaw = valoresEditados[r][c];
            let valorIngresado = typeof valRaw === 'string' ? valRaw.trim().toUpperCase() : String(valRaw);

            // -------- DETECTAR BORRADOS --------
            if (valorIngresado === "" && (colActual === 1 || colActual === 15)) {
                let valorAnteriorEstado = "";
                if (colActual === 1 && valsEstadoB) valorAnteriorEstado = String(valsEstadoB[r][0]).trim();
                else if (colActual === 15 && valsEstadoP) valorAnteriorEstado = String(valsEstadoP[r][14]).trim();

                // Valor previo: e.oldValue lo trae gratis en ediciones de una sola celda;
                // si no, lo sacamos del caché.
                let valorBorrado = "";
                if (numRows === 1 && numCols === 1 && e.oldValue !== undefined && e.oldValue !== null) {
                    valorBorrado = String(e.oldValue).trim();
                }
                if (valorBorrado === "" && cacheInfo && cacheInfo.headers) {
                    let sufijo = (colActual === 1) ? "_FISICO" : "_PREFORMA";
                    let idx = cacheInfo.headers.indexOf(nombreHoja + sufijo);
                    if (idx !== -1 && cacheInfo.data.length > filaActual) {
                        valorBorrado = String(cacheInfo.data[filaActual][idx]).trim();
                    }
                }

                if (valorBorrado !== "") {
                    let tipoCol = (colActual === 1) ? "Físico (Col A)" : "Preforma (Col O)";
                    filasHistorial.push(eventoHistorial(nombreHoja, filaActual, tipoCol, valorBorrado,
                                                      valorAnteriorEstado, "BORRADO MANUAL (Celda vaciada)"));
                }
            }

            // Un vaciado de A u O SÍ es un cambio relevante: hay que purgar el
            // caché y recalcular la hoja. (Antes se salía por el continue y el
            // dato borrado seguía vivo en memoria.)
            if (valorIngresado === "") {
                if (colActual === 1 || colActual === 15) huboCambiosRelevantes = true;
                if (colActual !== 14) continue;
            }
            huboCambiosRelevantes = true;

            // Normalización de lo que se teclea o escanea: MAYÚSCULAS y fuera
            // todo lo que no sea A-Z o 0-9. Se aplica a las cinco columnas de
            // captura; las de hora (L y S) ni siquiera pasan por aquí, así que
            // los ":" de la hora están a salvo.
            //
            // Se compara contra el valor CRUDO, no contra el ya normalizado: si
            // no, un cambio que solo fuera de minúscula a mayúscula no se
            // detectaría y la celda se quedaría como se tecleó.
            if (typeof valRaw === 'string') {
                let clean = valorIngresado.replace(/[^A-Z0-9]/g, '');
                if (String(valRaw) !== clean) {
                    batchUpdates.push({row: filaActual, col: colActual, val: clean});
                    valorIngresado = clean;
                    valoresEditados[r][c] = clean;
                }
            }

            // Errores estructurales (pedimento incompleto) acumulados para escribir en bloque.
            if ((colActual === 1 || colActual === 15) && /^\d{1,6}$/.test(valorIngresado)) {
                let colEstado = (colActual === 1) ? 2 : 16;
                let colHora = (colActual === 1) ? 12 : 19;
                let faltantes = 7 - valorIngresado.length;
                let textoNum = faltantes === 1 ? "número" : "números";

                batchUpdates.push({row: filaActual, col: colEstado, val: "🛑 ERROR: Faltan " + faltantes + " " + textoNum, bg: "#ffc107"});
                batchUpdates.push({row: filaActual, col: colHora, clear: true});
                continue;
            }

            // Duplicados: búsqueda O(1) en el índice en RAM.
            // Los marcadores de bloque no son guías: nunca son duplicados.
            if (colActual === 1 && !esMarcadorEstructural(valorIngresado)) {
                let duplicadoInfo = verificarDuplicadoConCache(cacheInfo, nombreHoja, valorIngresado, filaActual);

                if (duplicadoInfo.encontrado) {
                    batchUpdates.push({row: filaActual, col: 2, val: "⛔ DUPLICADO (En: " + duplicadoInfo.ubicacion + ")", bg: "#ff9800"});
                    let horaActual = valsC12 ? valsC12[r][10] : "";
                    if (!horaActual) {
                        batchUpdates.push({row: filaActual, col: 12, val: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "HH:mm:ss")});
                    }
                    continue;
                }
            }

        }
    }

    // -------- ESCRITURAS EN LOTE --------
    aplicarBatchUpdates(hoja, batchUpdates, filaInicial, numRows);
    registrarEnHistorialLote(e.source, filasHistorial);

    if (!huboCambiosRelevantes) return;

    // El caché se actualiza ANTES de recalcular: así los recálculos ven la
    // realidad y pueden reevaluar duplicados desde cero.
    let guiasAfectadas = actualizarBloqueEnCache(e.source, hoja, nombreHoja, filaInicial, numRows,
                                                 colInicial, numCols, valoresEditados);
    if (guiasAfectadas === null) {
        // Hubo que reconstruir la fotografía de la hoja: recargamos el caché.
        cacheInfo = getCacheData(e.source);
    }

    let tocoPreforma = tocaColO || (colInicial <= 14 && colInicial + numCols - 1 >= 14);

    // Hasta dónde recalcular, sin pagar un getLastRow. Se calcula DESPUÉS de
    // actualizar el caché, para que refleje lo que se acaba de escribir, y con
    // la última fila editada como suelo: si acabas de borrar la guía de la
    // última fila, el recálculo tiene que llegar igualmente hasta ahí para
    // limpiar su estado y su hora.
    let filaFinal = filaFinalDesdeCache(cacheInfo, nombreHoja, filaInicial + numRows - 1);

    // Las filas que el operador ACABA de tocar. Sin esto, la regla de conservar
    // alertas graves las dejaría pegadas también aquí: corriges la guía que
    // estaba duplicada y el ⛔ se queda, hablando de un valor que ya no está en
    // la celda. Los índices van 0-based, como datosMasivos.
    let filasEditadas = new Set();
    for (let r = 0; r < numRows; r++) filasEditadas.add(filaInicial + r - 1);

    recalcularHoja(hoja, e.source, cacheInfo, guiasAfectadas, tocoPreforma, false, filaFinal, filasEditadas);

    if (esModoInventario) {
        sincronizarInventariosAfectados(e.source, cacheInfo, guiasAfectadas, nombreHoja);
    } else if (esHojaPrincipal(nombreHoja) && !esHojaMS(nombreHoja)) {
        // Que la otra hoja destino se entere de que la guía cambió: si tenía un
        // duplicado apuntando a esta fila, hay que limpiarlo o reubicarlo.
        sincronizarDestinosAfectados(e.source, cacheInfo, guiasAfectadas, nombreHoja);
    }

  } finally {
    lock.releaseLock();
  }
}

function intentarLock(lock) {
    try {
        lock.waitLock(10000);
        return true;
    } catch (err) {
        return false;
    }
}

const TXT_PENDIENTE = "⏳ Pendiente (reintenta)";

// Estado de una guía de M-S que ya salió en una unidad. Se reconoce también el
// texto antiguo ("➡ Movido a ...") para que las hojas ya escritas se migren
// solas en la siguiente pasada en vez de dejar de reconocerse.
const TXT_SALIO = "➡ Salió en ";
function esEstadoSalida(txt) {
    let t = String(txt).trim();
    return t.startsWith(TXT_SALIO) || t.toUpperCase().startsWith("➡ MOVIDO A");
}

// La última guía de cada bloque lleva colgado el resumen del pedimento detrás
// de esta marca: «✅ Guía   ►   Bultos: 3 (M-S T1) | ✅ TODO SALIÓ».
//
// Son DOS cosas en una celda, y hay que saber separarlas. Mezclarlas causó un
// bucle infinito: el barrido de M-S comparaba la celda entera contra el estado
// que esperaba, nunca coincidían por culpa de la cola, y la reescribía sin la
// cola; después actualizarMS se la volvía a pegar. Cada pasada del disparador
// escribía la hoja entera, sin que nada hubiera cambiado nunca.
const SEP_RESUMEN = "   ►   ";

// Accesor para poder comprobarlo desde el banco de pruebas: las constantes con
// `const` no salen del eval con el que el banco carga este archivo, las
// funciones sí.
function separadorResumen() { return SEP_RESUMEN; }

// El estado de la guía, sin el resumen del bloque. Es lo único que se compara.
function cabezaEstado(txt) {
    let t = String(txt);
    let corte = t.indexOf(SEP_RESUMEN);
    return (corte === -1 ? t : t.substring(0, corte)).trim();
}

// El resumen colgado, si lo hay, con su separador. Se conserva al reescribir
// el estado para no borrar información que después habría que recalcular.
function colaResumen(txt) {
    let t = String(txt);
    let corte = t.indexOf(SEP_RESUMEN);
    return corte === -1 ? "" : t.substring(corte);
}

// Una fila está sin validar si tiene dato pero no estado, o si quedó marcada
// como pendiente porque el lock estaba ocupado. Lo segundo importa: si solo se
// mirara "estado vacío", las filas que marcamos como pendientes serían
// precisamente las que la red de seguridad dejaría de recoger.
function filaSinValidar(valDato, valEstado) {
    let d = String(valDato).trim();
    if (d === "") return false;

    // Las cabeceras de bloque (pedimento, SIN PEDIMENTO, COSTALES, FIN) NO
    // siempre reciben estado: en las hojas de rezago y en los bloques con error
    // se quedan en blanco a propósito. Si contaran como "sin validar", la red de
    // seguridad daría esa hoja por pendiente en cada pasada y la recalcularía
    // cada minuto, para siempre, sin que nada cambiara nunca.
    if (esCabeceraBloque(d)) return false;

    let e = String(valEstado).trim();
    return e === "" || e === TXT_PENDIENTE;
}

function marcarPendiente(hoja, filaInicial, numRows, colInicial, numCols) {
    try {
        if (colInicial > 1 || colInicial + numCols - 1 < 1) return;
        let rango = hoja.getRange(filaInicial, 2, numRows, 1);
        let vals = rango.getValues();
        let cambio = false;
        for (let r = 0; r < numRows; r++) {
            if (String(vals[r][0]).trim() === "") { vals[r][0] = TXT_PENDIENTE; cambio = true; }
        }
        if (cambio) rango.setValues(vals);
    } catch (err) {
        // Si ni esto se puede escribir, el trigger por tiempo lo recogerá después.
    }
}

// Columnas que este lote sabe escribir. Además de las de estado y hora, están
// las tres de captura (1 A, 14 N, 15 O), porque la normalización a mayúsculas
// devuelve el valor limpio a su propia celda. Una columna que falte aquí se
// descarta en silencio.
const COLS_BATCH = [1, 2, 12, 14, 15, 16, 19];

// Accesor para poder comprobarlo desde el banco de pruebas.
function columnasDelLote() { return COLS_BATCH; }

function aplicarBatchUpdates(hoja, batchUpdates, minRow, rowCount) {
    if (!batchUpdates || batchUpdates.length === 0) return;
    COLS_BATCH.forEach(col => {
        let updates = batchUpdates.filter(u => u.col === col);
        if (updates.length === 0) return;
        if (hoja.getMaxColumns() < col) return;

        let range = hoja.getRange(minRow, col, rowCount, 1);
        let vals = range.getValues();
        let bgs = updates.some(u => u.bg) ? range.getBackgrounds() : null;

        updates.forEach(u => {
            let idx = u.row - minRow;
            if (idx < 0 || idx >= rowCount) return;
            if (u.clear) vals[idx][0] = "";
            else if (u.val !== undefined) vals[idx][0] = u.val;
            if (u.bg && bgs) bgs[idx][0] = u.bg;
        });

        range.setValues(vals);
        if (bgs) range.setBackgrounds(bgs);
    });
}

// `tocoPreforma`: si es false, no se recalculan los colores de la columna O.
// Un escaneo normal (columna A) no puede cambiarlos, y comprobarlos cuesta una
// lectura de columna completa. Los menús pasan true para repintado total.
// `filaFinalSugerida` (opcional, y por eso va la última) evita un getLastRow en
// el camino del escaneo. Los menús y los triggers NO la pasan a propósito: ahí
// nadie espera delante de la pantalla y se prefiere la verdad del servidor. Si
// no se pasa, todo se comporta exactamente como antes — es el botón de pánico.
// `filasEditadas` (índices 0-based dentro de la hoja, o sea fila - 1) son las
// filas que el operador acaba de tocar. Van al final porque casi nadie las
// pasa: solo el camino de la edición las conoce. Sirven para que una alerta
// conservada no sobreviva a la propia corrección que la resuelve.
function recalcularHoja(hoja, source, cacheInfo, guiasAfectadas, tocoPreforma, repintarTodo, filaFinalSugerida, filasEditadas) {
    if (tocoPreforma === undefined) tocoPreforma = true;
    let n = perf("nombre de la hoja", 0, () => claveHoja(hoja.getName()));
    if (esHojaInventario(n)) actualizarInventario(hoja, cacheInfo, repintarTodo, filaFinalSugerida, filasEditadas);
    else if (esHojaMS(n)) actualizarMS(hoja, source, cacheInfo, repintarTodo, filaFinalSugerida, filasEditadas);
    else if (esHojaPrincipal(n)) actualizarGlobalPreforma(hoja, source, cacheInfo, guiasAfectadas, tocoPreforma, repintarTodo, filaFinalSugerida, filasEditadas);
}

// =========================================================================
// SISTEMA DE LECTURA DE CACHÉ (soporta múltiples ubicaciones por guía)
// =========================================================================
function getCacheData(source) {
    if (globalCacheData && globalCacheMap) return { data: globalCacheData, headers: globalCacheHeaders, map: globalCacheMap };

    let cacheSheet = perf("caché: abrir hoja", 0, () => source.getSheetByName("CACHE_SISTEMA"));
    if (!cacheSheet) return null;

    // getDataRange() parecía lo barato —una ida y vuelta en vez de tres— y
    // resultó ser lo más caro de todo el sistema. Medido: 682 ms para 236
    // filas, y EN CALIENTE, con la pestaña ya abierta. No es el coste de abrir
    // ni el volumen del dato: es que getDataRange tiene que averiguar hasta
    // dónde llegan los datos, y eso lleva dentro el mismo getLastRow que ya
    // estaba documentado aquí como la llamada más cara que hay.
    //
    // Un rango de límites conocidos no paga nada de eso: la hoja activa se lee
    // entera, 3.572 celdas, en 11 ms. getMaxRows/getMaxColumns son metadatos de
    // la rejilla, no contenido, y cuestan 5 ms medidos.
    //
    // Se leen de más todas las filas reservadas y vacías. Da igual:
    // construirIndiceCache las descarta antes de convertirlas a texto, que es
    // justo para lo que se le puso esa guarda.
    let maxFilas = perf("caché: medir la rejilla", 0, () => cacheSheet.getMaxRows());
    let maxCols = perf("caché: medir la rejilla", 0, () => cacheSheet.getMaxColumns());
    let fullData = perf("caché: leer valores", maxFilas * maxCols, () =>
        cacheSheet.getRange(1, 1, maxFilas, maxCols).getValues());

    // Sin esta guarda se entregaría un caché falso en lugar de null, y quien
    // comprueba "¿hay caché?" (el diagnóstico, el registro de borrados) daría
    // por bueno un índice inexistente.
    if (cacheVacio(fullData)) return null;

    globalCacheHeaders = fullData[0];
    globalCacheData = fullData;

    globalCacheMap = perf("(memoria) indexar el caché", 0, () =>
        construirIndiceCache(globalCacheData, globalCacheHeaders));

    return { data: globalCacheData, headers: globalCacheHeaders, map: globalCacheMap };
}

// ¿La foto del caché está en blanco? Es lo que antes decidía `lr < 1 || lc < 1`.
//
// Lo decide la FILA DE ENCABEZADOS, no cuántas filas vengan. Antes bastaba con
// que hubiera más de una fila para darlo por bueno, y eso valía mientras la
// foto se leyera con getDataRange: una hoja en blanco llegaba como [[""]], una
// sola fila. Ahora se lee la rejilla completa, así que una hoja en blanco llega
// como miles de filas vacías y aquel atajo la habría dado por válida.
//
// Mirar los encabezados es además lo correcto de por sí: sin encabezados no hay
// ninguna columna _FISICO que indexar, y construirIndiceCache devolvería un
// índice vacío con el que la detección de duplicados no diría nada.
function cacheVacio(fullData) {
    if (!fullData || fullData.length === 0) return true;
    if (!fullData[0]) return true;
    return fullData[0].every(v => String(v).trim() === "");
}

// Índice guía -> [{hoja, fila, isMS, isInventario}] a partir de la foto del caché.
//
// Se separa de getCacheData por dos razones: para poder medir aparte lo que es
// hablar con Google de lo que es puro cálculo, y para que el banco de pruebas
// pueda cubrirlo. Este índice es lo que hace que la detección de duplicados
// sirva de algo; si se corrompe, el sistema miente sin avisar.
//
// INVARIANTE: el índice de la fila en `data` ES la fila de la hoja. La fila 0
// son los encabezados, y `actualizarFotografiaMental` vuelca la fila 1 de la
// hoja en la fila 2 del caché, que es `data[1]`.
function construirIndiceCache(data, headers) {
    let mapa = new Map();
    if (!data || !headers) return mapa;

    // Los datos de cada columna se calculan UNA vez, no una por celda. Antes
    // `claveHoja`, `esHojaMS` y `esHojaInventario` se repetían en cada columna
    // del recorrido exterior; ahora quedan fuera del bucle caliente.
    let columnas = [];
    for (let c = 0; c < headers.length; c++) {
        let header = String(headers[c]);
        if (!header.endsWith("_FISICO")) continue;
        let hoja = claveHoja(header.replace("_FISICO", ""));
        columnas.push({ c: c, hoja: hoja, isMS: esHojaMS(hoja), isInventario: esHojaInventario(hoja) });
    }
    if (columnas.length === 0) return mapa;

    // El recorrido va por COLUMNAS y luego por filas, igual que antes, y eso no
    // es un detalle de estilo: el orden en que se apilan las entradas decide
    // cuál se nombra en «⛔ DUPLICADO (En: … Fila N)», porque quien consulta se
    // queda con la primera que encaje. Recorrer por filas parecía más rápido y
    // habría cambiado ese mensaje sin avisar. La ganancia real no estaba ahí,
    // sino en no convertir a texto lo que está vacío.
    for (let k = 0; k < columnas.length; k++) {
        let col = columnas[k];
        let c = col.c;

        for (let r = 1; r < data.length; r++) {
            let fila = data[r];
            if (!fila) continue;

            // La celda vacía se descarta ANTES de convertirla a texto. En un
            // caché de 3.000 filas la enorme mayoría están en blanco (relleno
            // de asegurarFilas) y hasta ahora cada una pagaba tres operaciones
            // de cadena para acabar descartada igual.
            let bruto = fila[c];
            if (bruto === "" || bruto === null || bruto === undefined) continue;

            let v = String(bruto).trim().toUpperCase();
            if (v === "" || esMarcadorEstructural(v)) continue;

            let arr = mapa.get(v);
            if (arr) arr.push({ hoja: col.hoja, fila: r, isMS: col.isMS, isInventario: col.isInventario });
            else mapa.set(v, [{ hoja: col.hoja, fila: r, isMS: col.isMS, isInventario: col.isInventario }]);
        }
    }
    return mapa;
}

// Índice: clave de hoja -> columna de su _FISICO dentro del caché.
function mapaColumnasFisico(cacheInfo) {
    let m = new Map();
    if (!cacheInfo || !cacheInfo.headers) return m;
    for (let c = 0; c < cacheInfo.headers.length; c++) {
        let header = String(cacheInfo.headers[c]);
        if (header.endsWith("_FISICO")) m.set(claveHoja(header.replace("_FISICO", "")), c);
    }
    return m;
}

// Última fila con dato en la columna A de una hoja, sacada del caché en vez de
// preguntársela a Sheets.
//
// getLastRow() resultó ser, con diferencia, la llamada más cara de todo el
// escaneo: 128-409 ms cada una, contra los ~48 ms de una llamada normal. En el
// barrido de M-S se pagaba una por pestaña, y solo eso eran 641 ms de un
// recálculo de 1,690 ms (y 2,044 ms del barrido completo).
//
// El caché mantiene la columna A de cada hoja en su columna _FISICO, con la
// fila del caché igual a la fila de la hoja, así que la respuesta ya está en
// memoria. Devuelve -1 si esa hoja no está indexada, para poder caer de vuelta
// en getLastRow().
function ultimaFilaEnCache(cacheInfo, colIdx) {
    if (!cacheInfo || !cacheInfo.data || colIdx === undefined || colIdx === null || colIdx < 0) return -1;
    for (let r = cacheInfo.data.length - 1; r >= 1; r--) {
        if (String(cacheInfo.data[r][colIdx]).trim() !== "") return r;
    }
    return 0;
}

// Claves de las pestañas M-S que contienen alguna de las guías tocadas, sacadas
// del índice del caché sin abrir una sola pestaña.
//
// Antes el barrido recorría TODAS las pestañas del archivo llamando a getName()
// en cada una para saber cuáles eran M-S: una llamada a la API por pestaña, en
// cada escaneo, para acabar abriendo casi siempre una sola.
function hojasConGuias(cacheInfo, guias, dominio) {
    let out = new Set();
    if (!cacheInfo || !cacheInfo.map || !guias) return out;
    guias.forEach(g => {
        let entradas = cacheInfo.map.get(String(g).trim().toUpperCase());
        if (!entradas) return;
        entradas.forEach(e => {
            let suyo = dominio === "ms" ? e.isMS
                     : dominio === "inventario" ? e.isInventario
                     : (!e.isMS && !e.isInventario);       // destino
            if (suyo) out.add(e.hoja);
        });
    });
    return out;
}

function hojasMSConGuias(cacheInfo, guias) {
    return hojasConGuias(cacheInfo, guias, "ms");
}

// Recalcula las OTRAS hojas destino que contienen alguna de las guías tocadas.
//
// Sin esto, corregir o borrar una guía dejaba el "⛔ DUPLICADO" pegado en la
// otra hoja destino hasta que alguien escaneara allí: el barrido de M-S solo
// mira pestañas M-S y el de inventarios solo inventarios, así que entre
// destinos no había nadie que limpiara. Solo se abren las que de verdad tienen
// la guía, o sea casi siempre ninguna.
function sincronizarDestinosAfectados(source, cacheInfo, guiasAfectadas, hojaOrigen) {
    if (!guiasAfectadas || guiasAfectadas.size === 0) return;

    let claveOrigen = claveHoja(hojaOrigen);
    hojasConGuias(cacheInfo, guiasAfectadas, "destino").forEach(clave => {
        if (clave === claveOrigen || esHojaSistema(clave)) return;
        let h = perf("abrir destino por nombre", 0, () => source.getSheetByName(clave));
        if (h) actualizarGlobalPreforma(h, source, cacheInfo, guiasAfectadas, false, false);
    });
}

// Hasta dónde hay que recalcular una hoja, sin preguntárselo a Sheets.
//
// `getLastRow()` mira TODAS las columnas; el caché solo conoce la A y la O. La
// diferencia importa en un caso muy concreto y nada raro:
//
//   Borras la guía de la última fila con datos. El caché se actualiza ANTES de
//   recalcular, así que ya devuelve la fila anterior. El recálculo no llegaría a
//   esa fila y el "✅ Ok" de la B y la hora de la L se quedarían pegados para
//   siempre — y la red de seguridad de los 5 minutos no lo recoge, porque solo
//   busca filas con dato y sin estado.
//
// Por eso la fila recién editada es SIEMPRE un suelo. Devuelve 0 cuando la hoja
// no está indexada, que significa «pregúntaselo a Sheets».
function filaFinalDesdeCache(cacheInfo, clave, filaEditadaFinal) {
    if (!cacheInfo || !cacheInfo.headers) return 0;

    let k = claveHoja(clave);
    let colF = cacheInfo.headers.indexOf(k + "_FISICO");
    let colP = cacheInfo.headers.indexOf(k + "_PREFORMA");

    // Sin ninguna de las dos columnas, la hoja no está en el caché.
    if (colF === -1 && colP === -1) return 0;

    // Que falte SOLO la de preforma es normal: las M-S no la tienen.
    let lrF = colF === -1 ? 0 : ultimaFilaEnCache(cacheInfo, colF);
    let lrP = colP === -1 ? 0 : ultimaFilaEnCache(cacheInfo, colP);
    if (lrF < 0) lrF = 0;
    if (lrP < 0) lrP = 0;

    let suelo = filaEditadaFinal > 0 ? filaEditadaFinal : 0;
    return Math.max(lrF, lrP, suelo, 1);
}

function hojaContieneAlgunaGuia(cacheInfo, colIdx, guias) {
    if (colIdx === undefined || !guias || guias.size === 0) return false;
    for (let r = 1; r < cacheInfo.data.length; r++) {
        let v = String(cacheInfo.data[r][colIdx]).trim().toUpperCase();
        if (v !== "" && guias.has(v)) return true;
    }
    return false;
}

// -------------------------------------------------------------------------
// AISLAMIENTO DE DOMINIOS
//   INVENTARIO -> solo choca con INVENTARIO (incluida otra ubicación IW de la
//                 misma pestaña: por eso NO se descarta la hoja actual, solo
//                 la fila exacta).
//   M-S        -> solo choca con otras M-S.
//   GLOBAL     -> solo choca con otras GLOBALES/REZAGO/AGA.
// -------------------------------------------------------------------------
function verificarDuplicadoConCache(cacheInfo, nombreHojaActual, guiaBuscada, filaActual) {
    if (!cacheInfo || !cacheInfo.map) return { encontrado: false };

    let clave = claveHoja(nombreHojaActual);
    let isCurrentMS = esHojaMS(clave);
    let isCurrentInv = esHojaInventario(clave);
    let matches = cacheInfo.map.get(guiaBuscada);
    if (!matches) return { encontrado: false };

    for (let i = 0; i < matches.length; i++) {
        let match = matches[i];

        if (isCurrentInv) {
            if (match.hoja === clave && match.fila === filaActual) continue;
            if (!match.isInventario) continue;
            let ubic = (match.hoja === clave)
                ? "esta hoja, fila " + match.fila
                : match.hoja + " Fila " + match.fila;
            return { encontrado: true, ubicacion: ubic };
        }

        if (match.hoja === clave) continue;

        if (isCurrentMS) {
            if (match.isMS) return { encontrado: true, ubicacion: match.hoja + " Fila " + match.fila };
        } else {
            if (!match.isMS && !match.isInventario) {
                return { encontrado: true, ubicacion: match.hoja + " Fila " + match.fila };
            }
        }
    }

    return { encontrado: false };
}

// Recalcula desde cero los duplicados externos de una hoja completa.
// Antes el texto "⛔ DUPLICADO" se conservaba tal cual y nunca se limpiaba
// aunque el original se hubiera borrado; ahora se reevalúa en cada pasada.
// Devuelve Map: índice de fila (0-based) -> match del caché.
function calcularDuplicadosExternos(datosMasivos, ultimaFila, claveEsta, cacheInfo) {
    let res = new Map();
    if (!cacheInfo || !cacheInfo.map) return res;

    let esInv = esHojaInventario(claveEsta);
    let esMS = esHojaMS(claveEsta);

    for (let i = 0; i < ultimaFila; i++) {
        let v = String(datosMasivos[i][0]).trim().toUpperCase();
        if (v === "" || v.startsWith("IW") || esCabeceraBloque(v)) continue;

        let matches = cacheInfo.map.get(v);
        if (!matches) continue;

        for (let m = 0; m < matches.length; m++) {
            let match = matches[m];
            if (match.hoja === claveEsta && match.fila === i) continue;

            if (esInv) {
                if (!match.isInventario) continue;   // inventario ignora Global y M-S
            } else if (esMS) {
                if (!match.isMS || match.hoja === claveEsta) continue;
            } else {
                if (match.isMS || match.isInventario || match.hoja === claveEsta) continue;
            }

            res.set(i, match);
            break;
        }
    }
    return res;
}

// Pedimentos repetidos en OTRA pestaña.
//
// Hasta ahora "🛑 PEDIMENTO REPETIDO" solo miraba dentro de la propia hoja
// (`pedimentosVistosFisico`), así que el mismo pedimento en dos pestañas pasaba
// sin aviso.
//
// Ojo con el aislamiento, que aquí es imprescindible: un pedimento SÍ tiene que
// estar a la vez en una M-S y en su destino — ese es el flujo normal, primero se
// preregistra y luego se embarca. Marcar eso sería un falso positivo en cada
// pedimento del archivo. Así que se aplica la misma regla que a las guías: M-S
// choca con M-S y destino con destino, nunca entre dominios.
function calcularPedimentosDuplicadosExternos(datosMasivos, ultimaFila, claveEsta, cacheInfo) {
    let res = new Map();
    if (!DETECTAR_PEDIMENTO_REPETIDO_ENTRE_PESTANAS) return res;
    if (!cacheInfo || !cacheInfo.map) return res;
    if (esHojaInventario(claveEsta)) return res;   // los inventarios no llevan pedimentos

    let esMS = esHojaMS(claveEsta);

    for (let i = 0; i < ultimaFila; i++) {
        let v = String(datosMasivos[i][0]).trim();
        if (!/^\d{7}$/.test(v)) continue;

        let matches = cacheInfo.map.get(v);
        if (!matches) continue;

        for (let m = 0; m < matches.length; m++) {
            let match = matches[m];
            // La propia hoja ya la vigila pedimentosVistosFisico.
            if (match.hoja === claveEsta) continue;
            if (match.isInventario) continue;
            if (esMS !== match.isMS) continue;
            res.set(i, match);
            break;
        }
    }
    return res;
}

// Escribe el aviso de pedimento repetido en otra pestaña. No pisa un aviso
// crítico que ya estuviera puesto (por ejemplo, el repetido dentro de la
// propia hoja, que es más urgente de resolver).
function marcarPedimentosRepetidosFuera(resultadosB, coloresB, mapa) {
    mapa.forEach((match, fila) => {
        if (nivelAlerta(resultadosB[fila][0]) >= NIVEL_CRITICO) return;
        resultadosB[fila][0] = "🛑 PEDIMENTO REPETIDO (En: " + match.hoja + " Fila " + match.fila + ")";
        coloresB[fila][0] = "#dc3545";
    });
}

// =========================================================================
// ESCRITURA EN CACHÉ (RAM + hoja) CON LIMPIEZA DE BORRADOS
// Devuelve un Set con las guías tocadas (valores nuevos y antiguos), o null
// si hubo que reconstruir la fotografía completa de la hoja.
// =========================================================================
// `hoja` es la pestaña que se acaba de editar. Antes se buscaba aquí dentro con
// buscarHojaPorClave(), que recorre TODAS las pestañas del archivo preguntando
// su nombre, y encima se hacía siempre aunque solo hiciera falta en dos ramas
// raras. El único llamador ya la tiene en la mano, así que se la pasa.
//
// Además es más correcto: buscarHojaPorClave compara nombres normalizados, así
// que en la rama del renombrado —la que existe precisamente para curar ese
// caso— podía devolver null y dejar la foto sin rehacer.
function actualizarBloqueEnCache(source, hoja, nombreHoja, filaInicial, numRows, colInicial, numCols, valoresEditados) {
    let clave = claveHoja(nombreHoja);
    let cacheSheet = source.getSheetByName("CACHE_SISTEMA");

    if (!cacheSheet) {
        if (hoja) actualizarFotografiaMental(hoja, source);
        invalidarCacheRAM();
        return null;
    }

    // Headers desde RAM cuando ya están cargados: evita 2 llamadas por escaneo.
    let headers = globalCacheHeaders;
    if (!headers) {
        let maxCols = Math.max(cacheSheet.getLastColumn(), 1);
        headers = cacheSheet.getRange(1, 1, 1, maxCols).getValues()[0];
    }

    // La hoja no está en el caché: o es nueva, o la acaban de RENOMBRAR.
    //
    // Lo segundo es lo peligroso. Renombrar una pestaña no dispara nada, así que
    // su columna vieja se queda en el caché con todas sus guías dentro. En
    // cuanto se escanea con el nombre nuevo se crea una segunda columna con las
    // MISMAS guías, y a partir de ahí cada fila de esa hoja se ve duplicada
    // contra su propio pasado: la pestaña entera en "⛔ DUPLICADO".
    //
    // Antes eso solo lo limpiaba el repaso de cada 5 minutos. Ahora se poda aquí
    // mismo, antes de crear la columna nueva, así que el primer escaneo tras el
    // cambio de nombre ya deja el caché coherente.
    if (headers.indexOf(clave + "_FISICO") === -1) {
        podarCacheHuerfano(source);
        if (hoja) actualizarFotografiaMental(hoja, source);
        invalidarCacheRAM();
        return null;
    }

    let isMSActual = esHojaMS(clave);
    let isInventarioActual = esHojaInventario(clave);
    let guiasAfectadas = new Set();

    // La hoja de caché también tiene que crecer, no solo el array en RAM.
    asegurarFilas(cacheSheet, filaInicial + numRows + 1);

    if (globalCacheData) {
        while (globalCacheData.length <= filaInicial + numRows) {
            globalCacheData.push(new Array(headers.length).fill(""));
        }
    }

    if (colInicial <= 1 && colInicial + numCols - 1 >= 1) {
        let idxData = 1 - colInicial;
        let colIdx = headers.indexOf(clave + "_FISICO");
        if (colIdx >= 0) {
            let valsToSet = [];
            for (let r = 0; r < numRows; r++) {
                let val = valoresEditados[r][idxData];
                valsToSet.push([val]);

                if (!globalCacheData) continue;

                let oldStr = String(globalCacheData[filaInicial + r][colIdx]).trim().toUpperCase();
                let vStr = String(val).trim().toUpperCase();
                globalCacheData[filaInicial + r][colIdx] = val;

                if (oldStr !== "") guiasAfectadas.add(oldStr);
                if (vStr !== "") guiasAfectadas.add(vStr);

                if (!globalCacheMap) continue;

                // 1. Purga el rastro viejo (esto es lo que hace que un borrado
                //    deje de contar como duplicado al instante).
                if (oldStr !== "" && oldStr !== vStr) {
                    let arr = globalCacheMap.get(oldStr);
                    if (arr) {
                        let newArr = arr.filter(m => !(m.hoja === clave && m.fila === filaInicial + r));
                        if (newArr.length === 0) globalCacheMap.delete(oldStr);
                        else globalCacheMap.set(oldStr, newArr);
                    }
                }
                // 2. Registra el dato nuevo.
                if (vStr !== "") {
                    let arr = globalCacheMap.get(vStr) || [];
                    if (!arr.some(m => m.hoja === clave && m.fila === filaInicial + r)) {
                        arr.push({ hoja: clave, fila: filaInicial + r, isMS: isMSActual, isInventario: isInventarioActual });
                        globalCacheMap.set(vStr, arr);
                    }
                }
            }
            cacheSheet.getRange(filaInicial + 1, colIdx + 1, numRows, 1).setValues(valsToSet);
        }
    }

    if (colInicial <= 15 && colInicial + numCols - 1 >= 15) {
        let idxData = 15 - colInicial;
        let colIdx = headers.indexOf(clave + "_PREFORMA");
        if (colIdx >= 0) {
            let valsToSet = [];
            for (let r = 0; r < numRows; r++) {
                let val = valoresEditados[r][idxData];
                valsToSet.push([val]);
                if (globalCacheData) globalCacheData[filaInicial + r][colIdx] = val;
            }
            cacheSheet.getRange(filaInicial + 1, colIdx + 1, numRows, 1).setValues(valsToSet);
        }
    }

    return guiasAfectadas;
}

// OJO: recorre TODAS las pestañas pidiendo su nombre. Fuera del camino de
// escaneo a propósito — si vuelve a aparecer ahí, son ~26 llamadas por escaneo.
// Hoy solo la usa la herramienta de medición.
function buscarHojaPorClave(source, clave) {
    let objetivo = claveHoja(clave);
    let hojas = source.getSheets();
    for (let i = 0; i < hojas.length; i++) {
        if (claveHoja(hojas[i].getName()) === objetivo) return hojas[i];
    }
    return null;
}

// Las M-S no llevan preforma: su columna O siempre está vacía.
// No tiene sentido reservarles columna en el caché ni leerla en cada foto.
function usaPreforma(nombreHoja) {
    return !esHojaMS(nombreHoja);
}

// Devuelve la columna (1-based) del header, creándola al final si no existe.
function columnaDeHeader(cacheSheet, headers, titulo) {
    let idx = headers.indexOf(titulo);
    if (idx !== -1) return idx + 1;

    // El sitio libre es el primer encabezado vacío, o el final. Contando los no
    // vacíos, un hueco en medio hacía que la columna nueva cayera encima de otra
    // que sí estaba en uso.
    let hueco = -1;
    for (let i = 0; i < headers.length; i++) {
        if (String(headers[i]).trim() === "") { hueco = i; break; }
    }
    let col = (hueco !== -1 ? hueco : headers.length) + 1;
    if (col > cacheSheet.getMaxColumns()) {
        cacheSheet.insertColumnsAfter(cacheSheet.getMaxColumns(), 2);
    }
    cacheSheet.getRange(1, col).setValue(titulo);
    headers[col - 1] = titulo;
    return col;
}

function actualizarFotografiaMental(hoja, source) {
    let clave = claveHoja(hoja.getName());
    if (esHojaSistema(clave)) return;

    let cacheSheet = source.getSheetByName("CACHE_SISTEMA");
    if (!cacheSheet) {
        cacheSheet = source.insertSheet("CACHE_SISTEMA");
        cacheSheet.hideSheet();
    }

    let lr = perf("foto: getLastRow", 0, () => Math.max(hoja.getLastRow(), 1));
    asegurarFilas(cacheSheet, lr + 1);

    let maxCols = Math.max(cacheSheet.getLastColumn(), 1);
    let headers = cacheSheet.getRange(1, 1, 1, maxCols).getValues()[0];

    // Las columnas se reservan por separado, no en pares: así una M-S ocupa
    // una sola columna en vez de dos, una de ellas siempre vacía.
    let conPreforma = usaPreforma(clave);
    let colFisico = columnaDeHeader(cacheSheet, headers, clave + "_FISICO");
    let colPreforma = conPreforma ? columnaDeHeader(cacheSheet, headers, clave + "_PREFORMA") : -1;

    let maxFilasCache = cacheSheet.getMaxRows();
    if (maxFilasCache > 1) {
        cacheSheet.getRange(2, colFisico, maxFilasCache - 1, 1).clearContent();
        if (colPreforma !== -1) cacheSheet.getRange(2, colPreforma, maxFilasCache - 1, 1).clearContent();
    }

    cacheSheet.getRange(2, colFisico, lr, 1).setValues(hoja.getRange(1, 1, lr, 1).getValues());

    if (colPreforma !== -1 && hoja.getMaxColumns() >= 15) {
        cacheSheet.getRange(2, colPreforma, lr, 1).setValues(hoja.getRange(1, 15, lr, 1).getValues());
    }
}

// Elimina del caché las columnas de hojas que ya no existen (renombradas o
// borradas). Sin esto, una pestaña eliminada seguía generando duplicados
// fantasma para siempre.
function podarCacheHuerfano(source) {
    let cacheSheet = source.getSheetByName("CACHE_SISTEMA");
    if (!cacheSheet) return 0;

    let lc = cacheSheet.getLastColumn();
    if (lc < 1) return 0;

    let headers = cacheSheet.getRange(1, 1, 1, lc).getValues()[0];
    let existentes = new Set(source.getSheets().map(h => claveHoja(h.getName())));

    // De derecha a izquierda para que los índices no se muevan al ir borrando.
    let aBorrar = columnasHuerfanas(headers, existentes);
    aBorrar.forEach(col => cacheSheet.deleteColumn(col));
    return aBorrar.length;
}

// Qué columnas del caché sobran, dados sus encabezados y las pestañas que
// existen de verdad. Devuelve columnas 1-based ya ordenadas de derecha a
// izquierda, que es como hay que borrarlas.
function columnasHuerfanas(headers, existentes) {
    let aBorrar = [];
    for (let i = 0; i < headers.length; i++) {
        // Con trim(): un encabezado de solo espacios es un HUECO reutilizable
        // para columnaDeHeader, y sin este trim aquí se tomaba por «pestaña
        // desconocida» y se borraba la columna, desplazando todas las de su
        // derecha. Saltarlo es mucho menos destructivo que eliminarlo.
        let h = String(headers[i]).trim();
        if (h === "") continue;
        let nombre = claveHoja(h.replace("_FISICO", "").replace("_PREFORMA", ""));

        // Pestaña renombrada o borrada.
        if (!existentes.has(nombre)) { aBorrar.push(i + 1); continue; }
        // Columna de preforma de una M-S: siempre vacía, no se usa.
        if (h.endsWith("_PREFORMA") && !usaPreforma(nombre)) aBorrar.push(i + 1);
    }
    return aBorrar.sort((a, b) => b - a);
}

// =========================================================================
// HISTORIAL AUDITADO (en lote, con usuario)
// =========================================================================
// Orden por defecto al crear la hoja desde cero. Si la hoja YA existe, se
// respeta el orden de sus encabezados: el historial es un registro de auditoría
// y reordenar sus columnas invalidaría lo ya registrado.
const HIST_ORDEN_DEFECTO = ["FECHA", "USUARIO", "PESTAÑA", "FILA", "COLUMNA", "VALOR", "ESTADO", "MOTIVO"];

const HIST_TITULOS = {
    FECHA:   "FECHA Y HORA",
    USUARIO: "USUARIO",
    "PESTAÑA": "PESTAÑA",
    FILA:    "FILA",
    COLUMNA: "COLUMNA",
    VALOR:   "GUÍA/PEDIMENTO BORRADO",
    ESTADO:  "ESTADO ANTERIOR",
    MOTIVO:  "MOTIVO"
};

// Sinónimos aceptados al leer los encabezados existentes (sin acentos y en
// mayúsculas), para reconocer la columna aunque el título varíe.
const HIST_SINONIMOS = {
    "FECHA Y HORA": "FECHA", "FECHA": "FECHA", "FECHA/HORA": "FECHA",
    "USUARIO": "USUARIO", "EMAIL": "USUARIO", "CORREO": "USUARIO",
    "PESTANA": "PESTAÑA", "HOJA": "PESTAÑA",
    "FILA": "FILA",
    "COLUMNA": "COLUMNA",
    "GUIA/PEDIMENTO BORRADO": "VALOR", "GUIA": "VALOR", "VALOR": "VALOR",
    "VALOR BORRADO": "VALOR", "GUIA BORRADA": "VALOR",
    "ESTADO ANTERIOR": "ESTADO", "ESTADO": "ESTADO",
    "MOTIVO": "MOTIVO"
};

function normalizarTitulo(t) {
    return String(t).trim().toUpperCase()
        .replace(/Á/g, "A").replace(/É/g, "E").replace(/Í/g, "I")
        .replace(/Ó/g, "O").replace(/Ú/g, "U").replace(/Ñ/g, "N");
}

function eventoHistorial(hojaAfectada, fila, columnaStr, valorBorrado, estadoAnterior, motivo) {
    return {
        FECHA:   Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "dd/MM/yyyy HH:mm:ss"),
        USUARIO: obtenerUsuarioActual(),
        "PESTAÑA": hojaAfectada,
        FILA:    fila,
        COLUMNA: columnaStr,
        VALOR:   valorBorrado,
        ESTADO:  estadoAnterior,
        MOTIVO:  motivo
    };
}

function registrarEnHistorialLote(source, eventos) {
    if (!eventos || eventos.length === 0) return;

    let hojaHistorial = source.getSheetByName("HISTORIAL_BORRADOS");
    let orden;

    if (!hojaHistorial) {
        hojaHistorial = source.insertSheet("HISTORIAL_BORRADOS");
        orden = HIST_ORDEN_DEFECTO.slice();
        hojaHistorial.getRange(1, 1, 1, orden.length).setValues([orden.map(k => HIST_TITULOS[k])]);
        hojaHistorial.getRange(1, 1, 1, orden.length).setFontWeight("bold").setBackground("#d9d9d9");
        hojaHistorial.setFrozenRows(1);
    } else {
        // Se lee el layout real de la hoja en vez de asumir uno.
        let ancho = Math.max(hojaHistorial.getLastColumn(), 1);
        let titulos = hojaHistorial.getRange(1, 1, 1, ancho).getValues()[0];
        orden = titulos.map(t => HIST_SINONIMOS[normalizarTitulo(t)] || null);

        // Campos que la hoja todavía no tiene: se añaden al final.
        let faltantes = HIST_ORDEN_DEFECTO.filter(k => orden.indexOf(k) === -1);
        if (faltantes.length > 0) {
            asegurarColumnas(hojaHistorial, ancho + faltantes.length);
            hojaHistorial.getRange(1, ancho + 1, 1, faltantes.length)
                .setValues([faltantes.map(k => HIST_TITULOS[k])])
                .setFontWeight("bold").setBackground("#d9d9d9");
            orden = orden.concat(faltantes);
        }
    }

    let filas = eventos.map(ev => orden.map(k => (k === null ? "" : ev[k])));

    let inicio = hojaHistorial.getLastRow() + 1;
    asegurarFilas(hojaHistorial, inicio + filas.length);
    hojaHistorial.getRange(inicio, 1, filas.length, orden.length).setValues(filas);
}

// =========================================================================
// SINCRONIZACIÓN MACHO
// =========================================================================
function sincronizarMacho(hojaMacho, source) {
    let ultimaFila = hojaMacho.getLastRow();
    let valoresMacho = [];
    if (ultimaFila > 0) valoresMacho = hojaMacho.getRange(1, 13, ultimaFila, 1).getValues();

    let hojas = source.getSheets();
    for (let i = 0; i < hojas.length; i++) {
        let hojaDestino = hojas[i];
        let n = claveHoja(hojaDestino.getName());

        // La propia MACHO es el origen, no destino.
        if (n === HOJA_MACHO) continue;
        // CACHE_SISTEMA e HISTORIAL_BORRADOS quedan fuera: la columna M de
        // CACHE_SISTEMA es una columna de caché, no la lista FEMAD.
        if (esHojaInterna(n)) continue;
        // Las plantillas de inventario SÍ la reciben, para que sus copias
        // nazcan con la validación y los colores ya puestos.

        let maxRows = hojaDestino.getMaxRows();
        if (maxRows > 0) hojaDestino.getRange(1, 13, maxRows, 1).clearContent();
        if (valoresMacho.length > 0) {
            if (maxRows < valoresMacho.length) hojaDestino.insertRowsAfter(maxRows, valoresMacho.length - maxRows);
            hojaDestino.getRange(1, 13, valoresMacho.length, 1).setValues(valoresMacho);
        }
    }
}

// =========================================================================
// VALIDACIÓN DE GUÍAS
// =========================================================================
function esGuiaUPSValida(guia) {
  let g = String(guia).trim().toUpperCase();
  if (g === "" || /^\d{7}$/.test(g)) return false;
  if (esMarcadorEstructural(g)) return false;
  if (g.startsWith("1Z")) {
      if (g.length !== 18) return false;
      const mapa = { 'A':2, 'B':3, 'C':4, 'D':5, 'E':6, 'F':7, 'G':8, 'H':9, 'I':0, 'J':1, 'K':2, 'L':3, 'M':4, 'N':5, 'O':6, 'P':7, 'Q':8, 'R':9, 'S':0, 'T':1, 'U':2, 'V':3, 'W':4, 'X':5, 'Y':6, 'Z':7 };
      let numStr = g.substring(2, 17); let checkDigitReal = parseInt(g.substring(17), 10);
      if (isNaN(checkDigitReal)) return false;
      let sumaImpares = 0; let sumaPares = 0;
      for (let i = 0; i < 15; i++) {
        let c = numStr.charAt(i); let val = (c >= '0' && c <= '9') ? parseInt(c, 10) : mapa[c];
        if (val === undefined || isNaN(val)) return false;
        if (i % 2 === 0) sumaImpares += val; else sumaPares += val;
      }
      return ((10 - ((sumaImpares + (sumaPares * 2)) % 10)) % 10) === checkDigitReal;
  }
  if (g.length > 7) return true;
  return false;
}

// Fixture de regresión: correr desde el editor tras tocar esGuiaUPSValida.
function TEST_guias() {
  const casos = [
    ["1Z999AA10123456784", true],   // ejemplo canónico de UPS
    ["1Z999AA10123456785", false],  // dígito verificador alterado
    ["1Z999AA1012345678",  false],  // longitud incorrecta
    ["6098234",            false],  // pedimento, no guía
    ["609823",             false],  // pedimento incompleto
    ["",                   false]
  ];
  let fallos = [];
  casos.forEach(c => { if (esGuiaUPSValida(c[0]) !== c[1]) fallos.push(c[0] + " → esperado " + c[1]); });
  Logger.log(fallos.length === 0 ? "✅ TEST_guias OK (" + casos.length + " casos)" : "❌ " + fallos.join(" | "));
  return fallos;
}

// =========================================================================
// PRE-PROCESAMIENTO DESDE CACHÉ
// =========================================================================
function obtenerGuiasRezagoDesdeCache(cacheInfo) {
    let guias = new Map();
    if (!cacheInfo || !cacheInfo.headers) return guias;

    for (let c = 0; c < cacheInfo.headers.length; c++) {
        let header = String(cacheInfo.headers[c]);
        if (!header.endsWith("_PREFORMA")) continue;

        let nombreHoja = claveHoja(header.replace("_PREFORMA", ""));
        if (nombreHoja.indexOf("REZAGO") === -1) continue;

        let pedActual = "";
        for (let r = 1; r < cacheInfo.data.length; r++) {
            let v = String(cacheInfo.data[r][c]).trim().toUpperCase();
            if (/^\d{7}$/.test(v)) pedActual = v;
            else if (v !== "" && !esMarcadorEstructural(v)) guias.set(v, { hoja: nombreHoja, pedimento: pedActual });
        }
    }
    return guias;
}

function obtenerRegistroMSDesdeCache(cacheInfo, nombreHojaActual) {
    let guiasOrigen = new Map();
    let registroMS = new Map();
    if (!cacheInfo || !cacheInfo.headers) return { guiasOrigen: guiasOrigen, registroMS: registroMS };

    let claveActual = claveHoja(nombreHojaActual);

    for (let c = 0; c < cacheInfo.headers.length; c++) {
        let header = String(cacheInfo.headers[c]);
        if (!header.endsWith("_FISICO")) continue;

        let nombreHoja = claveHoja(header.replace("_FISICO", ""));
        if (!esHojaMS(nombreHoja) || nombreHoja === claveActual) continue;

        // El registro previo de CUALQUIER M-S alimenta a CUALQUIER destino:
        // la carga se separa a mano por tipo, así que no hace falta filtrar por
        // nombre. `origen` solo sirve para el texto "(Escaneado en …)".
        let origen = tipoMS(nombreHoja);

        let pedActual = "";
        for (let r = 1; r < cacheInfo.data.length; r++) {
            let v = String(cacheInfo.data[r][c]).trim().toUpperCase();
            if (/^\d{7}$/.test(v)) {
                pedActual = v;
                if (!registroMS.has(pedActual)) registroMS.set(pedActual, new Set());
            } else if (v !== "" && !esMarcadorEstructural(v)) {
                if (!guiasOrigen.has(v)) guiasOrigen.set(v, origen);
                if (pedActual !== "") registroMS.get(pedActual).add(v);
            }
        }
    }
    return { guiasOrigen: guiasOrigen, registroMS: registroMS };
}

// Marca en las M-S las guías que ya fueron escaneadas en una hoja destino.
// `guiasAfectadas` acota el trabajo: si sabemos qué guías cambiaron, las M-S
// que no las contienen no se tocan (cero llamadas a la API). Con null hace
// barrido completo (menú / trigger por tiempo).
function sincronizarSalidasMS(source, cacheInfo, guiasAfectadas) {
    if (!cacheInfo || !cacheInfo.headers) return;

    let escaneadosDestino = new Map();
    let colPorHoja = mapaColumnasFisico(cacheInfo);

    // Recorre el caché entero (todas las columnas de destino × todas las filas)
    // para saber qué guía salió en qué pestaña. Es puro cálculo, sin API.
    perf("(memoria) índice de salidas", 0, () => {
        for (let c = 0; c < cacheInfo.headers.length; c++) {
            let header = String(cacheInfo.headers[c]);
            if (!header.endsWith("_FISICO")) continue;

            let n = claveHoja(header.replace("_FISICO", ""));
            if (esHojaMS(n) || esHojaInventario(n) || esHojaSistema(n) || n.indexOf("REZAGO") !== -1) continue;

            for (let r = 1; r < cacheInfo.data.length; r++) {
                let v = String(cacheInfo.data[r][c]).trim().toUpperCase();
                if (v !== "" && !esCabeceraBloque(v)) escaneadosDestino.set(v, n);
            }
        }
    });

    // Qué pestañas M-S hay que abrir. En un escaneo el caché ya sabe cuáles
    // contienen la guía, así que se piden por nombre y no se toca ninguna otra.
    // El camino largo (recorrer todas las pestañas preguntando su nombre una
    // por una) solo queda para el barrido completo desde los menús.
    let objetivos = [];
    let porNombre = guiasAfectadas && guiasAfectadas.size > 0;

    if (porNombre) {
        let claves = hojasMSConGuias(cacheInfo, guiasAfectadas);
        if (claves.size === 0) return;   // ninguna M-S tiene esas guías
        claves.forEach(clave => {
            if (!porNombre) return;
            let h = perf("abrir M-S por nombre", 0, () => source.getSheetByName(clave));
            // El caché guarda el nombre normalizado; si la pestaña real está
            // escrita distinto, getSheetByName falla y hay que ir por el largo.
            if (h) objetivos.push({ hoja: h, clave: clave });
            else porNombre = false;
        });
    }

    if (!porNombre) {
        objetivos = [];
        let hojas = perf("listar pestañas", 0, () => source.getSheets());
        for (let i = 0; i < hojas.length; i++) {
            let h = hojas[i];
            let n = perf("nombre de pestaña", 0, () => claveHoja(h.getName()));
            if (!esHojaMS(n)) continue;
            if (guiasAfectadas && guiasAfectadas.size > 0 &&
                !hojaContieneAlgunaGuia(cacheInfo, colPorHoja.get(n), guiasAfectadas)) continue;
            objetivos.push({ hoja: h, clave: n });
        }
    }

    let msModificadas = [];

    for (let i = 0; i < objetivos.length; i++) {
        let hojaMS = objetivos[i].hoja;
        let nMS = objetivos[i].clave;

        // El caché sabe hasta dónde llega la columna A de esta M-S; solo se le
        // pregunta a Sheets si la pestaña todavía no está indexada.
        let lr = ultimaFilaEnCache(cacheInfo, colPorHoja.get(nMS));
        if (lr < 0) lr = perf("M-S: getLastRow (sin caché)", 0, () => hojaMS.getLastRow());
        if (lr < 1) continue;

        let rangoStatus = hojaMS.getRange(1, 1, lr, 2);
        let vals = perf("M-S: leer A:B", lr * 2, () => rangoStatus.getValues());
        let modificados = false;

        for (let r = 0; r < lr; r++) {
            let v = String(vals[r][0]).trim().toUpperCase();
            if (v === "" || esCabeceraBloque(v)) continue;

            // Se compara SOLO la cabeza. La cola es el resumen del bloque, que
            // pone actualizarMS y que aquí no se sabe recalcular: si entrara en
            // la comparación, la celda no coincidiría nunca con lo esperado y
            // se reescribiría en cada pasada, para siempre.
            let statusActual = cabezaEstado(vals[r][1]);
            let cola = colaResumen(vals[r][1]);
            let destino = escaneadosDestino.get(v);

            if (destino) {
                let textoEsperado = TXT_SALIO + destino;

                // Este barrido es un pase parcial: solo sabe si la guía salió,
                // no si además está duplicada o mal puesta. Si lo que ya hay
                // escrito es más grave, se respeta. Antes lo borraba y el
                // operador veía la alerta desaparecer sola a los segundos.
                if (!puedePisar(statusActual, textoEsperado)) continue;

                // Al reescribir se devuelve la cola tal cual estaba, para no
                // dejar la celda a medias hasta que actualizarMS la rehaga.
                if (statusActual !== textoEsperado) { vals[r][1] = textoEsperado + cola; modificados = true; }
            } else if (esEstadoSalida(statusActual)) {
                vals[r][1] = cola; modificados = true;
            }
        }

        if (modificados) {
            perf("M-S: escribir A:B", lr * 2, () => rangoStatus.setValues(vals));
            msModificadas.push({ hoja: hojaMS, lr: lr });
        }
    }

    // El lr de cada M-S ya se calculó arriba desde el caché: se reutiliza en vez
    // de que actualizarMS lo vuelva a pedir. Y es coherente por construcción,
    // porque es la misma fila con la que se acaba de escribir la columna B.
    msModificadas.forEach(m => actualizarMS(m.hoja, source, cacheInfo, false, m.lr));
}

// Propaga un cambio al resto de pestañas de INVENTARIO. Solo se abren las que
// realmente contienen alguna de las guías tocadas.
function sincronizarInventariosAfectados(source, cacheInfo, guiasAfectadas, hojaOrigen) {
    if (!cacheInfo || !cacheInfo.headers) return;

    let claveOrigen = claveHoja(hojaOrigen);
    let colPorHoja = mapaColumnasFisico(cacheInfo);
    let hojas = source.getSheets();

    for (let i = 0; i < hojas.length; i++) {
        let h = hojas[i];
        let n = claveHoja(h.getName());
        if (!esHojaInventario(n) || n === claveOrigen) continue;

        if (guiasAfectadas && guiasAfectadas.size > 0) {
            if (!hojaContieneAlgunaGuia(cacheInfo, colPorHoja.get(n), guiasAfectadas)) continue;
        }

        actualizarInventario(h, cacheInfo);
    }
}

// =========================================================================
// CRONÓMETRO DE LLAMADAS A LA API
// =========================================================================
// Apagado siempre salvo mientras corre «Medir velocidad de escaneo». Sirve
// para saber en qué llamada concreta se va el tiempo, en vez de deducirlo:
// cada etiqueta acumula milisegundos, número de llamadas y celdas movidas.
// Con el cronómetro apagado el coste es una llamada a función vacía, nada
// frente a los ~59 ms que cuesta cualquier ida y vuelta a Sheets.
let PERF = null;

function perfIniciar() { PERF = { orden: [], ms: {}, n: {}, celdas: {} }; }
function perfFin() { let p = PERF; PERF = null; return p; }

function perf(etiqueta, celdas, fn) {
    if (!PERF) return fn();
    let t = Date.now();
    let r = fn();
    if (PERF.ms[etiqueta] === undefined) {
        PERF.orden.push(etiqueta);
        PERF.ms[etiqueta] = 0; PERF.n[etiqueta] = 0; PERF.celdas[etiqueta] = 0;
    }
    PERF.ms[etiqueta] += Date.now() - t;
    PERF.n[etiqueta]++;
    PERF.celdas[etiqueta] += celdas;
    return r;
}

// Devuelve las líneas del desglose, de la etiqueta más cara a la más barata.
function perfLineas(p, totalMs) {
    if (!p || p.orden.length === 0) return ["   (sin datos)"];
    let filas = p.orden.map(e => ({ e: e, ms: p.ms[e], n: p.n[e], c: p.celdas[e] }));
    filas.sort((a, b) => b.ms - a.ms);
    let sumaMs = 0, sumaN = 0;
    let out = [];
    filas.forEach(f => {
        sumaMs += f.ms; sumaN += f.n;
        let pct = totalMs > 0 ? Math.round(f.ms * 100 / totalMs) : 0;
        out.push("   " + String(f.ms).padStart(5) + " ms  " + String(pct).padStart(3) + "%  ·  " +
                 f.n + (f.n === 1 ? " llamada" : " llamadas") +
                 (f.c > 0 ? ", " + f.c.toLocaleString() + " celdas" : "") +
                 "  ·  " + f.e);
    });
    out.push("   " + String(sumaMs).padStart(5) + " ms       ·  " + sumaN + " llamadas en total");
    if (totalMs > sumaMs) out.push("   " + String(totalMs - sumaMs).padStart(5) + " ms       ·  resto (cálculo en memoria y llamadas sin medir)");
    return out;
}

// =========================================================================
// ESCRITURA DIFERENCIAL POR BLOQUES
// =========================================================================
// Filas vacías que se toleran dentro de un mismo bloque de escritura.
//
// Cada llamada a la API cuesta decenas de milisegundos independientemente de
// cuántas celdas lleve, así que escribir 200 filas de más en UNA llamada sale
// mucho más barato que partir en dos y pagar otra ida y vuelta. Con el valor
// anterior (2) una hoja con cambios dispersos generaba decenas de bloques y
// cada uno costaba de 3 a 5 llamadas: ahí se iban los segundos por escaneo.
const HUECO_MAX_BLOQUE = 200;

// Texto del duplicado dentro de la MISMA hoja.
//
// Antes salía siempre "🔄 Duplicado local", sin decir dónde estaba la otra: el
// mensaje que sí nombraba el pedimento existía en el código pero era
// inalcanzable, porque la comprobación de "ya la vi" se hacía primero y tapaba
// a la de "ya está asignada a un pedimento". El operador necesita saber a qué
// pedimento ir, así que ahora siempre se dice.
function duplicadoLocal(previa, pedActual, etiqueta) {
    let et = etiqueta || "Ped";   // los inventarios agrupan por ubicación, no por pedimento
    let fila = previa.idx + 1;
    let tienePed = previa.ped && previa.ped !== "SIN_CABECERA" && !esMarcadorEstructural(previa.ped);

    // Repetida dentro del MISMO pedimento (o la misma ubicación): es un doble
    // escaneo y basta con borrar la de abajo. No hay que ir a buscar nada, así
    // que va en gris discreto y la primera ni se marca.
    if (previa.ped === pedActual) {
        return { texto: "🔄 Duplicado local", color: "#acacac", marcarPrimera: false };
    }

    // En otro pedimento sí importa: hay que decidir a cuál pertenece. Naranja,
    // con la referencia de dónde está la otra, y se pintan las dos.
    if (!tienePed) {
        return { texto: "⛔ DUPLICADO (ya escaneada en la fila " + fila + ")", color: "#ff9800", marcarPrimera: true };
    }
    return { texto: "⛔ DUPLICADO (ya en " + et + ": " + previa.ped + ", fila " + fila + ")", color: "#ff9800", marcarPrimera: true };
}

// =========================================================================
// PRIORIDAD DE LAS ALERTAS
// =========================================================================
// Una alerta importante no puede quedar tapada por un mensaje informativo.
// El caso que lo destapó: el barrido de salidas escribía "➡ Salió en ..." en
// las M-S y borraba de paso el "⛔ DUPLICADO" que el operador acababa de ver.
//
// La distinción no es qué mensaje es más bonito, es QUIÉN escribe:
//
//   · Los tres cerebros recalculan la fila ENTERA desde cero, así que saben
//     todo lo que hay que saber y escriben lo que les dé la gana. Ahí es donde
//     una alerta resuelta se limpia sola.
//   · Los pases parciales (el barrido de M-S, los avisos de la preforma) solo
//     conocen UN aspecto de la fila. Esos no pueden bajar el nivel: si lo que
//     hay escrito es más grave que lo que traen, se callan y lo dejan.
//
// Así la alerta aguanta hasta que se arregla de verdad la fila, y entonces el
// recálculo de su propia hoja la retira.
const NIVEL_CRITICO = 4;   // 🛑 error de estructura, pedimento repetido
const NIVEL_ALTO    = 3;   // ⛔ duplicado entre hojas o entre pedimentos
const NIVEL_MEDIO   = 2;   // ❌ guía inválida, guía que va en otro pedimento
const NIVEL_AVISO   = 1;   // ⚠️ sobra, sin registrar en M-S · 🔄 duplicado local
const NIVEL_INFO    = 0;   // ✅ ok · ➡ salió en · ⏳ esperando · vacío

function nivelAlerta(texto) {
    let t = String(texto).trim();
    if (t === "") return NIVEL_INFO;
    if (t.startsWith("🛑")) return NIVEL_CRITICO;
    if (t.startsWith("⛔")) return NIVEL_ALTO;
    if (t.startsWith("❌")) return NIVEL_MEDIO;
    if (t.startsWith("⚠️") || t.startsWith("🔄")) return NIVEL_AVISO;
    return NIVEL_INFO;
}

// ¿Puede un pase parcial escribir `nuevo` encima de `previo`? Solo si no baja
// el nivel de alerta de la fila.
function puedePisar(previo, nuevo) {
    return nivelAlerta(nuevo) >= nivelAlerta(previo);
}

// -------------------------------------------------------------------------
// UNA ALERTA GRAVE NO SE CAE SOLA
//
// puedePisar protegía los pases PARCIALES (el barrido de M-S), pero no el
// recálculo completo, que es el que de verdad borraba alertas. Los tres
// cerebros reconstruyen la columna B entera en cada pasada, así que una alerta
// sobrevive únicamente mientras la condición que la generó se siga detectando.
// Y esa condición se mira contra el caché, que cambia cada vez que CUALQUIERA
// escanea en CUALQUIER pestaña. Resultado: el operador veía salir el ⛔, se iba,
// y al volver la fila estaba en verde sin que nadie hubiera arreglado nada.
//
// La regla es la misma de antes, ahora también aquí: lo recalculado solo pisa
// a lo que ya había si es igual de grave o más.
//
// Solo se protege de ⛔ para arriba, y esto es deliberado:
//   · ⛔ y 🛑 hablan de una RELACIÓN con otra fila o con otra pestaña. Son las
//     que dependen del caché y por tanto las que desaparecen solas.
//   · ❌ «Guía Inválida» sale del propio contenido de la columna A. Se
//     recalcula bien siempre, así que protegerla no arregla nada y en cambio
//     dejaría el error pegado después de corregir la guía.
//
// Y hay tres salidas, las tres deliberadas:
//   · columna A vacía   -> la fila se resetea entera; borrar tiene que limpiar
//   · fila recién editada -> «hasta que se modifique»: si el operador la acaba
//     de tocar, la alerta vieja ya no habla de lo que hay ahora en la celda
//   · repintarTodo      -> «Forzar Actualización» reconstruye sin conservar nada
function conservarAlertaGrave(previo, nuevo) {
    if (nivelAlerta(previo) < NIVEL_ALTO) return nuevo;
    if (puedePisar(cabezaEstado(previo), cabezaEstado(nuevo))) return nuevo;
    // Se conserva el estado, pero con la cola NUEVA: el resumen del bloque
    // ("Bultos: 3 | ✅ TODO SALIÓ") sí tiene que seguir actualizándose.
    return cabezaEstado(previo) + colaResumen(nuevo);
}

// Color de fondo que le toca a una alerta conservada. Se deduce del texto
// porque el color original se perdió: la celda solo guarda las letras.
function colorDeAlerta(texto) {
    let t = String(texto).trim();
    if (t.startsWith("🛑 ERROR")) return "#ffc107";
    if (t.startsWith("🛑")) return "#dc3545";
    if (t.startsWith("⛔")) return "#ff9800";
    if (t.startsWith("❌")) return "#df5f6b";
    return "#FFFFFF";
}

// Aplica la regla a la hoja entera, justo antes de escribir. Devuelve cuántas
// filas conservaron su alerta, que es lo que mira el banco de pruebas.
// `idxDato` / `idxEstado` son las posiciones dentro de datosMasivos: la
// columna A y su estado B son 0 y 1; la preforma O y su estado P son 14 y 15.
function conservarAlertasGraves(datosMasivos, resultadosB, coloresB, ultimaFila, repintarTodo, filasEditadas, idxDato, idxEstado) {
    if (repintarTodo) return 0;
    if (idxDato === undefined) idxDato = 0;
    if (idxEstado === undefined) idxEstado = 1;
    let conservadas = 0;
    for (let i = 0; i < ultimaFila; i++) {
        if (!datosMasivos[i]) continue;
        if (String(datosMasivos[i][idxDato]).trim() === "") continue;
        if (filasEditadas && filasEditadas.has(i)) continue;

        let previo = String(datosMasivos[i][idxEstado]);
        let conservado = conservarAlertaGrave(previo, resultadosB[i][0]);
        if (conservado === resultadosB[i][0]) continue;

        resultadosB[i][0] = conservado;
        coloresB[i][0] = colorDeAlerta(conservado);
        conservadas++;
    }
    return conservadas;
}

// Coletilla que explica por qué el conteo de un bloque es más bajo de lo que
// se ve en pantalla: esas filas llevan alerta y no cuentan como bulto.
function notaConAlerta(n) {
    if (!n || n <= 0) return "";
    return "⚠️ " + n + (n === 1 ? " con alerta" : " con alerta");
}

// Pedimento del bloque de preforma al que pertenece una fila de guía.
function pedimentoDeFilaPreforma(bloquesPreforma, fila) {
    for (let b = 0; b < bloquesPreforma.length; b++) {
        if (bloquesPreforma[b].filasGuias.indexOf(fila) !== -1) return bloquesPreforma[b].pedimento;
    }
    return "SIN_CABECERA";
}

// Escribe un aviso en la columna P sin destruir lo que ya hubiera: si la fila
// arrastra el "► Resumen: N bultos" se antepone, y nunca pisa un ⛔ ni un 🛑,
// que son más graves.
function escribirAvisoPreforma(resultadosP, coloresP, fila, texto, color) {
    let previo = String(resultadosP[fila][0]);
    if (!puedePisar(previo, texto)) return;
    // Si lo que había ya era una alerta, no se apilan dos avisos en la misma
    // celda: manda la que ya estaba.
    if (nivelAlerta(previo) > NIVEL_INFO) return;
    // El "► Resumen: N bultos" sí es informativo y no debe perderse: el aviso
    // se antepone en vez de borrarlo.
    resultadosP[fila][0] = previo === "" ? texto : texto + " | " + previo;
    coloresP[fila][0] = color;
}

// Y el aviso que se pone en la PRIMERA de las dos, para que se pinten ambas y
// se vea la pareja de un vistazo.
function textoPrimeraDuplicada(info) {
    if (info.veces === 1) return "⚠️ DUPLICADO (repetida en la fila " + info.fila + ")";
    return "⚠️ DUPLICADO (repetida " + info.veces + " veces, la 1ª en la fila " + info.fila + ")";
}

// Registra que `idx` (primera aparición) tiene una repetición en `filaRepetida`.
function anotarRepeticion(repeticiones, idx, filaRepetida) {
    let info = repeticiones.get(idx);
    if (!info) { info = { veces: 0, fila: filaRepetida }; repeticiones.set(idx, info); }
    info.veces++;
    return info;
}

// Construye los colores de la columna A a partir del valor y del estado final
// ya calculado. Devuelve null si el coloreado por script está desactivado.
// `filasParejaDuplicada` son las filas de AMBAS guías de cada pareja repetida
// dentro de la hoja. Hace falta aparte porque el color no se puede deducir solo
// del texto de la B: la primera de la pareja conserva su "✅ Ok" cuando el
// duplicado es del tipo discreto, y aun así en la columna A tiene que salir
// roja igual que la otra.
function coloresDeColumnaA(datosMasivos, resultadosB, ultimaFila, filasParejaDuplicada) {
    if (!COLOREAR_COLUMNA_A) return null;
    let out = [];
    for (let i = 0; i < ultimaFila; i++) {
        let esPareja = filasParejaDuplicada && filasParejaDuplicada.has(i) &&
                       String(datosMasivos[i][0]).trim() !== "";
        out.push([esPareja ? COLOR_A_DUPLICADO : colorColumnaA(datosMasivos[i][0], resultadosB[i][0])]);
    }
    return out;
}

function aplicarCambiosOptimizado(hoja, colStatus, colHora, idxStatusOriginal, idxHoraOriginal, resultadosStatus, resultadosHoras, datosMasivos, coloresNuevos, fontLinesA, fontColorsA, coloresA, repintarTodo) {
    let n = resultadosStatus.length;
    if (n === 0) return;

    // Repintado total: se escribe la hoja entera aunque nada haya cambiado.
    // Hace falta al retirar el formato condicional, porque si no las filas
    // cuyo estado no cambió se quedarían sin color. Solo lo usan los menús.
    if (repintarTodo) {
        hoja.getRange(1, colStatus, n, 1).setValues(resultadosStatus);
        hoja.getRange(1, colHora, n, 1).setValues(resultadosHoras);
        if (coloresNuevos) hoja.getRange(1, colStatus, n, 1).setBackgrounds(coloresNuevos);
        if (coloresA)   hoja.getRange(1, 1, n, 1).setBackgrounds(coloresA);
        if (fontLinesA) hoja.getRange(1, 1, n, 1).setFontLines(fontLinesA);
        if (fontColorsA) hoja.getRange(1, 1, n, 1).setFontColors(fontColorsA);
        return;
    }

    // Deliberadamente NO se leen los fondos actuales para detectar cambios de
    // color: eso costaba una lectura de columna completa por llamada (dos por
    // recálculo de una Global) y es lo que más pesa en el camino del escaneo.
    // El color se escribe junto con el estado, así que solo puede quedar
    // desfasado si el texto no cambió pero el color sí — caso raro que se
    // corrige en la siguiente edición de esa fila o con «Forzar Actualización».
    let bloques = []; let min = -1, max = -1;
    for (let i = 0; i < n; i++) {
        let originalStatus = datosMasivos[i] ? String(datosMasivos[i][idxStatusOriginal]) : "";
        let originalHora = datosMasivos[i] ? String(datosMasivos[i][idxHoraOriginal]).trim() : "";
        let nuevaHora = String(resultadosHoras[i][0]).trim();

        let cambioStatus = String(resultadosStatus[i][0]) !== originalStatus;
        // Se detecta tanto poner hora como QUITARLA (antes solo lo primero, así
        // que quedaban horas huérfanas en filas ya vacías).
        let cambioHora = (originalHora === "" && nuevaHora !== "") || (originalHora !== "" && nuevaHora === "");

        if (cambioStatus || cambioHora) {
            if (min === -1) { min = i; max = i; }
            else if (i - max > HUECO_MAX_BLOQUE) { bloques.push({min: min, max: max}); min = i; max = i; }
            else { max = i; }
        }
    }
    if (min !== -1) bloques.push({min: min, max: max});

    bloques.forEach(b => {
        let numRows = b.max - b.min + 1;
        perf("escribir estado", numRows, () =>
            hoja.getRange(b.min + 1, colStatus, numRows, 1).setValues(resultadosStatus.slice(b.min, b.max + 1)));
        perf("escribir hora", numRows, () =>
            hoja.getRange(b.min + 1, colHora, numRows, 1).setValues(resultadosHoras.slice(b.min, b.max + 1)));

        if (coloresNuevos) perf("color del estado", numRows, () =>
            hoja.getRange(b.min + 1, colStatus, numRows, 1).setBackgrounds(coloresNuevos.slice(b.min, b.max + 1)));
        if (coloresA) perf("color de la columna A", numRows, () =>
            hoja.getRange(b.min + 1, 1, numRows, 1).setBackgrounds(coloresA.slice(b.min, b.max + 1)));
        if (fontLinesA) perf("tachado de la columna A", numRows, () =>
            hoja.getRange(b.min + 1, 1, numRows, 1).setFontLines(fontLinesA.slice(b.min, b.max + 1)));
        if (fontColorsA) perf("color de fuente de la columna A", numRows, () =>
            hoja.getRange(b.min + 1, 1, numRows, 1).setFontColors(fontColorsA.slice(b.min, b.max + 1)));
    });
}

// Conserva la hora de escaneo original: solo sella la hora actual cuando la
// celda estaba vacía. Antes se reescribía "ahora" en todas las filas del
// bloque, borrando la trazabilidad de las filas vecinas.
function horaPreservada(datosMasivos, i, idxHora, valorFila, horaActual) {
    if (String(valorFila).trim() === "") return '';
    let previa = datosMasivos[i][idxHora];
    return String(previa).trim() !== "" ? previa : horaActual;
}

// =========================================================================
// CEREBRO PRINCIPAL: GLOBALES, T1, REZAGO, PREFORMA Y AGA
// =========================================================================
function actualizarGlobalPreforma(hoja, source, cacheInfo, guiasAfectadas, tocoPreforma, repintarTodo, filaFinalSugerida, filasEditadas) {
  if (tocoPreforma === undefined) tocoPreforma = true;
  // Si viene sugerida, se ahorra la llamada más cara del sistema. La etiqueta
  // se conserva: en la próxima medición del camino de edición debe salir con
  // CERO llamadas, y esa es la prueba de que el atajo se activó.
  const ultimaFila = filaFinalSugerida > 0
      ? filaFinalSugerida
      : perf("getLastRow", 0, () => Math.max(hoja.getLastRow(), 1));
  if (ultimaFila < 1) return;

  perf("asegurarColumnas", 0, () => asegurarColumnas(hoja, 19));

  const datosMasivos = perf("leer la hoja A:S", ultimaFila * 19, () =>
      hoja.getRange(1, 1, ultimaFila, 19).getValues());
  const horaActual = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "HH:mm:ss");

  let nombreHoja = perf("nombre de la hoja", 0, () => claveHoja(hoja.getName()));
  let esHojaMSLocal = esHojaMS(nombreHoja);
  let esRezago = nombreHoja.indexOf("REZAGO") !== -1;
  let requiereAlertaMS = !esHojaMSLocal && esHojaPrincipal(nombreHoja) && !esRezago;

  let datosMS = perf("(memoria) registro M-S", 0, () => obtenerRegistroMSDesdeCache(cacheInfo, nombreHoja));
  let guiasEnMS = datosMS.guiasOrigen;
  let registroMS = datosMS.registroMS;
  let guiasRezagoGlobal = esRezago ? obtenerGuiasRezagoDesdeCache(cacheInfo) : null;

  // Duplicados externos reevaluados desde el caché en cada pasada.
  let dupExternos = perf("(memoria) duplicados", 0, () =>
      calcularDuplicadosExternos(datosMasivos, ultimaFila, nombreHoja, cacheInfo));

  let mapaPreformas = {}; let mapaInversoPreforma = new Map();
  let resultadosP = []; let resultadosHorasP = []; let coloresP = [];
  let coloresColumnaO = [];

  let totalPedimentosPreforma = 0; let totalBultosPreforma = 0;
  let bloquesPreforma = []; let pedimentosVistosPreforma = new Set(); let filasDuplicadasPreforma = new Set();

  for (let i = 0; i < ultimaFila; i++) {
    let valP = String(datosMasivos[i][14]).trim();
    let estP = String(datosMasivos[i][15]).trim();
    // Si la columna O está vacía, la fila se resetea por completo: sin estado
    // fijo, sin hora, sin color. Así borrar O limpia todo, no solo el dato.
    let esErrP = valP !== "" && estP.startsWith("🛑 ERROR");

    resultadosP.push([esErrP ? estP : '']);
    resultadosHorasP.push([horaPreservada(datosMasivos, i, 18, valP, horaActual)]);
    coloresP.push([esErrP ? '#ffc107' : '#FFFFFF']);
    coloresColumnaO.push(['#FFFFFF']);
  }

  if (esRezago) {
      let bPAct = null;
      for (let i = 0; i < ultimaFila; i++) {
          let v = String(datosMasivos[i][14]).trim().toUpperCase(); if (v === "") continue;
          let esErrP = resultadosP[i][0] !== '';
          if (/^\d{7}$/.test(v)) {
              if (!esErrP) totalPedimentosPreforma++;
              if (pedimentosVistosPreforma.has(v)) filasDuplicadasPreforma.add(i); else pedimentosVistosPreforma.add(v);
              if (bPAct) bloquesPreforma.push(bPAct);
              bPAct = { pedimento: v, filaPedimento: i, guias: [], filasGuias: [], esErr: esErrP };
          } else {
              totalBultosPreforma++;
              if (bPAct) { bPAct.guias.push(v); bPAct.filasGuias.push(i); }
              else { bPAct = { pedimento: "SIN_CABECERA", filaPedimento: -1, guias: [v], filasGuias: [i], esErr: false }; }
          }
      }
      if (bPAct) bloquesPreforma.push(bPAct);
  } else {
      let gTmp = []; let fTmp = [];
      for (let i = 0; i < ultimaFila; i++) {
          let v = String(datosMasivos[i][14]).trim().toUpperCase(); if (v === "") continue;
          let esErrP = resultadosP[i][0] !== '';
          if (/^\d{7}$/.test(v)) {
              if (!esErrP) totalPedimentosPreforma++;
              if (pedimentosVistosPreforma.has(v)) filasDuplicadasPreforma.add(i); else pedimentosVistosPreforma.add(v);
              bloquesPreforma.push({ pedimento: v, filaPedimento: i, guias: gTmp.slice(), filasGuias: fTmp.slice(), esErr: esErrP });
              gTmp = []; fTmp = [];
          } else {
              totalBultosPreforma++; gTmp.push(v); fTmp.push(i);
          }
      }
      if (gTmp.length > 0) bloquesPreforma.push({ pedimento: "SIN_CABECERA", filaPedimento: -1, guias: gTmp.slice(), filasGuias: fTmp.slice(), esErr: false });
  }

  let repetidasPreforma = COLOREAR_PEDIMENTO_Y_DUP_EN_O
      ? repetidasEnPreforma(bloquesPreforma)
      : new Map();

  bloquesPreforma.forEach(bloque => {
    let pedimento = bloque.pedimento; let setGuias = new Set(bloque.guias);
    if (pedimento !== "" && pedimento !== "SIN_CABECERA") {
        mapaPreformas[pedimento] = setGuias;
        setGuias.forEach(g => mapaInversoPreforma.set(g, pedimento));
    }

    let colorFondoPreforma = "#00ff00";
    if (bloque.filaPedimento !== -1) {
        colorFondoPreforma = colorBloqueO(datosMasivos[bloque.filaPedimento][13]);
        // La letra de la N sigue mandando en las guías del bloque; el azul
        // sólo se queda con la celda del pedimento.
        coloresColumnaO[bloque.filaPedimento][0] = COLOREAR_PEDIMENTO_Y_DUP_EN_O
            ? COLOR_A_PEDIMENTO
            : colorFondoPreforma;
    }
    bloque.filasGuias.forEach(fG => { coloresColumnaO[fG][0] = colorFondoPreforma; });

    if (bloque.esErr) return;
    let textoEsperando = setGuias.size + " bultos";
    if (bloque.filaPedimento !== -1 && !esRezago) resultadosP[bloque.filaPedimento][0] = textoEsperando;
    if (bloque.filasGuias.length > 0 && !esRezago) resultadosP[bloque.filasGuias[bloque.filasGuias.length - 1]][0] = "► Resumen: " + textoEsperando;
  });

  filasDuplicadasPreforma.forEach(fila => {
      if (puedePisar(resultadosP[fila][0], "⚠️ PEDIMENTO REPETIDO")) {
          resultadosP[fila][0] = "⚠️ PEDIMENTO REPETIDO";
          coloresP[fila][0] = "#ffc107";
      }
  });

  // El rojo va al final: pisa tanto el azul del pedimento como el color de
  // bloque de las guías, para que un repetido nunca pase desapercibido.
  if (COLOREAR_PEDIMENTO_Y_DUP_EN_O) {
      filasDuplicadasPreforma.forEach(fila => { coloresColumnaO[fila][0] = COLOR_A_DUPLICADO; });

      // Misma lógica que en A/B: la O pinta SIEMPRE las dos guías de la pareja,
      // y la P gradúa el aviso (gris si es el mismo pedimento, naranja si son
      // distintos, con la primera marcada también).
      let repesPreforma = new Map();
      repetidasPreforma.forEach((previa, fila) => {
          let pedDeEsta = pedimentoDeFilaPreforma(bloquesPreforma, fila);
          let dupLocal = duplicadoLocal(previa, pedDeEsta);

          coloresColumnaO[fila][0] = COLOR_A_DUPLICADO;
          coloresColumnaO[previa.idx][0] = COLOR_A_DUPLICADO;

          escribirAvisoPreforma(resultadosP, coloresP, fila,
                                dupLocal.texto.replace("DUPLICADO", "GUÍA REPETIDA"), dupLocal.color);
          if (dupLocal.marcarPrimera) anotarRepeticion(repesPreforma, previa.idx, fila + 1);
      });

      repesPreforma.forEach((info, idx) => {
          escribirAvisoPreforma(resultadosP, coloresP, idx,
                                textoPrimeraDuplicada(info).replace("DUPLICADO", "GUÍA REPETIDA"), "#ff9800");
      });
  }

  if (!esHojaMSLocal && !esRezago) {
      registroMS.forEach((guiasSet, pedimento) => {
          if (!mapaPreformas[pedimento]) mapaPreformas[pedimento] = new Set();
          guiasSet.forEach(g => {
              mapaPreformas[pedimento].add(g);
              mapaInversoPreforma.set(g, pedimento);
          });
      });
  }

  let resultadosB = []; let resultadosHoras = []; let coloresB = [];
  for (let i = 0; i < ultimaFila; i++) {
    let valB = String(datosMasivos[i][0]).trim();
    let estB = String(datosMasivos[i][1]).trim();
    let esErrEstructura = estB.startsWith("🛑 ERROR");
    let esMovido = esEstadoSalida(estB);
    let dup = dupExternos.get(i);

    let fijo = '';
    let color = '#FFFFFF';
    // valB es la columna A. Si está vacía, la fila queda reseteada del todo:
    // sin estado fijo, sin hora, sin color. Borrar A limpia la fila completa.
    if (valB === "") {
        // fila vacía: se deja todo en blanco
    } else if (esErrEstructura) { fijo = estB; color = '#ffc107'; }
    else if (dup) { fijo = "⛔ DUPLICADO (En: " + dup.hoja + " Fila " + dup.fila + ")"; color = '#ff9800'; }
    else if (esMovido) { fijo = estB; color = '#e0e0e0'; }

    resultadosB.push([fijo]);
    resultadosHoras.push([horaPreservada(datosMasivos, i, 11, valB, horaActual)]);
    coloresB.push([color]);
  }

  let guiasGlobales = new Set(); let totalPedimentos = 0; let escaneadasEnA = new Set();

  for (let i = 0; i < ultimaFila; i++) {
     let v = String(datosMasivos[i][0]).trim().toUpperCase();
     if (v === "") continue;
     if (/^\d{7}$/.test(v)) continue;
     if (!esGuiaUPSValida(v)) continue;
     escaneadasEnA.add(v); guiasGlobales.add(v);
  }

  let bloquesFisicos = []; let pedimentosVistosFisico = new Set(); let filasDuplicadasFisico = new Set();
  let bAAct = null;

  for (let i = 0; i < ultimaFila; i++) {
      let v = String(datosMasivos[i][0]).trim().toUpperCase(); if (v === "") continue;
      let esErr = resultadosB[i][0] !== '';

      if (esCabeceraBloque(v)) {
          // "SIN PEDIMENTO" y demás marcadores abren bloque pero no son pedimentos:
          // no se cuentan ni pueden salir como "PEDIMENTO REPETIDO".
          let esPedimento = /^\d{7}$/.test(v);
          if (esPedimento) {
              if (!esErr) totalPedimentos++;
              if (pedimentosVistosFisico.has(v)) filasDuplicadasFisico.add(i); else pedimentosVistosFisico.add(v);
          }
          if (bAAct) bloquesFisicos.push(bAAct);
          bAAct = { pedimento: v, filaPedimento: i, guias: [], filasGuias: [], esErr: esErr, conAlerta: 0 };
      } else {
          // Una fila con alerta (duplicado, error, guía inválida) NO entra en el
          // bloque, así que no cuenta como bulto. Pero sí se cuenta aparte: si
          // no, un pedimento cuya única guía está duplicada parecía vacío y el
          // resumen decía "Esperando guías" con la guía ahí delante.
          if (esErr) {
              if (bAAct) bAAct.conAlerta++;
          } else if (!esGuiaUPSValida(v)) {
              resultadosB[i][0] = "❌ Guía Inválida"; coloresB[i][0] = "#df5f6b";
              if (bAAct) bAAct.conAlerta++;
          } else {
              if (bAAct) { bAAct.guias.push(v); bAAct.filasGuias.push(i); }
              else { bAAct = { pedimento: "SIN_CABECERA", filaPedimento: -1, guias: [v], filasGuias: [i], esErr: false, conAlerta: 0 }; }
          }
      }
  }
  if (bAAct) bloquesFisicos.push(bAAct);

  // Una sola estructura: guía -> { ped, idx } de su PRIMERA aparición. Antes
  // había dos (un Set y un Map) que se llenaban a la vez, y el Set tapaba
  // siempre al Map: por eso el mensaje con el pedimento nunca salía.
  let primeraAparicion = new Map();
  let repeticiones = new Map();          // idx de la primera -> { veces, fila }
  let filasParejaDuplicada = new Set();  // las DOS filas de cada pareja, para el rojo de la columna A
  let pedimentosCompletos = new Set(); let guiasFaltantesMap = new Map();

  for (let ped in mapaPreformas) {
      let faltantesArr = [];
      mapaPreformas[ped].forEach(g => { if (!escaneadasEnA.has(g)) faltantesArr.push(g); });
      guiasFaltantesMap.set(ped, faltantesArr);
      if (faltantesArr.length === 0 && mapaPreformas[ped].size > 0) pedimentosCompletos.add(ped);
  }

  bloquesFisicos.forEach(bloque => {
      let ped = bloque.pedimento;
      let esperadas = mapaPreformas[ped] || new Set();
      let sobran = 0; let escaneadasUnicas = new Set();
      // M-S donde estas guías fueron escaneadas de verdad, según el caché.
      let origenesReales = new Set();

      let txtFalta = "";
      if (requiereAlertaMS) {
          // Ya no se adivina si "debería" haber pasado por T1 o por GLOBALES:
          // no hay nada en la guía que lo indique.
          txtFalta = " ⚠️ Sin registrar en M-S";
      }

      bloque.guias.forEach((g, idx) => {
          let filaG = bloque.filasGuias[idx];
          let origen = guiasEnMS.get(g);
          let pedReal = mapaInversoPreforma.get(g);

          let previa = primeraAparicion.get(g);
          if (previa) {
              let dupLocal = duplicadoLocal(previa, ped);
              resultadosB[filaG][0] = dupLocal.texto;
              coloresB[filaG][0] = dupLocal.color;
              // En la columna A se pintan las dos siempre, aunque el aviso de
              // la B sea el discreto y la primera conserve su "✅ Ok".
              filasParejaDuplicada.add(filaG); filasParejaDuplicada.add(previa.idx);
              if (dupLocal.marcarPrimera) anotarRepeticion(repeticiones, previa.idx, filaG + 1);
          }
          else {
              primeraAparicion.set(g, { ped: ped, idx: filaG }); escaneadasUnicas.add(g);
              if (origen) origenesReales.add(origen);

              if (esRezago) {
                  if (pedReal) {
                      resultadosB[filaG][0] = pedimentosCompletos.has(pedReal) ? "✅ Recuperado (Ped: " + pedReal + ") | 🌟 COMPLETO" : "✅ Recuperado (Ped: " + pedReal + ")";
                      coloresB[filaG][0] = "#07c369";
                  } else {
                      let infoOtro = guiasRezagoGlobal.get(g);
                      if (infoOtro && infoOtro.hoja !== nombreHoja) { resultadosB[filaG][0] = "❌ Va en: " + infoOtro.hoja + " (Ped: " + infoOtro.pedimento + ")"; coloresB[filaG][0] = "#f5c6cb"; }
                      else { resultadosB[filaG][0] = "⚠️ Ajena (No es de rezago)"; coloresB[filaG][0] = "#df5f6b"; }
                  }
              } else {
                  if (esperadas.size === 0) {
                      // El pedimento de este bloque no tiene preforma, pero la
                      // guía sí puede pertenecer a OTRO pedimento que sí la
                      // tenga. Antes esto se cortaba aquí y salía "✅ Guía" tan
                      // tranquilo, tapando que la guía estaba en el bloque
                      // equivocado: el aviso solo aparecía si el pedimento
                      // escaneado tenía preforma propia.
                      if (pedReal && pedReal !== ped) {
                          resultadosB[filaG][0] = "❌ Va en: " + pedReal;
                          coloresB[filaG][0] = "#f5c6cb";
                          sobran++;
                      } else {
                          resultadosB[filaG][0] = "✅ Guía" + (origen ? " (Escaneado en " + origen + ")" : "");
                          coloresB[filaG][0] = (!origen && requiereAlertaMS) ? "#ffc107" : "#71b3e6";
                      }
                  } else if (esperadas.has(g)) {
                      resultadosB[filaG][0] = "✅ Ok" + (origen ? " (Escaneado en " + origen + ")" : "");
                      coloresB[filaG][0] = "#07c369";
                  } else {
                      if (pedReal) { resultadosB[filaG][0] = "❌ Va en: " + pedReal; coloresB[filaG][0] = "#f5c6cb"; }
                      else { resultadosB[filaG][0] = "⚠️ Sobra (Ajena)" + (origen ? " (Escaneado en " + origen + ")" : txtFalta); coloresB[filaG][0] = "#df5f6b"; }
                      sobran++;
                  }
              }
          }
      });

      if (!bloque.esErr && ped !== "SIN_CABECERA" && !esRezago) {
          let estadoStr = "";

          let nota = notaConAlerta(bloque.conAlerta);

          if (esperadas.size === 0) {
              if (escaneadasUnicas.size === 0) {
                  // Con guías abajo pero todas con alerta, decir "No en
                  // preforma" despista: lo que pasa es que no cuentan.
                  estadoStr = nota !== "" ? nota : "⚠️ No en preforma";
                  coloresB[bloque.filaPedimento][0] = "#FFF3CD";
              } else {
                  let registradoEnMS = true;
                  bloque.guias.forEach(g => { if (!guiasEnMS.has(g)) registradoEnMS = false; });

                  if (!registradoEnMS && requiereAlertaMS) {
                      estadoStr = txtFalta.trim();
                      coloresB[bloque.filaPedimento][0] = "#ffc107";
                  } else {
                      // Se informa la M-S real por la que pasó, tomada del
                      // caché, en vez de deducirla del formato de las guías.
                      if (nombreHoja.indexOf("A1") !== -1) estadoStr = "✅ A1 COMPLETO";
                      else if (origenesReales.size > 0) estadoStr = "✅ " + Array.from(origenesReales).sort().join(" + ");
                      else estadoStr = "✅ Escaneado";
                      coloresB[bloque.filaPedimento][0] = "#178ccc";
                  }
              }
          } else {
              let faltantesArr = guiasFaltantesMap.get(ped) || [];
              let faltan = faltantesArr.length;
              if (faltan === 0 && sobran === 0) {
                  // Sin "Esperando guías": el número de bultos ya va delante y
                  // dice lo mismo sin sugerir que no hay nada escaneado.
                  estadoStr = escaneadasUnicas.size === 0 ? nota : "✅ COMPLETO";
                  coloresB[bloque.filaPedimento][0] = escaneadasUnicas.size === 0 ? "#e2e3e5" : "#07c369";
              } else {
                  let det = [];
                  if (faltan > 0) det.push("❌ Faltan " + faltan + " (" + faltantesArr.join(", ") + ")");
                  if (sobran > 0) det.push("⚠️ Sobran " + sobran);
                  estadoStr = det.join(" y "); coloresB[bloque.filaPedimento][0] = "#FFF3CD";
              }
          }
          // Si el bloque tiene filas con alerta, se dice siempre, aunque el
          // estado ya diga otra cosa: explica el descuadre del conteo.
          if (nota !== "" && estadoStr.indexOf("con alerta") === -1) {
              estadoStr = estadoStr === "" ? nota : estadoStr + " | " + nota;
          }
          let txtResumen = "Bultos: " + escaneadasUnicas.size + (estadoStr !== "" ? " | " + estadoStr : "");
          resultadosB[bloque.filaPedimento][0] = txtResumen;

          if (bloque.filasGuias.length > 0) {
              let fUltima = bloque.filasGuias[bloque.filasGuias.length - 1];
              // cabezaEstado() quita la cola anterior. Aquí también hacía falta:
              // en las filas movidas o con error el estado se conserva tal cual
              // venía de la hoja (fijo = estB), cola incluida, y se le colgaba
              // otro resumen detrás en cada recálculo. La celda crecía sin fin.
              resultadosB[fUltima][0] = cabezaEstado(resultadosB[fUltima][0])
                  .replace(/ \(Escaneado en .*?\)/g, "") + SEP_RESUMEN + txtResumen;
          }
      }
  });

  // Se pintan las DOS guías de la pareja, no solo la repetida. Va después de
  // los resúmenes de bloque para no pisarlos: si esta fila era la última del
  // bloque y arrastra el "► Bultos: ...", esa cola se conserva.
  repeticiones.forEach((info, idx) => {
      resultadosB[idx][0] = textoPrimeraDuplicada(info) + colaResumen(resultadosB[idx][0]);
      coloresB[idx][0] = "#ff9800";
  });

  filasDuplicadasFisico.forEach(fila => {
      if (!resultadosB[fila][0].startsWith("⛔")) {
          resultadosB[fila][0] = "🛑 PEDIMENTO REPETIDO";
          coloresB[fila][0] = "#dc3545";
      }
  });

  // El mismo pedimento en otra pestaña del mismo tipo. Va después del repetido
  // dentro de la propia hoja, que es el aviso que manda si se dan los dos.
  marcarPedimentosRepetidosFuera(resultadosB, coloresB,
      calcularPedimentosDuplicadosExternos(datosMasivos, ultimaFila, nombreHoja, cacheInfo));

  if (esRezago) {
      bloquesPreforma.forEach(bloque => {
        if (bloque.pedimento !== "" && bloque.pedimento !== "SIN_CABECERA" && !bloque.esErr) {
          if (pedimentosCompletos.has(bloque.pedimento)) {
            resultadosP[bloque.filaPedimento][0] = "✅ REZAGO COMPLETO"; coloresP[bloque.filaPedimento][0] = "#07c369";
          } else {
            let faltantesArr = guiasFaltantesMap.get(bloque.pedimento) || [];
            resultadosP[bloque.filaPedimento][0] = faltantesArr.length > 0
                ? "⏳ Faltan " + faltantesArr.length + " (" + faltantesArr.join(", ") + ")"
                : "⏳ Faltan 0 bultos";
            coloresP[bloque.filaPedimento][0] = "#FFF3CD";
          }
        }
      });
      totalPedimentos = pedimentosCompletos.size;
  }

  let coloresA = coloresDeColumnaA(datosMasivos, resultadosB, ultimaFila, filasParejaDuplicada);
  // Una alerta grave no se cae sola: si lo recalculado es menos grave que
  // lo que ya había, se conserva lo que había. Ver conservarAlertasGraves.
  conservarAlertasGraves(datosMasivos, resultadosB, coloresB, ultimaFila, repintarTodo, filasEditadas, 0, 1);
  conservarAlertasGraves(datosMasivos, resultadosP, coloresP, ultimaFila, repintarTodo, filasEditadas, 14, 15);

  aplicarCambiosOptimizado(hoja, 2, 12, 1, 11, resultadosB, resultadosHoras, datosMasivos, coloresB, null, null, coloresA, repintarTodo);
  aplicarCambiosOptimizado(hoja, 16, 19, 15, 18, resultadosP, resultadosHorasP, datosMasivos, coloresP, null, null, null, repintarTodo);

  // Columna O: solo se toca si la edición afectó a la preforma. Un escaneo en
  // la columna A no puede cambiar estos colores, así que en el caso normal nos
  // ahorramos una lectura y una escritura de columna completa.
  if (tocoPreforma) {
      // "Forzar Actualización" repinta sin preguntar: se salta la lectura de
      // comparación, que ahí solo sería una llamada de más.
      let bgODistinto = repintarTodo === true;
      if (!bgODistinto) {
          let bgOActual = perf("leer fondos de la columna O", ultimaFila, () =>
              hoja.getRange(1, 15, ultimaFila, 1).getBackgrounds());
          for (let i = 0; i < ultimaFila; i++) {
              if (String(bgOActual[i][0]).toLowerCase() !== String(coloresColumnaO[i][0]).toLowerCase()) { bgODistinto = true; break; }
          }
      }
      if (bgODistinto) perf("color de la columna O", ultimaFila, () =>
          hoja.getRange(1, 15, ultimaFila, 1).setBackgrounds(coloresColumnaO));
  }

  // C1:C3 y Q1:Q2 ya vienen dentro de datosMasivos (columnas 3 y 17): se
  // comparan desde memoria y solo se escribe si cambiaron. Antes eran dos
  // lecturas extra a la API en cada escaneo.
  let textoPedimentosTop = esRezago ? "Pedimentos (Completos): " : "Total pedimentos: ";
  let cAct = i => (ultimaFila > i && datosMasivos[i]) ? String(datosMasivos[i][2]) : "";
  let c1c3Nuevo = [ ["Total bultos: " + guiasGlobales.size], [textoPedimentosTop + totalPedimentos], [""] ];
  if (cAct(0) !== c1c3Nuevo[0][0] || cAct(1) !== c1c3Nuevo[1][0])
      perf("totales C1:C3", 3, () => hoja.getRange("C1:C3").setValues(c1c3Nuevo));

  let qAct = i => (ultimaFila > i && datosMasivos[i]) ? String(datosMasivos[i][16]) : "";
  let q1q2Nuevo = [ ["Bultos (Preforma): " + totalBultosPreforma], ["Pedimentos (Preforma): " + totalPedimentosPreforma] ];
  if (qAct(0) !== q1q2Nuevo[0][0] || qAct(1) !== q1q2Nuevo[1][0])
      perf("totales Q1:Q2", 2, () => hoja.getRange("Q1:Q2").setValues(q1q2Nuevo));

  if (!esRezago) {
      sincronizarSalidasMS(source, cacheInfo, guiasAfectadas);
  }
}

// =========================================================================
// CEREBRO PRINCIPAL: M-S
// =========================================================================
function actualizarMS(hoja, source, cacheInfo, repintarTodo, filaFinalSugerida, filasEditadas) {
  const ultimaFila = filaFinalSugerida > 0
      ? filaFinalSugerida
      : perf("getLastRow (M-S/inventario)", 0, () => Math.max(hoja.getLastRow(), 1));
  if (ultimaFila < 1) return;

  perf("asegurarColumnas", 0, () => asegurarColumnas(hoja, 12));
  const datosMasivos = perf("leer la hoja A:L", ultimaFila * 12, () =>
      hoja.getRange(1, 1, ultimaFila, 12).getValues());
  const horaActual = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "HH:mm:ss");
  const nombreHojaMayus = claveHoja(hoja.getName());

  let dupExternos = calcularDuplicadosExternos(datosMasivos, ultimaFila, nombreHojaMayus, cacheInfo);

  let resultadosB = []; let resultadosHoras = []; let coloresB = [];
  let fontLinesA = []; let fontColorsA = [];

  for (let i = 0; i < ultimaFila; i++) {
    let valB = String(datosMasivos[i][0]).trim();
    let estB = String(datosMasivos[i][1]).trim();
    // valB es la columna A vacía => fila reseteada del todo (sin estado fijo,
    // sin tachado ni color de fuente). Los marcadores solo valen con dato en A.
    let vacia = valB === "";
    let esErrEstructura = !vacia && estB.startsWith("🛑 ERROR");
    let esMovido = !vacia && esEstadoSalida(estB);
    let dup = vacia ? null : dupExternos.get(i);

    let fijo = '';
    let color = '#FFFFFF';
    if (esErrEstructura) { fijo = estB; color = '#ffc107'; }
    else if (esMovido) { fijo = estB; color = '#e0e0e0'; }
    else if (dup) { fijo = "⛔ DUPLICADO (En: " + dup.hoja + " Fila " + dup.fila + ")"; color = '#ff9800'; }

    resultadosB.push([fijo]);
    resultadosHoras.push([horaPreservada(datosMasivos, i, 11, valB, horaActual)]);
    coloresB.push([color]);
    fontLinesA.push([esMovido ? 'line-through' : 'none']);
    fontColorsA.push([esMovido ? '#9e9e9e' : '#000000']);
  }

  let bloquesFisicos = []; let pedimentosVistosFisico = new Set(); let filasDuplicadasFisico = new Set();
  let bAAct = null; let guiasGlobales = new Set(); let totalPedimentos = 0;

  for (let i = 0; i < ultimaFila; i++) {
      let v = String(datosMasivos[i][0]).trim().toUpperCase(); if (v === "") continue;
      let esErr = resultadosB[i][0] !== '' && !esEstadoSalida(resultadosB[i][0]);

      if (esCabeceraBloque(v)) {
          let esPedimento = /^\d{7}$/.test(v);
          if (esPedimento) {
              if (!esErr) totalPedimentos++;
              if (pedimentosVistosFisico.has(v)) filasDuplicadasFisico.add(i); else pedimentosVistosFisico.add(v);
          }
          if (bAAct) bloquesFisicos.push(bAAct);
          bAAct = { pedimento: v, filaPedimento: i, guias: [], filasGuias: [], esErr: esErr, conAlerta: 0 };
      } else {
          if (esErr) {
              if (bAAct) bAAct.conAlerta++;
          } else if (!esGuiaUPSValida(v)) {
              resultadosB[i][0] = "❌ Guía Inválida"; coloresB[i][0] = "#df5f6b";
              if (bAAct) bAAct.conAlerta++;
          } else {
              guiasGlobales.add(v);
              if (bAAct) { bAAct.guias.push(v); bAAct.filasGuias.push(i); }
              else { bAAct = { pedimento: "SIN_CABECERA", filaPedimento: -1, guias: [v], filasGuias: [i], esErr: false, conAlerta: 0 }; }
          }
      }
  }
  if (bAAct) bloquesFisicos.push(bAAct);

  let primeraAparicion = new Map();      // guía -> { ped, idx } de la 1ª vez
  let repeticiones = new Map();          // idx de la 1ª -> { veces, fila }
  let filasParejaDuplicada = new Set();  // las DOS filas de cada pareja
  let totalMovidas = 0;
  let totalPedimentosTipo = 0;

  // El tipo lo da la pestaña en la que el operador decidió meter el pedimento.
  const tipoStr = tipoMS(nombreHojaMayus);

  bloquesFisicos.forEach(bloque => {
      let guiasUnicas = new Set();
      let movidas = 0;

      bloque.guias.forEach((g, idx) => {
          let filaG = bloque.filasGuias[idx];
          let statusActual = resultadosB[filaG][0];

          // El duplicado se evalúa SIEMPRE, también en las guías ya movidas:
          // antes "➡ Salió en ..." entraba primero y la repetición no se
          // llegaba a mirar, así que la alerta no volvía a salir nunca.
          let movida = esEstadoSalida(statusActual);
          if (movida) { movidas++; totalMovidas++; }

          if (movida && !primeraAparicion.has(g)) {
              primeraAparicion.set(g, { ped: bloque.pedimento, idx: filaG });
              guiasUnicas.add(g);
          } else {
              let previa = primeraAparicion.get(g);
              if (previa) {
                  let dupLocal = duplicadoLocal(previa, bloque.pedimento);
                  resultadosB[filaG][0] = dupLocal.texto;
                  coloresB[filaG][0] = dupLocal.color;
                  filasParejaDuplicada.add(filaG); filasParejaDuplicada.add(previa.idx);
                  if (dupLocal.marcarPrimera) anotarRepeticion(repeticiones, previa.idx, filaG + 1);
              } else {
                  primeraAparicion.set(g, { ped: bloque.pedimento, idx: filaG });
                  guiasUnicas.add(g);
                  resultadosB[filaG][0] = "✅ Guía"; coloresB[filaG][0] = "#71b3e6";
              }
          }
      });

      if (!bloque.esErr && bloque.pedimento !== "SIN_CABECERA") {
          let faltantes = guiasUnicas.size - movidas;
          let msg = "";
          totalPedimentosTipo++;

          let nota = notaConAlerta(bloque.conAlerta);
          let base = "Bultos: " + guiasUnicas.size + " (" + tipoStr + ")";

          if (guiasUnicas.size === 0) {
              msg = base;
              coloresB[bloque.filaPedimento][0] = nota !== "" ? "#ffc107" : "#e2e3e5";
          } else if (faltantes === 0) {
              msg = base + " | ✅ TODO SALIÓ";
              coloresB[bloque.filaPedimento][0] = "#07c369";
          } else {
              msg = base + " | ⚠️ Faltan " + faltantes + " por mover";
              coloresB[bloque.filaPedimento][0] = "#ffc107";
          }
          if (nota !== "") msg += " | " + nota;

          resultadosB[bloque.filaPedimento][0] = msg;

          if (bloque.filasGuias.length > 0 && msg !== "") {
              let filaUltimaGuia = bloque.filasGuias[bloque.filasGuias.length - 1];
              // cabezaEstado() quita la cola ANTERIOR antes de pegar la nueva.
              // Sin eso el resumen se acumulaba: la celda de una guía movida
              // llega con su cola ya puesta desde la pasada anterior (fijo =
              // estB la conserva), y se le colgaba otra detrás cada vez.
              let textoLimpio = cabezaEstado(resultadosB[filaUltimaGuia][0])
                  .replace(/ \(Escaneado en .*?\)/g, "")
                  .replace(/ ⚠️ Sin escaneo de .*/g, "");
              resultadosB[filaUltimaGuia][0] = textoLimpio + SEP_RESUMEN + msg;
          }
      }
  });

  // También aquí se pinta la primera de la pareja, conservando la cola del
  // resumen si esa fila era la última del bloque.
  repeticiones.forEach((info, idx) => {
      resultadosB[idx][0] = textoPrimeraDuplicada(info) + colaResumen(resultadosB[idx][0]);
      coloresB[idx][0] = "#ff9800";
  });

  filasDuplicadasFisico.forEach(fila => {
      if (!resultadosB[fila][0].startsWith("⛔")) {
          resultadosB[fila][0] = "🛑 PEDIMENTO REPETIDO";
          coloresB[fila][0] = "#dc3545";
      }
  });

  marcarPedimentosRepetidosFuera(resultadosB, coloresB,
      calcularPedimentosDuplicadosExternos(datosMasivos, ultimaFila, nombreHojaMayus, cacheInfo));

  // Una alerta grave no se cae sola: si lo recalculado es menos grave que
  // lo que ya había, se conserva lo que había. Ver conservarAlertasGraves.
  conservarAlertasGraves(datosMasivos, resultadosB, coloresB, ultimaFila, repintarTodo, filasEditadas, 0, 1);

  aplicarCambiosOptimizado(hoja, 2, 12, 1, 11, resultadosB, resultadosHoras, datosMasivos, coloresB, fontLinesA, fontColorsA,
                           coloresDeColumnaA(datosMasivos, resultadosB, ultimaFila, filasParejaDuplicada), repintarTodo);

  let fila3Resumen = tipoStr + ": " + totalPedimentosTipo;

  // El total incluye las guías ya movidas; se desglosa para no perder el dato
  // de cuántas siguen en piso.
  let textoBultos = "Total bultos: " + guiasGlobales.size;
  if (totalMovidas > 0) textoBultos += " (salieron: " + totalMovidas + " | en piso: " + (guiasGlobales.size - totalMovidas) + ")";

  // C1:C3 ya está dentro de datosMasivos (columna 3): sin lectura extra.
  let nuevosResumenes = [ [textoBultos], ["Total pedimentos: " + totalPedimentos], [fila3Resumen] ];
  let cAct = i => (ultimaFila > i && datosMasivos[i]) ? String(datosMasivos[i][2]) : "";
  if (cAct(0) !== nuevosResumenes[0][0] ||
      cAct(1) !== nuevosResumenes[1][0] ||
      cAct(2) !== nuevosResumenes[2][0]) {
      hoja.getRange("C1:C3").setValues(nuevosResumenes);
  }
}

// =========================================================================
// CEREBRO PRINCIPAL: INVENTARIOS
//
// Los inventarios forman un dominio cerrado: se cruzan SOLO entre pestañas de
// inventario. Lo que esté en Globales, M-S o Rezago no genera ninguna
// alerta aquí. Dentro del dominio sí se detecta:
//   · misma guía en dos pestañas de inventario distintas
//   · misma guía en dos ubicaciones IW distintas de la misma pestaña
//   · misma guía repetida dentro de la misma ubicación (duplicado local)
// =========================================================================
function actualizarInventario(hoja, cacheInfo, repintarTodo, filaFinalSugerida, filasEditadas) {
  const ultimaFila = filaFinalSugerida > 0
      ? filaFinalSugerida
      : perf("getLastRow (M-S/inventario)", 0, () => Math.max(hoja.getLastRow(), 1));
  asegurarColumnas(hoja, 12);

  const datosMasivos = perf("leer la hoja A:L", ultimaFila * 12, () =>
      hoja.getRange(1, 1, ultimaFila, 12).getValues());
  const horaActual = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "HH:mm:ss");
  const claveEsta = claveHoja(hoja.getName());

  // Ubicación IW vigente en cada fila, para poder nombrarla en los mensajes.
  let ubicacionPorFila = [];
  let ubActual = "";
  for (let i = 0; i < ultimaFila; i++) {
      let v = String(datosMasivos[i][0]).trim().toUpperCase();
      if (v.startsWith("IW")) ubActual = v;
      ubicacionPorFila.push(ubActual);
  }

  // Duplicados dentro del dominio inventario, recalculados desde el caché.
  let dupInventario = new Map();
  if (cacheInfo && cacheInfo.map) {
      for (let i = 0; i < ultimaFila; i++) {
          let v = String(datosMasivos[i][0]).trim().toUpperCase();
          if (v === "" || v.startsWith("IW") || esCabeceraBloque(v)) continue;

          let matches = cacheInfo.map.get(v);
          if (!matches) continue;

          for (let m = 0; m < matches.length; m++) {
              let match = matches[m];
              if (!match.isInventario) continue;                            // ignora Global / M-S
              if (match.hoja === claveEsta && match.fila === i) continue;    // la propia fila

              if (match.hoja === claveEsta) {
                  let otraUb = ubicacionPorFila[match.fila];
                  // Misma ubicación: eso es un duplicado local, se marca más abajo.
                  if (otraUb === undefined || otraUb === ubicacionPorFila[i]) continue;
                  dupInventario.set(i, "⛔ DUPLICADO (En: " + otraUb + ", fila " + match.fila + ")");
              } else {
                  dupInventario.set(i, "⛔ DUPLICADO (En: " + match.hoja + " Fila " + match.fila + ")");
              }
              break;
          }
      }
  }

  let resultadosB = []; let resultadosHoras = []; let coloresB = [];
  for (let i = 0; i < ultimaFila; i++) {
    let valA = String(datosMasivos[i][0]).trim();
    let estB = String(datosMasivos[i][1]).trim();
    // valA vacía => fila reseteada del todo. Borrar A limpia estado, hora y color.
    let vacia = valA === "";
    let esErrEstructura = !vacia && estB.startsWith("🛑 ERROR");
    let dup = vacia ? null : dupInventario.get(i);

    let fijo = '';
    let color = '#FFFFFF';
    if (esErrEstructura) { fijo = estB; color = '#ffc107'; }
    else if (dup) { fijo = dup; color = '#ff9800'; }

    resultadosB.push([fijo]);
    resultadosHoras.push([horaPreservada(datosMasivos, i, 11, valA, horaActual)]);
    coloresB.push([color]);
  }

  let filaUbicacionActual = -1; let ultimaFilaGuia = -1;
  // Map en vez de Set: hace falta recordar en qué fila quedó la primera para
  // poder señalarla y pintar las dos guías de la pareja.
  let guiasFisicas = new Map(); let totalUbicaciones = 0; let totalBultosInventario = 0;
  let repeticiones = new Map();
  let filasParejaDuplicada = new Set();

  function cerrarUbicacion() {
      if (filaUbicacionActual === -1 || resultadosB[filaUbicacionActual][0] !== '') return;
      let msg = "Bultos: " + guiasFisicas.size;
      totalBultosInventario += guiasFisicas.size;
      resultadosB[filaUbicacionActual][0] = msg;
      coloresB[filaUbicacionActual][0] = "#178ccc";
      if (ultimaFilaGuia !== -1 && ultimaFilaGuia > filaUbicacionActual) {
          resultadosB[ultimaFilaGuia][0] = "✅ Ok" + SEP_RESUMEN + msg;
      }
  }

  for (let i = 0; i < ultimaFila; i++) {
    let valor = String(datosMasivos[i][0]).trim().toUpperCase(); if (valor === "") continue;
    let esErr = resultadosB[i][0] !== '';

    if (valor.startsWith("IW")) {
      cerrarUbicacion();
      if (!esErr) totalUbicaciones++;
      filaUbicacionActual = i; ultimaFilaGuia = -1; guiasFisicas.clear();
    } else if (esErr) {
      // Duplicado entre inventarios o error estructural: ya tiene mensaje fijo.
    } else if (!esGuiaUPSValida(valor)) {
      resultadosB[i][0] = "❌ Guía Inválida"; coloresB[i][0] = "#df5f6b";
    } else if (filaUbicacionActual === -1) {
      // Guía escaneada antes de cualquier ubicación: antes se quedaba SIN
      // estado, y una columna B vacía con dato en A hacía que la red de
      // seguridad tomara la hoja por pendiente en cada pasada.
      resultadosB[i][0] = "⚠️ Falta la ubicación IW arriba"; coloresB[i][0] = "#ffc107";
    } else {
      let previa = guiasFisicas.get(valor);
      if (previa !== undefined) {
          let ubi = String(datosMasivos[filaUbicacionActual][0]).trim().toUpperCase();
          let dupLocal = duplicadoLocal({ ped: ubi, idx: previa }, ubi, "Ubic");
          resultadosB[i][0] = dupLocal.texto;
          coloresB[i][0] = dupLocal.color;
          filasParejaDuplicada.add(i); filasParejaDuplicada.add(previa);
          if (dupLocal.marcarPrimera) anotarRepeticion(repeticiones, previa, i + 1);
      } else {
          guiasFisicas.set(valor, i);
          resultadosB[i][0] = "✅ Ok"; coloresB[i][0] = "#07c369";
          ultimaFilaGuia = i;
      }
    }
  }
  cerrarUbicacion();

  repeticiones.forEach((info, idx) => {
      resultadosB[idx][0] = textoPrimeraDuplicada(info) + colaResumen(resultadosB[idx][0]);
      coloresB[idx][0] = "#ff9800";
  });

  // Una alerta grave no se cae sola: si lo recalculado es menos grave que
  // lo que ya había, se conserva lo que había. Ver conservarAlertasGraves.
  conservarAlertasGraves(datosMasivos, resultadosB, coloresB, ultimaFila, repintarTodo, filasEditadas, 0, 1);

  aplicarCambiosOptimizado(hoja, 2, 12, 1, 11, resultadosB, resultadosHoras, datosMasivos, coloresB, null, null,
                           coloresDeColumnaA(datosMasivos, resultadosB, ultimaFila, filasParejaDuplicada), repintarTodo);

  // C1:C3 ya está dentro de datosMasivos (columna 3): sin lectura extra.
  let c1c3Nuevo = [ ["Total bultos: " + totalBultosInventario], ["Ubicaciones (IW): " + totalUbicaciones], [""] ];
  let cAct = i => (ultimaFila > i && datosMasivos[i]) ? String(datosMasivos[i][2]) : "";
  if (cAct(0) !== c1c3Nuevo[0][0] || cAct(1) !== c1c3Nuevo[1][0]) {
      hoja.getRange("C1:C3").setValues(c1c3Nuevo);
  }
}

// =========================================================================
// MENÚ
// =========================================================================
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('📦 Opciones Avanzadas')
    // Arriba, suelto, lo del día a día. Todo lo demás en submenús: son cosas de
    // mantenimiento o de configuración, y tenerlas a la vista hacía un menú
    // larguísimo donde costaba encontrar las dos que se usan a diario.
    .addItem('📋 Agrupar Guías por Pedimento (Col A)', 'agruparPorPedimento')
    .addItem('🧹 Limpiar guías movidas (Rango seleccionado)', 'limpiarGuiasMovidasSeleccion')
    .addItem('🔄 Forzar Actualización de esta pestaña', 'forzarActualizacionHojaActiva')
    .addSeparator()

    .addSubMenu(ui.createMenu('🔍 Revisar')
        .addItem('¿Por qué esta guía sale así?', 'diagnosticarGuia')
        .addItem('Diagnóstico del sistema', 'diagnosticoSistema')
        .addItem('Medir velocidad de escaneo', 'medirRendimiento')
        .addItem('Prueba: ¿qué cuesta abrir el caché?', 'probarCosteCache'))

    .addSubMenu(ui.createMenu('🌙 Cierre y limpieza')
        .addItem('Cierre del día (historial + caché)', 'cierreDelDia')
        .addSeparator()
        .addItem('Vaciar historial de borrados ahora', 'limpiarHistorialAhora')
        .addItem('Vaciarlo solo cada día', 'instalarLimpiezaHistorial')
        .addItem('Dejar de vaciarlo solo', 'quitarLimpiezaHistorial'))

    .addSubMenu(ui.createMenu('⚙️ Disparadores')
        .addItem('Trigger avanzado (6 min, sin usuario)', 'instalarTriggerAvanzado')
        .addItem('Trigger simple + usuario en el historial', 'instalarTriggerConUsuario')
        .addSeparator()
        .addItem('Quitar los disparadores', 'desinstalarTriggerAvanzado'))

    .addSubMenu(ui.createMenu('🔧 Mantenimiento')
        .addItem('Reconstruir caché completo', 'RECONSTRUIR_CACHE_TOTAL')
        .addItem('Proteger hojas del sistema', 'protegerHojasSistema'))

    .addToUi();
}

// =========================================================================
// PROTECCIÓN DE LAS HOJAS INTERNAS
//
// Se usa protección de SOLO AVISO a propósito. Una protección normal se
// aplicaría también al script: éste escribe con la autoridad de quien dispara
// la edición, así que un operador que no estuviera en la lista de editores
// haría fallar el setValues y perdería su escaneo. El aviso evita el borrado
// accidental sin bloquear a nadie.
// =========================================================================
const DESC_PROTECCION = "Hoja interna del motor de escaneos — no editar a mano";

function protegerHojasSistema() {
  conLock(ss => {
    let protegidas = [];

    ss.getSheets().forEach(hoja => {
      if (!esHojaInterna(hoja.getName())) return;

      // Se retira la protección anterior de este script para no acumular.
      hoja.getProtections(SpreadsheetApp.ProtectionType.SHEET).forEach(p => {
          if (p.getDescription() === DESC_PROTECCION) p.remove();
      });

      hoja.protect().setDescription(DESC_PROTECCION).setWarningOnly(true);
      protegidas.push(hoja.getName());
    });

    if (protegidas.length === 0) {
        ss.toast('No se encontraron hojas internas que proteger.', 'Sin cambios', 5);
        return;
    }
    ss.toast('🔒 Protegidas (solo aviso): ' + protegidas.join(', ') +
             '. El script sigue escribiendo con normalidad.', 'Listo', 8);
  });
}

// =========================================================================
// MEDICIÓN DE RENDIMIENTO
//
// Todos los escaneos del archivo se serializan con el mismo lock de documento,
// así que el techo de throughput NO depende de cuántos operadores haya: es
// 1 / (tiempo por escaneo), repartido entre todos. Esta función mide ese tiempo
// sobre la pestaña activa y traduce el número a escaneos por minuto.
// =========================================================================
function medirRendimiento() {
  const ss = obtenerArchivo();
  const ui = SpreadsheetApp.getUi();
  const hoja = ss.getActiveSheet();
  const nombre = claveHoja(hoja.getName());

  if (esHojaSistema(nombre)) {
    ui.alert("⏱️ Medición", "Esta pestaña es del sistema. Colócate en una hoja de escaneo.", ui.ButtonSet.OK);
    return;
  }

  let L = [];
  let lr = hoja.getLastRow();
  let anchoLeido = esHojaPrincipal(nombre) ? 19 : 12;

  L.push("Pestaña: " + nombre);
  L.push("Filas con datos: " + lr + "  ·  celdas leídas por recálculo: " + (lr * anchoLeido).toLocaleString());

  // ── Peso del archivo ────────────────────────────────────────────────────
  // Coste de UNA llamada trivial a la API. Si esto ya es alto, el problema no
  // es el script: es que el documento pesa y cada ida y vuelta se arrastra.
  let t0 = Date.now();
  for (let k = 0; k < 3; k++) hoja.getRange(1, 1).getValue();
  let msPorLlamada = Math.round((Date.now() - t0) / 3);

  let celdasTotales = 0;
  ss.getSheets().forEach(h => { celdasTotales += h.getMaxRows() * h.getMaxColumns(); });

  L.push("");
  L.push("── PESO DEL ARCHIVO ──");
  L.push("Celdas totales del archivo: " + celdasTotales.toLocaleString() +
         "  (usadas de verdad: " + (lr * anchoLeido).toLocaleString() + ")");
  L.push("Coste de UNA llamada a la API: ~" + msPorLlamada + " ms");
  if (msPorLlamada > 250) {
      L.push("🔴 Muy alto. En un archivo ligero son 30-80 ms. El cuello de botella");
      L.push("   es el peso del documento, no el script. Ver recomendación abajo.");
  } else if (msPorLlamada > 120) {
      L.push("🟡 Alto. Conviene aligerar el archivo.");
  } else {
      L.push("✅ Normal.");
  }
  L.push("");

  // 1. Carga del caché en frío (lo que paga el primer escaneo tras una pausa).
  invalidarCacheRAM();
  perfIniciar();
  t0 = Date.now();
  let cacheInfo = getCacheData(ss);
  let tCache = Date.now() - t0;
  let perfCache = perfFin();
  L.push("── DESGLOSE ──");
  L.push("Cargar caché (en CADA escaneo): " + tCache + " ms" +
         (cacheInfo ? "  ·  " + cacheInfo.map.size + " guías indexadas" : "  ·  SIN CACHÉ"));

  // 2. Recálculo completo de la hoja: es el grueso de cada escaneo.
  // 2. Un escaneo de verdad: el recálculo YA arrastra dentro la sincronización
  //    de M-S, así que medirlas por separado y sumarlas contaba ese barrido dos
  //    veces e inflaba el resultado. Y se le pasa una guía real de la hoja,
  //    porque con el conjunto vacío el filtro se desactiva y se abren TODAS las
  //    M-S: eso es el peor caso, no un escaneo normal.
  let guiaMuestra = null;
  if (lr > 0) {
    let colA = hoja.getRange(1, 1, lr, 1).getValues();
    for (let i = lr - 1; i >= 0 && !guiaMuestra; i--) {
      let v = String(colA[i][0]).trim().toUpperCase();
      if (v !== "" && esGuiaUPSValida(v)) guiaMuestra = v;
    }
  }
  let guiasAfectadas = guiaMuestra ? new Set([guiaMuestra]) : new Set();

  // Se le pasa la fila final sacada del caché, igual que hace un escaneo de
  // verdad. Sin ella se llamaba al getLastRow, y por eso seguía apareciendo en
  // el desglose con 100-300 ms una llamada que el escaneo ya no paga: se
  // estaba midiendo el camino del menú y presentándolo como el del operador.
  let filaSugerida = filaFinalDesdeCache(cacheInfo, nombre, lr);

  perfIniciar();
  t0 = Date.now();
  recalcularHoja(hoja, ss, cacheInfo, guiasAfectadas, false, false, filaSugerida);
  let tEscaneo = Date.now() - t0;
  let perfEscaneo = perfFin();
  L.push("Recalcular la hoja:          " + tEscaneo + " ms" +
         (guiaMuestra ? "  (probando con una guía real de la hoja)" : ""));
  if (!guiaMuestra) {
      // Sin guía de muestra el filtro de M-S se desactiva y se abren TODAS.
      // Eso multiplica el tiempo, y el aviso de antes —un discreto «(hoja
      // vacía)»— era demasiado fácil de pasar por alto: se leía el número como
      // si fuera el de un escaneo normal cuando es el peor caso posible.
      L.push("   ⚠️ LA COLUMNA A ESTÁ VACÍA. Esto NO es un escaneo normal: es el");
      L.push("      PEOR CASO. Sin una guía que filtrar se abren TODAS las M-S,");
      L.push("      y abrir cada pestaña en frío cuesta cientos de ms.");
      L.push("      Escanea algo en la columna A y vuelve a medir.");
  }

  // 3. Barrido completo de M-S: no pasa en un escaneo normal, solo cuando la
  //    guía toca muchas pestañas o al forzar desde el menú. Se mide aparte y NO
  //    se suma al tiempo por escaneo.
  let tSyncTodo = 0;
  let perfSyncTodo = null;
  if (esHojaPrincipal(nombre) && nombre.indexOf("REZAGO") === -1) {
    perfIniciar();
    t0 = Date.now();
    sincronizarSalidasMS(ss, cacheInfo, new Set());
    tSyncTodo = Date.now() - t0;
    perfSyncTodo = perfFin();
    L.push("Barrido de TODAS las M-S:    " + tSyncTodo + " ms  (peor caso, aparte)");
  }

  // Dónde se va el tiempo, llamada por llamada. Es lo que decide qué se
  // optimiza después: sin esto solo se puede especular.
  L.push("");
  L.push("── DÓNDE SE VA LA CARGA DEL CACHÉ ──");
  perfLineas(perfCache, tCache).forEach(x => L.push(x));

  L.push("");
  L.push("── DÓNDE SE VA EL ESCANEO ──");
  perfLineas(perfEscaneo, tEscaneo).forEach(x => L.push(x));
  if (perfSyncTodo) {
    L.push("");
    L.push("── DÓNDE SE VA EL BARRIDO COMPLETO ──");
    perfLineas(perfSyncTodo, tSyncTodo).forEach(x => L.push(x));
  }

  // El caché SÍ cuenta: desde que se descarta al empezar cada edición, cada
  // escaneo paga su relectura. Antes se restaba del total con la excusa de que
  // solo se cargaba la primera vez, y eso ya no es cierto.
  let porEscaneo = tCache + tEscaneo;
  let porMinuto = porEscaneo > 0 ? Math.floor(60000 / porEscaneo) : 0;

  // La medición llama a recalcularHoja, nunca a procesarEdicion, así que todo
  // esto queda FUERA de los números de arriba aunque el operador sí lo pague.
  // Se cronometra en seco, sin escribir nada: la herramienta tiene que seguir
  // siendo inocua.
  perfIniciar();
  let t0Ed = Date.now();
  perf("edición: buscar la hoja por nombre", 0, () => buscarHojaPorClave(ss, nombre));
  perf("edición: getMaxColumns", 0, () => hoja.getMaxColumns());
  if (lr > 0) perf("edición: lectura de apoyo", 15, () => hoja.getRange(1, 2, 1, 15).getValues());
  let tEdicion = Date.now() - t0Ed;
  let perfEdicion = perfFin();

  L.push("");
  L.push("── LO QUE PAGA LA EDICIÓN (y no se ve arriba) ──");
  perfLineas(perfEdicion, tEdicion).forEach(x => L.push(x));

  L.push("");
  L.push("── CAPACIDAD ──");
  L.push("Tiempo por escaneo: ~" + (porEscaneo / 1000).toFixed(1) + " s" +
         "   (" + tCache + " ms de caché + " + tEscaneo + " ms de recálculo)");
  L.push("Techo del archivo:  ~" + porMinuto + " escaneos por minuto");
  L.push("Repartido entre 7 operadores: ~" + Math.floor(porMinuto / 7) + " escaneos/min cada uno");
  L.push("");

  if (porEscaneo < 700) {
    L.push("✅ Holgado. Aguanta 7 operadores sin problema.");
  } else if (porEscaneo < 1500) {
    L.push("🟡 Aceptable con pocos operadores. Con 7 en paralelo se notará espera.");
    L.push("   Reduce filas con datos o pide el recálculo incremental.");
  } else {
    L.push("🔴 Lento. Con varios operadores se van a formar colas y saldrá");
    L.push("   «⏳ Pendiente (reintenta)». Hace falta recálculo incremental.");
  }

  L.push("");
  L.push("Nota: todos los operadores comparten el mismo turno (lock del");
  L.push("documento), así que este techo es del archivo entero, no por persona.");

  // Recomendación concreta según dónde esté el cuello de botella.
  if (msPorLlamada > 120) {
      let filasUsadas = Math.max(lr, 50);
      let sugeridas = Math.ceil((filasUsadas + 200) / 100) * 100;
      L.push("");
      L.push("── QUÉ HACER ──");
      L.push("El archivo pesa " + celdasTotales.toLocaleString() + " celdas y solo usas " + lr + " filas.");
      L.push("1. Borra las filas sobrantes de CADA pestaña: deja ~" + sugeridas + ".");
      L.push("2. Revisa el formato condicional: si las reglas cubren columnas");
      L.push("   enteras (A:A, A1:S3000), acótalas al rango que usas.");
      L.push("3. Lo mismo con la validación de datos de la columna M.");
      L.push("Esto suele bajar el coste por llamada de golpe, y con él todo lo demás.");
  }

  ui.alert("⏱️ Velocidad de escaneo", L.join("\n"), ui.ButtonSet.OK);
}

// =========================================================================
// PRUEBA: ¿QUIÉN PAGA EL PRIMER CONTACTO CON CACHE_SISTEMA?
// =========================================================================
// La medición normal dice que leer el caché cuesta ~570 ms en UNA sola
// llamada, cuando una llamada corriente cuesta ~90. Eso no es el volumen de
// datos: leer 96 celdas de una M-S en frío costó 235 ms y esas mismas 96 en
// caliente costaron 3. Lo caro es abrir la pestaña la primera vez.
//
// De ahí sale la idea de guardar el índice fuera de la hoja (CacheService) y
// dejar de abrir CACHE_SISTEMA para leerlo. Pero el escaneo también ESCRIBE en
// esa hoja (actualizarBloqueEnCache), y hoy la lectura va primero, así que es
// ella la que paga el primer toque y la escritura ya llega en caliente. Si se
// quita la lectura, la escritura pasa a ser la primera. La pregunta que decide
// si CacheService ahorra algo o nada es una sola:
//
//     ¿escribir en frío cuesta lo mismo que leer en frío?
//
// Por ejecución solo se puede medir UNA cosa en frío —la primera que toque la
// hoja la calienta para todo lo demás—, y en medirRendimiento la lectura del
// caché siempre llega antes. Por eso esto va aparte y no allí dentro.
//
// No cambia nada del sistema: escribe una celda de usar y tirar y la borra.
function probarCosteCache() {
  const ss = obtenerArchivo();
  const ui = SpreadsheetApp.getUi();

  // Cada paso se cronometra desde el primero, incluidos los que parecen
  // gratis. Si el primer toque lo pagara getMaxColumns en vez de la escritura,
  // el resultado saldría engañosamente barato y no habría forma de saberlo.
  let t0 = Date.now();
  let cacheSheet = ss.getSheetByName("CACHE_SISTEMA");
  let msAbrir = Date.now() - t0;

  if (!cacheSheet) {
    ui.alert("🧪 Prueba del caché",
             "No existe CACHE_SISTEMA. Usa «Reconstruir caché completo» primero.",
             ui.ButtonSet.OK);
    return;
  }

  t0 = Date.now();
  let colScratch = cacheSheet.getMaxColumns();
  let msMaxCols = Date.now() - t0;

  // La celda de pruebas va en la FILA 1 de la última columna de la rejilla:
  //   · No la mira nadie. El índice solo lee columnas cuyo encabezado acaba en
  //     _FISICO, y esta columna no tiene encabezado.
  //   · Al estar en la fila 1 no alarga el rango hacia abajo, así que la
  //     lectura de después mide lo de siempre y no 3.000 filas de relleno.
  // Se borra enseguida. Si la ejecución se cortara justo en medio, lo que
  // quedaría es una celda suelta en una columna sin encabezado — invisible
  // para el índice, y la poda de huérfanas la elimina sola por ser la de más
  // a la derecha, sin desplazar ninguna columna en uso.
  const celdaPrueba = cacheSheet.getRange(1, colScratch);

  // 1. ESCRITURA EN FRÍO. Va la primera a propósito: es el único dato que no
  //    tenemos y el que decide el rumbo.
  t0 = Date.now();
  celdaPrueba.setValue("⏱");
  SpreadsheetApp.flush();
  let msEscrituraFria = Date.now() - t0;

  // Se deshace ANTES de leer, para que el rango con datos vuelva a ser el de
  // siempre y la lectura de abajo mida lo que mediría en un escaneo real.
  celdaPrueba.clearContent();
  SpreadsheetApp.flush();

  // 2. LAS DOS FORMAS DE LEER, una detrás de otra y ya las dos en caliente,
  //    para que la comparación sea limpia. Esta es la prueba de cargo: la
  //    primera medición dio 682 ms EN CALIENTE, más que los 566 en frío, así
  //    que abrir la pestaña no tenía nada que ver. Lo que cuesta es que
  //    getDataRange averigüe hasta dónde llegan los datos.
  t0 = Date.now();
  let datos = cacheSheet.getDataRange().getValues();
  let msLecturaCaliente = Date.now() - t0;

  t0 = Date.now();
  let datosRejilla = cacheSheet.getRange(1, 1, cacheSheet.getMaxRows(), colScratch).getValues();
  let msLecturaRejilla = Date.now() - t0;

  // 3. ESCRITURA EN CALIENTE: la referencia de cuánto cuesta el mismo trabajo
  //    sin el primer toque. La diferencia con (1) ES el coste de abrir.
  t0 = Date.now();
  celdaPrueba.setValue("⏱");
  SpreadsheetApp.flush();
  let msEscrituraCaliente = Date.now() - t0;
  celdaPrueba.clearContent();
  SpreadsheetApp.flush();

  // 4. Llamada trivial de referencia, para tener el suelo de este archivo.
  t0 = Date.now();
  for (let k = 0; k < 3; k++) cacheSheet.getRange(1, 1).getValue();
  let msLlamadaNormal = Math.round((Date.now() - t0) / 3);

  let L = [];
  L.push("Qué mide: por qué leer CACHE_SISTEMA cuesta ~10 veces una llamada");
  L.push("normal, y si el arreglo funciona.");
  L.push("");
  L.push("── LAS DOS FORMAS DE LEER (las dos en caliente) ──");
  L.push("getDataRange, como estaba:   " + msLecturaCaliente + " ms   (" + datos.length + " filas)");
  L.push("Rango explícito, como queda: " + msLecturaRejilla + " ms   (" + datosRejilla.length + " filas)");
  L.push("");
  L.push("── EL RESTO ──");
  L.push("Abrir la hoja por su nombre:      " + msAbrir + " ms");
  L.push("Preguntar cuántas columnas tiene: " + msMaxCols + " ms");
  L.push("Escribir 1 celda, en frío:        " + msEscrituraFria + " ms");
  L.push("Escribir 1 celda, en caliente:    " + msEscrituraCaliente + " ms");
  L.push("Una llamada corriente:            ~" + msLlamadaNormal + " ms");
  L.push("(las dos escrituras incluyen un flush forzado, que un escaneo real no");
  L.push(" hace: ahí se vuelca todo junto al final. Salen más caras de lo que son.)");
  L.push("");

  // ── ¿Cabe el índice en CacheService, y a qué precio? ────────────────────
  // Se mide antes de construir nada, porque es lo que decide si vale la pena
  // construirlo. El límite son 100 KB por clave: si no cabe hay que trocearlo,
  // y eso es bastante más código del que parece.
  let payload = JSON.stringify(datos);
  let kb = (payload.length / 1024).toFixed(1);
  let cache = CacheService.getDocumentCache();
  let cabe = true;
  let msPut = 0, msGet = 0;

  t0 = Date.now();
  try { cache.put("WMS_PRUEBA_TAMANO", payload, 60); }
  catch (err) { cabe = false; }
  msPut = Date.now() - t0;

  if (cabe) {
      t0 = Date.now();
      cache.get("WMS_PRUEBA_TAMANO");
      msGet = Date.now() - t0;
      cache.remove("WMS_PRUEBA_TAMANO");
  }

  // ── Veredicto ───────────────────────────────────────────────────────────
  // La primera corrida de esta prueba tumbó la hipótesis de partida. Se creía
  // que lo caro era abrir la pestaña por primera vez, porque en las M-S las
  // mismas 4 lecturas costaban 942 ms en frío y 13 en caliente. Pero aquí la
  // lectura EN CALIENTE dio 682 ms, más que los 566 en frío de la medición
  // anterior: el primer toque no pintaba nada. Lo caro era getDataRange, que
  // para saber dónde acaban los datos hace por dentro el mismo getLastRow que
  // ya estaba documentado como la llamada más cara del sistema.
  L.push("── QUÉ SIGNIFICA ──");
  let mejora = msLecturaCaliente - msLecturaRejilla;
  if (mejora > 100) {
      L.push("🟢 El rango explícito ahorra " + mejora + " ms por escaneo.");
      L.push("");
      L.push("Leer un rango de límites conocidos no obliga a Sheets a calcular");
      L.push("dónde acaban los datos, que era todo el coste. Se leen de más las");
      L.push("filas reservadas vacías y no importa: el índice las descarta.");
      L.push("");
      L.push("Con esto, los " + msGet + " ms de CacheService dejan de compensar el");
      L.push("riesgo de tener el índice en dos sitios que se pueden desincronizar.");
  } else if (mejora > 0) {
      L.push("🟡 El rango explícito solo ahorra " + mejora + " ms.");
      L.push("");
      L.push("Menos de lo esperado. Si la lectura sigue por encima de 300 ms,");
      L.push("el siguiente paso es recortar las filas reservadas de CACHE_SISTEMA");
      L.push("o mover el índice a CacheService.");
  } else {
      L.push("🔴 El rango explícito no mejora nada (o empeora).");
      L.push("");
      L.push("Entonces el coste no era averiguar el extremo de los datos, y hay");
      L.push("que ir a CacheService o a escribir el caché menos a menudo.");
  }

  L.push("");
  L.push("── LA ALTERNATIVA: EL ÍNDICE FUERA DE LA HOJA ──");
  L.push("Tamaño del índice serializado: " + kb + " KB   (límite: 100 KB por clave)");
  if (cabe) {
      L.push("Guardarlo en CacheService:     " + msPut + " ms");
      L.push("Recuperarlo de CacheService:   " + msGet + " ms");
      L.push("✅ Cabe entero, sin trocear.");
  } else {
      L.push("⚠️ No cabe en una sola clave: habría que partirlo en trozos.");
      L.push("   Se puede, pero es bastante más código y más sitios donde fallar.");
  }

  ui.alert("🧪 ¿Qué cuesta abrir el caché?", L.join("\n"), ui.ButtonSet.OK);
}

// =========================================================================
// DIAGNÓSTICO DE UNA GUÍA CONCRETA
// =========================================================================
// Responde "¿por qué esta guía dice lo que dice?" con datos, no con teorías.
// Se para uno en la celda de la guía y el informe enseña todo lo que el
// sistema sabe de ella: dónde la tiene el caché, qué M-S la registran, a qué
// pedimento la asignan y qué espera el bloque en el que cayó.
function diagnosticarGuia() {
  const ss = obtenerArchivo();
  const ui = SpreadsheetApp.getUi();
  const hoja = ss.getActiveSheet();
  const nombreHoja = claveHoja(hoja.getName());

  let celda = hoja.getActiveCell();
  let guia = String(celda.getValue()).trim().toUpperCase();

  if (guia === "") {
    let resp = ui.prompt("🔍 Diagnóstico de guía",
        "Colócate en la celda de la guía, o escríbela aquí:", ui.ButtonSet.OK_CANCEL);
    if (resp.getSelectedButton() !== ui.Button.OK) return;
    guia = String(resp.getResponseText()).trim().toUpperCase();
    if (guia === "") return;
  }

  invalidarCacheRAM();
  let cacheInfo = getCacheData(ss);
  let L = [];
  let esPedimento = /^\d{7}$/.test(guia);

  L.push((esPedimento ? "Pedimento: " : "Guía: ") + guia);
  L.push("Pestaña actual: " + nombreHoja + "   ·   celda " + celda.getA1Notation());
  if (!esPedimento) L.push("¿Formato de guía válido?: " + (esGuiaUPSValida(guia) ? "SÍ" : "NO"));
  L.push("");

  if (!cacheInfo) {
    L.push("❌ No hay caché. Usa «Reconstruir caché completo».");
    ui.alert("🔍 Diagnóstico", L.join("\n"), ui.ButtonSet.OK);
    return;
  }

  // ── Un pedimento no vive en el índice de guías: se busca a mano ───────────
  if (esPedimento) {
    L.push("── DÓNDE APARECE ESTE PEDIMENTO ──");
    let apariciones = [];
    for (let c = 0; c < cacheInfo.headers.length; c++) {
        let header = String(cacheInfo.headers[c]);
        if (!header.endsWith("_FISICO") && !header.endsWith("_PREFORMA")) continue;
        let esPre = header.endsWith("_PREFORMA");
        let nom = claveHoja(header.replace("_FISICO", "").replace("_PREFORMA", ""));
        for (let r = 1; r < cacheInfo.data.length; r++) {
            if (String(cacheInfo.data[r][c]).trim() === guia) {
                apariciones.push({ hoja: nom, fila: r, pre: esPre, ms: esHojaMS(nom) });
            }
        }
    }

    if (apariciones.length === 0) {
        L.push("   En ninguna parte según el caché. Si lo ves escrito, el caché");
        L.push("   está desfasado: corre «♻️ Reconstruir caché completo».");
    } else {
        apariciones.forEach(a => {
            L.push("   · " + a.hoja + "  fila " + a.fila +
                   (a.pre ? "  (preforma, col O)" : "  (escaneo, col A)") +
                   (a.ms ? "  [M-S]" : ""));
        });
    }

    let enMS = apariciones.filter(a => a.ms && !a.pre);
    let hojasMS = {};
    enMS.forEach(a => { hojasMS[a.hoja] = (hojasMS[a.hoja] || 0) + 1; });
    let nombresMS = Object.keys(hojasMS);

    L.push("");
    L.push("── ¿ESTÁ REPETIDO? ──");
    let repetidoEnUna = nombresMS.some(n => hojasMS[n] > 1);
    if (repetidoEnUna) {
        L.push("   🛑 Sí, DOS VECES DENTRO DE LA MISMA M-S. Eso sí lo marca el");
        L.push("      sistema como «PEDIMENTO REPETIDO».");
    } else if (nombresMS.length > 1) {
        L.push("   ⚠️ Está en " + nombresMS.length + " pestañas M-S distintas:");
        nombresMS.forEach(n => L.push("      · " + n));
        L.push("");
        L.push("   OJO: el sistema NO marca esto. El aviso de «PEDIMENTO REPETIDO»");
        L.push("   solo mira dentro de cada pestaña por separado, nunca entre");
        L.push("   pestañas. Si esto no debería pasar, avísame y lo añado.");
    } else {
        L.push("   No. Aparece una sola vez en las M-S" +
               (nombresMS.length === 1 ? " (" + nombresMS[0] + ")" : "") + ".");
    }

    L.push("");
    L.push("── QUÉ GUÍAS LE CUELGAN ──");
    let datosMSPed = obtenerRegistroMSDesdeCache(cacheInfo, "");
    let setPed = datosMSPed.registroMS.get(guia);
    L.push("   Según las M-S: " + (setPed ? setPed.size + " guías" : "ninguna"));
    L.push("   Si aquí dice 'ninguna' pero en la M-S sí ves guías debajo, es que");
    L.push("   el pedimento no está justo encima de ellas o tiene algún carácter");
    L.push("   raro: las guías se asignan al último pedimento que haya ARRIBA.");

    ui.alert("🔍 Diagnóstico de pedimento", L.join("\n"), ui.ButtonSet.OK);
    return;
  }

  // ── Dónde la tiene el caché ──────────────────────────────────────────────
  L.push("── DÓNDE ESTÁ, SEGÚN EL CACHÉ ──");
  let apariciones = cacheInfo.map.get(guia) || [];
  if (apariciones.length === 0) {
    L.push("   En ninguna parte. El caché NO conoce esta guía.");
    L.push("   Si tú la ves escrita en una pestaña, ese caché está desfasado:");
    L.push("   corre «♻️ Reconstruir caché completo».");
  } else {
    apariciones.forEach(a => {
      let tipo = a.isMS ? "M-S" : (a.isInventario ? "INVENTARIO" : "destino");
      L.push("   · " + a.hoja + "  fila " + a.fila + "   (" + tipo + ")");
    });
  }
  L.push("");

  // ── Qué dice el registro de M-S ──────────────────────────────────────────
  let datosMS = obtenerRegistroMSDesdeCache(cacheInfo, nombreHoja);
  let origen = datosMS.guiasOrigen.get(guia);

  L.push("── REGISTRO EN M-S ──");
  if (origen) {
    L.push("   ✅ Registrada. Origen que se mostraría: " + origen);
  } else {
    L.push("   ❌ NO registrada en ninguna M-S.");
    L.push("   Por eso sale «⚠️ Sin registrar en M-S».");
  }

  let pedEnMS = "";
  datosMS.registroMS.forEach((set, ped) => { if (set.has(guia)) pedEnMS = ped; });
  if (pedEnMS !== "") L.push("   Pedimento que le asigna la M-S: " + pedEnMS);
  else if (origen) {
    L.push("   ⚠️ Está en una M-S pero SIN pedimento encima: por eso no entra");
    L.push("      en la lista esperada de ningún pedimento.");
  }
  L.push("");

  // ── Qué espera el bloque en el que cayó ──────────────────────────────────
  if (esHojaPrincipal(nombreHoja) && !esHojaInventario(nombreHoja)) {
      let lr = Math.max(hoja.getLastRow(), 1);
      let colA = hoja.getRange(1, 1, lr, 1).getValues();
      let filaGuia = celda.getRow();
      let pedBloque = "";
      for (let i = Math.min(filaGuia, lr) - 1; i >= 0; i--) {
          let v = String(colA[i][0]).trim().toUpperCase();
          if (/^\d{7}$/.test(v)) { pedBloque = v; break; }
          if (esMarcadorEstructural(v)) break;
      }

      L.push("── EL BLOQUE DONDE ESTÁ ESCANEADA ──");
      if (pedBloque === "") {
          L.push("   No hay pedimento encima de esta fila.");
      } else {
          L.push("   Pedimento del bloque: " + pedBloque);
          let esperadasMS = datosMS.registroMS.get(pedBloque);
          L.push("   La M-S le da a ese pedimento: " +
                 (esperadasMS ? esperadasMS.size + " guías" : "ninguna (no está en M-S)"));
          if (esperadasMS && esperadasMS.has(guia)) {
              L.push("   ✅ Esta guía SÍ está en esa lista → debería salir «✅ Ok».");
          } else if (pedEnMS !== "" && pedEnMS !== pedBloque) {
              L.push("   ❌ La M-S la tiene en el pedimento " + pedEnMS + ", no en este.");
              L.push("      Debería salir «❌ Va en: " + pedEnMS + "».");
          } else if (esperadasMS && esperadasMS.size > 0) {
              L.push("   ⚠️ No está en la lista de ese pedimento y no aparece en");
              L.push("      ningún otro → «⚠️ Sobra (Ajena)».");
          }
      }
      L.push("");
  }

  // ── Veredicto ────────────────────────────────────────────────────────────
  L.push("── QUÉ HACER ──");
  if (apariciones.length === 0) {
    L.push("El caché no la conoce. Reconstruye el caché y vuelve a mirar.");
  } else if (!origen) {
    L.push("El caché la tiene, pero en ninguna pestaña M-S. Comprueba que la");
    L.push("pestaña donde la escribiste sea de verdad una M-S: su nombre tiene");
    L.push("que empezar por «M-S». Si la acabas de teclear ahí, reconstruye el");
    L.push("caché para que quede indexada.");
  } else if (pedEnMS === "") {
    L.push("Está en una M-S pero sin pedimento de 7 dígitos encima de ella.");
    L.push("Ponle su pedimento arriba en la M-S y el destino ya la reconocerá.");
  } else {
    L.push("Todo cuadra. Si aun así el mensaje no es el esperado, usa");
    L.push("«🔄 Forzar Actualización» en esta pestaña.");
  }

  ui.alert("🔍 Diagnóstico de guía", L.join("\n"), ui.ButtonSet.OK);
}

// =========================================================================
// DIAGNÓSTICO
// =========================================================================
function diagnosticoSistema() {
  const ss = obtenerArchivo();
  const ui = SpreadsheetApp.getUi();

  invalidarCacheRAM();
  let cacheInfo = getCacheData(ss);
  let L = [];

  // --- Caché ---
  L.push("── CACHÉ DE DUPLICADOS ──");
  if (!cacheInfo) {
      L.push("❌ No existe CACHE_SISTEMA. Usa «Reconstruir caché completo».");
  } else {
      let existentes = new Set(ss.getSheets().map(h => claveHoja(h.getName())));
      let indexadas = [], huerfanas = [], preformasSobrantes = [];

      cacheInfo.headers.forEach(h => {
          let t = String(h).trim();
          if (t === "") return;
          let nombre = claveHoja(t.replace("_FISICO", "").replace("_PREFORMA", ""));
          if (!existentes.has(nombre)) { huerfanas.push(t); return; }
          if (t.endsWith("_PREFORMA") && !usaPreforma(nombre)) { preformasSobrantes.push(t); return; }
          if (t.endsWith("_FISICO")) indexadas.push(nombre);
      });

      L.push("✅ Pestañas indexadas: " + indexadas.length + " (" + indexadas.join(", ") + ")");
      L.push("   Guías en el índice: " + cacheInfo.map.size);
      L.push(huerfanas.length === 0
          ? "✅ Sin columnas huérfanas"
          : "⚠️ Columnas de pestañas que ya no existen: " + huerfanas.join(", "));
      if (preformasSobrantes.length > 0) {
          L.push("⚠️ Preformas sobrantes de hojas M-S: " + preformasSobrantes.join(", "));
      }
      if (huerfanas.length > 0 || preformasSobrantes.length > 0) {
          L.push("   → Se limpian con «Reconstruir caché completo».");
      }
  }

  // --- Estado de las pestañas de trabajo ---
  L.push("");
  L.push("── PESTAÑAS ──");
  ss.getSheets().forEach(hoja => {
      let n = claveHoja(hoja.getName());
      if (esHojaSistema(n)) return;

      let lr = hoja.getLastRow();
      if (lr < 1) { L.push("· " + n + ": vacía"); return; }

      let datos = hoja.getRange(1, 1, lr, 2).getValues();
      let conDato = 0, pendientes = 0, duplicados = 0, invalidas = 0;

      datos.forEach(f => {
          let a = String(f[0]).trim();
          if (a === "") return;
          conDato++;
          let b = String(f[1]).trim();
          if (filaSinValidar(a, b)) pendientes++;
          if (b.startsWith("⛔")) duplicados++;
          if (b.startsWith("❌ Guía Inválida")) invalidas++;
      });

      let linea = "· " + n + ": " + conDato + " filas";
      if (pendientes > 0) linea += " | ⏳ " + pendientes + " sin validar";
      if (duplicados > 0) linea += " | ⛔ " + duplicados + " duplicadas";
      if (invalidas > 0) linea += " | ❌ " + invalidas + " inválidas";
      if (pendientes === 0 && duplicados === 0 && invalidas === 0) linea += " | ✅ limpia";
      L.push(linea);
  });

  // --- Disparadores ---
  L.push("");
  L.push("── DISPARADORES ──");
  try {
      let ts = ScriptApp.getProjectTriggers();
      if (ts.length === 0) L.push("⚠️ Ninguno. Solo funciona el trigger simple onEdit.");
      else ts.forEach(t => L.push("· " + t.getHandlerFunction() + " (" + t.getEventType() + ")"));
  } catch (err) {
      L.push("No se pudieron leer: " + err.message);
  }

  // --- Protección ---
  L.push("");
  L.push("── PROTECCIÓN ──");
  let protegidas = [];
  ss.getSheets().forEach(hoja => {
      if (!esHojaInterna(hoja.getName())) return;
      let tiene = hoja.getProtections(SpreadsheetApp.ProtectionType.SHEET)
                      .some(p => p.getDescription() === DESC_PROTECCION);
      protegidas.push((tiene ? "✅ " : "⚠️ sin proteger: ") + hoja.getName());
  });
  L.push(protegidas.join("\n"));

  ui.alert("🩺 Diagnóstico del sistema", L.join("\n"), ui.ButtonSet.OK);
}

// Las funciones de menú también escriben en masa: sin lock pueden corromper
// datos si un operador escanea al mismo tiempo.
function conLock(fn) {
  const ss = obtenerArchivo();
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(20000)) {
      ss.toast('⏳ Hay otra operación en curso. Intenta de nuevo en unos segundos.', 'Ocupado', 6);
      return;
  }
  try { fn(ss); } finally { lock.releaseLock(); }
}

function forzarActualizacionHojaActiva() {
  conLock(ss => {
    const hoja = ss.getActiveSheet();
    const nombreHoja = claveHoja(hoja.getName());

    if (esHojaSistema(nombreHoja)) {
        ss.toast('ℹ️ Esta pestaña es del sistema y no se recalcula.', 'Sin Acción', 4);
        return;
    }

    ss.toast('⏳ Sincronizando datos, por favor espera...', 'Actualizando', 3);

    // Podar primero las columnas de pestañas renombradas o borradas: si no, la
    // hoja se compararía contra su propio pasado y saldría toda duplicada.
    podarCacheHuerfano(ss);
    actualizarFotografiaMental(hoja, ss);
    invalidarCacheRAM();
    let cacheInfo = getCacheData(ss);

    // repintarTodo = true: reescribe estados y colores de TODAS las filas.
    // Es lo que hay que correr una vez por pestaña al retirar el formato
    // condicional, para que los colores del script queden aplicados.
    recalcularHoja(hoja, ss, cacheInfo, null, true, true);
    if (esHojaInventario(nombreHoja)) sincronizarInventariosAfectados(ss, cacheInfo, null, nombreHoja);

    ss.toast('✅ Hoja actualizada y coloreada correctamente.', 'Éxito', 4);
  });
}

function actualizadorAutomaticoGlobal() {
  const ss = obtenerArchivo();
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(30000)) return;

  try {
    // Autocuración: quita del caché las pestañas renombradas o borradas antes
    // de que empiecen a generar duplicados fantasma.
    podarCacheHuerfano(ss);

    // PASADA 1: detectar hojas con filas sin validar (escaneos que se perdieron
    // por un lock ocupado o un timeout) y re-fotografiarlas.
    let pendientes = [];
    ss.getSheets().forEach(hoja => {
        let nombreHoja = claveHoja(hoja.getName());
        let lr = hoja.getLastRow();
        if (esHojaSistema(nombreHoja) || lr <= 1) return;

        let necesitaActualizar = false;

        if (esHojaMS(nombreHoja) || esHojaInventario(nombreHoja)) {
            let datos = hoja.getRange(2, 1, lr - 1, 2).getValues();
            for (let i = 0; i < datos.length; i++) {
                if (filaSinValidar(datos[i][0], datos[i][1])) { necesitaActualizar = true; break; }
            }
        } else if (esHojaPrincipal(nombreHoja)) {
            if (hoja.getMaxColumns() >= 16) {
                // Solo la columna A. La preforma NO se mira: en la columna P
                // únicamente llevan texto la fila del pedimento y la última guía
                // de cada bloque; las de en medio se quedan vacías a propósito.
                // Mirarlas daba por pendiente toda hoja con preforma, siempre, y
                // la red la recalculaba en cada pasada del trigger sin fin.
                // Además "⏳ Pendiente" solo se escribe para ediciones de la
                // columna A (ver marcarPendiente), así que la preforma nunca
                // formó parte de este mecanismo.
                let datosFisicos = hoja.getRange(2, 1, lr - 1, 2).getValues();
                for (let i = 0; i < datosFisicos.length; i++) {
                    if (filaSinValidar(datosFisicos[i][0], datosFisicos[i][1])) { necesitaActualizar = true; break; }
                }
            } else {
                necesitaActualizar = true;
            }
        }

        if (necesitaActualizar) {
            actualizarFotografiaMental(hoja, ss);
            pendientes.push(hoja);
        }
    });

    // El caché se recarga UNA sola vez, no una por hoja (antes era O(n²)).
    invalidarCacheRAM();
    let cacheInfo = getCacheData(ss);

    // PASADA 2: recalcular. Los recálculos solo escriben estados, horas y
    // colores; nunca tocan las columnas A ni O, así que el caché sigue válido.
    pendientes.forEach(hoja => recalcularHoja(hoja, ss, cacheInfo, null));

    // Barrido completo de "movidos" fuera del camino crítico del escaneo.
    sincronizarSalidasMS(ss, cacheInfo, null);
  } finally {
    lock.releaseLock();
  }
}

function agruparPorPedimento() {
  conLock(ss => {
    const hoja = ss.getActiveSheet();
    let lr = hoja.getLastRow();
    if (lr < 1) return;

    let nombreHoja = claveHoja(hoja.getName());
    if (esHojaSistema(nombreHoja)) {
        ss.toast('ℹ️ Esta pestaña es del sistema.', 'Sin Acción', 4);
        return;
    }

    let cacheInfo = getCacheData(ss);
    // Solo el bloque físico (A..L). NO se toca la columna M (lista FEMAD,
    // que es una lista fija y no pertenece a ninguna fila) ni la N (letra de
    // color, que pertenece al bloque de preforma en la columna O).
    const colsToMove = 12;
    asegurarColumnas(hoja, 15);
    let esRezago = nombreHoja.indexOf("REZAGO") !== -1;

    let mapaPreforma = new Map();
    let valsO = hoja.getRange(1, 15, lr, 1).getValues();

    if (esRezago) {
        let pedActualO = "";
        for (let i = 0; i < lr; i++) {
          let v = String(valsO[i][0]).trim().toUpperCase();
          if (/^\d{7}$/.test(v)) pedActualO = v;
          else if (v !== "" && pedActualO !== "") mapaPreforma.set(v, pedActualO);
        }
    } else {
        let tempGuiasO = [];
        for (let i = 0; i < lr; i++) {
          let v = String(valsO[i][0]).trim().toUpperCase();
          if (/^\d{7}$/.test(v)) { tempGuiasO.forEach(g => mapaPreforma.set(g, v)); tempGuiasO = []; }
          else if (v !== "") tempGuiasO.push(v);
        }
    }

    let datosMS = obtenerRegistroMSDesdeCache(cacheInfo, nombreHoja);
    datosMS.registroMS.forEach((guias, ped) => {
        guias.forEach(g => { if (!mapaPreforma.has(g)) mapaPreforma.set(g, ped); });
    });

    if (esRezago) {
        obtenerGuiasRezagoDesdeCache(cacheInfo).forEach((info, guia) => {
            if (!mapaPreforma.has(guia)) mapaPreforma.set(guia, info.pedimento);
        });
    }

    let rangoData = hoja.getRange(1, 1, lr, colsToMove);
    let datosFisicos = rangoData.getValues();

    let agrupacion = new Map();
    let pedFisicoActual = "SIN PEDIMENTO";

    for (let i = 0; i < datosFisicos.length; i++) {
      let fila = datosFisicos[i];
      let valA = String(fila[0]).trim().toUpperCase();
      if (valA === "") continue;

      // Agrupar REORDENA, nunca borra. Antes las guías ya salidas se
      // descartaban aquí y desaparecían de la hoja sin quedar registradas en el
      // historial: era la causa de que "se borraran guías" solas. Para
      // eliminarlas está «🧹 Limpiar guías movidas», que sí deja rastro.
      if (/^\d{7}$/.test(valA)) {
          pedFisicoActual = valA;
          if (!agrupacion.has(pedFisicoActual)) agrupacion.set(pedFisicoActual, { cabecera: fila, guias: [] });
          else agrupacion.get(pedFisicoActual).cabecera = fila;
      } else {
          let pedDestino = mapaPreforma.get(valA) || pedFisicoActual;
          if (!agrupacion.has(pedDestino)) {
              let dummy = [pedDestino].concat(Array(colsToMove - 1).fill(""));
              agrupacion.set(pedDestino, { cabecera: dummy, guias: [] });
          }
          agrupacion.get(pedDestino).guias.push(fila);
      }
    }

    let newVals = [];
    agrupacion.forEach((bloque, ped) => {
        if (ped === "SIN PEDIMENTO") return;
        if (bloque.cabecera) newVals.push(bloque.cabecera);
        bloque.guias.forEach(g => newVals.push(g));
    });

    if (agrupacion.has("SIN PEDIMENTO")) {
        newVals.push(["SIN PEDIMENTO"].concat(Array(colsToMove - 1).fill("")));
        agrupacion.get("SIN PEDIMENTO").guias.forEach(g => newVals.push(g));
    }

    rangoData.clearContent();
    hoja.getRange(1, 1, lr, colsToMove).setBackground("#FFFFFF").setFontColor("#000000").setFontLine("none");
    if (newVals.length > 0) {
        hoja.getRange(1, 1, newVals.length, colsToMove).setValues(newVals);
    }

    // Las filas se movieron: la fotografía anterior ya no vale.
    actualizarFotografiaMental(hoja, ss);
    invalidarCacheRAM();
    cacheInfo = getCacheData(ss);

    recalcularHoja(hoja, ss, cacheInfo, null);
    if (esHojaInventario(nombreHoja)) sincronizarInventariosAfectados(ss, cacheInfo, null, nombreHoja);

    ss.toast('✅ Guías agrupadas correctamente en la parte superior.', 'Agrupación', 5);
  });
}

function limpiarGuiasMovidasSeleccion() {
  conLock(ss => {
    const hoja = ss.getActiveSheet();
    const rangoSeleccionado = hoja.getActiveRange();
    if (!rangoSeleccionado) return;

    asegurarColumnas(hoja, 12);
    let filaInicio = rangoSeleccionado.getRow();
    let numFilasSeleccion = rangoSeleccionado.getNumRows();
    if (numFilasSeleccion < 1) return;

    let lr = hoja.getLastRow();
    let maxFilaData = Math.max(lr, filaInicio + numFilasSeleccion - 1);
    let totalFilasAProcesar = maxFilaData - filaInicio + 1;
    if (totalFilasAProcesar < 1) return;

    let rangoData = hoja.getRange(filaInicio, 1, totalFilasAProcesar, 12);
    let valores = rangoData.getValues();

    // Los valores suben, así que TODO lo que va pegado a la fila tiene que subir
    // con ellos. Antes solo se movían los valores: los colores se quedaban en su
    // sitio y acababan describiendo una fila que ya no era esa (por eso "no me
    // borra el color"), y las validaciones se quedaban descolocadas igual.
    let fondos    = rangoData.getBackgrounds();
    let colorsFte = rangoData.getFontColors();
    let lineasFte = rangoData.getFontLines();
    let validaciones = rangoData.getDataValidations();

    let paraEliminar = new Set();
    let filasHistorial = [];
    let nombreHoja = claveHoja(hoja.getName());

    for (let i = 0; i < numFilasSeleccion && i < valores.length; i++) {
        let valB = String(valores[i][1]).trim();
        if (esEstadoSalida(valB)) {
            paraEliminar.add(i);
            let guiaBorrada = String(valores[i][0]).trim();
            if (guiaBorrada !== "") {
                filasHistorial.push(eventoHistorial(nombreHoja, filaInicio + i, "Físico (Col A)", guiaBorrada, valB, "LIMPIEZA DE GUÍA YA SALIDA"));
            }
        }
    }

    for (let i = 0; i < numFilasSeleccion && i < valores.length; i++) {
        let valA = String(valores[i][0]).trim().toUpperCase();
        if (!/^\d{7}$/.test(valA) || paraEliminar.has(i)) continue;

        let tieneGuias = false;
        for (let j = i + 1; j < numFilasSeleccion && j < valores.length; j++) {
            let nextA = String(valores[j][0]).trim().toUpperCase();
            if (/^\d{7}$/.test(nextA)) break;
            if (nextA !== "" && !paraEliminar.has(j)) { tieneGuias = true; break; }
        }
        if (!tieneGuias) {
            paraEliminar.add(i);
            filasHistorial.push(eventoHistorial(nombreHoja, filaInicio + i, "Físico (Col A)", valA, "Vacío", "LIMPIEZA DE PEDIMENTO VACÍO"));
        }
    }

    if (paraEliminar.size === 0) {
        ss.toast('ℹ️ No se encontraron guías movidas en el rango seleccionado.', 'Sin cambios', 5);
        return;
    }

    registrarEnHistorialLote(ss, filasHistorial);

    let eliminadas = paraEliminar.size;
    let nuevosValores = [], nuevosFondos = [], nuevosColores = [], nuevasLineas = [], nuevasValidaciones = [];
    for (let i = 0; i < valores.length; i++) {
        if (paraEliminar.has(i)) continue;
        nuevosValores.push(valores[i]);
        nuevosFondos.push(fondos[i]);
        nuevosColores.push(colorsFte[i]);
        nuevasLineas.push(lineasFte[i]);
        nuevasValidaciones.push(validaciones[i]);
    }

    // Las filas que quedan al final se vacían y se dejan en formato neutro. La
    // validación de datos SÍ se conserva: se copia la de la última fila que
    // sobrevivió, para que las celdas recién liberadas sigan validando igual que
    // el resto de la columna en lugar de quedarse sin regla.
    // Cada fila vacía debe ser un array propio, no la misma referencia repetida.
    let validacionModelo = nuevasValidaciones.length > 0
        ? nuevasValidaciones[nuevasValidaciones.length - 1]
        : validaciones[validaciones.length - 1];
    for (let k = 0; k < eliminadas; k++) {
        nuevosValores.push(Array(12).fill(""));
        nuevosFondos.push(Array(12).fill("#FFFFFF"));
        nuevosColores.push(Array(12).fill("#000000"));
        nuevasLineas.push(Array(12).fill("none"));
        nuevasValidaciones.push(validacionModelo.slice());
    }

    rangoData.setValues(nuevosValores);
    rangoData.setBackgrounds(nuevosFondos);
    rangoData.setFontColors(nuevosColores);
    rangoData.setFontLines(nuevasLineas);
    rangoData.setDataValidations(nuevasValidaciones);

    actualizarFotografiaMental(hoja, ss);
    invalidarCacheRAM();
    let cacheInfo = getCacheData(ss);

    recalcularHoja(hoja, ss, cacheInfo, null);
    if (esHojaInventario(nombreHoja)) sincronizarInventariosAfectados(ss, cacheInfo, null, nombreHoja);

    ss.toast('✅ Guías limpiadas (' + eliminadas + ' filas). Colores y validaciones subieron con ellas.', 'Limpieza Completa', 5);
  });
}

// =========================================================================
// RECONSTRUCCIÓN TOTAL DEL CACHÉ
// =========================================================================
function RECONSTRUIR_CACHE_TOTAL() {
  conLock(ss => {
    ss.toast('📸 Tomando fotografía de todas las pestañas...', 'Reconstruyendo Caché', 5);

    // Se borra la hoja entera para que no sobrevivan columnas de pestañas
    // renombradas o eliminadas (duplicados fantasma).
    let vieja = ss.getSheetByName("CACHE_SISTEMA");
    if (vieja) ss.deleteSheet(vieja);
    invalidarCacheRAM();

    ss.getSheets().forEach(hoja => actualizarFotografiaMental(hoja, ss));
    invalidarCacheRAM();

    ss.toast('✅ Caché reconstruido con éxito.', 'Listo', 5);
  });
}
