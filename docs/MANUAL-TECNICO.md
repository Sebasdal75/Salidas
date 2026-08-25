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
| Principal / Global | `esHojaPrincipal` | GLOBAL PENDIENTE, AGA, REZAGO, TRANSITO DE ARRIBO | Sí |
| M-S (registro previo) | `esHojaMS` | M-S T1, M-S GLOBALES, M-S A1, SIMPLES, MULTIPLES | No |
| Inventario | `esHojaInventario` | INVENTARIO A, INVENTARIO MACHO | No |
| Sistema | `esHojaSistema` | CACHE_SISTEMA, HISTORIAL_BORRADOS, MACHO, *plantillas* | — |

`esHojaSistema` = `esHojaInterna` (CACHE/HISTORIAL) **∪** `esHojaMacho`
(cualquier pestaña con "MACHO" en el nombre). Diferencia clave: las plantillas
MACHO **sí** reciben el volcado de la columna M, las internas **no**.
Ver §7.

> **Tránsito de arribo:** una pestaña cuyo nombre lleve `TRANSITO` o `TRÁNSITO`
> usa el cerebro de las Globales sin cambios —preforma en la O, faltantes y
> sobrantes— pero **llegar no es embarcarse**, así que `esHojaTransito` la saca
> de dos sitios: no se le exige registro previo en M-S (saldría el aviso en
> todas las guías) y **no cuenta como destino de salida** (si contara, escanear
> un bulto que llega marcaría su fila de la M-S como salida y la limpieza la
> borraría dándola por embarcada).

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
- **`alCambiarEstructura`** (instalable, `onChange`): **`onEdit` NO se dispara al
  borrar o insertar filas.** Es una limitación de Apps Script, y es el caso que
  más daño hace al caché: borrar una fila sube todas las de abajo, así que la
  correspondencia «guía → fila N» se rompe para TODAS las filas por debajo, no
  solo para la que se fue. La red de 5 minutos tampoco lo recoge, porque las
  columnas A y B suben juntas y ninguna fila queda «sin validar».

  Reacciona a `REMOVE_ROW`, `INSERT_ROW`, `REMOVE_COLUMN`, `INSERT_COLUMN` y
  `REMOVE_GRID` (`cambioAfectaAlCache()`): re-fotografía la hoja activa,
  invalida el caché y recalcula **sin `repintarTodo`**, para no llevarse por
  delante las alertas graves que sigan en pie. Con `REMOVE_GRID` además poda.

  No existe versión simple de `onChange`, así que lo instalan los dos modos del
  menú. **Al cambiar de modo hay que reinstalarlo.**

### La marca de mantenimiento

`PROP_MANTENIMIENTO` (`marcarMantenimiento` / `quitarMantenimiento` /
`hayMantenimientoEnCurso`) silencia `alCambiarEstructura` mientras el propio
sistema mueve filas. Solo la usa `cierreDelDia`: su recorte borra filas en cada
pestaña y dispararía una avalancha de ejecuciones rehaciendo el caché una vez
por hoja, cuando el cierre ya lo reconstruye entero al final. Caduca sola a los
2 minutos por si una ejecución se corta a medias.

El crecimiento automático **no** la usa, a propósito: marcarla ahí abriría una
ventana ciega en la que un borrado de fila real se perdería. Se prefiere repetir
un trabajo de un segundo una vez cada cincuenta escaneos.

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
   **El caché guarda la FILA DE LA HOJA (1, 2, 3…); `datosMasivos` es un array
   que empieza en 0.** La conversión es `filaHoja = i + 1`, y mezclarlas ya
   costó un bug: en los inventarios, una guía nunca se saltaba a sí misma y se
   leía la ubicación de la fila siguiente, así que la ÚLTIMA guía de cada
   ubicación IW salía duplicada contra la ubicación del bloque de abajo.
   En las M-S y las Globales no se veía porque el filtro de dominio ya descarta
   la propia hoja entera. Si escribes un test para esto, pon en el fixture la
   fila de la hoja, no el índice: el test que había codificaba el error.
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
8. **La columna B lleva DOS cosas: el estado y el resumen del bloque**, pegados
   con `SEP_RESUMEN` (`"   ►   "`). Sepáralas siempre con `cabezaEstado()` /
   `colaResumen()`. Comparar la celda entera contra un estado esperado causó un
   bucle infinito: el barrido de M-S reescribía la celda sin la cola y
   `actualizarMS` se la volvía a pegar, en cada pasada del disparador. Y al
   colgar el resumen hay que quitar el anterior, o la celda crece sin fin.
