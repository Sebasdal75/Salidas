'use strict';
// =========================================================================
// LA PANTALLA. Sin librerías ni compilación: un archivo, lo abre cualquier
// navegador (la pistola Zebra incluida).
//
// Lo que importa en una pistola:
//   · el cursor SIEMPRE está en el campo de escaneo, escanees lo que escanees;
//   · el resultado sale grande, con su color y con sonido (distinto si está mal);
//   · si se cae la red, los escaneos se guardan en una cola y se mandan en
//     orden en cuanto vuelve: no se pierde ninguno ni se cambia su orden.
// =========================================================================

const $ = (id) => document.getElementById(id);
const estado = { operador: '', unidad: null, vista: 'fisico', version: null, cola: [], enviando: false, sondeo: null };

// ---- Utilidades --------------------------------------------------------

function limpiarHijos(el) { while (el.firstChild) el.removeChild(el.firstChild); }

// Texto negro o blanco, el que se lea mejor sobre el color de fondo.
function textoSobre(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return '#14212b';
  const n = parseInt(m[1], 16);
  const luz = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return luz > 0.6 ? '#14212b' : '#ffffff';
}
function pintar(el, fondo) {
  el.style.background = fondo || '';
  el.style.color = fondo ? textoSobre(fondo) : '';
}

// 0 = bien, 1 = aviso, 2 = error. Se decide por el primer símbolo, como en la hoja.
function gravedad(texto) {
  const t = String(texto || '').trim();
  if (t.startsWith('🛑') || t.startsWith('⛔') || t.startsWith('❌')) return 2;
  if (t.startsWith('⚠️') || t.startsWith('🔄')) return 1;
  return 0;
}

let audio = null;
function pitar(nivel) {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    const tonos = nivel === 0 ? [[880, .09]] : nivel === 1 ? [[520, .14], [520, .14]] : [[220, .22], [180, .3]];
    let t = audio.currentTime;
    tonos.forEach(([f, d]) => {
      const o = audio.createOscillator(), g = audio.createGain();
      o.frequency.value = f; o.type = 'square'; g.gain.value = .08;
      o.connect(g); g.connect(audio.destination); o.start(t); o.stop(t + d); t += d + .05;
    });
  } catch (e) { /* sin sonido no pasa nada */ }
}

