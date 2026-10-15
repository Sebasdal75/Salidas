'use strict';
// =========================================================================
// EL MOTOR DE UNA GLOBAL
//
// Es `actualizarGlobalPreforma` de Codigo.gs, trasladada a una función pura:
// recibe lo escaneado en una unidad (columna A), su lista esperada (columna O,
// la «preforma») y lo que hay en las OTRAS unidades, y devuelve el estado, el
// color y la hora de cada fila, más los totales.
//
// Se conserva el ORDEN DE DECISIONES del original, porque ese orden es la
// regla: lo que se pisa a qué, y qué alerta aguanta. Las funciones citan su
// origen para poder compararlas con el código de la hoja.
//
// Sin base de datos ni red: se prueba con arreglos. Quien guarda y sirve es
// `servicio.js`.
//
// LO QUE TODAVÍA NO ESTÁ (fase 2 en adelante, ver docs/APP-FASES.md) entra por
// `hooks` y `ms`, que por defecto no dicen nada:
//   · hooks.retenida(valor)   → «🛑 RETENIDA (FEMAD)» o ""        (FEMAD)
//   · hooks.yaSalio(valor, ped) → «⛔ YA SALIÓ el …» o ""          (salidas)
//   · hooks.pedimentoUsado(ped) → «🛑 PEDIMENTO YA USADO …» o ""   (otros días)
//   · hooks.costal(valor)     → true si es un costal               (costales)
//   · ms.guiasOrigen / ms.registroMS                               (las M-S)
// =========================================================================

const R = require('./reglas');
const { COLOR, SEP_RESUMEN } = R;

const HOOKS_VACIOS = {
  retenida: () => '',
  yaSalio: () => '',
  pedimentoUsado: () => '',
  costal: () => false,
};

function texto(v) { return String(v === undefined || v === null ? '' : v); }

// horaPreservada: solo sella la hora cuando la celda estaba vacía.
function horaPreservada(valorFila, previa, ahora) {
  if (texto(valorFila).trim() === '') return '';
  return texto(previa).trim() !== '' ? previa : ahora;
}

// pedimentosPorFila: el pedimento que manda sobre cada fila, en una pasada.
// En la A el pedimento ENCABEZA su bloque (hacia adelante); en la O va DEBAJO
// de sus guías (hacia atrás).
function pedimentosPorFila(valores, haciaAbajo) {
  const n = valores.length;
  const out = new Array(n);
  let actual = '';
  const paso = (i) => {
    const v = texto(valores[i]).trim().toUpperCase();
    if (R.esPedimento(v)) actual = v;
    else if (R.esMarcadorEstructural(v)) actual = '';
    out[i] = actual;
  };
  if (haciaAbajo) { for (let i = n - 1; i >= 0; i--) paso(i); }
  else { for (let i = 0; i < n; i++) paso(i); }
  return out;
}

// repetidasEnPreforma: guía repetida dentro de la O → su primera aparición.
function repetidasEnPreforma(bloques) {
  const out = new Map();
  const vistas = new Map();
  bloques.forEach(bloque => {
    bloque.guias.forEach((g, k) => {
      if (R.esMarcadorEstructural(g)) return;
      const idx = bloque.filasGuias[k];
      const previa = vistas.get(g);
      if (previa) out.set(idx, previa);
      else vistas.set(g, { ped: bloque.pedimento, idx: idx });
    });
  });
  return out;
}

function pedimentoDeFilaPreforma(bloques, fila) {
  for (const b of bloques) if (b.filasGuias.indexOf(fila) !== -1) return b.pedimento;
  return 'SIN_CABECERA';
}

// escribirAvisoPreforma: no pisa un aviso más grave ni apila dos.
function escribirAvisoPreforma(estadosP, coloresP, fila, textoAviso, color) {
  const previo = texto(estadosP[fila]);
  if (!R.puedePisar(previo, textoAviso)) return;
  if (R.nivelAlerta(previo) > R.NIVEL.INFO) return;
  estadosP[fila] = previo === '' ? textoAviso : textoAviso + ' | ' + previo;
  coloresP[fila] = color;
}

function anotarRepeticion(repeticiones, idx, filaRepetida) {
  let info = repeticiones.get(idx);
  if (!info) { info = { veces: 0, fila: filaRepetida }; repeticiones.set(idx, info); }
  info.veces++;
}

