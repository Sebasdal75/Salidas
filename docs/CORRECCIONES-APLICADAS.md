# Correcciones aplicadas — 2026-08-09

Se aplicaron los 23 hallazgos de `REVISION-CODIGO.md` más 2 bugs que aparecieron
al revisar el propio código corregido. Aquí queda el registro de qué cambió y
qué comportamiento visible se modifica.

Verificación: `node tests/harness.js` (50 asserts sobre la lógica pura) y
`node --check` sobre el script completo. **Nada de esto se ha ejecutado contra
un Google Sheet real** — ver "Qué falta probar" al final.

---

## Bloqueantes

| # | Qué pasaba | Qué se hizo |
|---|---|---|
| P0-1 | Borrar una celda registraba el historial pero salía por un `continue`: el caché conservaba la guía y la hoja no se recalculaba. Los `⛔ DUPLICADO` se volvían permanentes. | Un vaciado de A u O ahora marca `huboCambiosRelevantes`. Además los duplicados externos se **reevalúan desde el caché en cada pasada** en vez de conservar el texto viejo, así que se limpian solos. |
| P0-2 | `sincronizarMacho` recorría `getSheets()` filtrando solo `!== "MACHO"`, y borraba la columna M de `CACHE_SISTEMA` (columna de caché de la 7ª hoja registrada). | Se excluyen todas las hojas de sistema con `esHojaSistema()`. |
| P0-3 | Los headers del caché se escribían con `hoja.getName()` en crudo y se buscaban en MAYÚSCULAS. Funcionaba por casualidad. | Helper `claveHoja()` aplicado en todos los puntos donde se construye o compara un nombre de hoja. |

## Rendimiento

| # | Qué se hizo | Efecto |
|---|---|---|
| P1-1 | `sincronizarMovidosBodegaDesdeCache` acepta ahora un `Set` de guías afectadas. Las bodegas que no contienen ninguna se descartan en RAM, sin abrir la hoja. | Un escaneo normal pasa de tocar **todas** las bodegas a tocar **0 o 1**. |
| P1-2 | Entrada dual: `onEdit` (simple) y `alEditar` (instalable), con menú para instalar/desinstalar. | Techo de 30 s → 6 min y el historial puede registrar al editor. |
| P1-3 | La detección de borrados usa `e.oldValue` y lecturas en bloque; el historial se escribe con un único `setValues`. | Borrar 300 filas pasa de ~600 llamadas API a ~3. |
| — | `actualizadorAutomaticoGlobal` recargaba el caché entero una vez por hoja actualizada (O(n²)). Ahora son dos pasadas con una sola recarga. | — |
| P2-6 | La columna O ya no se repinta entera en cada escaneo: se compara contra los fondos actuales y solo se escribe si cambió. | — |
| P2-11 | `actualizarBloqueEnCache` usa los headers ya cargados en RAM. | 2 llamadas API menos por escaneo. |
| — | Los descartes baratos (columna irrelevante, hoja de sistema) se hacen **antes** de pedir el lock. | Los escaneos ya no compiten con ediciones que no importan. |

## Auditoría y datos

- **P1-4** — `HISTORIAL_BORRADOS` gana la columna `USUARIO` (se añade sola a las hojas ya existentes). Con el trigger simple escribe `(sin trigger avanzado)`; con el instalable, el email real.
- **P1-5** — La hora de escaneo (col L y col S) ya no se reescribe en las filas vecinas de un bloque. Solo se sella cuando la celda estaba vacía.
- **P1-6** — `aplicarCambiosOptimizado` detecta también cuando una hora debe **borrarse** y cuando solo cambia el color.
- **P1-7** — `actualizarBloqueEnCache` expande las filas de `CACHE_SISTEMA` (antes solo crecía el array en RAM y `getRange` acababa lanzando excepción).
- **P1-8** — `esHojaPrincipal` excluye `CACHE_SISTEMA` e `HISTORIAL_BORRADOS`.
- **P1-9** — `RECONSTRUIR_CACHE_TOTAL` borra la hoja de caché y la recrea; `podarCacheHuerfano()` limpia columnas de pestañas renombradas/borradas y corre en el trigger por tiempo.
- **P2-1** — `procesarCostales` comprueba el destino: si hay filas con datos debajo avisa (`⚠️ SIN ESPACIO`) en vez de pisarlas.
- **P2-3 / P2-4** — Las funciones de menú invalidan la RAM tras re-fotografiar y corren bajo el lock del documento.
- **P2-5** — `waitLock` sube a 10 s y, si aun así falla, escribe `⏳ Pendiente (reintenta)` en la columna B en vez de perder el escaneo en silencio.
- **P2-7** — Guardas de ancho (`asegurarColumnas`) antes de todo `getRange` que asumía 12/15/19 columnas.
- **P2-8** — Costales en una hoja de inventario ya no llama a `actualizarConteos`.
- **P2-9** — `obtenerArchivo()` con `ID_ARCHIVO` opcional para los triggers por tiempo.
- **P2-10 / P2-13** — Arrays vacíos sin referencia compartida; condición muerta `"OTROS"` eliminada.
- **P2-12** — `e.oldValue` usado como fuente primaria del valor borrado.

