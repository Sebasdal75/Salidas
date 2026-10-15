'use strict';
// =========================================================================
// REGLAS PURAS: lo que dice el sistema actual (Codigo.gs) sobre qué es cada
// cosa que se escanea. Sin base de datos, sin red: solo texto entra y sale.
//
// Cada función dice de qué función de Codigo.gs viene, para poder comparar.
// Los textos y los colores son LOS MISMOS que en la hoja: los operadores ya
// los conocen y el manual los explica.
// =========================================================================

// ---- Colores (Codigo.gs, líneas 62-67 y alrededores) --------------------
const COLOR = {
  A_PEDIMENTO: '#178ccc',   // pedimento (7 dígitos) → azul
  A_GUIA: '#00ff00',        // guía válida → verde
  A_DUPLICADO: '#df5f6b',   // duplicada → rojo
  A_UBICACION: '#a4c2f4',   // ubicación IW en inventarios → azul claro
  A_NEUTRO: '#ffffff',
  OK: '#07c369',
  GUIA: '#71b3e6',
  AMARILLO: '#ffc107',
  NARANJA: '#ff9800',
  ROJO_SUAVE: '#f5c6cb',
  ROJO: '#dc3545',
  GRIS: '#acacac',
  GRIS_CLARO: '#e0e0e0',
  FALTA: '#FFF3CD',
  NEUTRO_BLOQUE: '#e2e3e5',
};

// ---- Textos fijos -------------------------------------------------------
const SEP_RESUMEN = '   ►   ';   // separa el estado de la guía del resumen del bloque

// ---- Marcadores y tipos de valor ---------------------------------------

// esMarcadorEstructural
function esMarcadorEstructural(v) {
  const s = String(v === undefined || v === null ? '' : v).trim().toUpperCase();
  if (s === '') return false;
  return s === 'COSTALES' || s === 'FIN' || s === 'SIN_CABECERA' || s.indexOf('SIN PEDIMENTO') !== -1;
}

function esPedimento(v) {
  return /^\d{7}$/.test(String(v === undefined || v === null ? '' : v).trim());
}

// esCabeceraBloque
function esCabeceraBloque(v) {
  return esPedimento(v) || esMarcadorEstructural(v);
}

// esUbicacionIW
function esUbicacionIW(valor) {
  return String(valor === undefined || valor === null ? '' : valor).trim().toUpperCase().indexOf('IW') === 0;
}

// esGuiaUPSValida: 7 dígitos = pedimento (no es guía), 18 desde «1Z» con dígito
// de control, u 11 caracteres = guía corta. Todo lo demás está mal escrito.
const MAPA_1Z = { A: 2, B: 3, C: 4, D: 5, E: 6, F: 7, G: 8, H: 9, I: 0, J: 1, K: 2, L: 3, M: 4, N: 5, O: 6,
                  P: 7, Q: 8, R: 9, S: 0, T: 1, U: 2, V: 3, W: 4, X: 5, Y: 6, Z: 7 };
function esGuiaUPSValida(guia) {
  const g = String(guia === undefined || guia === null ? '' : guia).trim().toUpperCase();
  if (g === '' || /^\d{7}$/.test(g)) return false;
  if (esMarcadorEstructural(g)) return false;
  if (g.startsWith('1Z')) {
    if (g.length !== 18) return false;
    const numStr = g.substring(2, 17);
    const real = parseInt(g.substring(17), 10);
    if (isNaN(real)) return false;
    let impares = 0, pares = 0;
    for (let i = 0; i < 15; i++) {
      const c = numStr.charAt(i);
      const val = (c >= '0' && c <= '9') ? parseInt(c, 10) : MAPA_1Z[c];
      if (val === undefined || isNaN(val)) return false;
      if (i % 2 === 0) impares += val; else pares += val;
    }
    return ((10 - ((impares + pares * 2) % 10)) % 10) === real;
  }
  return /^[A-Z0-9]{11}$/.test(g);
}

// ---- Captura -----------------------------------------------------------

