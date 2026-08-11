# Manual técnico — WMS Salidas ESCANEOS UPS

Referencia para quien mantiene el código de `Codigo.gs` (Google Apps Script,
motor V8). No es el manual del operador (`MANUAL-OPERADORES.md`): esto asume que
sabes JavaScript y quieres modificar el sistema sin romperlo.

Léelo junto con `REVISION-CODIGO.md` (por qué estaba roto) y
`CORRECCIONES-APLICADAS.md` (qué se cambió). Este documento describe **cómo
funciona hoy**.

---

## 1. Qué es y qué prioriza

Un WMS montado sobre una hoja de Google Sheets. Operadores escanean códigos de
barras con pistola en la columna A de varias pestañas; el `onEdit` valida en
tiempo real, detecta duplicados, cuadra contra una lista esperada y colorea.

**La prioridad absoluta es el rendimiento del `onEdit`.** El trigger simple
tiene un techo de 30 s (el instalable, 6 min), y varios operadores escanean en
paralelo. Todo el diseño gira en torno a no releer las hojas en cada escaneo.

Dos reglas que no se negocian:

1. **Cero llamadas a la API de Sheets dentro de bucles.** Se lee en bloque, se
   procesa en memoria, se escribe en lote.
2. **El índice de duplicados vive en RAM**, no se reconstruye en cada escaneo;
   se actualiza quirúrgicamente.

---

## 2. Modelo de datos

### Columnas de una pestaña de trabajo

| Col | # | Contenido | Quién escribe |
|-----|---|-----------|---------------|
| A | 1 | **Físico**: lo que se escanea (pedimento o guía) | Operador |
| B | 2 | **Estado** del físico (`✅ Ok`, `⛔ DUPLICADO`, …) | Script |
| C | 3 | Resúmenes (filas 1-3: totales) | Script |
| D | 4 | Marca `T1` (fuerza tipo) o `COSTALES` (dispara `procesarCostales`) | Operador |
| L | 12 | Hora del escaneo físico (`HH:mm:ss`) | Script |
| M | 13 | Lista FEMAD (Guardia Nacional), replicada desde MACHO | `sincronizarMacho` |
| N | 14 | Letra `a`/`b`/`c` → color del bloque de preforma | Operador |
| O | 15 | **Preforma**: lista esperada (solo Globales) | Operador |
| P | 16 | Estado de la preforma | Script |
| Q | 17 | Resúmenes de preforma (filas 1-2) + marcas `COSTALES`/`FIN` | Ambos |
| S | 19 | Hora del escaneo de preforma | Script |

Nota sobre índices: `datosMasivos` se lee con `getRange(1,1,lr,19)`, base 0. Por
eso col A = `[i][0]`, col B = `[i][1]`, col D = `[i][3]`, col N = `[i][13]`,
col O = `[i][14]`, col P = `[i][15]`. **Fila de hoja = índice + 1.**

### Estructura de bloques en la columna A

```
6100166          ← cabecera (pedimento, 7 dígitos) o marcador estructural
1Z...             ← guía
1Z...             ← guía
6100168          ← nueva cabecera → cierra el bloque anterior
...
```

Todo lo que va debajo de una cabecera pertenece a ella hasta la siguiente.
`esCabeceraBloque()` reconoce cabeceras: pedimento de 7 dígitos **o** marcador
estructural (`esMarcadorEstructural`: `COSTALES`, `FIN`, `SIN_CABECERA`,
`SIN PEDIMENTO`). Los marcadores abren bloque pero no cuentan como pedimento ni
entran al índice de duplicados.

### Taxonomía de pestañas

Cuatro dominios, decididos **por el nombre** (todo pasa por `claveHoja()` =
`trim().toUpperCase()`):

| Dominio | Predicado | Ejemplos | Preforma |
|---------|-----------|----------|----------|
| Principal / Global | `esHojaPrincipal` | GLOBAL PENDIENTE, AGA, REZAGO | Sí |
| M-S (registro previo) | `esHojaMS` | M-S T1, M-S GLOBALES, M-S A1, SIMPLES, MULTIPLES | No |
| Inventario | `esHojaInventario` | INVENTARIO A, INVENTARIO MACHO | No |
| Sistema | `esHojaSistema` | CACHE_SISTEMA, HISTORIAL_BORRADOS, MACHO, *plantillas* | — |

