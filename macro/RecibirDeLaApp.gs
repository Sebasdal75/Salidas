// =========================================================================
// RECIBIR LO QUE MANDA LA APP DE 1Z  →  ARCHIVO «WMS ÍNDICE DE HOUSE»
// =========================================================================
//
// Va en el proyecto de script DEL ARCHIVO DEL ÍNDICE, no en el del WMS.
//
// QUÉ CAMBIA RESPECTO A LA VERSIÓN ANTERIOR, y por qué:
//
//   1. LA PESTAÑA SE CREA SI NO EXISTE. Antes, si no encontraba «SOBRANTES»
//      escribía en `getSheets()[0]`. En aquel archivo eso era inofensivo; en
//      ESTE, la primera pestaña puede ser «INDICE_HOUSE», que tiene cuatro
//      columnas con un formato fijo. Once columnas de otra forma metidas ahí
//      no dan ningún error: el índice sigue pareciendo correcto y empieza a
//      devolver houses equivocadas. Es el peor tipo de fallo que hay aquí.
//
//   2. EL PAR GUÍA→HOUSE TAMBIÉN VA AL ÍNDICE. Sin esto, lo que manda la app
//      se queda en una pestaña suelta y el WMS no se entera de nada: seguiría
//      diciendo «—» en la columna C de esas guías. Guardar el registro
//      completo y alimentar el índice son dos cosas distintas y hacen falta
//      las dos.
//
//   3. CON LOCK. Dos operarios escaneando a la vez mandan dos POST a la vez, y
//      sin lock los dos leen el mismo «última fila» y uno escribe encima del
//      otro. El bulto perdido no deja rastro: nadie sabe que faltó.
//
//   4. SE VALIDA ANTES DE ESCRIBIR EN EL ÍNDICE. Una guía mal leída metida ahí
//      es una house falsa que después alguien despacha.
// =========================================================================

const NOMBRE_HOJA = 'SOBRANTES';

// SU PROPIA PESTAÑA, NO «INDICE_HOUSE».
//
// Lo que manda la app no ha pasado por el inbound: es lo que una persona leyó
// de la etiqueta con el teléfono en la mano. Mezclado con el índice bueno no
// habría forma de separarlo después, y el día que una lectura salga mal habría
// que revisar cuarenta y cinco mil filas para encontrarla. Aparte, se borra la
// pestaña y ya.
//
// El WMS la lee como TERCERA FUENTE, junto al índice caliente y al frío. El
// nombre tiene que ser exactamente este: es el que busca.
const HOJA_INDICE = 'INDICE_HOUSE_APP';
const CABECERA_INDICE = ['GUIA', 'HOUSE', 'FECHA', 'ORIGEN'];

// De dónde vino cada fila. Sirve para poder deshacer: el día que la app mande
// algo mal, se filtra por esta columna y se borra solo lo suyo.
const ORIGEN_APP = 'APP 1Z';

function doPost(e) {
  try {
    const datos = JSON.parse(e.postData.contents);

    if (datos.accion === 'verificar_pass') {
      const esperada = PropertiesService.getScriptProperties().getProperty('ADMIN_PASS');
      // Sin propiedad configurada NO se responde pass_valida. Asi la app sabe
      // que no hay veredicto y no bloquea el acceso.
      if (!esperada) return responder({ sin_configurar: true });
      return responder({ pass_valida: String(datos.pass) === String(esperada) });
    }

    // EL LOCK CUBRE LAS DOS ESCRITURAS. Si cubriera solo una, una fila podría
    // quedar en «SOBRANTES» y no en el índice, o al revés.
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(25000)) {
      return responder({ ok: false, error: 'ocupado, reintenta' });
    }
    let alIndice = false;
    try {
      guardarFila(datos);
      alIndice = guardarEnIndice(datos);
    } finally {
      lock.releaseLock();
    }

    // Se le dice a la app si el par entró al índice o no. Sin esto, una guía
    // descartada por mal escrita se vería como guardada y nadie lo sabría
    // hasta que el bulto no tuviera house.
    return responder({ ok: true, en_indice: alIndice });

  } catch (error) {
    return responder({ ok: false, error: String(error) });
  }
}

