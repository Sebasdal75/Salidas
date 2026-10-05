/*************************************************************
 * QUÉ PESTAÑAS MIRA LA MACRO
 *
 * Pegar esto en el proyecto de la macro y usar `esHojaDeSalidas(nombre)`.
 *
 * SE DECIDE POR REGLAS, NO POR UNA LISTA DE NOMBRES. Las pestañas de unidad
 * llevan la placa detrás —«GLOBAL 2 20-AE-3H»— y cambian cada semana: una
 * lista de nombres exactos deja fuera la unidad nueva el día que se crea, y
 * nadie se entera hasta que falta medio camión en el informe.
 *
 * Es una COPIA de las reglas del WMS, a propósito y con su riesgo: si allí se
 * añade una pestaña de sistema nueva, aquí hay que añadirla también. La
 * alternativa —llamar al WMS— ataría los dos proyectos y haría que un fallo en
 * uno parara el otro.
 *************************************************************/

// ¿Esta pestaña es de las que carga la macro?
function esHojaDeSalidas(nombreHoja) {
  if (esHojaQueNoSeToca(nombreHoja)) return false;

  // ───────────────────────────────────────────────────────────────
  // AQUÍ SE DECIDE EL ALCANCE. Déjalo como está para que entren SOLO
  // las Globales, que es como está hoy la confronta del WMS.
  // Para que entren todas las de unidad —T1, tránsito, etc.—, cambia
  // esta línea por:   return true;
  // ───────────────────────────────────────────────────────────────
  return clave_(nombreHoja).indexOf("GLOBAL") === 0;
}

// Todo lo que la macro NO debe tocar. Una sola función para no tener la lista
// repartida en cinco sitios.
function esHojaQueNoSeToca(nombreHoja) {
  var n = clave_(nombreHoja);

  // 1. MOTOR Y LISTAS DEL SISTEMA.
  //    El prefijo «SIS_» es la regla nueva: cualquier pestaña que empiece así
  //    es del sistema, sin tener que ampliar nada cuando nazca otra.
  if (n.indexOf("SIS_") === 0) return true;
  if (n.indexOf("_RAPIDO") !== -1) return true;      // nombres de antes del prefijo
  if (n === "GUIAS_LEIDAS") return true;
  if (n === "CACHE_SISTEMA") return true;
  if (n.indexOf("HISTORIAL") !== -1) return true;
  if (n.indexOf("INDICE_HOUSE") !== -1) return true; // y el _FRIO
  if (n.indexOf("INDICE_SALIDAS") !== -1) return true;
  if (n === "HOUSE_ACTIVO") return true;             // ya no existe, por si queda

  // 2. INFORMES. Repiten guías que ya están en las pestañas de verdad: una
  //    macro que los lea cuenta cada bulto dos veces.
  if (n.indexOf("CONFRONTA") === 0) return true;
  if (n.indexOf("ERRORES_") === 0) return true;
  if (n.indexOf("CONSOLIDADO") === 0) return true;

  // 3. LISTAS QUE SE TECLEAN A MANO. No son escaneos.
  if (n.indexOf("MACHO") !== -1) return true;        // FEMAD y plantillas
  if (esSinInformacion_(n)) return true;

  // 4. LAS M-S. SON DE ESCANEO, pero son el paso de ANTES de cargar: ahí la
  //    carga se está juntando y el pedimento puede no estar escrito todavía.
  //    Contarlas junto a las de salida duplica cada bulto.
  if (n.indexOf("M-S ") === 0 || n.indexOf("MS ") === 0) return true;
  if (n.indexOf("SIMPLES") === 0 || n.indexOf("MULTIPLES") === 0) return true;

  // 5. OTRAS FAMILIAS que no son salida.
  if (n.indexOf("INVENTARIO") !== -1) return true;
  if (n.indexOf("REZAGO") !== -1) return true;

  return false;
}

function clave_(nombre) {
  return String(nombre === undefined || nombre === null ? "" : nombre)
         .trim().toUpperCase();
}

// «SIN INFORMACIÓN» se escribe de varias maneras. Se reconoce sin acentos y
// sin importar los espacios de más: nadie escribe el nombre de una pestaña dos
// veces igual, y si no casa, la macro se come una lista como si fueran guías.
function esSinInformacion_(n) {
  var t = String(n)
    .replace(/[ÁÀÄÂ]/g, 'A').replace(/[ÉÈËÊ]/g, 'E').replace(/[ÍÌÏÎ]/g, 'I')
    .replace(/[ÓÒÖÔ]/g, 'O').replace(/[ÚÙÜÛ]/g, 'U')
    .replace(/[^A-Z0-9]+/g, ' ').trim();
  return t === "SIN INFORMACION" || t === "SIN INFO";
}

// Para comprobarlo de un vistazo en TU archivo: ejecútala y mira el registro.
function QUE_HOJAS_TOMA() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var toma = [], deja = [];
  ss.getSheets().forEach(function (h) {
    (esHojaDeSalidas(h.getName()) ? toma : deja).push(h.getName());
  });
  Logger.log("TOMA (" + toma.length + "):\n  " + toma.join("\n  ") +
             "\n\nNO TOCA (" + deja.length + "):\n  " + deja.join("\n  "));
}
