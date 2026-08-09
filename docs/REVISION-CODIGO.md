# Revisión del WMS (Apps Script) — 2026-08-09

> **Estado: todos los hallazgos de este documento fueron corregidos el 2026-08-09.**
> El registro de qué cambió está en [`CORRECCIONES-APLICADAS.md`](CORRECCIONES-APLICADAS.md).
> Las referencias de línea de abajo apuntan al código **anterior** a la corrección.

Revisión del script `Codigo.gs` contra las reglas de negocio declaradas
(caché híbrido, batch writes, aislamiento Globales / Bodegas / Inventarios,
historial auditado).

**Veredicto general:** la arquitectura es correcta y el enfoque de caché en RAM +
hoja oculta es el adecuado para el volumen que manejas. Pero hay **3 fallos
bloqueantes** que rompen reglas que tú mismo definiste, y varios cuellos de
botella que contradicen el objetivo de "cero lag".

Numeración por prioridad. Las referencias son a `Codigo.gs`.

---

## P0 — Bloqueantes (corregir antes que nada)

### P0-1. Borrar una celda NO actualiza el caché ni recalcula la hoja

`Codigo.gs:84`

```js
if (valorIngresado === "" && colActual !== 14) continue;
huboCambiosRelevantes = true;
```

Cuando un operador vacía una celda de la columna A, el flujo entra al bloque de
detección de borrados (se registra en `HISTORIAL_BORRADOS`), y acto seguido cae
en este `continue`. Como `huboCambiosRelevantes` nunca se pone en `true`:

- **no se llama a `actualizarBloqueEnCache`** → toda la lógica de "1. Elimina el
  rastro viejo de RAM" (`Codigo.gs:285-293`) es **código muerto** para borrados
  puros;
- **no se llama a `actualizarGlobalPreforma` / `actualizarConteos` /
  `actualizarInventario`** → los conteos, faltantes y el cuadre quedan viejos.

Consecuencias en piso:

1. La guía borrada **sigue viva** en `globalCacheMap` y en `CACHE_SISTEMA`. Si el
   operador la reescanea en la hoja correcta, sale `⛔ DUPLICADO (En: hoja vieja)`
   apuntando a una fila que ya está vacía.
2. Como `actualizarGlobalPreforma` **preserva** cualquier estado que empiece por
   `⛔ DUPLICADO (En:` (`Codigo.gs:787` y equivalentes), ese duplicado fantasma
   se vuelve **pegajoso**: no se limpia solo nunca.
3. El pedimento no vuelve a marcar "❌ Faltan N".

Esto contradice directamente la regla *"cuando un operador escanea algo nuevo o
borra algo, el script modifica dinámicamente el Array en la RAM"*.

**Arreglo:** marcar el cambio como relevante antes del `continue`, o mejor,
separar la condición:

```js
if (valorIngresado === "") {
    // un vaciado en A/O sí es un cambio relevante: hay que purgar caché y recalcular
    if (colActual === 1 || colActual === 15) huboCambiosRelevantes = true;
    if (colActual !== 14) continue;
}
huboCambiosRelevantes = true;
```

Y al recalcular, dejar de preservar `⛔ DUPLICADO (En: ...)` a ciegas: reevaluarlo
contra el caché ya purgado.

---

### P0-2. `sincronizarMacho` machaca la columna M de `CACHE_SISTEMA`

`Codigo.gs:398-416`

```js
let hojas = source.getSheets();
for (let i = 0; i < hojas.length; i++) {
    let hojaDestino = hojas[i];
    if (hojaDestino.getName().toUpperCase() !== "MACHO") {
        ...
        hojaDestino.getRange(1, 13, maxRows, 1).clearContent();
```

`getSheets()` devuelve **todas** las hojas, incluidas las ocultas. El único filtro
es `!== "MACHO"`. Por lo tanto, cada vez que alguien edita la columna M en MACHO:

- se **borra y sobrescribe la columna 13 de `CACHE_SISTEMA`**, que es la columna
  de caché de la 7ª hoja registrada (el 7º par `_FISICO`/`_PREFORMA`);
- se ensucia igualmente `HISTORIAL_BORRADOS` (ahí la columna M está vacía, así que
  el daño es solo cosmético).

Resultado: **corrupción silenciosa del caché**. Esa hoja pierde todas sus guías del
índice, sus duplicados dejan de detectarse, y sus faltantes se calculan mal, hasta
que alguien corra `RECONSTRUIR_CACHE_TOTAL`.