## Inventarios (lo que pediste)

Los inventarios son ahora un **dominio cerrado**:

- Se cruzan **solo entre pestañas de inventario**. Lo que esté en Globales, Bodegas, Rezago o AGA no genera ninguna alerta en un inventario.
- Se detecta la misma guía en **dos pestañas de inventario distintas** → `⛔ DUPLICADO (En: INVENTARIO B Fila 40)`.
- Se detecta la misma guía en **dos ubicaciones IW distintas de la misma pestaña** → `⛔ DUPLICADO (En: IW-B-07, fila 55)`. Antes esto no se veía: el `Set` de duplicados se reiniciaba en cada `IW` y el caché ignoraba la propia hoja.
- Se mantiene `🔄 Duplicado local` para la misma guía repetida dentro de la **misma** ubicación.
- Al escanear en un inventario, las **demás pestañas de inventario que contengan esa guía se recalculan solas** (`sincronizarInventariosAfectados`). Solo se abren las que realmente la contienen.

Nota de diseño: cuando una guía aparece en dos inventarios, **ambas filas quedan marcadas**. No hay forma de saber cuál es la correcta, así que se señalan las dos para que el operador decida.

---

## Cambios de comportamiento visibles

Tres cosas cambian en pantalla. Si alguna no te cuadra, dilo y se revierte.

1. **Bodegas: `✅ TODO MOVIDO` ahora aparece.** Antes las guías movidas se excluían del bloque del pedimento, así que el contador `movidas` nunca subía y un pedimento completamente movido mostraba `⏳ Esperando guías...`. Era código muerto que delataba la intención original.

2. **Bodegas: `Total bultos` incluye las guías movidas**, con desglose: `Total bultos: 120 (movidos: 45 | en bodega: 75)`. Antes las movidas no se contaban y el número encogía solo. Si prefieres el conteo anterior, es un cambio de una línea.

3. **`⛔ DUPLICADO` ya no es permanente.** Se recalcula en cada pasada, así que si borras el original la marca desaparece sola. Antes se quedaba pegada para siempre.

---

## Qué falta probar

El harness cubre la lógica pura. **Todo lo que llama a la API de Sheets solo se puede probar en el archivo real.** Antes de dejarlo en producción con operadores:

1. Copia el archivo y prueba ahí primero.
2. Corre `RECONSTRUIR_CACHE_TOTAL` una vez (los headers del caché cambian a mayúsculas; los antiguos con otra capitalización quedarían huérfanos).
3. Menú → **Instalar trigger avanzado**. Si tras instalarlo ves estados escritos dos veces, significa que `PropertiesService` no está disponible en el trigger simple de tu archivo: avísame y cambio el guard por otro método.
4. Comprueba en este orden: escaneo normal → escaneo duplicado → **borrar la guía duplicada y verificar que la marca desaparece** → costales → agrupar → limpiar movidas.
5. Cronometra un escaneo en la Global más pesada, antes y después. Es la única medida real de la mejora.

---

## Hallazgos del archivo real (`Salidas ESCANEOS UPS`)

Tras revisar el archivo de producción aparecieron tres cosas que el código por sí solo no revelaba.

### El bug de `sincronizarMacho` estaba armado, no era teórico

La columna M de tu `CACHE_SISTEMA` es exactamente `INVENTARIO MACHO NO BORRAR_FISICO`.
Como el volcado de MACHO empieza en la **fila 1**, la siguiente edición de la columna M
habría sustituido ese encabezado por una guía y esa pestaña habría desaparecido del
índice de duplicados. Todavía no había ocurrido: la columna solo contenía el encabezado.

