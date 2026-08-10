# Correcciones aplicadas — 2026-08-09

Se aplicaron los 23 hallazgos de `REVISION-CODIGO.md` más 2 bugs que aparecieron
al revisar el propio código corregido. Aquí queda el registro de qué cambió y
qué comportamiento visible se modifica.

Verificación: `node tests/harness.js` (73 asserts sobre la lógica pura) y
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

---

## Bodegas: sin preforma y sin adivinar el tipo

### Las pestañas M-S no reservan columna de preforma

Las bodegas no usan preforma, así que su columna O siempre está vacía. Aun así
el caché les reservaba una columna `_PREFORMA` (visible en `CACHE_SISTEMA`:
`M-S GLOBALES_PREFORMA`, `M-S T1_PREFORMA`, `M-S A1_PREFORMA`… todas en blanco)
y cada foto leía esa columna para nada.

Ahora las columnas del caché se reservan **una a una** en vez de por pares, y a
las bodegas solo se les da la de físico. En tu archivo eso quita **5 columnas
vacías** y 5 lecturas por reconstrucción. `podarCacheHuerfano()` las borra solo
la primera vez que corra el repaso automático.

### El tipo T1 / GLOBALES lo decide la pestaña

El código deducía el tipo comparando los 10 primeros caracteres de cada guía:
si todas compartían prefijo, "M-S T1"; si no, "M-S GLOBALES". Eso no funciona:

- con **guías cortas** la "base" es la guía entera, así que dos guías cualesquiera
  daban dos bases y el pedimento salía siempre como GLOBALES;
- con **guías 1Z** el prefijo es la cuenta del embarcador, que no dice nada sobre
  si el pedimento es T1 o global. Por eso en tu pestaña `M-S GLOBALES` todos los
  pedimentos aparecían etiquetados `(M-S T1)` y el resumen decía
  `M-S T1: 18 | M-S GLOBALES: 0`.

El operador ya decide el tipo al elegir la pestaña donde escanea. Ahora el tipo
sale de ahí (`tipoBodega()`) y la heurística desaparece.

En las hojas Globales, donde antes se adivinaba por qué bodega había pasado el
pedimento, ahora se informa la bodega **real** registrada en el caché:
`✅ M-S T1`, `✅ M-S GLOBALES`, o `✅ M-S T1 + M-S GLOBALES` si vino de las dos.

**Cambios visibles:**

| Antes | Ahora |
|---|---|
| `M-S T1: 18 \| M-S GLOBALES: 0` en la hoja M-S GLOBALES | `M-S GLOBALES: 18` |
| `Bultos: 2 (M-S T1)` dentro de M-S GLOBALES | `Bultos: 2 (M-S GLOBALES)` |
| `⚠️ Sin escaneo de M-S T1` (adivinado) | `⚠️ Sin escaneo en Bodegas` |
| `✅ M-S T1` en la Global (adivinado) | `✅ M-S T1` solo si de verdad pasó por ahí |

---

## Hora atada a la columna A (no al estado de B)

La hora (col L en físico, col S en preforma) debe fijarse al **escaneo de la
columna A**, no al estado que el sistema escribe en B. Requisitos:

1. Se sella una vez, cuando A recibe un valor.
2. **No** cambia aunque B se recalcule mil veces.
3. Se **borra** cuando se borra A — sin reintroducir ningún bug de borrado.

Los tres ya se cumplen: `horaPreservada()` lee la columna A (`valB`/`valP`/`valA`
son `datosMasivos[i][0]` y `[14]`, o sea A y O, nunca B), conserva la hora previa
si existe, y devuelve vacío cuando A está vacía. `aplicarCambiosOptimizado`
detecta tanto poner como **quitar** la hora, así que al borrar A la limpia.

Lo que faltaba: al borrar A, ciertos **estados fijos** de B (`🛑 ERROR`,
`➡ Salió en …`) se quedaban pegados, y en las M-S también el tachado y el color
de fuente. Ahora, cuando la columna A de una fila está vacía, los tres cerebros
**resetean la fila completa**: sin estado, sin hora, sin color, sin tachado.
Borrar A limpia todo de un golpe.

Los estados fijos siguen sobreviviendo a un recálculo disparado por *otra* fila
(su A sigue con dato); solo se limpian cuando la propia A se vacía. Sin riesgo
para el bug P0-1: el borrado sigue purgando el caché y recalculando.

Tres asserts nuevos en el harness fijan el comportamiento: B cambia y la hora
queda fija, A borrada y la hora se limpia, A nueva y la hora se sella.

---

## Colores desde el código (para retirar el formato condicional)

