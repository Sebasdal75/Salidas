# La app WMS Salidas — arquitectura

Para quien la mantenga o tenga que aprobarla (sistemas, quien programe).
Para instalarla, ver [`APP-INSTALACION.md`](APP-INSTALACION.md); para saber qué
mensaje sale y por qué, [`APP-REGLAS-GLOBALES.md`](APP-REGLAS-GLOBALES.md).

---

## 1. Por qué existe

El sistema de hoy es una hoja de Google Sheets con un programa de Google Apps
Script (`Codigo.gs` y compañía). Funciona, pero depende de Google: la cuenta, los
límites de tiempo de Google, y el hecho de que los datos viven fuera de la
empresa. La empresa trabaja con Microsoft 365.

La app hace lo mismo **sin depender de Google**: es un programa web propio, con
su base de datos, que se puede alojar donde la empresa decida.

**La idea central: las reglas no cambian, el soporte sí.** Los mensajes
(`✅ Ok`, `⛔ DUPLICADO …`, `❌ Faltan 2 (…)`), los colores y el orden en que se
pisan unos a otros son exactamente los de la hoja. Los operadores no tienen que
aprender nada nuevo; lo que cambia es que ya no hay una hoja que se pueda
romper escribiendo en la celda equivocada.

---

## 2. Qué es, en un dibujo

```
 Pistola Zebra / PC / teléfono
      │  (navegador: HTML + JS, sin instalar nada)
      ▼
 ┌──────────────────────────────────────────┐
 │  servidor.js     HTTP: la pantalla y /api │
 │     │                                    │
 │  servicio.js     guardar, recalcular,     │
 │     │            historial (transacción) │
 │     ├── motor.js   el cerebro (puro)      │
 │     │     └── reglas.js  textos, colores  │
 │  db.js           la base de datos         │
 └──────────────────────────────────────────┘
      │
   SQLite hoy · PostgreSQL / Azure SQL mañana
```

- **Node.js 22**, sin librerías externas: nada que instalar con `npm`, nada que
  vigilar por vulnerabilidades de terceros. El código del sistema actual ya es
  JavaScript, así que las reglas se trasladaron sin reescribirlas en otro
  lenguaje (menos riesgo de que se pierda un detalle).
- **La pantalla no se compila**: son tres archivos (`index.html`, `estilos.css`,
  `app.js`). Cualquier navegador moderno la abre, la pistola incluida.

### Por qué el motor es una función pura

`motor.js` no sabe de bases de datos ni de red. Recibe lo escaneado en una
unidad, su lista esperada y lo que hay en las otras unidades, y devuelve el
estado, color y hora de cada fila. Eso permite probarlo con arreglos (23
pruebas) y es lo que más importa conservar: **el motor es la regla de negocio**.

---

## 3. De la hoja a la app: qué reemplaza a qué

| En la hoja de Google | En la app | Por qué cambia |
|---|---|---|
| Pestaña de una unidad (`GLOBAL 1 20-AE-3H`) | Una **unidad** (tabla `unidades`) | — |
| Columna A (lo escaneado) y B (estado) | Renglones de la lista `fisico` | Una fila por renglón, con su estado y color guardados |
| Columna O/P (preforma) y N (letra del bloque) | Lista `preforma` | Igual |
| Hora en la columna L / S | Columna `hora` de cada renglón | Se sella una vez y no cambia |
| `CACHE_SISTEMA` y el caché en RAM | **La base de datos** | Era un parche para que leer la hoja no fuera lento. Con una base de datos con índices ya no hace falta, y desaparece toda una clase de errores (caché desalineado, fantasmas, «reconstruir caché») |
| `LockService` y `⏳ Pendiente (reintenta)` | **Transacción** por escaneo | Cada escaneo entra completo o no entra; nunca se pisan. Ya no hay «pendiente» ni cola de lock |
| `onEdit` / trigger instalable / latido | Una petición HTTP por escaneo | Sin límite de 30 s ni de 6 min |
| Trigger de cada 5 minutos (repaso) | No hace falta | Nada se queda sin validar: validar es parte de guardar |
| `HISTORIAL_BORRADOS` | Tabla `historial` | Igual: quién, cuándo, qué, motivo |
| `Forzar Actualización` | Botón «Forzar actualización» | Recalcula sin conservar alertas viejas |
| Protección de pestañas, «solo lectura» | No existe la hoja que romper | El operador solo puede escanear, corregir o borrar su fila |
| ID del archivo y carpetas en *Script Properties* | Variables de entorno (`DB_PATH`, …) | Nada sensible en el código ni en git |