// normalizacionAEscribir: lo que el escáner mete se limpia a [A-Z0-9] en mayúsculas.
function normalizarCaptura(crudo) {
  if (typeof crudo !== 'string') return String(crudo === undefined || crudo === null ? '' : crudo);
  return crudo.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// detectarGuiasPegadas
function detectarGuiasPegadas(valor) {
  const v = String(valor).trim().toUpperCase();
  if (v.length <= 18) return null;
  if (v.startsWith('1Z')) {
    const seg = v.indexOf('1Z', 2);
    if (seg >= 16) return { primera: v.substring(0, seg), segunda: v.substring(seg) };
    if (v.length === 25 && /^\d{7}$/.test(v.substring(18))) {
      return { primera: v.substring(0, 18), segunda: v.substring(18) };
    }
  }
  const m = v.match(/^(\d{7})(1Z[0-9A-Z]{16})$/);
  if (m) return { primera: m[1], segunda: m[2] };
  return null;
}

// textoCapturaInvalida (sin la rama de comandos: en la app los comandos son botones)
function textoCapturaInvalida(valor) {
  const pegadas = detectarGuiasPegadas(valor);
  if (!pegadas) return '❌ Guía Inválida';
  return '❌ DOS PEGADAS: ' + pegadas.primera + ' + ' + pegadas.segunda;
}

// Escaneo de 1 a 6 dígitos: un pedimento incompleto. Devuelve el texto o "".
function errorDePedimentoCorto(valor) {
  const v = String(valor).trim();
  if (!/^\d{1,6}$/.test(v)) return '';
  const faltan = 7 - v.length;
  return '🛑 ERROR: Faltan ' + faltan + ' ' + (faltan === 1 ? 'número' : 'números');
}

// ---- Estados -----------------------------------------------------------

// cabezaEstado / colaResumen: el estado de la guía, y el resumen del bloque colgado.
function cabezaEstado(txt) {
  const t = String(txt === undefined || txt === null ? '' : txt);
  const corte = t.indexOf(SEP_RESUMEN);
  return (corte === -1 ? t : t.substring(0, corte)).trim();
}
function colaResumen(txt) {
  const t = String(txt === undefined || txt === null ? '' : txt);
  const corte = t.indexOf(SEP_RESUMEN);
  return corte === -1 ? '' : t.substring(corte);
}

// esEstadoSalida (para cuando exista el módulo de salidas / M-S)
function esEstadoSalida(txt) {
  const t = String(txt === undefined || txt === null ? '' : txt).trim();
  return t.startsWith('➡ Salió en ') || t.toUpperCase().startsWith('➡ MOVIDO A');
}

// ---- Alertas: quién gana cuando dos reglas hablan de la misma fila -----
const NIVEL = { CRITICO: 4, ALTO: 3, MEDIO: 2, AVISO: 1, INFO: 0 };

function nivelAlerta(texto) {
  const t = String(texto === undefined || texto === null ? '' : texto).trim();
  if (t === '') return NIVEL.INFO;
  if (t.startsWith('🛑')) return NIVEL.CRITICO;
  if (t.startsWith('⛔')) return NIVEL.ALTO;
  if (t.startsWith('❌')) return NIVEL.MEDIO;
  if (t.startsWith('⚠️') || t.startsWith('🔄')) return NIVEL.AVISO;
  return NIVEL.INFO;
}
function puedePisar(previo, nuevo) { return nivelAlerta(nuevo) >= nivelAlerta(previo); }

function esAlertaDeDuplicado(texto) {
  const t = cabezaEstado(texto);
  if (t.startsWith('🔄')) return true;
  const u = t.toUpperCase();
  return u.indexOf('DUPLICAD') !== -1 || u.indexOf('REPETID') !== -1;
}
// Una alerta grave no se cae sola: ⛔ para arriba, y cualquier duplicado.
function mereceConservarse(texto) {
  if (nivelAlerta(texto) >= NIVEL.ALTO) return true;
  return esAlertaDeDuplicado(texto);
}
function conservarAlertaGrave(previo, nuevo) {
  if (!mereceConservarse(previo)) return nuevo;
  if (puedePisar(cabezaEstado(previo), cabezaEstado(nuevo))) return nuevo;
  return cabezaEstado(previo) + colaResumen(nuevo);
}
function colorDeAlerta(texto) {
  const t = cabezaEstado(texto);
  if (t.startsWith('🛑 ERROR')) return COLOR.AMARILLO;
  if (t.startsWith('🛑')) return COLOR.ROJO;
  if (t.startsWith('⛔')) return COLOR.NARANJA;
  if (t.startsWith('❌')) return COLOR.A_DUPLICADO;
  if (t.startsWith('🔄')) return COLOR.GRIS;
  if (t.toUpperCase().indexOf('DUPLICAD') !== -1) return COLOR.NARANJA;
  if (t.toUpperCase().indexOf('REPETID') !== -1) return COLOR.AMARILLO;
  return COLOR.A_NEUTRO;
}

// Texto del duplicado dentro de la MISMA unidad (duplicadoLocal).
function duplicadoLocal(previa, pedActual) {
  const fila = previa.idx + 1;
  const tienePed = previa.ped && previa.ped !== 'SIN_CABECERA' && !esMarcadorEstructural(previa.ped);
  if (previa.ped === pedActual) {
    return { texto: '🔄 Duplicado local', color: COLOR.GRIS, marcarPrimera: false };
  }
  if (!tienePed) {
    return { texto: '⛔ DUPLICADO (ya escaneada en la fila ' + fila + ')', color: COLOR.NARANJA, marcarPrimera: true };
  }
  return { texto: '⛔ DUPLICADO (ya en Ped: ' + previa.ped + ', fila ' + fila + ')', color: COLOR.NARANJA, marcarPrimera: true };
}
function textoPrimeraDuplicada(info) {
  if (info.veces === 1) return '⚠️ DUPLICADO (repetida en la fila ' + info.fila + ')';
  return '⚠️ DUPLICADO (repetida ' + info.veces + ' veces, la 1ª en la fila ' + info.fila + ')';
}
function duplicadoBloqueaCierre(textoDup) { return nivelAlerta(textoDup) >= NIVEL.ALTO; }
function notaConAlerta(n) { return (!n || n <= 0) ? '' : '⚠️ ' + n + ' con alerta'; }

// Color de la columna A (colorColumnaA).
function colorColumnaA(valor, estado) {
  const v = String(valor === undefined || valor === null ? '' : valor).trim().toUpperCase();
  if (v === '') return COLOR.A_NEUTRO;
  if (String(estado || '').toUpperCase().indexOf('DUPLICAD') !== -1) return COLOR.A_DUPLICADO;
  if (v.startsWith('IW')) return COLOR.A_UBICACION;
  if (/^\d{7}$/.test(v)) return COLOR.A_PEDIMENTO;
  if (esMarcadorEstructural(v)) return COLOR.A_NEUTRO;
  if (esGuiaUPSValida(v)) return COLOR.A_GUIA;
  return COLOR.A_DUPLICADO;
}

// Color de bloque de la preforma según la letra de la columna N.
function colorBloqueO(letraN) {
  const l = String(letraN === undefined || letraN === null ? '' : letraN).trim().toLowerCase();
  if (l === 'a') return '#35ec09';
  if (l === 'b') return '#ff00ff';
  if (l === 'c') return '#39b1b9';
  return '#00ff00';
}

// ---- Nombres de unidad -------------------------------------------------
function claveUnidad(nombre) {
  return String(nombre === undefined || nombre === null ? '' : nombre).trim().toUpperCase();
}

module.exports = {
  COLOR, SEP_RESUMEN, NIVEL,
  esMarcadorEstructural, esPedimento, esCabeceraBloque, esUbicacionIW, esGuiaUPSValida,
  normalizarCaptura, detectarGuiasPegadas, textoCapturaInvalida, errorDePedimentoCorto,
  cabezaEstado, colaResumen, esEstadoSalida,
  nivelAlerta, puedePisar, esAlertaDeDuplicado, mereceConservarse, conservarAlertaGrave, colorDeAlerta,
  duplicadoLocal, textoPrimeraDuplicada, duplicadoBloqueaCierre, notaConAlerta,
  colorColumnaA, colorBloqueO, claveUnidad,
};