**Arreglo:** excluir hojas de sistema explícitamente.

```js
const HOJAS_SISTEMA = ["MACHO", "CACHE_SISTEMA", "HISTORIAL_BORRADOS"];
...
let n = hojaDestino.getName().toUpperCase();
if (HOJAS_SISTEMA.includes(n) || n.includes("HISTORIAL")) continue;
```

Bonus: esta función es además muy cara dentro de `onEdit` (clear + write de una
columna completa × N hojas). Ver P1-1.

---

### P0-3. Los nombres de hoja se comparan en mayúsculas contra headers guardados con su capitalización original

Los headers de `CACHE_SISTEMA` se escriben con el nombre **tal cual**
(`actualizarFotografiaMental`, `Codigo.gs:329` y `Codigo.gs:350`):

```js
let nHoja = hoja.getName();               // ← sin toUpperCase
let headerFisico = nHoja + "_FISICO";
```

Pero todos los consumidores lo buscan en MAYÚSCULAS:

- `onEdit` → `const nombreHoja = hoja.getName().toUpperCase()` (`Codigo.gs:23`)
- `actualizarBloqueEnCache` → `headers.indexOf(nombreHoja + "_FISICO")` (`Codigo.gs:252`)
- detección de borrados → `cacheInfo.headers.indexOf(nombreHoja + sufijo)` (`Codigo.gs:73`)
- `getCacheData` → `hojaHeader.includes("INVENTARIO")` (`Codigo.gs:192`, **sin** normalizar)

Hoy funciona **por casualidad**, porque tus pestañas ya están en mayúsculas
("M-S T1", "INVENTARIO", "MACHO"). En cuanto alguien cree o renombre una pestaña
como `Rezago 2`, `Cuentas Especiales` o `Inventario B`, pasa lo siguiente:

| Efecto | Causa |
|---|---|
| Rebuild completo de esa hoja **en cada escaneo** | `indexOf(...) === -1` → cae al fallback `actualizarFotografiaMental` (`Codigo.gs:253`). Adiós rendimiento. |
| El caché en RAM nunca se actualiza quirúrgicamente | Se sale por el `return` antes de tocar `globalCacheMap`. |
| Borrados no se registran en el historial | `idx === -1` → `valorBorrado` queda `""`. |
| **Cada reescaneo se marca como `⛔ DUPLICADO` contra sí mismo** | En `verificarDuplicadoConCache`, `match.hoja === nombreHojaActual` compara `"Rezago 2"` vs `"REZAGO 2"` → no coincide → la hoja se ve a sí misma como "otra hoja". |
| Una hoja `Inventario B` se clasifica como Global | `hojaHeader.includes("INVENTARIO")` es `false` sin `toUpperCase()`. |

El último punto es el peor: rompe el aislamiento Inventario/Bodega/Global.

**Arreglo:** normalizar en un único lugar. Introducir un helper y usarlo en
**todos** los sitios donde se construya o compare un header:

```js
function claveHoja(nombre) { return String(nombre).trim().toUpperCase(); }
```

y en `getCacheData`: `let hojaHeader = claveHoja(header.replace("_FISICO", ""));`

---

## P1 — Graves (rendimiento y auditoría)

### P1-1. `sincronizarMovidosBodegaDesdeCache` corre en CADA escaneo de una hoja Global

`Codigo.gs:988` la llama al final de `actualizarGlobalPreforma`, sin condición
salvo `!esRezago`. Y esa función (`Codigo.gs:521-585`):

1. recorre todo el caché para construir `escaneadosDestino`;
2. hace `getSheets()` y, por **cada** bodega, un `getRange(1,1,lr,2).getValues()` **en vivo**;
3. si detecta cambios, hace `setValues` y **vuelve a llamar a `actualizarConteos`**
   sobre esa bodega — que a su vez lee 12 columnas completas y escribe estados,
   colores, tachados y colores de fuente.

Es, con diferencia, lo más caro del sistema, y se dispara en cada lectura de
pistola en una Global. Con 6-8 bodegas de varios miles de filas esto solo ya puede
comerse los 30 s del trigger simple.

Contradice directamente el principio *"jamás llamadas pesadas de la API dentro de
bucles"*: aquí el bucle es sobre hojas, y dentro hay lecturas y escrituras completas.

**Arreglo recomendado:**
- Leer las bodegas **desde el caché** (`cacheInfo`), no en vivo, para decidir si hay
  algo que cambiar; solo tocar la hoja cuando realmente cambió algo.