---

## 4. Modelo de datos

```sql
unidades(id, nombre, clave, tipo, estado, version, creada)
filas(unidad_id, lista, pos, valor, estado, color, color_a, hora, usuario, letra)
historial(id, fecha, usuario, unidad, lista, fila, valor, estado, motivo)
```

- `filas.lista` es `'fisico'` (lo escaneado, columna A) o `'preforma'` (lo
  esperado, columna O). `pos` es el renglón menos uno; **los renglones no se
  recorren al borrar**: se vacía el valor y el renglón queda en su sitio, porque
  los mensajes citan números de fila («repetida en la fila 4»).
- `unidades.version` sube con cada cambio. Las pantallas preguntan «¿cambió algo
  desde la versión N?» cada 2 segundos y el servidor contesta `sinCambios` sin
  recalcular ni mandar la tabla: así siete pantallas abiertas casi no cuestan.
- `unidades.tipo` es `GLOBAL` hoy. Aquí entrarán las M-S y los inventarios
  (fase 2), que son dominios distintos con reglas de duplicados distintas.
- Un índice único impide dos unidades **abiertas** con el mismo nombre.

---

## 5. Qué pasa cuando alguien escanea

`servicio.escanear` hace todo dentro de **una transacción**:

1. Normaliza lo escaneado: mayúsculas y solo `A-Z0-9` (el lector a veces manda
   espacios o saltos de línea). Rechaza lo que mide más de 200 caracteres.
2. Si el renglón tenía algo y se sobrescribe o se vacía, lo manda al historial.
3. Entre 1 y 6 dígitos es un pedimento a medias: se guarda como
   `🛑 ERROR: Faltan N números`, en amarillo, sin hora.
4. Guarda el renglón y **recalcula la unidad entera** con `motor.calcularUnidad`.
5. Guarda solo las filas cuyo estado, color u hora cambiaron.
6. Si lo escaneado (o lo que había antes) está también en **otras** unidades,
   las recalcula: el duplicado aparece en las dos.
7. Sube la versión y devuelve el resultado de la fila + los totales.

La pantalla pinta ese resultado grande, con su color y un pitido (uno corto si
está bien; dos medios si es aviso; uno grave si es error).

### Sin red

La pantalla mete cada escaneo en una cola y los manda **en orden**. Si no hay
red, se quedan esperando (se ve un aviso amarillo) y salen solos al volver. Si
el servidor rechaza uno (por ejemplo, la unidad ya se cerró), se descarta y se
avisa en rojo, para no atascar la cola.

---

## 6. Concurrencia

En la hoja se necesitaba un *lock* del documento porque dos ejecuciones podían
leer el mismo estado y escribir una encima de la otra. Aquí:

- **SQLite en un solo servidor**: cada escaneo corre en `BEGIN IMMEDIATE … COMMIT`.
  Node ejecuta una petición a la vez para la base, y la transacción garantiza
  que o entra todo o nada. Siete operadores no se estorban.
- **Varios servidores** (si algún día hace falta más de uno): pasar a PostgreSQL o
  Azure SQL y usar `SELECT … FOR UPDATE` sobre la fila de la unidad (o un bloqueo
  de aplicación por unidad). Ver §8.

No hay prioridades ni colas de espera: una transacción dura milisegundos.

---

## 7. Quién es quién

Cada escaneo guarda quién lo hizo.

- **Detrás de la empresa (producción):** un proxy con el inicio de sesión de la
  empresa (Microsoft Entra ID) pone el correo del usuario en una cabecera
  (`x-ms-client-principal-name` en Azure; se cambia con `AUTH_HEADER`). Con
  `EXIGIR_SSO=1` **solo esa cabecera vale**: el nombre que escriba alguien en la
  pantalla se ignora, y una petición sin cabecera recibe 401. Los operadores
  entran con su cuenta de Microsoft 365, sin contraseñas nuevas.
- **Esto solo es seguro si la app es alcanzable únicamente a través del
  proxy**: si se puede llegar directo, cualquiera puede escribir la cabecera.
- **Sin inicio de sesión (pruebas o red interna cerrada):** la pantalla pide el
  nombre y lo manda en `x-operador`. **Esto no es una autenticación**: cualquiera
  que llegue a la dirección puede escribir cualquier nombre. Solo vale en una red
  que ya esté protegida.

> En producción, la app **no debe** quedar abierta a internet, y debe correr con
> `EXIGIR_SSO=1` detrás del inicio de sesión de la empresa.