async function api(metodo, ruta, cuerpo) {
  const cabeceras = { 'content-type': 'application/json', 'x-operador': encodeURIComponent(estado.operador) };
  const r = await fetch(ruta, { method: metodo, headers: cabeceras, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
  let datos = {};
  try { datos = await r.json(); } catch (e) { /* sin cuerpo */ }
  if (!r.ok) { const err = new Error(datos.error || 'Falló la petición.'); err.codigo = r.status; throw err; }
  return datos;
}

// ---- Pantallas ---------------------------------------------------------

function mostrar(nombre) {
  ['entrada', 'unidades', 'unidad'].forEach(n => { $('pantalla-' + n).hidden = n !== nombre; });
  $('atras').hidden = nombre !== 'unidad';
  $('salir').hidden = nombre === 'entrada';
  $('operador').textContent = estado.operador;
  if (nombre !== 'unidad') { detenerSondeo(); $('titulo').textContent = 'WMS Salidas'; }
}

function entrar(nombre) {
  estado.operador = nombre;
  try { localStorage.setItem('operador', nombre); } catch (e) { /* sin almacenamiento */ }
  irAUnidades();
}

async function irAUnidades() {
  estado.unidad = null;
  mostrar('unidades');
  await cargarUnidades();
}

async function cargarUnidades() {
  try {
    const { unidades } = await api('GET', '/api/unidades');
    const ul = $('lista-unidades');
    limpiarHijos(ul);
    $('sin-unidades').hidden = unidades.length > 0;
    unidades.forEach(u => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      const nom = document.createElement('span'); nom.className = 'unidad-nombre'; nom.textContent = u.nombre;
      const dat = document.createElement('span'); dat.className = 'unidad-datos';
      dat.textContent = u.bultos + ' bultos · ' + u.filas + ' filas';
      b.append(nom, dat);
      b.addEventListener('click', () => abrirUnidad(u.id));
      li.appendChild(b); ul.appendChild(li);
    });
  } catch (e) { alert(e.message); }
}

async function abrirUnidad(id) {
  estado.unidad = { id };
  estado.version = null;
  mostrar('unidad');
  cambiarVista('fisico');
  await refrescar(true);
  iniciarSondeo();
  enfocar();
}

function enfocar() { const c = $('campo-escaneo'); if (!$('pantalla-unidad').hidden) c.focus({ preventScroll: true }); }

// ---- La unidad ---------------------------------------------------------

async function refrescar(forzar) {
  if (!estado.unidad) return;
  try {
    const v = await api('GET', '/api/unidades/' + estado.unidad.id + (!forzar && estado.version !== null ? '?v=' + estado.version : ''));
    if (v.sinCambios) return;
    estado.version = v.version;
    estado.unidad = v;
    $('titulo').textContent = v.nombre;
    dibujarTotales(v.totales);
    dibujarTabla($('tabla-fisico'), v.fisico, true);
    dibujarTabla($('tabla-preforma'), v.preforma, false);
    if (estado.vista === 'historial') cargarHistorial();
  } catch (e) { /* sin red: el sondeo lo reintenta */ }
}

function dibujarTotales(t) {
  const caja = $('totales');
  limpiarHijos(caja);
  [['Bultos', t.bultos], [t.etiquetaPedimentos, t.pedimentos],
   ['Esperados', t.bultosPreforma], ['Pedimentos esperados', t.pedimentosPreforma]].forEach(([nombre, n]) => {
    if (nombre !== 'Bultos' && nombre !== t.etiquetaPedimentos && !n) return;
    const s = document.createElement('span'); s.className = 'dato';
    const b = document.createElement('b'); b.textContent = n;
    s.append(nombre + ': ', b); caja.appendChild(s);
  });
}

function dibujarTabla(tabla, filas, conHora) {
  const cuerpo = tabla.querySelector('tbody');
  const alFondo = tabla === $('tabla-fisico') &&
    (window.innerHeight + window.scrollY >= document.body.scrollHeight - 80);
  limpiarHijos(cuerpo);
  filas.forEach(f => {
    const tr = document.createElement('tr');
    if (f.valor !== '') tr.className = 'tocable';
    const n = document.createElement('td'); n.className = 'num'; n.textContent = f.fila;
    const v = document.createElement('td'); v.className = 'valor'; v.textContent = f.valor; pintar(v, f.valor ? f.colorA : '');
    const e = document.createElement('td'); e.textContent = f.estado; pintar(e, f.estado ? f.color : '');
    tr.append(n, v, e);
    if (conHora) { const h = document.createElement('td'); h.className = 'hora'; h.textContent = f.hora; tr.appendChild(h); }
    tr.addEventListener('click', () => editarFila(tabla === $('tabla-fisico') ? 'fisico' : 'preforma', f));
    cuerpo.appendChild(tr);
  });
  if (alFondo) window.scrollTo({ top: document.body.scrollHeight });
}

function iniciarSondeo() { detenerSondeo(); estado.sondeo = setInterval(() => refrescar(false), 2000); }
function detenerSondeo() { if (estado.sondeo) { clearInterval(estado.sondeo); estado.sondeo = null; } }

function cambiarVista(vista) {
  estado.vista = vista;
  document.querySelectorAll('.pestanas button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.vista === vista)));
  ['fisico', 'preforma', 'historial'].forEach(n => { $('vista-' + n).hidden = n !== vista; });
  if (vista === 'historial') cargarHistorial();
  enfocar();
}

async function cargarHistorial() {
  if (!estado.unidad) return;
  try {
    const { historial } = await api('GET', '/api/unidades/' + estado.unidad.id + '/historial?limite=100');
    const cuerpo = $('tabla-historial').querySelector('tbody');
    limpiarHijos(cuerpo);
    historial.forEach(h => {
      const tr = document.createElement('tr');
      [h.fecha.replace('T', ' '), h.usuario, h.fila, h.valor, h.motivo].forEach(x => {
        const td = document.createElement('td'); td.textContent = x; tr.appendChild(td);
      });
      cuerpo.appendChild(tr);
    });
  } catch (e) { /* se reintenta al volver a entrar */ }
}

// ---- Escanear ----------------------------------------------------------

function mostrarResultado(valor, texto, color, nivel) {
  const caja = $('resultado');
  caja.hidden = false;
  pintar(caja, color && color !== '#FFFFFF' ? color : '#e8f5e9');
  $('resultado-valor').textContent = valor;
  // Solo el estado de la fila: el resumen del bloque (tras «►») ya está en la tabla.
  const cabeza = String(texto || '').split('   ►   ')[0].trim();
  $('resultado-estado').textContent = cabeza || (nivel === 0 ? '✅ Guardado' : '');
}

function dibujarCola() {
  const c = $('cola');
  c.hidden = estado.cola.length === 0;
  c.textContent = estado.cola.length
    ? '📡 Sin conexión: ' + estado.cola.length + ' escaneo(s) esperando. Se mandan solos al volver la red.'
    : '';
}

// Manda la cola en orden. Si falla por red, se queda y se reintenta; si el
// servidor lo rechaza (error de uso), se descarta y se avisa.
async function vaciarCola() {
  if (estado.enviando) return;
  estado.enviando = true;
  try {
    while (estado.cola.length) {
      const e = estado.cola[0];
      try {
        const r = await api('POST', '/api/unidades/' + e.unidad + '/escaneo',
                            { valor: e.valor, lista: e.lista, pos: e.pos });
        estado.cola.shift();
        const nivel = gravedad(r.estado);
        if (e.unidad === (estado.unidad && estado.unidad.id)) {
          mostrarResultado(r.valor || e.valor, r.estado, r.color, nivel);
          pitar(nivel);
          dibujarTotales(r.totales);
          estado.version = null;   // fuerza a releer la tabla en el próximo sondeo
          refrescar(true);
        }
      } catch (err) {
        if (err.codigo) {   // lo rechazó el servidor: no tiene caso reintentar
          estado.cola.shift();
          mostrarResultado(e.valor, '❌ ' + err.message, '#df5f6b', 2);
          pitar(2);
        } else { break; }   // sin red: se queda en la cola
      }
    }
  } finally { estado.enviando = false; dibujarCola(); }
}

function encolar(valor, lista, pos) {
  estado.cola.push({ unidad: estado.unidad.id, valor, lista, pos });
  dibujarCola();
  vaciarCola();
}

// ---- Editar o borrar una fila -------------------------------------------

function editarFila(lista, fila) {
  const d = $('dialogo-fila');
  $('dialogo-titulo').textContent = 'Fila ' + fila.fila + (lista === 'preforma' ? ' (lista esperada)' : '');
  $('dialogo-estado').textContent = fila.estado || '';
  $('dialogo-valor').value = fila.valor;
  d.dataset.lista = lista; d.dataset.pos = String(fila.fila - 1);
  d.showModal();
  $('dialogo-valor').select();
}

// ---- Cableado ------------------------------------------------------------

$('form-entrada').addEventListener('submit', (e) => {
  e.preventDefault();
  const n = $('nombre-operador').value.trim();
  if (n) entrar(n);
});
$('salir').addEventListener('click', () => {
  try { localStorage.removeItem('operador'); } catch (e) { /* nada */ }
  estado.operador = ''; mostrar('entrada'); $('nombre-operador').focus();
});
$('atras').addEventListener('click', irAUnidades);

$('form-unidad').addEventListener('submit', async (e) => {
  e.preventDefault();
  const nombre = $('nombre-unidad').value.trim();
  if (!nombre) return;
  try {
    const { unidad } = await api('POST', '/api/unidades', { nombre });
    $('nombre-unidad').value = '';
    abrirUnidad(unidad.id);
  } catch (err) { alert(err.message); }
});

$('form-escaneo').addEventListener('submit', (e) => {
  e.preventDefault();
  const campo = $('campo-escaneo');
  const valor = campo.value;
  campo.value = '';
  if (valor.trim() === '' || !estado.unidad) return;
  if (audio === null) pitar(0);   // el navegador pide un gesto para activar el sonido
  encolar(valor, 'fisico');
  enfocar();
});

document.querySelectorAll('.pestanas button').forEach(b => b.addEventListener('click', () => cambiarVista(b.dataset.vista)));

$('forzar').addEventListener('click', async () => {
  try { await api('POST', '/api/unidades/' + estado.unidad.id + '/forzar'); await refrescar(true); }
  catch (err) { alert(err.message); }
  enfocar();
});

$('form-preforma').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const r = await api('POST', '/api/unidades/' + estado.unidad.id + '/preforma', { texto: $('texto-preforma').value });
    $('texto-preforma').value = '';
    await refrescar(true);
    alert('Lista esperada guardada: ' + r.renglones + ' renglones.');
  } catch (err) { alert(err.message); }
});