// La pestaña del registro completo. SE CREA si no está: ver el punto 1 de
// arriba, escribir en la primera pestaña que haya es lo que no puede pasar.
function hojaDestino() {
  const libro = SpreadsheetApp.getActiveSpreadsheet();
  let hoja = libro.getSheetByName(NOMBRE_HOJA);
  if (!hoja) {
    hoja = libro.insertSheet(NOMBRE_HOJA, libro.getNumSheets());
    hoja.appendRow(['FECHA', 'GUIA', 'HOUSE', 'REMITENTE', 'DIRECCION REMITENTE',
                    'CONSIGNATARIO', 'DIRECCION CONSIGNATARIO', 'BULTOS', 'PESO',
                    'OPERARIO', 'AREA']);
    hoja.getRange('B:C').setNumberFormat('@');
    hoja.setFrozenRows(1);
  }
  return hoja;
}

function guardarFila(d) {
  hojaDestino().appendRow([
    new Date(),
    d.guia || '',
    d.house || '',
    d.remitente_nombre || '',
    d.remitente_direccion || '',
    d.consignatario_nombre || '',
    d.consignatario_direccion || '',
    d.bultos || '',
    d.peso || '',
    d.operario || '',
    d.area || ''
  ]);
}

// -------------------------------------------------------------------------
// EL ÍNDICE
// -------------------------------------------------------------------------

// Mete el par guía→house donde el WMS lo va a buscar.
//
// SE AÑADE AL FINAL, nunca se reescribe el índice: tiene decenas de miles de
// filas y reescribirlo en cada POST sería minutos por escaneo. Si una guía
// acaba dos veces, no pasa nada grave —el WMS se queda con la primera— y el
// botón «🧹 Quitar 1Z repetidos del índice» las junta cuando convenga.
function guardarEnIndice(d) {
  const guia = claveGuia_(d.guia);
  const house = claveGuia_(d.house);

  // SIN LAS DOS COSAS NO SE ESCRIBE. Media fila en el índice es peor que
  // ninguna: una guía sin house tapa la búsqueda, y una house sin guía no la
  // encuentra nadie.
  if (!esGuiaBuena_(guia) || house === '') return false;

  const libro = SpreadsheetApp.getActiveSpreadsheet();
  let h = libro.getSheetByName(HOJA_INDICE);
  if (!h) {
    // La crea la app, no el WMS: aquí es donde nace esta pestaña.
    h = libro.insertSheet(HOJA_INDICE, libro.getNumSheets());
    h.getRange(1, 1, 1, 4).setValues([CABECERA_INDICE]);
    h.setFrozenRows(1);
  }
  // Si está vacía, la cabecera primero: `leerIndice` del WMS empieza en la
  // fila 2 y sin cabecera se comería la primera guía.
  if (h.getLastRow() === 0) {
    h.getRange(1, 1, 1, 4).setValues([CABECERA_INDICE]);
  }

  h.appendRow([guia, house, new Date(), ORIGEN_APP]);
  return true;
}

// La misma normalización que usa el WMS en la columna A: sin guiones, sin
// espacios y en mayúsculas. Si aquí se guarda «1Z 613 V09…» y allí se busca
// «1Z613V09…», no casan y la house no sale, sin ningún error que lo explique.
function claveGuia_(v) {
  return String(v === undefined || v === null ? '' : v)
         .trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Los dos largos buenos: 18 empezando por 1Z, u 11 caracteres.
//
// ONCE CARACTERES, NO ONCE DÍGITOS. Las guías cortas llevan letra delante
// —«V0264205381»— y exigir dígitos tiraba guías buenas.
function esGuiaBuena_(g) {
  if (/^1Z[A-Z0-9]{16}$/.test(g)) return true;
  return /^[A-Z0-9]{11}$/.test(g);
}

function responder(objeto) {
  return ContentService
    .createTextOutput(JSON.stringify(objeto))
    .setMimeType(ContentService.MimeType.JSON);
}