- No re-llamar a `actualizarConteos` completo: la única cosa que cambia es el
  contador de "faltan N por mover". Actualizar solo `C1:C3` y la fila cabecera.
- O mejor: sacar la sincronización de "movidos" del camino crítico del escaneo y
  llevarla a `actualizadorAutomaticoGlobal` (trigger por tiempo, p. ej. cada minuto)
  o al ítem de menú "Forzar actualización".

### P1-2. Usar un trigger `onEdit` **instalable**, no el simple

Hoy `onEdit(e)` es un trigger simple. Eso implica:

- **límite duro de 30 segundos** de ejecución;
- `Session.getActiveUser().getEmail()` devuelve cadena vacía en muchos escenarios
  (por eso, entre otras cosas, hoy no se registra el usuario — ver P1-4);
- no hay autorización para servicios externos si algún día quieres notificaciones.

Con recálculos de hojas completas + `sincronizarMacho` + sincronización de movidos,
30 s es un techo real, no teórico. Un trigger instalable (`ScriptApp.newTrigger('alEditar').forSpreadsheet(ss).onEdit().create()`)
sube el límite a 6 minutos y habilita el email del editor.

Nota: al pasar a instalable, renombra la función (p. ej. `alEditar`) para no dejar
también el simple activo y ejecutar todo dos veces.

### P1-3. Lecturas y `appendRow` uno por uno dentro del bucle de borrados

`Codigo.gs:66` y `Codigo.gs:80`:

```js
let celdaEstadoRelacionada = hoja.getRange(filaActual, colActual === 1 ? 2 : 16);
let valorAnteriorEstado = String(celdaEstadoRelacionada.getValue()).trim();
...
registrarEnHistorial(...);   // hace un appendRow por llamada
```

Ambas están dentro del doble `for` de filas × columnas. Si alguien selecciona 300
filas y pulsa Supr: **300 `getValue()` + 300 `appendRow()`** = ~600 llamadas a la
API en una sola ejecución. Timeout garantizado, y el historial queda a medias.

**Arreglo:**
- El estado anterior ya está disponible sin leer la hoja: usa `e.oldValue`
  (para ediciones de celda única) o lee **una vez** el bloque
  `hoja.getRange(filaInicial, 2, numRows, 1)` antes del bucle, igual que ya haces
  con `valsC12` (`Codigo.gs:52`).
- Acumular las filas de historial en un array y hacer **un solo**
  `hojaHistorial.getRange(lr+1, 1, filas.length, 8).setValues(filas)` al final.

Lo mismo aplica a `limpiarGuiasMovidasSeleccion` (`Codigo.gs:1424` y `1446`), que
también llama a `registrarEnHistorial` dentro de bucles.

### P1-4. El historial NO registra el usuario

La regla declarada dice: *"registra el evento ... capturando: Fecha, Hoja, Fila,
Valor borrado y el **Usuario (Email)** que realizó la acción"*.

`registrarEnHistorial` (`Codigo.gs:383-396`) escribe 7 columnas: FECHA Y HORA,
PESTAÑA, FILA, COLUMNA, GUÍA/PEDIMENTO BORRADO, ESTADO ANTERIOR, MOTIVO.
**No hay columna de usuario y nunca se llama a `Session.getActiveUser().getEmail()`.**

Sin eso el historial no es auditable: sabes qué se borró, no quién. Añadir columna
`USUARIO` y, ojo, esto **requiere el trigger instalable** de P1-2 para que el email
no venga vacío.

### P1-5. Se pisan las horas de escaneo de filas vecinas

En los tres "cerebros" (`actualizarGlobalPreforma`, `actualizarConteos`,
`actualizarInventario`) el array de horas se construye así:

```js
if (valB === "") resultadosHoras.push(['']);
else resultadosHoras.push([horaActual]);   // ← horaActual = AHORA
```

Es decir, **toda** fila no vacía recibe la hora actual. Luego
`aplicarCambiosOptimizado` (`Codigo.gs:598`) escribe bloques contiguos:

```js
hoja.getRange(b.min + 1, colHora, numRows, 1).setValues(resultadosHoras.slice(...));
```

Y los bloques agrupan filas con hasta 2 de separación (`Codigo.gs:592`). Cuando
llega un escaneo nuevo, cambian la fila escaneada + la fila de resumen anterior +
la cabecera del pedimento → **esas filas vecinas pierden su hora original y se
sellan con la hora del último escaneo**. La columna L deja de ser trazable.

