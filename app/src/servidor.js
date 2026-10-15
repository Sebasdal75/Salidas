'use strict';
// =========================================================================
// EL SERVIDOR: reparte la pantalla y contesta a la API. Solo módulos de Node,
// nada que instalar.
//
//   PORT      puerto (3000)
//   HOST      en qué dirección escucha: 0.0.0.0 (por defecto) = toda la red
//             local, para que lleguen las pistolas; 127.0.0.1 = solo este equipo
//   DB_PATH   archivo de la base (./datos/wms.sqlite)
//   TZ        zona horaria para las horas del escaneo (America/Mexico_City)
//   DB_JOURNAL WAL (por defecto) o DELETE; DELETE si la base está en un disco de red
//   AUTH_HEADER   cabecera con el usuario que pone el inicio de sesión de la empresa
//                 (x-ms-client-principal-name, la de Azure App Service)
//   EXIGIR_SSO=1  en producción: SOLO vale esa cabecera; el nombre escrito en la
//                 pantalla se ignora y sin cabecera la petición es un 401
//
// QUIÉN ESCANEA. Detrás del inicio de sesión de la empresa (Microsoft Entra ID /
// «Autenticación» de Azure App Service) el servidor recibe el correo en esa
// cabecera y la usa. Sin eso —en pruebas o en la red interna sin inicio de
// sesión— toma el nombre que la pantalla manda en x-operador.
//
// LA CABECERA SOLO SE PUEDE CREER SI NADIE MÁS LLEGA AL SERVIDOR: la app debe
// quedar detrás del proxy que inicia la sesión, y solo detrás de él. Si se puede
// llegar directo, cualquiera puede escribir la cabecera. Ver
// docs/APP-ARQUITECTURA.md, apartado «Quién es quién».
// =========================================================================

const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { abrir } = require('./db');
const { crearServicio, ErrorDeUso } = require('./servicio');

const WEB = path.join(__dirname, 'web');
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
                '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
                '.webmanifest': 'application/manifest+json' };
const MAX_CUERPO = 1024 * 1024;

function operadorDe(req, config) {
  const sso = req.headers[config.cabeceraSso];
  if (sso) return String(sso).trim();
  if (config.exigirSso) return '';      // en producción el nombre escrito no vale
  const manual = req.headers['x-operador'];
  if (!manual) return '';
  try { return decodeURIComponent(String(manual)).trim(); } catch (e) { return ''; }
}

function leerCuerpo(req) {
  return new Promise((resolve, reject) => {
    let total = 0; const trozos = [];
    req.on('data', (t) => {
      total += t.length;
      if (total > MAX_CUERPO) { reject(new ErrorDeUso('El envío es demasiado grande.', 413)); req.destroy(); return; }
      trozos.push(t);
    });
    req.on('end', () => {
      if (total === 0) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(trozos).toString('utf8'))); }
      catch (e) { reject(new ErrorDeUso('El envío no se entiende.')); }
    });
    req.on('error', reject);
  });
}