`esHojaSistema` = `esHojaInterna` (CACHE/HISTORIAL) **∪** `esHojaMacho`
(cualquier pestaña con "MACHO" en el nombre). Diferencia clave: las plantillas
MACHO **sí** reciben el volcado de la columna M, las internas **no**.
Ver §7.

> **Qué es una M-S:** un **registro previo**. El bulto se escanea cuando ya está
> físicamente presente pero aún no se sabe en qué unidad se va. Su contenido
> alimenta la preforma de la Global (§6.1).

---

## 3. El caché híbrido (la pieza central)

### 3.1 Las tres capas

1. **`CACHE_SISTEMA`** (hoja oculta) — persistencia. Una columna por
   `HOJA_FISICO` y otra por `HOJA_PREFORMA` (las M-S solo tienen `_FISICO`, §6.3).
   Fila 1 = headers; fila `r+1` = fila `r` de la hoja origen.
2. **`globalCacheData`** (`Array<Array>`) — la fotografía en RAM. `[0]` =
   headers. Índice de fila **idéntico** al de `CACHE_SISTEMA`.
3. **`globalCacheMap`** (`Map<guía, Array<ubicación>>`) — índice O(1) de
   duplicados. Cada ubicación es `{hoja, fila, isMS, isInventario}`. Una guía
   puede tener varias ubicaciones (existe lícitamente en M-S y luego en Global).

Las tres viven en variables globales del motor V8, que **sobreviven entre
escaneos** de una misma invocación. `getCacheData()` las carga una vez
(construye el Map recorriendo columnas `_FISICO`); las siguientes llamadas
devuelven la RAM.

### 3.2 Invariante crítico de indexación

```
globalCacheData[r]  ↔  fila (r+1) de CACHE_SISTEMA  ↔  fila r de la hoja origen
```

Se mantiene en `getCacheData` (lectura), en la detección de borrados y en
`actualizarBloqueEnCache` (escritura). **Romperlo desalinea todos los
duplicados.** Cualquier refactor que toque el caché debe preservarlo.

### 3.3 Actualización quirúrgica

`actualizarBloqueEnCache()` es el corazón. Cuando se edita la columna A:

1. Expande RAM y hoja de caché si el escaneo cae más abajo (`asegurarFilas`).
2. Por cada celda: compara `oldStr` (RAM) vs `vStr` (nuevo).
   - Si `oldStr !== ""` y cambió → **purga** la ubicación vieja del Map. *(Esto
     es lo que hace que un borrado deje de contar como duplicado al instante.)*
   - Si `vStr !== ""` → añade la ubicación nueva.
3. Escribe la columna del caché con **un** `setValues`.
4. Devuelve un `Set` de guías tocadas (viejas + nuevas), o `null` si tuvo que
   reconstruir la fotografía completa.

El `Set` devuelto acota el trabajo de sincronización aguas abajo (§6.2).

### 3.4 Reconstrucción y poda

- `actualizarFotografiaMental(hoja)` — re-fotografía **una** hoja al caché.
  Reserva columnas de a una (`columnaDeHeader`); a las M-S no les da `_PREFORMA`.
- `podarCacheHuerfano(source)` — borra columnas de pestañas que ya no existen
  (duplicados fantasma) y las `_PREFORMA` sobrantes de M-S. Corre en el trigger
  por tiempo.
- `RECONSTRUIR_CACHE_TOTAL()` — borra `CACHE_SISTEMA` entera y la rehace. Único
  botón que arregla un caché corrupto.
- `invalidarCacheRAM()` — pone las tres globales en `null`. **Obligatorio**
  después de cualquier `actualizarFotografiaMental` fuera del `onEdit`, o la RAM
  queda desincronizada de la hoja.

---

## 4. Flujo de ejecución

```
onEdit(e)  /  alEditar(e)          ← simple vs instalable (§8)
   └─ procesarEdicion(e)
        ├─ descartes baratos (columna irrelevante / hoja sistema) ANTES del lock
        ├─ LockService.getDocumentLock().waitLock(10s)   → si falla: marcarPendiente()
        ├─ sincronizarMacho (si tocaMacho)
        ├─ getCacheData()                                 ← carga RAM
        ├─ bucle filas × columnas:
        │    ├─ detectar borrados → filasHistorial[]
        │    ├─ limpiar caracteres no [A-Z0-9]
        │    ├─ /^\d{1,6}$/ → "🛑 ERROR: Faltan N números"
        │    ├─ verificarDuplicadoConCache() → batchUpdates[]
        │    └─ COSTALES → procesarCostales()
        ├─ aplicarBatchUpdates()          ← escritura en lote de errores/duplicados
        ├─ registrarEnHistorialLote()     ← un solo setValues
        ├─ actualizarBloqueEnCache()      → guiasAfectadas (Set)
        ├─ recalcularHoja()               ← el "cerebro" que toque (§6)
        └─ sincronizarInventariosAfectados / sincronizarSalidasMS
```