**Arreglo:** conservar la hora existente y solo poner la nueva si estaba vacía:

```js
let horaPrevia = String(datosMasivos[i][11]).trim();
resultadosHoras.push([valB === "" ? '' : (horaPrevia || horaActual)]);
```

### P1-6. `aplicarCambiosOptimizado` nunca limpia una hora que sobra

`Codigo.gs:591`:

```js
if (String(resultadosStatus[i][0]) !== originalStatus || (originalHora === "" && nuevaHora !== ""))
```

Detecta "había hora vacía y ahora hay hora", pero **no** el caso inverso
("había hora y ahora debe quedar vacía") cuando el estado no cambió. Filas donde se
borró la guía pero la columna B ya estaba vacía conservan el timestamp huérfano.
Añadir `|| (originalHora !== "" && nuevaHora === "")`.

Mismo problema con los colores: si el texto de estado queda idéntico pero el color
debe cambiar, el bloque no se escribe.

### P1-7. `actualizarBloqueEnCache` no expande las filas de `CACHE_SISTEMA`

`Codigo.gs:305` y `Codigo.gs:322`:

```js
cacheSheet.getRange(filaInicial + 1, colIdx + 1, numRows, 1).setValues(valsToSet);
```

Se expande el array en RAM (`Codigo.gs:263-267`) pero **no la hoja**. Si un escaneo
cae por debajo de `cacheSheet.getMaxRows()`, `getRange` lanza excepción dentro de
`onEdit`. El `finally` libera el lock, pero el escaneo se pierde sin validar y el
caché queda desincronizado.

`actualizarFotografiaMental` sí acolcha +100 filas (`Codigo.gs:338-340`), así que tarda
en aparecer — pero es cuestión de tiempo. Añade el mismo `insertRowsAfter` aquí.

### P1-8. `esHojaPrincipal` clasifica `CACHE_SISTEMA` y `HISTORIAL_BORRADOS` como hojas Globales

`Codigo.gs:422-426`:

```js
function esHojaPrincipal(nombreHoja) {
    let n = nombreHoja.toUpperCase();
    if (n === "MACHO" || n.includes("INVENTARIO") || esHojaBodega(n)) return false;
    return true;   // ← todo lo demás, incluidas las hojas de sistema
}
```

Si alguien edita manualmente la columna A de `HISTORIAL_BORRADOS` (o quita el
ocultamiento de `CACHE_SISTEMA` y toca algo), `onEdit` ejecuta
`actualizarGlobalPreforma` sobre esa hoja: inserta columnas hasta la S, escribe
`C1:C3`, `Q1:Q2` y pinta la columna O entera. Destruye la hoja de auditoría.

`actualizadorAutomaticoGlobal` sí las excluye explícitamente (`Codigo.gs:1249`) —
es una inconsistencia. Centralizar la exclusión en `esHojaPrincipal`.

### P1-9. Columnas huérfanas en `CACHE_SISTEMA` tras renombrar o borrar una pestaña

Nada elimina headers de hojas que ya no existen. Ni `actualizarFotografiaMental`
ni `RECONSTRUIR_CACHE_TOTAL` (`Codigo.gs:1493`) hacen limpieza: solo reescriben
las columnas de las hojas presentes.

Consecuencia: una pestaña borrada sigue produciendo
`⛔ DUPLICADO (En: HOJA_QUE_YA_NO_EXISTE Fila 412)` para siempre.

**Arreglo:** en `RECONSTRUIR_CACHE_TOTAL`, borrar la hoja `CACHE_SISTEMA` y
recrearla desde cero, o recorrer los headers y eliminar los pares cuya hoja no
exista en `source.getSheets()`.

---

## P2 — Medios

### P2-1. `procesarCostales` sobrescribe la columna A sin desplazar

`Codigo.gs:646`:

```js
hoja.getRange(filaDestino, 1, datosAPegar.length, 1).setValues(datosAPegar);
```

Escribe N filas hacia abajo desde `filaDestino`, **pisando lo que hubiera**. Si el
operador dispara COSTALES en una fila que no está al final, pierde datos escaneados
sin aviso. Tampoco valida que existan suficientes filas (`getRange` puede lanzar).

Sugerencia: `insertRowsAfter` para hacer hueco, o validar que el rango destino esté
vacío y avisar con un `toast` si no lo está.

### P2-2. En Inventario, un duplicado entre dos ubicaciones IW de la MISMA hoja no se detecta

Dos capas fallan a la vez:

