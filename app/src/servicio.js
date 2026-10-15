'use strict';
// =========================================================================
// EL SERVICIO: lo que hace la app cuando alguien escanea, borra o pega.
//
// Reglas de oro, las mismas que en la hoja:
//   · cada escaneo se guarda y se recalcula DENTRO de una transacción;
//   · se recalcula la unidad entera desde sus renglones (el motor es puro);
//   · si el escaneo toca guías o pedimentos que están en OTRAS unidades, esas
//     también se recalculan (el duplicado aparece en las dos);
//   · lo que se borra o se sobrescribe queda en el historial.
// =========================================================================

const R = require('./reglas');
const { calcularUnidad } = require('./motor');
const { transaccion } = require('./db');

class ErrorDeUso extends Error {
  constructor(mensaje, codigo) { super(mensaje); this.codigo = codigo || 400; }
}

// Tamaños máximos: lo que entra por la red nunca se acepta sin tope.
const MAX_VALOR = 200;          // un código de barras largo trae ~150 caracteres
const MAX_NOMBRE_UNIDAD = 80;
const MAX_RENGLONES_PREFORMA = 20000;

function crearServicio(db, opciones) {
  const zona = (opciones && opciones.zona) || process.env.TZ || 'America/Mexico_City';
  const reloj = (opciones && opciones.reloj) || (() => new Date());
  const hooks = (opciones && opciones.hooks) || {};
  const exigirMS = !!(opciones && opciones.exigirMS);

  const fmtHora = new Intl.DateTimeFormat('en-GB', { timeZone: zona, hour12: false,
    hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const fmtFecha = new Intl.DateTimeFormat('sv-SE', { timeZone: zona, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const horaAhora = () => fmtHora.format(reloj());
  const fechaAhora = () => fmtFecha.format(reloj()).replace(' ', 'T');

  const q = {
    unidad: db.prepare('SELECT * FROM unidades WHERE id = ?'),
    unidades: db.prepare("SELECT * FROM unidades WHERE estado = 'abierta' ORDER BY id"),
    filas: db.prepare('SELECT * FROM filas WHERE unidad_id = ? AND lista = ? ORDER BY pos'),
    insFila: db.prepare(`INSERT INTO filas (unidad_id, lista, pos, valor, estado, color, color_a, hora, usuario, letra)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                         ON CONFLICT(unidad_id, lista, pos) DO UPDATE SET valor = excluded.valor,
                           estado = excluded.estado, color = excluded.color, color_a = excluded.color_a,
                           hora = excluded.hora, usuario = excluded.usuario, letra = excluded.letra`),
    setResultado: db.prepare(`UPDATE filas SET estado = ?, color = ?, color_a = ?, hora = ?
                              WHERE unidad_id = ? AND lista = ? AND pos = ?`),
    subeVersion: db.prepare('UPDATE unidades SET version = version + 1 WHERE id = ?'),
    historial: db.prepare(`INSERT INTO historial (fecha, usuario, unidad, lista, fila, valor, estado, motivo)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    historialDe: db.prepare('SELECT * FROM historial WHERE unidad = ? ORDER BY id DESC LIMIT ?'),
    // Lo que hay en OTRAS unidades abiertas del mismo tipo (el dominio de los duplicados).
    deOtras: db.prepare(`SELECT f.valor, f.pos, u.nombre FROM filas f JOIN unidades u ON u.id = f.unidad_id
                         WHERE f.lista = 'fisico' AND f.valor <> '' AND u.estado = 'abierta'
                           AND u.tipo = ? AND u.id <> ?`),
    unidadesConValor: db.prepare(`SELECT DISTINCT u.id FROM filas f JOIN unidades u ON u.id = f.unidad_id
                                  WHERE f.lista = 'fisico' AND f.valor = ? AND u.estado = 'abierta'
                                    AND u.tipo = ? AND u.id <> ?`),
  };

  function unidadOError(id) {
    const u = q.unidad.get(Number(id));
    if (!u) throw new ErrorDeUso('No existe esa unidad.', 404);
    return u;
  }
  function cargar(unidadId, lista) { return q.filas.all(unidadId, lista); }

  // Lo que hay en las otras unidades: guías y pedimentos → dónde están.
  function contextoDeOtras(u) {
    const guias = new Map(), pedimentos = new Map();
    for (const f of q.deOtras.all(u.tipo, u.id)) {
      const valor = f.valor.toUpperCase();
      const lugar = { hoja: f.nombre, fila: f.pos + 1 };
      if (R.esPedimento(valor)) {
        if (!pedimentos.has(valor)) pedimentos.set(valor, []);
        pedimentos.get(valor).push(lugar);
      } else if (!R.esMarcadorEstructural(valor)) {
        if (!guias.has(valor)) guias.set(valor, []);
        guias.get(valor).push(lugar);
      }
    }
    return { guias, pedimentos };
  }

  // Recalcula una unidad y guarda lo que cambió. Devuelve el resultado del motor.
  function recalcular(u, { filasEditadas, forzar } = {}) {
    const fisico = cargar(u.id, 'fisico');
    const preforma = cargar(u.id, 'preforma');
    const mapear = (rows) => rows.map(f => ({ valor: f.valor, estado: f.estado, hora: f.hora, letra: f.letra }));
    const res = calcularUnidad({
      nombre: u.nombre, fisico: mapear(fisico), preforma: mapear(preforma),
      otras: contextoDeOtras(u), ahora: horaAhora(), forzar: !!forzar,
      filasEditadas: filasEditadas || null, hooks, exigirMS,
    });
    let cambios = 0;
    res.filas.forEach((r, i) => {
      const f = fisico[i];
      if (!f) return;   // posición sin fila física (solo hay preforma)
      if (f.estado !== r.estado || f.color !== r.color || f.color_a !== r.colorA || f.hora !== r.hora) {
        q.setResultado.run(r.estado, r.color, r.colorA, r.hora, u.id, 'fisico', f.pos);
        cambios++;
      }
    });
    res.preforma.forEach((r, i) => {
      const f = preforma[i];
      if (!f) return;
      if (f.estado !== r.estado || f.color !== r.color || f.color_a !== r.colorO || f.hora !== r.hora) {
        q.setResultado.run(r.estado, r.color, r.colorO, r.hora, u.id, 'preforma', f.pos);
        cambios++;
      }
    });
    if (cambios) q.subeVersion.run(u.id);
    return res;
  }

  // Las otras unidades que comparten alguno de estos valores se recalculan.
  function recalcularAfectadas(u, valores) {
    const ids = new Set();
    for (const v of valores) {
      if (!v) continue;
      for (const r of q.unidadesConValor.all(v, u.tipo, u.id)) ids.add(r.id);
    }
    ids.forEach(id => recalcular(q.unidad.get(id)));
  }

  function motivoDeCambio(previo, nuevo) {
    const p = String(previo).trim(), n = String(nuevo).trim();
    if (p === '') return null;
    if (n === '') return 'BORRADO MANUAL (Celda vaciada)';
    if (p.toUpperCase() === n.toUpperCase()) return null;
    return 'SOBRESCRITA con «' + n + '» (la celda ya tenía otra guía)';
  }

  function usuarioValido(usuario) {
    const u = String(usuario === undefined || usuario === null ? '' : usuario).trim();
    if (u === '') throw new ErrorDeUso('Falta decir quién escanea.', 401);
    return u;
  }

  const api = {
    horaAhora, fechaAhora,

    crearUnidad(nombre, tipo) {
      // Mayúsculas y un solo espacio entre palabras: «global  1 20-ae-3h» y
      // «GLOBAL 1 20-AE-3H» son la misma unidad.
      const limpio = String(nombre === undefined ? '' : nombre).trim().toUpperCase().replace(/\s+/g, ' ');
      if (limpio === '') throw new ErrorDeUso('Escribe el nombre de la unidad.');
      if (limpio.length > MAX_NOMBRE_UNIDAD) throw new ErrorDeUso('El nombre de la unidad es demasiado largo.');
      const clave = R.claveUnidad(limpio);
      return transaccion(db, () => {
        const ya = db.prepare("SELECT id FROM unidades WHERE clave = ? AND estado = 'abierta'").get(clave);
        if (ya) throw new ErrorDeUso('Ya hay una unidad abierta con ese nombre.', 409);
        const r = db.prepare('INSERT INTO unidades (nombre, clave, tipo, creada) VALUES (?, ?, ?, ?)')
                    .run(limpio, clave, tipo || 'GLOBAL', fechaAhora());
        return q.unidad.get(Number(r.lastInsertRowid));
      });
    },

    listarUnidades() {
      return q.unidades.all().map(u => {
        const fis = cargar(u.id, 'fisico').filter(f => f.valor !== '');
        const bultos = new Set(fis.filter(f => R.esGuiaUPSValida(f.valor)).map(f => f.valor)).size;
        return { id: u.id, nombre: u.nombre, tipo: u.tipo, version: u.version, filas: fis.length, bultos };
      });
    },

    // La unidad como la ve la pantalla. Con `version` igual a la actual no manda nada.
    obtenerUnidad(id, version) {
      const u = unidadOError(id);
      if (version !== undefined && version !== null && Number(version) === u.version) {
        return { id: u.id, version: u.version, sinCambios: true };
      }
      const res = calcularUnidad({
        nombre: u.nombre, fisico: cargar(u.id, 'fisico'), preforma: cargar(u.id, 'preforma'),
        otras: contextoDeOtras(u), ahora: horaAhora(), forzar: false,
        filasEditadas: new Set(), hooks, exigirMS,
      });
      // Los totales salen del motor; el resto, de lo guardado (que ya trae el último cálculo).
      const mostrar = (rows) => rows.map(f => ({ fila: f.pos + 1, valor: f.valor, estado: f.estado,
        color: f.color, colorA: f.color_a, hora: f.hora, usuario: f.usuario }));
      return { id: u.id, nombre: u.nombre, tipo: u.tipo, version: u.version,
               fisico: mostrar(cargar(u.id, 'fisico')), preforma: mostrar(cargar(u.id, 'preforma')),
               totales: res.totales };
    },

    // UN ESCANEO (o una edición, o un borrado si `valor` viene vacío con `pos`).
    escanear(id, { valor, lista, pos, usuario }) {
      const quien = usuarioValido(usuario);
      const donde = lista === 'preforma' ? 'preforma' : 'fisico';
      return transaccion(db, () => {
        const u = unidadOError(id);
        if (u.estado !== 'abierta') throw new ErrorDeUso('Esa unidad ya está cerrada.', 409);
        const filas = cargar(u.id, donde);
        const esEdicion = pos !== undefined && pos !== null;
        const p = esEdicion ? Number(pos) : filas.length;
        if (!Number.isInteger(p) || p < 0) throw new ErrorDeUso('Renglón inválido.');
        const previa = filas.find(f => f.pos === p) || null;

        if (String(valor === undefined || valor === null ? '' : valor).length > MAX_VALOR) {
          throw new ErrorDeUso('Lo escaneado es demasiado largo: vuelve a escanear.');
        }
        const limpio = R.normalizarCaptura(valor);
        if (limpio === '' && !previa) throw new ErrorDeUso('No hay nada que guardar.');

        // Lo que se sobrescribe o se borra, al historial.
        const motivo = previa ? motivoDeCambio(previa.valor, limpio) : null;
        if (motivo) {
          q.historial.run(fechaAhora(), quien, u.nombre, donde, p + 1, previa.valor, previa.estado, motivo);
        }

        // Entre 1 y 6 dígitos es un pedimento a medias: se queda como error, sin hora.
        const corto = R.errorDePedimentoCorto(limpio);
        q.insFila.run(u.id, donde, p, limpio,
          corto, corto ? R.COLOR.AMARILLO : '#FFFFFF', '#ffffff', '',
          limpio === '' ? '' : quien, previa ? previa.letra : '');

        const tocadas = [limpio, previa ? previa.valor : ''].map(x => x.toUpperCase());
        const res = recalcular(u, { filasEditadas: new Set([p]) });
        recalcularAfectadas(u, tocadas.filter(x => !R.esMarcadorEstructural(x)));
        q.subeVersion.run(u.id);

        const fila = (donde === 'fisico' ? res.filas : res.preforma)[p] || {};
        return { fila: p + 1, valor: limpio, estado: fila.estado || '', color: fila.color || '#FFFFFF',
                 colorA: fila.colorA || fila.colorO || '#ffffff', hora: fila.hora || '',
                 totales: res.totales, version: q.unidad.get(u.id).version };
      });
    },

    // «Forzar actualización»: recalcula sin conservar alertas viejas.
    forzar(id) {
      return transaccion(db, () => {
        const u = unidadOError(id);
        const res = recalcular(u, { forzar: true });
        q.subeVersion.run(u.id);
        return { totales: res.totales, version: q.unidad.get(u.id).version };
      });
    },

    // Pegar la lista esperada (la columna O): un valor por renglón, reemplaza la anterior.
    pegarPreforma(id, textoPegado, usuario) {
      const quien = usuarioValido(usuario);
      return transaccion(db, () => {
        const u = unidadOError(id);
        const renglones = String(textoPegado || '').split(/\r?\n/);
        if (renglones.length > MAX_RENGLONES_PREFORMA) throw new ErrorDeUso('La lista es demasiado larga.');
        if (renglones.some(x => x.length > MAX_VALOR)) throw new ErrorDeUso('Hay un renglón demasiado largo.');
        const nuevas = renglones.map(x => R.normalizarCaptura(x));
        while (nuevas.length && nuevas[nuevas.length - 1] === '') nuevas.pop();
        const viejas = cargar(u.id, 'preforma');
        viejas.forEach(f => {
          if (f.valor !== '') {
            q.historial.run(fechaAhora(), quien, u.nombre, 'preforma', f.pos + 1, f.valor, f.estado,
                            'PREFORMA REEMPLAZADA (se pegó una lista nueva)');
          }
        });
        db.prepare("DELETE FROM filas WHERE unidad_id = ? AND lista = 'preforma'").run(u.id);
        nuevas.forEach((valor, pos) => {
          const corto = R.errorDePedimentoCorto(valor);
          q.insFila.run(u.id, 'preforma', pos, valor, corto, corto ? R.COLOR.AMARILLO : '#FFFFFF',
                        '#FFFFFF', '', valor === '' ? '' : quien, '');
        });
        const res = recalcular(u);
        q.subeVersion.run(u.id);
        recalcularAfectadas(u, []);
        return { renglones: nuevas.length, totales: res.totales, version: q.unidad.get(u.id).version };
      });
    },

    historial(id, limite) {
      const u = unidadOError(id);
      return q.historialDe.all(u.nombre, Math.min(Number(limite) || 100, 500));
    },
  };
  return api;
}

module.exports = { crearServicio, ErrorDeUso };