`recalcularHoja()` despacha al cerebro según el dominio: `actualizarInventario`,
`actualizarMS`, o `actualizarGlobalPreforma`.

Columnas que disparan el `onEdit`: `colsValidas = [1, 4, 14, 15, 17]` (A, D, N,
O, Q) más la 13 (M) solo en MACHO. Cualquier otra edición se descarta sin pedir
el lock.

---

## 5. Aislamiento de duplicados

`verificarDuplicadoConCache()` (por escaneo) y `calcularDuplicadosExternos()`
(hoja completa, en cada recálculo) aplican la misma regla de dominios:

| Hoja actual | Choca con | Ignora |
|-------------|-----------|--------|
| Inventario | otros inventarios **y otra ubicación IW de sí misma** | Global, M-S |
| M-S | otras M-S | Global, Inventario, sí misma |
| Global/Rezago/AGA | otras Globales | M-S, Inventario, sí misma |

El caso especial de inventario: **no** se descarta la hoja actual, solo la fila
exacta (`match.hoja === clave && match.fila === filaActual`), para poder detectar
la misma guía en dos ubicaciones IW de la misma pestaña.

Los `⛔ DUPLICADO` **se reevalúan desde el caché en cada pasada** (no se
conserva el texto viejo), así que se limpian solos al borrar el original. Este
fue el bug P0-1: antes eran permanentes.

---

## 6. Los tres cerebros

Cada uno lee su rango en bloque, procesa en arrays paralelos
(`resultadosB`, `resultadosHoras`, `coloresB`), y escribe con
`aplicarCambiosOptimizado()`.

### 6.1 `actualizarGlobalPreforma(hoja, source, cacheInfo, guiasAfectadas)`

El más complejo. Cubre Globales, REZAGO y AGA. Rango: `1..lr × 19` columnas.

- Parsea preforma (col O) y físico (col A) en bloques `{pedimento, filaPedimento,
  guias[], filasGuias[]}`.
- **Fusiona el registro de las M-S** en la preforma esperada
  (`obtenerRegistroMSDesdeCache` → `registroMS`): la lista esperada de un
  pedimento = su columna O **+** lo registrado en M-S para ese pedimento.
  **Cualquier M-S alimenta a cualquier destino** (Global, A1, T1, AGA…): la
  carga se separa a mano por tipo, así que no hay filtro origen→destino. Lo
  único que se descarta es que una M-S se jale a sí misma.
- Cuadra: `✅ Ok` / `❌ Va en: X` / `⚠️ Sobra` / `❌ Faltan N (...)` / `✅ COMPLETO`.
- Informa la M-S real por la que pasó (`origenesReales`, del caché) en vez de
  adivinarla.
- REZAGO tiene su propia rama (recuperación por pedimento).
- Al final llama a `sincronizarSalidasMS` (§6.2) salvo en REZAGO.

### 6.2 `sincronizarSalidasMS(source, cacheInfo, guiasAfectadas)`

Marca en las M-S las guías que ya salieron en una unidad (`➡ Salió en <hoja>`).
Optimización clave: si `guiasAfectadas` viene con contenido, **descarta en RAM**
(`hojaContieneAlgunaGuia` sobre `mapaColumnasFisico`) las M-S que no contienen
ninguna guía tocada, sin abrir la hoja. Con `null` hace barrido completo
(menú / trigger por tiempo).

### 6.3 `actualizarMS(hoja, source, cacheInfo)`

Cerebro de las M-S. El tipo (`M-S T1` / `M-S GLOBALES` / …) lo da `tipoMS()`
**por el nombre de la pestaña**, no por heurística sobre las guías (bug
corregido: antes comparaba prefijos, que no distinguen nada). Cuenta salidas vs
pendientes: `✅ TODO SALIÓ` / `⚠️ Faltan N por salir`. `esEstadoSalida()`
reconoce el estado nuevo (`➡ Salió en`) y el viejo (`➡ Movido a`) para migrar
hojas ya escritas.