- `verificarDuplicadoConCache` (`Codigo.gs:218`) hace `if (match.hoja === nombreHojaActual) continue;` — ignora la propia hoja.
- `actualizarInventario` (`Codigo.gs:1177`) hace `guiasFisicas.clear()` en cada fila `IW`, así que el `Set` de duplicados locales se reinicia por ubicación.

Resultado: la misma guía puede estar en `IW-A-01` y `IW-B-07` de la misma pestaña
sin ninguna alerta. Para un inventario de ubicaciones finales eso es justo el error
que quieres cazar.

**Arreglo:** en `actualizarInventario`, llevar un `Set` a nivel de hoja además del
`Set` por ubicación, y marcar `⛔ Duplicado en otra ubicación (IW-xxx)`.

### P2-3. Los menús no invalidan las variables globales tras `actualizarFotografiaMental`

`agruparPorPedimento` (`Codigo.gs:1391`), `limpiarGuiasMovidasSeleccion`
(`Codigo.gs:1487`) y `forzarActualizacionHojaActiva` (`Codigo.gs:1236`) terminan
llamando a `actualizarFotografiaMental`, que reescribe `CACHE_SISTEMA`, pero **no**
resetean `globalCacheData` / `globalCacheMap`. Solo `RECONSTRUIR_CACHE_TOTAL` lo hace
(`Codigo.gs:1504-1506`).

En `agruparPorPedimento` el problema es visible: las filas se reordenan, así que los
`fila:` guardados en el `Map` quedan apuntando a posiciones incorrectas, y los
mensajes de duplicado citan filas equivocadas.

**Arreglo:** un helper `invalidarCacheRAM()` y llamarlo al final de las tres.

### P2-4. Los menús no toman el lock del documento

`onEdit` usa `LockService.getDocumentLock()`, pero `agruparPorPedimento`,
`limpiarGuiasMovidasSeleccion` y `RECONSTRUIR_CACHE_TOTAL` escriben masivamente sin
lock. Si un operador escanea mientras otro reordena, se corrompen datos. Envolver
las funciones de menú en el mismo lock.

### P2-5. Un `waitLock` fallido descarta el escaneo en silencio

`Codigo.gs:9-14`:

```js
try { lock.waitLock(3000); } catch (lockError) { return; }
```

Con pistolas disparando en paralelo, esto pasará. El escaneo queda en la columna A
**sin estado, sin hora y sin entrar al caché** — y como nadie lo sabe, el operador
sigue. Luego la guía no cuenta como duplicado en ningún lado.

Mínimo: subir a 10 s y, si aun así falla, escribir `⏳ Reintentar` en la columna B
para que se vea. La red de seguridad existe (`actualizadorAutomaticoGlobal` detecta
"columna A llena, columna B vacía"), pero solo si ese trigger por tiempo está
realmente configurado y no depende de `getActiveSpreadsheet()` — ver P2-9.

### P2-6. `hoja.getRange(1, 15, ultimaFila, 1).setBackgrounds(...)` incondicional

`Codigo.gs:976`. Repinta la columna O **completa** en cada recálculo, sin el diffing
por bloques que sí se usa para todo lo demás. En una Global de 5 000 filas es una
escritura de 5 000 celdas por escaneo. Pasarla por `aplicarCambiosOptimizado` o
comparar contra `getBackgrounds()` previo.

### P2-7. Rangos que asumen ancho mínimo de hoja

- `actualizarFotografiaMental` (`Codigo.gs:374`): `hoja.getRange(1, 15, lr, 1)` falla si la hoja tiene menos de 15 columnas.
- `actualizarConteos` / `actualizarInventario`: `getRange(1, 1, ultimaFila, 12)` falla con menos de 12.

`actualizarGlobalPreforma` sí se protege (`Codigo.gs:664-665`). Aplicar la misma
guarda en las demás; si no, `RECONSTRUIR_CACHE_TOTAL` revienta con la primera
pestaña estrecha del archivo.

### P2-8. `procesarCostales` llama a la función equivocada en Inventario

`Codigo.gs:651-655`: el `else` (todo lo que no es Principal ni Bodega) son las hojas
de Inventario y MACHO, y ahí llama a `actualizarConteos`, que espera la estructura
pedimento/guía, no ubicaciones `IW`. Debería llamar a `actualizarInventario` o
simplemente no hacer nada.

### P2-9. `actualizadorAutomaticoGlobal` usa `getActiveSpreadsheet()`