function responder(res, codigo, objeto) {
  const cuerpo = JSON.stringify(objeto);
  res.writeHead(codigo, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(cuerpo);
}

function crearServidor(servicio, opciones) {
  const config = {
    cabeceraSso: String((opciones && opciones.cabeceraSso) || 'x-ms-client-principal-name').toLowerCase(),
    exigirSso: !!(opciones && opciones.exigirSso),
  };
  const rutas = [];
  const ruta = (metodo, patron, fn) => rutas.push({ metodo, re: new RegExp('^' + patron + '$'), fn });

  ruta('GET', '/api/estado', async () => ({ ok: true, hora: servicio.horaAhora() }));
  ruta('GET', '/api/unidades', async () => ({ unidades: servicio.listarUnidades() }));
  ruta('POST', '/api/unidades', async (req, m, cuerpo) => {
    operadorObligatorio(req);
    return { unidad: servicio.crearUnidad(cuerpo.nombre, cuerpo.tipo) };
  });
  ruta('GET', '/api/unidades/(\\d+)', async (req, m, cuerpo, url) =>
    servicio.obtenerUnidad(m[1], url.searchParams.get('v')));
  ruta('POST', '/api/unidades/(\\d+)/escaneo', async (req, m, cuerpo) =>
    servicio.escanear(m[1], { valor: cuerpo.valor, lista: cuerpo.lista, pos: cuerpo.pos, usuario: operadorObligatorio(req) }));
  ruta('POST', '/api/unidades/(\\d+)/forzar', async (req, m) => { operadorObligatorio(req); return servicio.forzar(m[1]); });
  ruta('POST', '/api/unidades/(\\d+)/preforma', async (req, m, cuerpo) =>
    servicio.pegarPreforma(m[1], cuerpo.texto, operadorObligatorio(req)));
  ruta('GET', '/api/unidades/(\\d+)/historial', async (req, m, cuerpo, url) =>
    ({ historial: servicio.historial(m[1], url.searchParams.get('limite')) }));

  function operadorObligatorio(req) {
    const o = operadorDe(req, config);
    if (!o) throw new ErrorDeUso('Falta decir quién escanea.', 401);
    return o;
  }

  function estatico(req, res, url) {
    let archivo = url.pathname === '/' ? '/index.html' : url.pathname;
    const completo = path.normalize(path.join(WEB, archivo));
    if (!completo.startsWith(WEB + path.sep) && completo !== WEB) { res.writeHead(403); return res.end(); }
    fs.readFile(completo, (err, datos) => {
      if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('No existe.'); }
      res.writeHead(200, {
        'content-type': TIPOS[path.extname(completo)] || 'application/octet-stream',
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:",
      });
      res.end(datos);
    });
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) return estatico(req, res, url);
    try {
      const r = rutas.find(x => x.metodo === req.method && x.re.test(url.pathname));
      if (!r) throw new ErrorDeUso('No existe esa ruta.', 404);
      // Las escrituras solo se aceptan como JSON. Un formulario de otro sitio no
      // puede mandar este tipo sin un permiso previo del navegador (que aquí
      // nunca se da), así que una página ajena no puede escribir en nombre de
      // quien tenga la sesión de la empresa abierta.
      if (req.method === 'POST' && !/^application\/json\b/i.test(req.headers['content-type'] || '')) {
        throw new ErrorDeUso('Solo se aceptan envíos en JSON.', 415);
      }
      const cuerpo = req.method === 'POST' ? await leerCuerpo(req) : {};
      const salida = await r.fn(req, url.pathname.match(r.re), cuerpo, url);
      responder(res, 200, salida);
    } catch (err) {
      if (err instanceof ErrorDeUso) return responder(res, err.codigo, { error: err.message });
      console.error(err);
      responder(res, 500, { error: 'Algo falló en el servidor. Intenta de nuevo.' });
    }
  });
}

// Las direcciones de este equipo en la red local: las que hay que abrir en la
// pistola. (Una dirección de red local no se ve desde internet.)
function direccionesLocales() {
  const out = [];
  Object.values(os.networkInterfaces()).forEach(lista => (lista || []).forEach(d => {
    if (d.family === 'IPv4' && !d.internal) out.push(d.address);
  }));
  return out;
}

if (require.main === module) {
  const [mayor, menor] = process.versions.node.split('.').map(Number);
  if (mayor < 22 || (mayor === 22 && menor < 13)) {
    console.error('Esta app necesita Node.js 22.13 o más nuevo (tienes ' + process.versions.node + ').');
    process.exit(1);
  }
  const ruta = process.env.DB_PATH || path.join(__dirname, '..', 'datos', 'wms.sqlite');
  fs.mkdirSync(path.dirname(ruta), { recursive: true });
  const servicio = crearServicio(abrir(ruta, { journal: process.env.DB_JOURNAL }));
  const puerto = Number(process.env.PORT) || 3000;
  const servidor = crearServidor(servicio, {
    cabeceraSso: process.env.AUTH_HEADER, exigirSso: process.env.EXIGIR_SSO === '1' });
  const host = process.env.HOST || '0.0.0.0';
  servidor.listen(puerto, host, () => {
    console.log('WMS Salidas lista' + (process.env.EXIGIR_SSO === '1' ? ' (solo con inicio de sesión de la empresa)' : '') + '.');
    console.log('  En este equipo:  http://localhost:' + puerto);
    if (host === '0.0.0.0') direccionesLocales().forEach(ip => console.log('  En la pistola:   http://' + ip + ':' + puerto));
    console.log('  Base de datos:   ' + ruta);
  });
}

module.exports = { crearServidor, direccionesLocales };