// conservarAlertasGraves: «una alerta grave no se cae sola». Lo recalculado solo
// pisa a lo que ya había si es igual de grave o más. Se salta cuando la columna
// está vacía (borrar limpia), cuando la fila se acaba de editar («hasta que se
// modifique») y cuando se fuerza («Forzar actualización» no conserva nada).
function conservarAlertasGraves(valores, previos, estados, colores, forzar, filasEditadas) {
  if (forzar) return 0;
  let conservadas = 0;
  for (let i = 0; i < valores.length; i++) {
    if (texto(valores[i]).trim() === '') continue;
    if (filasEditadas && filasEditadas.has(i)) continue;
    const conservado = R.conservarAlertaGrave(texto(previos[i]), estados[i]);
    if (conservado === estados[i]) continue;
    estados[i] = conservado;
    colores[i] = R.colorDeAlerta(conservado);
    conservadas++;
  }
  return conservadas;
}

// -------------------------------------------------------------------------
// calcularUnidad
//
// entrada = {
//   nombre,                          'GLOBAL 1 20-AE-3H'
//   fisico:   [{valor, estado, hora}]      columna A y su estado/hora de antes
//   preforma: [{valor, estado, hora, letra}]  columna O (y N), estado/hora de antes
//   otras: { guias: Map(guía → [{hoja, fila}]), pedimentos: Map(ped → [{hoja, fila}]) }
//          lo que hay en las OTRAS Globales (nunca la propia, ni M-S, ni inventarios)
//   ahora: 'HH:mm:ss'
//   forzar: bool                     «Forzar actualización»: no conserva alertas
//   filasEditadas: Set(idx)          filas recién tocadas
//   hooks, ms, exigirMS              ver arriba
// }
// -------------------------------------------------------------------------
function calcularUnidad(entrada) {
  const nombre = R.claveUnidad(entrada.nombre);
  const hooks = Object.assign({}, HOOKS_VACIOS, entrada.hooks || {});
  const ms = entrada.ms || { guiasOrigen: new Map(), registroMS: new Map() };
  const guiasEnMS = ms.guiasOrigen || new Map();
  const registroMS = ms.registroMS || new Map();
  const otras = entrada.otras || { guias: new Map(), pedimentos: new Map() };
  const ahora = entrada.ahora || '00:00:00';
  const fisico = entrada.fisico || [];
  const pref = entrada.preforma || [];
  const n = Math.max(fisico.length, pref.length);

  const A = []; const O = [];
  for (let i = 0; i < n; i++) {
    const f = fisico[i] || {}; const p = pref[i] || {};
    A.push({ valor: texto(f.valor).trim(), estado: texto(f.estado).trim(), hora: f.hora });
    O.push({ valor: texto(p.valor).trim(), estado: texto(p.estado).trim(), hora: p.hora, letra: p.letra });
  }

  const esRezago = nombre.indexOf('REZAGO') !== -1;
  const rezagoCruzaMS = esRezago && nombre.indexOf('MS') !== -1;
  const esTransito = nombre.indexOf('TRANSITO') !== -1 || nombre.indexOf('TRÁNSITO') !== -1;
  // En un arribo no se exige registro previo en M-S. Y mientras no exista el
  // módulo de las M-S (fase 2) tampoco se exige en ninguna: `exigirMS` lo prende.
  const requiereAlertaMS = !!entrada.exigirMS && !esRezago && !esTransito;

  // ---- 1. LA PREFORMA: estado de arranque de cada fila de la O ----------
  const pedsPorFilaO = pedimentosPorFila(O.map(x => x.valor), true);
  const estadosP = [], horasP = [], coloresP = [], coloresO = [];
  for (let i = 0; i < n; i++) {
    const valP = O[i].valor, estP = O[i].estado;
    const esErrP = valP !== '' && estP.startsWith('🛑 ERROR');
    const retP = esErrP ? '' : texto(hooks.retenida(valP));
    const yaP = (esErrP || retP !== '') ? '' : texto(hooks.yaSalio(valP, pedsPorFilaO[i]));
    estadosP.push(esErrP ? estP : (retP !== '' ? retP : yaP));
    horasP.push(horaPreservada(valP, O[i].hora, ahora));
    coloresP.push(esErrP ? COLOR.AMARILLO : (retP !== '' ? COLOR.ROJO : (yaP !== '' ? COLOR.NARANJA : '#FFFFFF')));
    coloresO.push(yaP !== '' ? COLOR.A_DUPLICADO : '#FFFFFF');
  }

  // ---- 2. Los bloques de la preforma ------------------------------------
  let totalPedimentosPreforma = 0, totalBultosPreforma = 0;
  const bloquesPreforma = [];
  const pedimentosVistosPreforma = new Set();
  const filasDuplicadasPreforma = new Set();

  if (esRezago) {
    // En el rezago el pedimento ABRE su bloque.
    let b = null;
    for (let i = 0; i < n; i++) {
      const v = O[i].valor.toUpperCase(); if (v === '') continue;
      const esErrP = estadosP[i] !== '';
      if (R.esPedimento(v)) {
        if (!esErrP) totalPedimentosPreforma++;
        if (pedimentosVistosPreforma.has(v)) filasDuplicadasPreforma.add(i); else pedimentosVistosPreforma.add(v);
        if (b) bloquesPreforma.push(b);
        b = { pedimento: v, filaPedimento: i, guias: [], filasGuias: [], esErr: esErrP };
      } else if (R.esMarcadorEstructural(v)) {
        // ni cuenta ni se marca
      } else if (!R.esGuiaUPSValida(v)) {
        if (estadosP[i] === '') { estadosP[i] = R.textoCapturaInvalida(v); coloresP[i] = R.COLOR.A_DUPLICADO; }
      } else {
        totalBultosPreforma++;
        if (b) { b.guias.push(v); b.filasGuias.push(i); }
        else b = { pedimento: 'SIN_CABECERA', filaPedimento: -1, guias: [v], filasGuias: [i], esErr: false };
      }
    }
    if (b) bloquesPreforma.push(b);
  } else {
    // En las demás el pedimento CIERRA su bloque, por debajo de sus guías.
    let gTmp = [], fTmp = [];
    for (let i = 0; i < n; i++) {
      const v = O[i].valor.toUpperCase(); if (v === '') continue;
      const esErrP = estadosP[i] !== '';
      if (R.esPedimento(v)) {
        if (!esErrP) totalPedimentosPreforma++;
        if (pedimentosVistosPreforma.has(v)) filasDuplicadasPreforma.add(i); else pedimentosVistosPreforma.add(v);
        bloquesPreforma.push({ pedimento: v, filaPedimento: i, guias: gTmp.slice(), filasGuias: fTmp.slice(), esErr: esErrP });
        gTmp = []; fTmp = [];
      } else if (R.esMarcadorEstructural(v)) {
        // no es guía ni pedimento
      } else if (!R.esGuiaUPSValida(v)) {
        if (estadosP[i] === '') { estadosP[i] = R.textoCapturaInvalida(v); coloresP[i] = R.COLOR.A_DUPLICADO; }
      } else {
        totalBultosPreforma++; gTmp.push(v); fTmp.push(i);
      }
    }
    if (gTmp.length > 0) {
      bloquesPreforma.push({ pedimento: 'SIN_CABECERA', filaPedimento: -1, guias: gTmp.slice(), filasGuias: fTmp.slice(), esErr: false });
    }
  }

  const repetidasPreforma = repetidasEnPreforma(bloquesPreforma);
  const guiasPreformaSinPedimento = new Map();   // guía → fila en la O
  const filaPreformaDeGuia = new Map();
  const filaPedimentoPreforma = new Map();
  const pedimentosGemelos = new Map();           // ped en la O → ped en la A
  const guiasEnOtroPedimento = new Map();        // guía → ped bajo el que se escaneó
  const mapaPreformas = new Map();               // ped → Set(guías)
  const mapaInversoPreforma = new Map();         // guía → ped

  bloquesPreforma.forEach(bloque => {
    const pedimento = bloque.pedimento;
    const setGuias = new Set(bloque.guias);
    if (pedimento !== '' && pedimento !== 'SIN_CABECERA') {
      mapaPreformas.set(pedimento, setGuias);
      setGuias.forEach(g => mapaInversoPreforma.set(g, pedimento));
      bloque.guias.forEach((g, k) => {
        if (bloque.filasGuias[k] !== undefined) filaPreformaDeGuia.set(g, bloque.filasGuias[k]);
      });
      if (bloque.filaPedimento !== -1) filaPedimentoPreforma.set(pedimento, bloque.filaPedimento);
    } else if (bloque.filasGuias.length > 0 && !esRezago) {
      bloque.guias.forEach((g, k) => {
        if (bloque.filasGuias[k] !== undefined) guiasPreformaSinPedimento.set(g, bloque.filasGuias[k]);
      });
    }

    let colorFondo = '#00ff00';
    if (bloque.filaPedimento !== -1) {
      colorFondo = R.colorBloqueO(O[bloque.filaPedimento].letra);
      coloresO[bloque.filaPedimento] = R.COLOR.A_PEDIMENTO;
    }
    bloque.filasGuias.forEach(fG => { coloresO[fG] = colorFondo; });

    if (bloque.esErr) return;
    const textoEsperando = setGuias.size + ' bultos';
    if (bloque.filaPedimento !== -1 && !esRezago) estadosP[bloque.filaPedimento] = textoEsperando;
    if (bloque.filasGuias.length > 0 && !esRezago) {
      estadosP[bloque.filasGuias[bloque.filasGuias.length - 1]] = '► Resumen: ' + textoEsperando;
    }
  });

  filasDuplicadasPreforma.forEach(fila => {
    if (R.puedePisar(estadosP[fila], '⚠️ PEDIMENTO REPETIDO')) {
      estadosP[fila] = '⚠️ PEDIMENTO REPETIDO';
      coloresP[fila] = COLOR.AMARILLO;
    }
  });
  filasDuplicadasPreforma.forEach(fila => { coloresO[fila] = R.COLOR.A_DUPLICADO; });

  const repesPreforma = new Map();
  repetidasPreforma.forEach((previa, fila) => {
    const pedDeEsta = pedimentoDeFilaPreforma(bloquesPreforma, fila);
    const dupLocal = R.duplicadoLocal(previa, pedDeEsta);
    coloresO[fila] = R.COLOR.A_DUPLICADO;
    coloresO[previa.idx] = R.COLOR.A_DUPLICADO;
    escribirAvisoPreforma(estadosP, coloresP, fila, dupLocal.texto.replace('DUPLICADO', 'GUÍA REPETIDA'), dupLocal.color);
    if (dupLocal.marcarPrimera) anotarRepeticion(repesPreforma, previa.idx, fila + 1);
  });
  repesPreforma.forEach((info, idx) => {
    escribirAvisoPreforma(estadosP, coloresP, idx,
      R.textoPrimeraDuplicada(info).replace('DUPLICADO', 'GUÍA REPETIDA'), COLOR.NARANJA);
  });

  // El registro de las M-S se dobla sobre la preforma (fase 2).
  if (!esRezago || rezagoCruzaMS) {
    registroMS.forEach((guiasSet, pedimento) => {
      if (!mapaPreformas.has(pedimento)) mapaPreformas.set(pedimento, new Set());
      guiasSet.forEach(g => {
        mapaPreformas.get(pedimento).add(g);
        mapaInversoPreforma.set(g, pedimento);
      });
    });
  }

  // ---- 3. LA COLUMNA A: estado de arranque de cada fila ------------------
  const pedsPorFilaA = pedimentosPorFila(A.map(x => x.valor), false);

  // Duplicados con otras Globales (calcularDuplicadosExternos).
  const dupExternos = new Map();
  for (let i = 0; i < n; i++) {
    const v = A[i].valor.toUpperCase();
    if (v === '' || v.startsWith('IW') || R.esCabeceraBloque(v)) continue;
    const lista = otras.guias.get(v);
    if (lista && lista.length) dupExternos.set(i, lista[0]);
  }

  const estadosB = [], horasB = [], coloresB = [];
  const movidasEnA = new Map();
  for (let i = 0; i < n; i++) {
    const valB = A[i].valor, estB = A[i].estado;
    const esErrEstructura = estB.startsWith('🛑 ERROR');
    const esMovido = R.esEstadoSalida(estB);
    const dup = dupExternos.get(i);
    if (esMovido && valB !== '') movidasEnA.set(valB.toUpperCase(), R.cabezaEstado(estB));

    let fijo = '', color = '#FFFFFF';
    if (valB === '') {
      // fila vacía: todo en blanco
    } else if (esErrEstructura) { fijo = estB; color = COLOR.AMARILLO; }
    else if (texto(hooks.retenida(valB)) !== '') { fijo = '🛑 RETENIDA (FEMAD)'; color = COLOR.ROJO; }
    else if (dup) { fijo = '⛔ DUPLICADO (En: ' + dup.hoja + ' Fila ' + dup.fila + ')'; color = COLOR.NARANJA; }
    else if (esMovido) { fijo = estB; color = COLOR.GRIS_CLARO; }
    else {
      const ya = texto(hooks.yaSalio(valB, pedsPorFilaA[i]));
      if (ya !== '') { fijo = ya; color = COLOR.NARANJA; }
    }
    estadosB.push(fijo);
    horasB.push(horaPreservada(valB, A[i].hora, ahora));
    coloresB.push(color);
  }

  // ---- 4. Las guías de la A y sus bloques --------------------------------
  const guiasGlobales = new Set();
  const escaneadasEnA = new Set();
  for (let i = 0; i < n; i++) {
    const v = A[i].valor.toUpperCase();
    if (v === '' || R.esPedimento(v) || !R.esGuiaUPSValida(v)) continue;
    escaneadasEnA.add(v); guiasGlobales.add(v);
  }

  let totalPedimentos = 0;
  const bloquesFisicos = [];
  const pedimentosVistosFisico = new Map();
  const filasDuplicadasFisico = new Map();
  let bAct = null;
  for (let i = 0; i < n; i++) {
    const v = A[i].valor.toUpperCase(); if (v === '') continue;
    const esErr = estadosB[i] !== '';
    if (R.esCabeceraBloque(v)) {
      if (R.esPedimento(v)) {
        if (!esErr) totalPedimentos++;
        if (pedimentosVistosFisico.has(v)) {
          const primera = pedimentosVistosFisico.get(v);
          filasDuplicadasFisico.set(i, primera + 1);
          filasDuplicadasFisico.set(primera, i + 1);
        } else {
          pedimentosVistosFisico.set(v, i);
        }
      }
      if (bAct) bloquesFisicos.push(bAct);
      bAct = { pedimento: v, filaPedimento: i, guias: [], filasGuias: [], esErr: esErr, conAlerta: 0 };
    } else if (esErr) {
      if (bAct) bAct.conAlerta++;
    } else if (!R.esGuiaUPSValida(v)) {
      estadosB[i] = R.textoCapturaInvalida(v);
      coloresB[i] = R.COLOR.A_DUPLICADO;
      if (bAct) bAct.conAlerta++;
    } else {
      if (bAct) { bAct.guias.push(v); bAct.filasGuias.push(i); }
      else bAct = { pedimento: 'SIN_CABECERA', filaPedimento: -1, guias: [v], filasGuias: [i], esErr: false, conAlerta: 0 };
    }
  }
  if (bAct) bloquesFisicos.push(bAct);

  if (guiasPreformaSinPedimento.size > 0) {
    bloquesFisicos.forEach(bf => bf.guias.forEach(g => {
      const filaO = guiasPreformaSinPedimento.get(g);
      if (filaO !== undefined) {
        escribirAvisoPreforma(estadosP, coloresP, filaO, '⚠️ SIN PEDIMENTO: falta ponerlo DEBAJO, en la O', COLOR.AMARILLO);
      }
    }));
  }

  // ---- 5. Faltantes por pedimento y pedimento «gemelo» --------------------
  const primeraAparicion = new Map();
  const repeticiones = new Map();
  const filasParejaDuplicada = new Set();
  const pedimentosCompletos = new Set();
  const guiasFaltantes = new Map();

  mapaPreformas.forEach((set, ped) => {
    const faltantes = [];
    set.forEach(g => { if (!escaneadasEnA.has(g)) faltantes.push(g); });
    guiasFaltantes.set(ped, faltantes);
    if (faltantes.length === 0 && set.size > 0) pedimentosCompletos.add(ped);
  });

  // Mismos 1Z, otro número: un dedazo en el pedimento, no guías descolocadas.
  const preformaPorConjunto = new Map();
  mapaPreformas.forEach((set, p) => {
    if (set.size === 0) return;
    preformaPorConjunto.set(Array.from(set).sort().join('|'), p);
  });

  bloquesFisicos.forEach(bloque => {
    const ped = bloque.pedimento;
    const esperadas = mapaPreformas.get(ped) || new Set();

    let pedGemelo = null;
    if (esperadas.size === 0 && bloque.guias.length > 0 && ped !== '' && ped !== 'SIN_CABECERA' && !bloque.esErr) {
      const clave = Array.from(new Set(bloque.guias)).sort().join('|');
      const candidato = preformaPorConjunto.get(clave);
      if (candidato && candidato !== ped) pedGemelo = candidato;
    }
    let sobran = 0;
    const escaneadasUnicas = new Set();
    const origenesReales = new Set();
    const txtFalta = requiereAlertaMS ? ' ⚠️ Sin registrar en M-S' : '';

    bloque.guias.forEach((g, idx) => {
      const filaG = bloque.filasGuias[idx];
      const origen = guiasEnMS.get(g);
      const pedReal = mapaInversoPreforma.get(g);
      const sufijoOrigen = origen ? ' (Escaneado en ' + origen + ')' : '';

      const previa = primeraAparicion.get(g);
      if (previa) {
        const dupLocal = R.duplicadoLocal(previa, ped);
        estadosB[filaG] = dupLocal.texto;
        coloresB[filaG] = dupLocal.color;
        // conAlerta se contó antes: el duplicado se descubre AQUÍ.
        if (R.duplicadoBloqueaCierre(dupLocal.texto)) bloque.conAlerta++;
        filasParejaDuplicada.add(filaG); filasParejaDuplicada.add(previa.idx);
        if (dupLocal.marcarPrimera) anotarRepeticion(repeticiones, previa.idx, filaG + 1);
        return;
      }
      primeraAparicion.set(g, { ped: ped, idx: filaG });
      escaneadasUnicas.add(g);
      if (origen) origenesReales.add(origen);

      if (esRezago) {
        if (pedReal) {
          const deDonde = (rezagoCruzaMS && origen) ? ' (' + origen + ')' : '';
          estadosB[filaG] = pedimentosCompletos.has(pedReal)
            ? '✅ Recuperado (Ped: ' + pedReal + ')' + deDonde + ' | 🌟 COMPLETO'
            : '✅ Recuperado (Ped: ' + pedReal + ')' + deDonde;
          coloresB[filaG] = COLOR.OK;
        } else if (hooks.costal(g)) {
          estadosB[filaG] = '✅ Guía'; coloresB[filaG] = COLOR.GUIA;
        } else {
          estadosB[filaG] = '⚠️ Ajena (No es de rezago)'; coloresB[filaG] = R.COLOR.A_DUPLICADO;
        }
        return;
      }

      if (esperadas.size === 0) {
        if (pedReal && pedReal !== ped) {
          estadosB[filaG] = '❌ Va en: ' + pedReal; coloresB[filaG] = COLOR.ROJO_SUAVE;
          if (pedGemelo) pedimentosGemelos.set(pedGemelo, ped); else guiasEnOtroPedimento.set(g, ped);
          sobran++;
        } else {
          estadosB[filaG] = '✅ Guía' + sufijoOrigen;
          coloresB[filaG] = (!origen && requiereAlertaMS) ? COLOR.AMARILLO : COLOR.GUIA;
        }
      } else if (esperadas.has(g)) {
        estadosB[filaG] = '✅ Ok' + sufijoOrigen; coloresB[filaG] = COLOR.OK;
      } else if (pedReal) {
        estadosB[filaG] = '❌ Va en: ' + pedReal; coloresB[filaG] = COLOR.ROJO_SUAVE;
        if (pedGemelo) pedimentosGemelos.set(pedGemelo, ped); else guiasEnOtroPedimento.set(g, ped);
        sobran++;
      } else if (hooks.costal(g)) {
        estadosB[filaG] = '✅ Guía'; coloresB[filaG] = COLOR.GUIA;
      } else {
        estadosB[filaG] = '⚠️ Sobra (Ajena)' + (origen ? sufijoOrigen : txtFalta);
        coloresB[filaG] = R.COLOR.A_DUPLICADO;
        sobran++;
      }
    });

    // El resumen del pedimento.
    if (bloque.esErr || ped === 'SIN_CABECERA' || esRezago) return;
    let estadoStr = '';
    const nota = R.notaConAlerta(bloque.conAlerta);

    if (esperadas.size === 0) {
      if (pedGemelo) {
        estadoStr = '⚠️ PEDIMENTOS NO COINCIDEN: estos mismos ' + bloque.guias.length +
                    ' 1Z están registrados bajo el pedimento ' + pedGemelo;
        coloresB[bloque.filaPedimento] = COLOR.AMARILLO;
      } else if (escaneadasUnicas.size === 0) {
        estadoStr = nota !== '' ? nota : '⚠️ No en preforma';
        coloresB[bloque.filaPedimento] = COLOR.FALTA;
      } else {
        let registradoEnMS = true;
        bloque.guias.forEach(g => { if (!guiasEnMS.has(g)) registradoEnMS = false; });
        if (!registradoEnMS && requiereAlertaMS) {
          estadoStr = txtFalta.trim();
          coloresB[bloque.filaPedimento] = COLOR.AMARILLO;
        } else if (nota !== '') {
          estadoStr = '';
          coloresB[bloque.filaPedimento] = COLOR.AMARILLO;
        } else {
          if (nombre.indexOf('A1') !== -1) estadoStr = '✅ A1 COMPLETO';
          else if (origenesReales.size > 0) estadoStr = '✅ ' + Array.from(origenesReales).sort().join(' + ');
          else estadoStr = '✅ Escaneado';
          coloresB[bloque.filaPedimento] = R.COLOR.A_PEDIMENTO;
        }
      }
    } else {
      const faltantes = guiasFaltantes.get(ped) || [];
      const faltan = faltantes.length;
      if (faltan === 0 && sobran === 0) {
        if (escaneadasUnicas.size === 0 || nota !== '') {
          estadoStr = '';
          coloresB[bloque.filaPedimento] = nota !== '' ? COLOR.AMARILLO : COLOR.NEUTRO_BLOQUE;
        } else {
          estadoStr = '✅ COMPLETO';
          coloresB[bloque.filaPedimento] = COLOR.OK;
        }
      } else {
        const det = [];
        if (faltan > 0) det.push('❌ Faltan ' + faltan + ' (' + faltantes.join(', ') + ')');
        if (sobran > 0) det.push('⚠️ Sobran ' + sobran);
        estadoStr = det.join(' y ');
        coloresB[bloque.filaPedimento] = COLOR.FALTA;
      }
    }
    if (nota !== '' && estadoStr.indexOf('con alerta') === -1) {
      estadoStr = estadoStr === '' ? nota : estadoStr + ' | ' + nota;
    }
    const txtResumen = 'Bultos: ' + escaneadasUnicas.size + (estadoStr !== '' ? ' | ' + estadoStr : '');
    estadosB[bloque.filaPedimento] = txtResumen;

    if (bloque.filasGuias.length > 0) {
      const fUltima = bloque.filasGuias[bloque.filasGuias.length - 1];
      estadosB[fUltima] = R.cabezaEstado(estadosB[fUltima]).replace(/ \(Escaneado en .*?\)/g, '') +
                          SEP_RESUMEN + txtResumen;
    }
  });

  // ---- 6. Avisos que se escriben también en la O --------------------------
  pedimentosGemelos.forEach((pedEnA, pedEnO) => {
    const filaP = filaPedimentoPreforma.get(pedEnO);
    if (filaP === undefined) return;
    escribirAvisoPreforma(estadosP, coloresP, filaP,
      '⚠️ PEDIMENTOS NO COINCIDEN: los mismos 1Z se escanearon bajo ' + pedEnA, COLOR.AMARILLO);
  });
  guiasEnOtroPedimento.forEach((pedEscaneado, g) => {
    const filaO = filaPreformaDeGuia.get(g);
    if (filaO === undefined) return;
    escribirAvisoPreforma(estadosP, coloresP, filaO,
      '⚠️ PEDIMENTOS NO COINCIDEN: se escaneó en ' + pedEscaneado, COLOR.AMARILLO);
  });

  // Se pintan las DOS guías de la pareja.
  repeticiones.forEach((info, idx) => {
    estadosB[idx] = R.textoPrimeraDuplicada(info) + R.colaResumen(estadosB[idx]);
    coloresB[idx] = COLOR.NARANJA;
  });

  // El mismo pedimento dos veces en ESTA unidad: las dos filas.
  filasDuplicadasFisico.forEach((otraFila, fila) => {
    if (texto(estadosB[fila]).startsWith('⛔')) return;
    estadosB[fila] = '🛑 PEDIMENTO REPETIDO (también en la fila ' + otraFila + ')';
    coloresB[fila] = COLOR.ROJO;
    filasParejaDuplicada.add(fila);
  });

  // El mismo pedimento en OTRA Global.
  for (let i = 0; i < n; i++) {
    const v = A[i].valor;
    if (!R.esPedimento(v)) continue;
    const lista = otras.pedimentos.get(v);
    if (!lista || !lista.length) continue;
    if (R.nivelAlerta(estadosB[i]) >= R.NIVEL.CRITICO) continue;
    estadosB[i] = '🛑 PEDIMENTO REPETIDO (En: ' + lista[0].hoja + ' Fila ' + lista[0].fila + ')';
    coloresB[i] = COLOR.ROJO;
    filasParejaDuplicada.add(i);
  }

  // Y el que ya se usó OTRO DÍA (fase 2: el histórico de salidas).
  for (let i = 0; i < n; i++) {
    if (R.nivelAlerta(estadosB[i]) >= R.NIVEL.CRITICO) continue;
    if (!R.esPedimento(A[i].valor)) continue;
    const aviso = texto(hooks.pedimentoUsado(A[i].valor));
    if (aviso === '') continue;
    estadosB[i] = aviso + R.colaResumen(estadosB[i]);
    coloresB[i] = COLOR.ROJO;
  }

  // El rezago dice también, en la O, qué pedimentos están completos.
  if (esRezago) {
    bloquesPreforma.forEach(bloque => {
      if (bloque.pedimento !== '' && bloque.pedimento !== 'SIN_CABECERA' && !bloque.esErr) {
        if (pedimentosCompletos.has(bloque.pedimento)) {
          estadosP[bloque.filaPedimento] = '✅ REZAGO COMPLETO'; coloresP[bloque.filaPedimento] = COLOR.OK;
        } else {
          const faltantes = guiasFaltantes.get(bloque.pedimento) || [];
          estadosP[bloque.filaPedimento] = faltantes.length > 0
            ? '⏳ Faltan ' + faltantes.length + ' (' + faltantes.join(', ') + ')'
            : '⏳ Faltan 0 bultos';
          coloresP[bloque.filaPedimento] = COLOR.FALTA;
        }
      }
      // Las que ya se movieron, dichas también en la preforma.
      bloque.filasGuias.forEach(fila => {
        if (estadosP[fila] !== '') return;
        const txt = movidasEnA.get(O[fila].valor.toUpperCase());
        if (!txt) return;
        estadosP[fila] = txt; coloresP[fila] = COLOR.GRIS_CLARO;
      });
    });
    totalPedimentos = pedimentosCompletos.size;
  }

  // ---- 7. Colores de la A, y alertas que no se caen solas -----------------
  const coloresA = [];
  for (let i = 0; i < n; i++) {
    const esPareja = filasParejaDuplicada.has(i) && A[i].valor !== '';
    coloresA.push(esPareja ? R.COLOR.A_DUPLICADO : R.colorColumnaA(A[i].valor, estadosB[i]));
  }
  const filasEd = entrada.filasEditadas || null;
  conservarAlertasGraves(A.map(x => x.valor), A.map(x => x.estado), estadosB, coloresB, entrada.forzar, filasEd);
  conservarAlertasGraves(O.map(x => x.valor), O.map(x => x.estado), estadosP, coloresP, entrada.forzar, filasEd);

  return {
    filas: A.map((x, i) => ({ valor: x.valor, estado: estadosB[i], color: coloresB[i], colorA: coloresA[i], hora: horasB[i] })),
    preforma: O.map((x, i) => ({ valor: x.valor, estado: estadosP[i], color: coloresP[i], colorO: coloresO[i], hora: horasP[i] })),
    totales: {
      bultos: guiasGlobales.size,
      pedimentos: totalPedimentos,
      etiquetaPedimentos: esRezago ? 'Pedimentos (Completos)' : 'Total pedimentos',
      bultosPreforma: totalBultosPreforma,
      pedimentosPreforma: totalPedimentosPreforma,
    },
  };
}

module.exports = { calcularUnidad, pedimentosPorFila, horaPreservada };