9. **No leas el caché con `getDataRange()`.** Medido: 682 ms para 236 filas, y
   **en caliente**. `getDataRange` averigua por dentro dónde acaban los datos, y
   eso lleva el mismo `getLastRow` que es la llamada más cara del sistema. Con
   un rango de límites conocidos (`getMaxRows()` × `getMaxColumns()`, 5 ms cada
   metadato) baja a ~240 ms leyendo cuatro veces más celdas. Por eso `cacheVacio`
   mira la fila de encabezados y no cuántas filas vienen.
10. **Una alerta grave no la pisa un recálculo** (`conservarAlertasGraves`). Los
    tres cerebros reconstruyen la columna B entera, así que una alerta sobrevive
    solo mientras su condición se siga detectando — y esa condición se mira
    contra el caché, que cambia con cada escaneo de cualquiera.

    Se protege lo que dice `mereceConservarse`: de `NIVEL_ALTO` para arriba,
    **y además cualquier aviso de duplicado sea del nivel que sea**
    (`esAlertaDeDuplicado`). Lo segundo no es un añadido: los duplicados están
    repartidos por tres niveles a propósito —el `⛔` alarma, el `🔄` gris del
    mismo pedimento no— así que filtrar solo por nivel dejaba fuera justo los
    discretos. El caso que lo delataba: en una pareja duplicada la segunda fila
    lleva `⛔` y aguantaba, pero la primera lleva
    `⚠️ DUPLICADO (repetida en la fila N)`, de nivel aviso, y se caía sola.

    No se protege lo que cambia solo según avanza el trabajo o según el
    contenido de la propia celda: `⚠️ Sobra (Ajena)`, `Sin registrar en M-S`,
    `Faltan N por mover`, `❌ Va en: …`, `❌ Guía Inválida`.

    Si añades una alerta conservable, `colorDeAlerta` tiene que saber devolver
    su color: conservar el texto y dejar la celda en blanco es peor que no
    conservarlo, porque el aviso queda invisible.
11. **`conAlerta` se cuenta al armar los bloques, ANTES de detectar duplicados.**
    Si añades una alerta nueva dentro del recorrido, súmala tú
    (`duplicadoBloqueaCierre`). Sin eso el bloque se firma `✅ COMPLETO` con un
    `⛔` sin resolver dos filas más abajo.
12. **Las filas nuevas nacen sin validación de datos**, y esa validación es la
    que hace sonar el escáner. `asegurarFilasDeEscaneo` la **construye** en vez
    de copiarla de la fila de arriba: copiarla solo funciona si esa fila la
    tiene, y las reglas puestas a mano cubren un rango fijo. Qué columnas la
    llevan lo decide `columnasValidables`, el mismo sitio que usa el botón de
    reponerla: dos sitios decidiendo lo mismo acaban separándose, y el día que
    uno cambie las filas nuevas se quedarían sin la O sin que nada lo diga.
13. **Las Globales NO usan `filaFinalSugerida`.** Las M-S y los inventarios sí:
    su columna A se actualiza en el caché durante el mismo escaneo, así que la
    fila final sacada de ahí es fiable. Una Global tiene una segunda fuente que
    decide sus mensajes —la preforma de la columna O— y esa puede llegar por
    caminos que **no disparan `onEdit`**: una importación, una fórmula, un
    pegado que Sheets no clasifica como edición.

    Si la columna `_PREFORMA` del caché se queda corta, el recálculo no llega a
    leer el final de la columna O y las guías cuya preforma quedó fuera del
    rango salen `⚠️ Sobra (Ajena)`. No sobran: no se leyó su preforma. Era la
    causa de que «se arreglara solo» al forzar la actualización, que sí usa
    `getLastRow`.

    Acusar a un bulto de ajeno no se puede hacer desde una lectura que podría
    estar truncada. Cuesta una llamada (~50 ms) sobre un escaneo de ~900.
14. **NADA automático escribe valores en la columna A**, salvo la normalización
    del propio escaneo — y esa escribe **solo las celdas que cambian**
    (`rangoDeUpdates`). Es el invariante más importante del archivo: la columna
    A es del operador.

    El peligro no es escribir un valor equivocado, es **reescribir uno bueno**.
    El patrón «leo un rango, cambio una celda, escribo el rango entero» devuelve
    a la hoja una copia leída milisegundos antes; y el `onEdit` simple, cuando
    no consigue el lock en 10 s, **escanea igual sin lock** (para eso existe
    `⏳ Pendiente`). Entre la lectura y la escritura cabe un escaneo ajeno, y esa
    guía desaparece sin quedar en el historial, porque el historial registra
    vaciados de celda hechos por una persona, no reescrituras de rango.

    Ya pasó dos veces: `sincronizarSalidasMS` reescribía A:B aunque solo tocara
    la B, y `aplicarBatchUpdates` reescribía el bloque editado entero. Si añades
    una escritura, acótala a lo que de verdad cambia y **nunca incluyas la
    columna A si no es lo que estás cambiando**.

    Las únicas dos funciones que mueven valores en la columna A son de menú:
    `agruparPorPedimento` (con confirmación y registro) y
    `limpiarGuiasMovidasSeleccion` (con registro). Ninguna función del caché
    escribe jamás en una hoja de escaneo: el caché solo lee de ellas.