---

## 8. Base de datos y cómo cambiarla

Todo el acceso a datos pasa por **`db.js`** (conexión, esquema, transacciones) y
por las consultas preparadas de **`servicio.js`**. SQLite se eligió para empezar
porque no hay nada que instalar y alcanza de sobra para una operación de este
tamaño (decenas de miles de renglones, siete operadores).

Para pasar a **PostgreSQL** o **Azure SQL**:

1. Cambiar `db.js` por un módulo que abra la conexión del otro motor y ofrezca
   `prepare()` / `exec()` equivalentes (o adaptar `servicio.js`, que usa unas
   quince consultas sencillas).
2. El esquema es SQL estándar: `AUTOINCREMENT` pasa a `SERIAL`/`IDENTITY`, y el
   índice único parcial (`WHERE estado = 'abierta'`) existe en PostgreSQL y, como
   índice filtrado, en SQL Server.
3. Los motores en red son asíncronos: `servicio.js` pasaría a `async/await`.
   El motor (`motor.js`) **no cambia**.

Para respaldar, ver `APP-INSTALACION.md`.

---

## 9. Seguridad

- **Entradas con tope**: valor ≤ 200 caracteres, nombre de unidad ≤ 80, lista
  pegada ≤ 20 000 renglones, cuerpo de petición ≤ 1 MB.
- **SQL parametrizado** en todas las consultas: nada de texto del usuario
  pegado a una consulta.
- **La pantalla escribe con `textContent`**, nunca con `innerHTML`: lo escaneado
  no puede inyectar código en la página. Además la política de seguridad de
  contenido (`Content-Security-Policy`) solo deja ejecutar scripts del propio
  servidor.
- **Los archivos estáticos no se salen de su carpeta** (hay una prueba con
  varios intentos de `../`).
- **Secretos**: la app no lleva ninguno. La ruta de la base y el puerto son
  variables de entorno. Si más adelante se conecta a OneDrive/SharePoint o a una
  base en red, esas credenciales van en variables de entorno o en Azure Key
  Vault, **nunca en el repositorio**.
- **Peticiones entre sitios**: las escrituras exigen `Content-Type:
  application/json` (el navegador lo trata como petición «con permiso previo» y
  la bloquea desde otro sitio) y no se envía ninguna cabecera CORS.

---

## 10. Qué hay que pedirle a sistemas

Para pasar de «funciona en una laptop» a producción:

1. **Dónde corre**:
   - *Hoy, listo*: una máquina virtual de Azure o un servidor de la empresa con
     **disco propio** (Node 22 o Docker), con un proxy de inicio de sesión
     (Entra ID) delante y la app alcanzable solo por él.
   - *Cuando exista la base en red*: Azure App Service o Container Apps con
     Entra ID y una base PostgreSQL/Azure SQL administrada. SQLite sobre
     almacenamiento de red **no** es confiable.
2. **Una base**: hoy, el disco del servidor con respaldo a **otro** sitio
   (`npm run respaldar`). Más adelante, PostgreSQL o Azure SQL.
3. **Un nombre y certificado**: `wms.empresa.com` con HTTPS. Las pistolas Zebra
   deben llegar a ese nombre (misma red o VPN).
4. **Respaldo diario** de la base y retención (la guía está en `APP-INSTALACION.md`).
5. **Quién la mantiene**: una persona con acceso al repositorio y al servidor.
6. **Cuentas**: que los operadores existan en el directorio de la empresa (si se
   usa Entra ID).

---

## 11. Límites conocidos de la fase 1

- No hay M-S, inventarios, houses, costales, retenidas, «sin información»,
  confronta de pedimentos, pedimentos finales ni cierre del día. Entran por fases
  (ver [`APP-FASES.md`](APP-FASES.md)); el motor ya trae los **ganchos** para
  varias (`hooks.retenida`, `hooks.yaSalio`, `hooks.pedimentoUsado`,
  `hooks.costal`, `ms`), que por ahora no dicen nada.
- Los duplicados entre unidades se calculan con una consulta sobre todas las
  unidades abiertas. Con decenas de miles de renglones es instantáneo; si algún
  día fueran cientos de miles, se limitaría la consulta a las guías de la unidad
  (ya hay un índice por valor).
- No hay comandos por código de barras (`WMSACT`…): en la app son botones. Los
  códigos de barras de comandos se pueden volver a añadir si hace falta.
- Un solo servidor y un solo proceso, con la base en disco local. Para dos o más,
  o para App Service, hace falta antes la base en red (§6 y §8).