El formato condicional se reevalúa en cada cambio y frena tanto al script como
al navegador. Ahora los colores los pinta el código, en el mismo `setValues`
que ya se hacía, sin llamadas extra a la API.

### Columna A (escaneo físico)

| Contenido de A | Color | Constante |
|---|---|---|
| Pedimento (7 dígitos) | Azul `#178ccc` | `COLOR_A_PEDIMENTO` |
| Guía válida | Verde `#00ff00` | `COLOR_A_GUIA` |
| Guía **duplicada** (⛔ o 🔄 en B) | Rojo `#df5f6b` | `COLOR_A_DUPLICADO` |
| Guía inválida | Rojo `#df5f6b` | `COLOR_A_DUPLICADO` |
| Ubicación `IW…` en inventarios | Azul claro `#a4c2f4` | `COLOR_A_UBICACION` |
| Marcador estructural o fila vacía | Sin color `#ffffff` | `COLOR_A_NEUTRO` |

Interruptor: `COLOREAR_COLUMNA_A = false` devuelve el control al formato
condicional.

### Columna O (preforma)

Conserva su esquema por bloques: el color lo fija la letra de la columna **N**
de la fila del pedimento y se extiende a todas las guías de ese bloque.

| Letra en N | Color del bloque |
|---|---|
| `a` | Verde brillante `#35ec09` |
| `b` | Rosa `#ff00ff` |
| `c` | Turquesa `#39b1b9` |
| Vacía, o cualquier otra letra | Sin color `#ffffff` |

**Corregido respecto al código original:** Gemini tenía el verde `#00ff00` como
valor *por defecto* de `colorFondoPreforma`, así que teñía de verde todos los
bloques aunque la columna N estuviera vacía. El comportamiento correcto es que
sin letra no se pinte nada; sólo `a`, `b` y `c` cambian el color. Lo mismo para
las guías sueltas que caen antes del primer pedimento (bloque sin cabecera): no
hay N que consultar, así que se quedan sin color. `COLOR_O_SIN_LETRA = "#00ff00"`
devuelve el verde de antes.

Encima de eso se añaden los dos colores de la columna A:

- **La celda del pedimento va en azul** `#178ccc`, no en el color del bloque.
  Las guías del bloque sí conservan el color de la letra.
- **Lo repetido va en rojo** `#df5f6b`, y el rojo se aplica al final, así que
  pisa tanto el azul del pedimento como el color de bloque de las guías.

Dos casos caen en ese rojo:

1. **Pedimento repetido** — ya se detectaba y avisaba en P con
   `⚠️ PEDIMENTO REPETIDO`; ahora además se pinta la celda de O.
2. **Guía repetida dentro de la misma preforma** — detección **nueva**
   (`filasGuiaRepetidaEnPreforma`). Se mira la columna O completa de la hoja,
   no bloque por bloque, porque una guía no puede pertenecer a dos pedimentos y
   repetirla infla el conteo de bultos esperados. Se saltan los pedimentos
   (tienen su propia detección) y los marcadores estructurales
   (`SIN PEDIMENTO`, `COSTALES`, `FIN`), que se repiten de forma legítima.

Para que la celda roja no quede sin explicación, la fila recibe el aviso
`⚠️ GUÍA REPETIDA EN PREFORMA` en la columna P. Si esa fila ya traía el
`► Resumen: N bultos`, el aviso se **antepone** (`⚠️ GUÍA REPETIDA | ► Resumen:
…`) en vez de borrarlo, y nunca pisa un `⛔` ni un `🛑`, que son más graves.

Interruptor: `COLOREAR_PEDIMENTO_Y_DUP_EN_O = false` deja la columna O
exactamente como estaba (solo color de bloque, sin azul ni rojo ni el aviso
nuevo).

La columna O sigue escribiéndose solo si la edición tocó la preforma
(`tocoPreforma`): un escaneo en la columna A no puede cambiar estos colores.
Con `repintarTodo` se salta además la lectura de comparación, que ahí sería una
llamada de más.

### Cómo hacer el cambio en la hoja

Mientras el formato condicional siga puesto, **él manda** y los colores del
código no se ven. El orden seguro es:

1. Pegar el código nuevo.
2. Quitar las reglas de formato condicional de las columnas A y O
   (*Formato → Formato condicional*).
3. Correr **🔄 Forzar Actualización** una vez por pestaña. Ese es el único modo
   que repinta la hoja **entera** (`repintarTodo`); el escaneo normal sólo
   escribe las filas que cambiaron, así que sin este paso las filas viejas se
   quedarían con el color anterior.