15. **El alto que necesita una hoja lo marca la columna que llega más abajo, no
    la celda que se acaba de tocar.** En una Global la A y la O crecen por
    separado, y la preforma de la O suele ir muy por delante del escaneo físico
    de la A.

    Mientras `asegurarFilasDeEscaneo` recibía `filaInicial + numRows - 1`,
    escanear arriba en la A no estiraba la hoja aunque la preforma estuviera
    pegada al último renglón de la rejilla, y la cola de la preforma se quedaba
    fuera. Eso sale luego como «faltantes» que nunca llegaron a caber — el mismo
    síntoma del invariante 13, por otro camino.

    Ahora recibe `filaQueMarcaElAlto(filaEditada, filaFinal)`, y `filaFinal`
    viene de `filaFinalDesdeCache`, que ya coge la más baja de `_FISICO` y
    `_PREFORMA`. Por eso el crecimiento va **después** de calcular `filaFinal`
    y antes de recalcular.

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
`getCacheData` · `construirIndiceCache` · `cacheVacio` · `mapaColumnasFisico` ·
`hojaContieneAlgunaGuia` · `verificarDuplicadoConCache` ·
`calcularDuplicadosExternos` · `actualizarBloqueEnCache` · `columnaDeHeader` ·
`actualizarFotografiaMental` · `ultimaFilaEnCache` · `filaFinalDesdeCache` ·
`podarCacheHuerfano` · `columnasHuerfanas` · `RECONSTRUIR_CACHE_TOTAL`

### Filas: crecer y recortar
`asegurarFilas` · `asegurarFilasDeEscaneo` · `filasNecesarias` ·
`filaQueMarcaElAlto` · `recortarFilasSobrantes` · `filasTrasRecorte`

### Alertas: nivel, prioridad y permanencia
`nivelAlerta` · `puedePisar` · `conservarAlertaGrave` ·
`conservarAlertasGraves` · `colorDeAlerta` · `duplicadoBloqueaCierre` ·
`notaConAlerta` · `duplicadoLocal` · `cabezaEstado` · `colaResumen`

### Validación «GUIA RETENIDA»
`formulaGuiaRetenida` · `reglaGuiaRetenida` · `aplicarValidacionRetenida` ·
`columnasValidables` · `reponerValidacionEnHoja` ·
`aplicarValidacionHojaActiva` · `aplicarValidacionEnTodas`

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
`diagnosticarGuia` · `medirRendimiento` · `probarCosteCache` · `cierreDelDia` ·
`limpiarHistorialAhora` · `instalarLimpiezaHistorial` · `protegerHojasSistema`

### Estructura y disparadores
`alCambiarEstructura` · `cambioAfectaAlCache` · `instalarTriggerDeEstructura` ·
`marcarMantenimiento` · `quitarMantenimiento` · `hayMantenimientoEnCurso` ·
`instalarTriggerAvanzado` · `instalarTriggerConUsuario` ·
`desinstalarTriggerAvanzado`

### Medición
`perf` · `perfIniciar` · `perfFin` · `perfLineas`

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
| `SEP_RESUMEN` | `"   ►   "` | Separa el estado de la guía del resumen del bloque, en la misma celda |
| `MARGEN_FILAS` | `20` | A cuántas filas del final se empieza a estirar la hoja |
| `BLOQUE_FILAS` | `50` | Mínimo que se añade de una vez. Independiente del margen: crecer cuesta lo mismo para 20 filas que para 50, así el tirón cae una vez cada 50 escaneos |
| `FILAS_BASE` | `200` | Altura a la que vuelven las hojas en el cierre del día |
| `TXT_GUIA_RETENIDA` | `"GUIA RETENIDA"` | Texto de ayuda de la validación que rechaza guías de la lista FEMAD |
| `PROP_MANTENIMIENTO` | `'MANTENIMIENTO_EN_CURSO'` | Silencia `alCambiarEstructura` mientras el cierre mueve filas |
| `DESC_PROTECCION` | `"Hoja interna…"` | Descripción de la protección de solo aviso |
| `HIST_ORDEN_DEFECTO` | `[FECHA,USUARIO,…]` | Orden de columnas al crear el historial de cero |