$('form-fila').addEventListener('submit', (e) => {
  e.preventDefault();
  const d = $('dialogo-fila');
  const valor = $('dialogo-valor').value;
  const lista = d.dataset.lista, pos = Number(d.dataset.pos);
  d.close();
  // Vacío = borrar la fila. Va directo, no por la cola: es una acción de pantalla.
  api('POST', '/api/unidades/' + estado.unidad.id + '/escaneo', { valor, lista, pos })
    .then(() => refrescar(true))
    .catch(err => alert(err.message))
    .finally(enfocar);
});
$('dialogo-cancelar').addEventListener('click', () => { $('dialogo-fila').close(); enfocar(); });

// Si el cursor se va a otro lado dentro de la unidad, vuelve al campo de escaneo.
document.addEventListener('click', (e) => {
  if (!$('pantalla-unidad').hidden && !e.target.closest('textarea, dialog, input, button')) enfocar();
});
window.addEventListener('online', vaciarCola);
setInterval(() => { if (estado.cola.length) vaciarCola(); }, 3000);

(function arrancar() {
  let guardado = '';
  try { guardado = localStorage.getItem('operador') || ''; } catch (e) { /* nada */ }
  if (guardado) entrar(guardado); else { mostrar('entrada'); $('nombre-operador').focus(); }
})();