### El historial tiene `USUARIO` en la columna B

Layout real: `FECHA Y HORA | USUARIO | PESTAÑA | FILA | COLUMNA | GUÍA | ESTADO ANTERIOR | MOTIVO`.
`registrarEnHistorialLote` lee ahora los encabezados y coloca cada campo donde
corresponde en lugar de asumir un orden. Escribir con orden fijo habría descuadrado
todo el registro de auditoría.

Dato relacionado: **el script desplegado no es el que se revisó**. El de producción ya
registra el usuario y escribe `Ubicaciones:` donde el revisado escribe `Ubicaciones (IW):`.
Conviene exportar el código real antes del próximo cambio.

### Los marcadores de bloque contaban como guías

`agruparPorPedimento` escribe `SIN PEDIMENTO` en la columna A y `procesarCostales`
escribe `⚠️ SIN PEDIMENTO`. Como `esGuiaUPSValida` acepta cualquier cadena de más de
7 caracteres, esas filas:

- sumaban a `Total bultos`,
- recibían estado de guía,
- **entraban al índice del caché**, así que dos pestañas con esa fila se marcaban
  `⛔ DUPLICADO` mutuamente.

Ahora `esMarcadorEstructural()` los reconoce y `esCabeceraBloque()` los trata como
apertura de bloque: no cuentan como bultos, no se indexan y no pueden salir como
`PEDIMENTO REPETIDO`.

### Guías cortas / no-1Z

Confirmado que **ya funcionan**: al ser de más de 7 dígitos (normalmente 10),
`esGuiaUPSValida` las acepta y el patrón de error `/^\d{1,6}$/` no las toca. No hay
colisión con el pedimento de 7 dígitos. Hay tests que lo fijan.

**Una precaución:** si una guía numérica empieza por cero, Sheets se lo come al
convertirla en número (`0123456789` → `123456789`) **antes** de que el script la vea, y
eso no se puede recuperar desde el código. Formatea las columnas A y O como
*Formato → Número → Texto sin formato*.

### Sobre las guías faltantes

Confirmado que se siguen listando: `❌ Faltan 3 (1ZAB..., 1ZCD..., 1ZEF...)`. Sin cambios.

---

## Hojas MACHO (lista FEMAD) y plantillas

Con la aclaración de que **MACHO es la lista de guías retenidas por la Guardia
Nacional** y que las pestañas con "MACHO" en el nombre son plantillas de
inventario, los roles quedan separados en tres:

| Rol | Qué es | ¿Se escanea / indexa? | ¿Recibe la columna M? |
|---|---|---|---|
| `MACHO` | Origen de la lista FEMAD | No | No (es el origen) |
| Cualquier pestaña con "MACHO" en el nombre | Plantilla de inventario | **No** | **Sí** |
| `CACHE_SISTEMA`, `HISTORIAL_BORRADOS` | Internas del motor | No | **No** |
| El resto | Globales, bodegas, inventarios reales | Sí | Sí |

Tres consecuencias:

1. **`INVENTARIO MACHO NO BORRAR` sale del índice de duplicados.** Es una
   plantilla: no debe generar alertas contra los inventarios reales. Al ejecutar
   `RECONSTRUIR_CACHE_TOTAL` (o `podarCacheHuerfano` desde el trigger por tiempo)
   sus columnas desaparecen del caché, lo que además **desactiva definitivamente**
   el problema de la columna M descrito arriba.
2. **Las plantillas siguen recibiendo el volcado de la columna M**, para que las
   copias que salgan de ellas nazcan con la validación y los colores puestos.
   Solo `CACHE_SISTEMA` e `HISTORIAL_BORRADOS` quedan excluidas.
3. `sincronizarMacho` ya no depende de una comparación exacta con `"MACHO"`.

### ⚠️ Cuidado al copiar la plantilla

La regla es **por nombre**: cualquier pestaña cuyo nombre contenga "MACHO" queda
fuera del escaneo. Si duplicas la plantilla, Sheets la llamará
`Copia de INVENTARIO MACHO NO BORRAR` — y seguiría sin escanearse.
**Renómbrala** (por ejemplo `INVENTARIO 12 AGO`) antes de usarla.

Si prefieres una marca explícita en lugar del nombre (una celda con `PLANTILLA`,
o un prefijo tipo `ZZ_`), se cambia en una línea: la regla vive en `esHojaMacho()`.