`Codigo.gs:1241`. En un trigger por tiempo no hay "hoja activa" garantizada; lo
correcto es `SpreadsheetApp.openById('<ID>')`. Si esta es tu red de seguridad para
los escaneos perdidos (P2-5), conviene asegurarse de que realmente corre.

### P2-10. `Array(eliminadas).fill(Array(12).fill(""))` comparte la misma referencia

`Codigo.gs:1465`. Las N filas vacías son **el mismo array**. Hoy no rompe nada
porque solo se pasa a `setValues`, pero es una bomba de relojería en cuanto alguien
mute una fila. Usar `Array.from({length: eliminadas}, () => Array(12).fill(""))`.

### P2-11. `actualizarBloqueEnCache` relee los headers de la hoja en cada edición

`Codigo.gs:249-250`: `getLastColumn()` + `getValues()` en cada escaneo, teniendo
`globalCacheHeaders` ya en RAM. Son 2 llamadas de API evitables por escaneo.

### P2-12. `e.oldValue` está sin usar

El objeto del evento trae el valor previo gratis para ediciones de celda única. Se
podría usar como fuente primaria para la detección de borrados (con el caché como
respaldo para ediciones multi-celda), ahorrando la búsqueda en el caché y la lectura
de la celda de estado.

### P2-13. Condición muerta en `agruparPorPedimento`

`Codigo.gs:1366`: `if (ped !== "OTROS" && ...)` — la clave `"OTROS"` nunca se crea.

---

## Cosas que están BIEN (no tocar)

- **Indexado de filas del caché.** `globalCacheData[r]` ↔ fila `r` de la hoja ↔ fila
  `r+1` de `CACHE_SISTEMA`. Es consistente en `getCacheData`, en la detección de
  borrados y en `actualizarBloqueEnCache`. Fácil de romper en un refactor: dejarlo
  documentado.
- **Aislamiento Inventario / Bodega / Global** en `verificarDuplicadoConCache`: la
  lógica de tres ramas refleja exactamente la regla declarada (salvo el problema de
  capitalización de P0-3).
- **`Map` con array de ubicaciones por guía** — correcto para permitir que una guía
  exista lícitamente en T1 y luego en Global.
- **Módulo 10 de UPS.** Verificado contra el ejemplo canónico `1Z999AA10123456784`:
  impares (1,3,5,…) sumados tal cual = 40, pares ×2 = 56, total 96 → dígito 4 ✅.
  Coincide con lo que calcula el código. Aun así, ver la recomendación de fixture
  más abajo.
- **`aplicarCambiosOptimizado`** con agrupación en bloques contiguos: buena idea, y
  el umbral de 2 filas de hueco es un compromiso razonable.

---

## Riesgos menores a vigilar

- **`esGuiaUPSValida`**: cualquier cadena de más de 7 caracteres que no empiece por
  `1Z` se acepta sin validación (`Codigo.gs:444`). Una guía tecleada como `IZ...`
  (i latina en vez de uno) pasa como válida. Si solo trabajas con UPS, exige el
  prefijo `1Z`; si hay otras paqueterías, al menos un patrón por transportista.
- **Sin fixture de regresión.** Guarda 20-30 guías reales (válidas e inválidas) en
  una función de test y córrela tras cada cambio en `esGuiaUPSValida`. Es la única
  función del script donde un error de un carácter rechaza mercancía real.
- **`mapaPreformas` como objeto plano** en vez de `Map` (`Codigo.gs:680`): con claves
  numéricas el orden de iteración de `for...in` es el numérico ascendente, no el de
  inserción. Hoy no importa porque solo se usa para lookups, pero un `Map` sería más
  seguro y consistente con el resto.
- **`onEdit` no maneja multi-rango** (`e.range` es un único rango; una selección
  discontinua con Ctrl solo reporta el último).

---

## Orden de ataque sugerido

1. **P0-2** (`sincronizarMacho` excluye hojas de sistema) — una línea, evita corrupción.
2. **P0-3** (normalizar nombres con `claveHoja()`) — evita el peor fallo latente.
3. **P0-1** (borrados actualizan caché y recalculan) — restaura la regla de negocio.
4. **P1-2** (pasar a trigger instalable) — desbloquea P1-4 y sube el techo a 6 min.
5. **P1-1** (sacar la sincronización de movidos del camino crítico) — el mayor golpe
   de rendimiento.
6. **P1-3 / P1-4** (historial en batch + columna usuario) — cierra la auditoría.
7. Resto de P1, luego P2.