### 6.4 `actualizarInventario(hoja, cacheInfo)`

Ubicaciones `IW...` como cabeceras, guías debajo. Dominio cerrado: solo cruza
contra otros inventarios (§5). `sincronizarInventariosAfectados` propaga a las
demás pestañas de inventario que contengan la guía tocada.

---

## 7. Sincronización MACHO

`sincronizarMacho(hojaMacho, source)` replica la columna M (lista FEMAD) a todas
las pestañas **excepto**:

- La propia MACHO (es el origen).
- Las internas (`esHojaInterna`): en `CACHE_SISTEMA` la columna M es una columna
  de caché, no la lista. **Este era el bug P0-2**: sin la exclusión, editar la M
  corrompía el índice de la 7ª hoja registrada.

Las plantillas de inventario (`INVENTARIO MACHO NO BORRAR`) **sí** reciben la M,
para que las copias que salgan de ellas nazcan con la validación puesta.

---

## 8. Triggers y concurrencia

- **`onEdit`** (simple): techo 30 s, no identifica al editor. Se aparta si el
  instalable está activo (`triggerInstalableActivo()` lee `PROP_TRIGGER` de
  `ScriptProperties`).
- **`alEditar`** (instalable): techo 6 min, identifica al editor (con matices,
  §9). `instalarTriggerAvanzado()` lo crea + crea el repaso por tiempo cada 5 min.
- **`actualizadorAutomaticoGlobal`** (por tiempo, cada 5 min): red de seguridad.
  Recoge filas con dato pero sin estado (`filaSinValidar`, que incluye el
  marcador `⏳ Pendiente`), poda el caché y sincroniza salidas. Dos pasadas con
  **una sola** recarga de caché (antes era O(n²)).

Lock: `LockService.getDocumentLock()`. El `onEdit` intenta 10 s; si falla,
`marcarPendiente()` escribe `⏳ Pendiente (reintenta)` en col B para que no se
pierda en silencio y el trigger por tiempo lo recoja. Las funciones de menú
corren bajo `conLock()`.

---

## 9. Historial auditado

`HISTORIAL_BORRADOS`. `eventoHistorial()` construye un objeto por campo;
`registrarEnHistorialLote()` **lee los headers reales de la hoja** y coloca cada
campo en su columna (tabla de sinónimos `HIST_SINONIMOS`, sin acentos). Campos
faltantes se añaden al final. Motivo: el archivo de producción tiene `USUARIO`
en la columna B, no al final; escribir con orden fijo descuadraría la auditoría.

Usuario (`obtenerUsuarioActual`): `getActiveUser().getEmail()`. Entre cuentas
@gmail distintas Google devuelve `""` — no hay forma de sortearlo. El respaldo
`getEffectiveUser()` **solo se usa con el trigger simple**; con el instalable
devolvería al instalador, no al editor, así que se escribe `(no identificado)`.

---

## 10. Escritura diferencial

`aplicarCambiosOptimizado()` no reescribe la hoja entera: detecta filas que
cambiaron (estado, hora **puesta o quitada**, o color) y las agrupa en bloques
contiguos (une los que están a ≤2 filas). Escribe cada bloque con un `setValues`
/ `setBackgrounds`. `horaPreservada()` conserva la hora original: solo sella la
actual si la celda estaba vacía (bug P1-5: antes pisaba las vecinas).

---

## 11. Invariantes y trampas (leer antes de tocar)

1. **Indexación del caché** (§3.2). Lo más fácil de romper en un refactor.
2. **`invalidarCacheRAM()` tras re-fotografiar fuera del `onEdit`.** Si no, la
   RAM miente. Ya está en las funciones de menú; replícalo en cualquier nueva.
3. **Nombres siempre por `claveHoja()`.** Nunca compares `hoja.getName()` crudo
   contra un header. El bug P0-3 era exactamente esto.
4. **Nada de API dentro de bucles.** Si necesitas un dato de la hoja en un bucle,
   léelo en bloque antes (patrón `valsEstadoB`, `valsC12`).
5. **Marcadores estructurales no son guías.** Si añades un texto que el script
   escriba en col A, mételo en `esMarcadorEstructural` o contará como bulto y se
   indexará como duplicado.
6. **`esGuiaUPSValida` acepta cualquier cosa >7 caracteres** que no sea 1Z. Guías
   cortas (≥8 dígitos) pasan; 7 dígitos exactos = pedimento. Si cambias esto,
   corre `TEST_guias()` desde el editor.
7. **El tipo de M-S y la M-S real salen del nombre/caché, no de las guías.**
   No reintroduzcas heurísticas de prefijo.

---

## 12. Cómo probar

`tests/harness.js` cubre la **lógica pura** (sin API de Sheets) con stubs:
clasificación de hojas, validación de guías, aislamiento de duplicados,
preservación de horas, layout del historial, marcadores. 73 asserts.

```bash
node tests/harness.js        # todo verde antes de commitear
node --check Codigo.gs        # sintaxis
```

Lo que toca la API **solo se prueba en un archivo real**: copia el spreadsheet,
`RECONSTRUIR_CACHE_TOTAL`, instala el trigger avanzado, y verifica escaneo →
duplicado → borrado → costales → agrupar → limpiar.

---

## 13. Índice de funciones

### Clasificación y utilidades
`claveHoja` · `esHojaInterna` · `esHojaMacho` · `esHojaSistema` · `esHojaMS` ·
`tipoMS` · `esHojaInventario` · `esHojaPrincipal` · `usaPreforma` ·
`esMarcadorEstructural` · `esCabeceraBloque` · `asegurarColumnas` ·
`asegurarFilas` · `invalidarCacheRAM` · `obtenerArchivo` · `buscarHojaPorClave`

### Entrada / concurrencia
`onEdit` · `alEditar` · `procesarEdicion` · `triggerInstalableActivo` ·
`instalarTriggerAvanzado` · `desinstalarTriggerAvanzado` · `intentarLock` ·
`marcarPendiente` · `conLock`

### Caché
`getCacheData` · `mapaColumnasFisico` · `hojaContieneAlgunaGuia` ·
`verificarDuplicadoConCache` · `calcularDuplicadosExternos` ·
`actualizarBloqueEnCache` · `columnaDeHeader` · `actualizarFotografiaMental` ·
`podarCacheHuerfano` · `RECONSTRUIR_CACHE_TOTAL`

### Cerebros y escritura
`recalcularHoja` · `actualizarGlobalPreforma` · `actualizarMS` ·
`actualizarInventario` · `aplicarCambiosOptimizado` · `horaPreservada` ·
`aplicarBatchUpdates` · `procesarCostales`

### Pre-procesamiento desde caché
`obtenerGuiasRezagoDesdeCache` · `obtenerRegistroMSDesdeCache` ·
`sincronizarSalidasMS` · `sincronizarInventariosAfectados` · `sincronizarMacho`

### Historial / validación
`eventoHistorial` · `registrarEnHistorialLote` · `normalizarTitulo` ·
`esEstadoSalida` · `filaSinValidar` · `esGuiaUPSValida` · `TEST_guias` ·
`obtenerUsuarioActual`

### Menú
`onOpen` · `forzarActualizacionHojaActiva` · `actualizadorAutomaticoGlobal` ·
`agruparPorPedimento` · `limpiarGuiasMovidasSeleccion` · `diagnosticoSistema` ·
`protegerHojasSistema`

---

## 14. Constantes de configuración

| Constante | Valor | Para qué |
|-----------|-------|----------|
| `ID_ARCHIVO` | `''` | ID del spreadsheet; solo lo necesita el trigger por tiempo si `getActiveSpreadsheet()` devuelve null |
| `HOJAS_INTERNAS` | `["CACHE_SISTEMA","HISTORIAL_BORRADOS"]` | Hojas del motor |
| `HOJA_MACHO` | `"MACHO"` | Origen de la lista FEMAD |
| `PROP_TRIGGER` | `'TRIGGER_EDICION_INSTALADO'` | Flag del trigger instalable en ScriptProperties |
| `TXT_SALIO` | `"➡ Salió en "` | Prefijo del estado de salida de M-S |
| `TXT_PENDIENTE` | `"⏳ Pendiente (reintenta)"` | Marca de escaneo no validado |
| `DESC_PROTECCION` | `"Hoja interna…"` | Descripción de la protección de solo aviso |
| `HIST_ORDEN_DEFECTO` | `[FECHA,USUARIO,…]` | Orden de columnas al crear el historial de cero |
