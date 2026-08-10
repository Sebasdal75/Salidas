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
| (vacía o desconocida) | Verde `#00ff00` |
| `a` | Verde brillante `#35ec09` |
| `b` | Rosa `#ff00ff` |
| `c` | Turquesa `#39b1b9` |

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

---

## Cronómetro de llamadas a la API

`⏱️ Medir velocidad de escaneo` daba tres cifras gruesas (cargar caché,
recalcular, sincronizar M-S). Suficiente para saber **si** va lento, no para
saber **por qué**. Con 223 filas el recálculo costaba 1,478 ms y una llamada
suelta 59 ms: eso da ~25 llamadas, pero contando el código sólo salen ~10. La
diferencia podía estar en el tamaño del payload o en llamadas no contadas, y sin
medirlo cualquier optimización era a ciegas.

Ahora hay un cronómetro por llamada (`perf`), apagado salvo mientras corre la
medición. Cada punto instrumentado acumula milisegundos, número de llamadas y
celdas movidas; el informe los ordena de más caro a más barato, con su
porcentaje, e imputa la diferencia a «resto (cálculo en memoria y llamadas sin
medir)» para que los números cuadren con el total.

Puntos instrumentados en el camino del escaneo:

| Etiqueta | Dónde |
|---|---|
| `getLastRow`, `asegurarColumnas` | Antes de leer |
| `leer la hoja A:S` / `leer la hoja A:L` | Lectura masiva de los tres cerebros |
| `escribir estado`, `escribir hora` | `aplicarCambiosOptimizado` |
| `color del estado`, `color de la columna A` | `aplicarCambiosOptimizado` |
| `tachado de la columna A`, `color de fuente de la columna A` | `aplicarCambiosOptimizado` (M-S) |
| `leer fondos de la columna O`, `color de la columna O` | Preforma |
| `totales C1:C3`, `totales Q1:Q2` | Cabeceras |
| `M-S: getLastRow`, `M-S: leer A:B`, `M-S: escribir A:B` | `sincronizarSalidasMS` |

Coste con el cronómetro apagado: una llamada a función que hace `return fn()`.
Nada frente a los ~59 ms de cualquier ida y vuelta a Sheets.

---

## getLastRow() era el cuello de botella (y la medición se contaba doble)

El cronómetro por llamada dio el desglose real con 298 filas en GLOBAL 2, y
desmontó las dos hipótesis que había sobre la mesa:

```
── DÓNDE SE VA EL RECÁLCULO ──
   694 ms  41%  ·  5 llamadas, 1,362 celdas  ·  M-S: leer A:B
   641 ms  38%  ·  5 llamadas               ·  M-S: getLastRow
   150 ms   9%  ·  1 llamada, 5,662 celdas  ·  leer la hoja A:S
   117 ms   7%  ·  1 llamada                ·  getLastRow
     2 ms   0%  ·  1 llamada                ·  asegurarColumnas
```

**El payload no era el problema.** Leer 5,662 celdas de golpe costó 150 ms, un
9%. Estrechar la lectura para saltarse las columnas E-K habría ahorrado
milisegundos y costado una llamada extra: mala idea, descartada.

**`getLastRow()` sí lo era.** 641 ms entre 5 llamadas son ~128 ms cada una, casi
tres veces lo que cuesta una llamada normal (48 ms), y en el barrido completo
llegó a 409 ms por llamada. No devuelve un dato guardado: obliga a Sheets a
recorrer la hoja.

La respuesta ya estaba en memoria. El caché guarda la columna A de cada hoja en
su columna `_FISICO`, con la fila del caché igual a la fila de la hoja, así que
`ultimaFilaEnCache()` la saca sin tocar la API. Se cae de vuelta a `getLastRow()`
solo si esa pestaña aún no está indexada. Es seguro porque el barrido de M-S
únicamente modifica filas que tienen guía en la columna A — exactamente las que
el caché conoce — y en `onEdit` el caché se actualiza antes del recálculo.

### La medición se contaba dos veces

`actualizarGlobalPreforma` termina llamando a `sincronizarSalidasMS`, así que el
tiempo de «Recalcular esta hoja» **ya incluía** el barrido de M-S. La medición lo
volvía a ejecutar aparte y sumaba las dos cifras: los «~3.8 s por escaneo» eran
en realidad ~1.7 s. Las tres mediciones anteriores estaban infladas igual.

Además pasaba `new Set()` como guías afectadas, y con el conjunto vacío el
filtro se desactiva y se abren **todas** las M-S. Eso es el peor caso, no un
escaneo normal.

Ahora la medición coge una guía real de la hoja, ejecuta un escaneo completo y
reporta **ese** número; el barrido total de M-S se mide aparte y se etiqueta
como peor caso, sin sumarse al tiempo por escaneo.

---

## El barrido abría todas las pestañas para preguntarles el nombre

Quitado `getLastRow()`, el escaneo bajó a 1,448 ms con 321 filas, pero el
desglose dejó al descubierto otro renglón:

```
   167 ms  12%  ·  1 llamada                ·  getLastRow
   152 ms  10%  ·  1 llamada, 6,099 celdas  ·  leer la hoja A:S
   ...
   646 ms        ·  7 llamadas en total
   802 ms        ·  resto (cálculo en memoria y llamadas sin medir)
```

**El 55% del escaneo estaba fuera de lo medido.** Las siete llamadas
instrumentadas sumaban 646 ms de 1,448.

Eran llamadas sin instrumentar, y la culpable estaba en `sincronizarSalidasMS`:

```js
let hojas = source.getSheets();
for (let i = 0; i < hojas.length; i++) {
    let nMS = claveHoja(hojas[i].getName());   // ← una llamada POR PESTAÑA
    if (!esHojaMS(nMS)) continue;
```

Se recorrían **todas** las pestañas del archivo, preguntando el nombre de cada
una, para acabar abriendo casi siempre una sola. Con ~25 pestañas eso son ~25
idas y vuelta por escaneo.

El caché ya sabe la respuesta: su índice guarda, por guía, en qué pestañas está
y si son M-S. `hojasMSConGuias()` devuelve las pestañas a abrir sin tocar la
API, y luego se piden por nombre con `getSheetByName()` — una llamada por
pestaña que de verdad hay que abrir, normalmente una.

El caché guarda el nombre normalizado (`claveHoja`), así que si una pestaña real
está escrita con otra combinación de mayúsculas `getSheetByName()` devolvería
null; en ese caso se cae de vuelta al recorrido largo. El barrido completo desde
los menús (sin guías afectadas) sigue usando ese camino, que ahí sí hace falta.

### El "resto" ya no es una caja negra

Se instrumentaron también los dos `getName()` que quedaban y las tres fases de
cálculo puro (`(memoria) duplicados`, `(memoria) registro M-S`,
`(memoria) índice de salidas`), para poder separar el tiempo de CPU del tiempo
de red en la próxima medición.

El envoltorio que medía la sincronización entera se quitó a propósito: sus
llamadas internas ya se miden una por una y contar además el total las sumaría
dos veces.

---

## El duplicado dentro de la hoja nunca decía en qué pedimento

Escanear una guía en un pedimento y volver a escanearla en otro de la misma hoja
daba `🔄 Duplicado local`, a secas. El mensaje útil existía en el código:

```js
if (guiasVistasGeneral.has(g))            { ... "🔄 Duplicado local" }
else if (guiasYaAsignadasGlobal.has(g))   { ... "⛔ Duplicado local (Ya en Ped: X)" }
```

…pero era **inalcanzable**. Las dos estructuras se llenaban en la misma línea
del `else`, así que cuando el `Map` tenía la guía el `Set` también, y la primera
rama se quedaba siempre con el caso. La segunda no se ejecutó nunca.

Se fusionan en una sola, `primeraAparicion: guía -> { ped, idx }`, y el mensaje
ahora siempre dice dónde está la otra:

`duplicadoLocal()` devuelve texto, color y si hay que marcar la primera,
graduando el aviso según lo grave que sea:

| Situación | Mensaje | Color | ¿Marca la primera? |
|---|---|---|---|
| El mismo pedimento | `🔄 Duplicado local` | Gris `#acacac` | No |
| Otro pedimento | `⛔ DUPLICADO (ya en Ped: 6100166, fila 12)` | Naranja `#ff9800` | Sí |
| Bloque sin cabecera o marcador | `⛔ DUPLICADO (ya escaneada en la fila 12)` | Naranja | Sí |
| Inventarios, misma ubicación | `🔄 Duplicado local` | Gris | No |
| Inventarios, otra ubicación | `⛔ DUPLICADO (ya en Ubic: IW-A-01, fila 7)` | Naranja | Sí |

Repetir dentro del mismo pedimento es un doble escaneo: se borra la de abajo y
ya, no hay nada que investigar. Va en gris y ni se toca la primera. En cambio la
misma guía en dos pedimentos distintos obliga a decidir a cuál pertenece, y ahí
sí hace falta el naranja y la referencia.

Eso es la columna B. **En la columna A las dos guías salen rojas siempre**, en
los dos casos: son un duplicado que hay que borrar, y verlo de un vistazo es el
objetivo de ese color.

Para eso el color de la A no puede deducirse solo del texto de la B — la primera
de la pareja conserva su `✅ Ok` cuando el aviso es el discreto. Los tres
cerebros llevan un `filasParejaDuplicada` con las filas de **ambas** guías, y
`coloresDeColumnaA()` lo recibe y las fuerza a rojo. Una fila sin dato en A no se
pinta aunque esté en el conjunto.

### En el caso grave se pintan las dos, no solo una

Antes solo se marcaba la repetida; la primera se quedaba en `✅ Ok` y no había
forma de ver la pareja. Ahora la primera recibe
`⚠️ DUPLICADO (repetida en la fila 45)` — o `repetida 3 veces, la 1ª en la fila
45` si hay más de una — y el mismo fondo naranja.

Ese pase corre **después** de los resúmenes de bloque, así que si la primera era
la última guía de su bloque y arrastraba el `► Bultos: …`, esa cola se conserva.

El coloreado de la columna A pasa a buscar la raíz `DUPLICAD` sin distinguir
mayúsculas, para que ningún texto nuevo se escape del rojo.

Aplicado en los tres cerebros: Global/preforma, M-S e inventarios.

---

## Cuatro fallos encontrados en producción

### 1. La red de seguridad se recalculaba a sí misma sin parar

`actualizadorAutomaticoGlobal` marca una hoja como pendiente si encuentra una
fila con dato y sin estado, y la recalcula. Si el recálculo **no llena ese
estado**, la siguiente pasada la encuentra otra vez. Cada minuto. Para siempre.
Eso es lo que se veía como «actualizando constantemente y no se movía».

Tres tipos de fila caían en esa trampa:

- **La preforma.** En la columna P solo llevan texto la fila del pedimento y la
  última guía de cada bloque; las de en medio se dejan vacías a propósito. Así
  que **toda hoja con preforma estaba permanentemente pendiente.** Se retira la
  preforma de la detección: `marcarPendiente()` solo escribe para ediciones de
  la columna A, o sea que la preforma nunca formó parte de este mecanismo.
- **Las cabeceras de bloque.** En rezago y en bloques con error, la fila del
  pedimento se queda sin estado a propósito. `filaSinValidar()` ahora las
  descarta con `esCabeceraBloque()`.
- **Guías de inventario sin ubicación IW encima.** No entraban en ninguna rama y
  se quedaban sin estado. Ahora reciben `⚠️ Falta la ubicación IW arriba`, que
  además es información útil.

### 2. La alerta de duplicado desaparecía sola en las M-S

`sincronizarSalidasMS` reemplazaba el estado por `➡ Salió en …` en cuanto la
guía aparecía escaneada en un destino — **incluido cuando ese estado era un
`⛔ DUPLICADO`**. El operador veía la alerta aparecer y borrarse sola a los
segundos. Y el cerebro M-S remataba: evaluaba `esEstadoSalida()` *antes* que la
repetición, así que una vez marcada como movida la guía ya no volvía a
compararse y la alerta no regresaba nunca.

Ahora el barrido no pisa ningún estado que contenga `DUPLICAD`, y el cerebro
evalúa la repetición siempre, también en las guías ya movidas.

### 3. No avisaba que la guía iba en otro pedimento

Si el bloque escaneado **no tenía preforma propia** (`esperadas.size === 0`), el
código respondía `✅ Guía` y ahí se cortaba, sin llegar a mirar
`mapaInversoPreforma`. Resultado: una guía que pertenecía a otro pedimento con
preforma pasaba por buena. El aviso `❌ Va en: X` solo aparecía cuando el
pedimento escaneado tenía preforma, que es justo cuando menos falta hacía.

Ahora se consulta siempre, y si la guía pertenece a otro pedimento sale
`❌ Va en: X` y cuenta como sobrante.

### 4. La columna O pintaba solo una de las dos

Igual que había pasado en la A. Ahora `repetidasEnPreforma()` devuelve la pareja
completa —trabajando sobre los bloques, porque el pedimento no está siempre en
el mismo sitio: en las hojas normales cierra el bloque por debajo de sus guías y
en las de rezago lo abre por arriba— y se pintan las dos.

La columna P gradúa el aviso con la misma regla que la B: gris si la repetición
es dentro del mismo pedimento, naranja con referencia si es en otro.
`escribirAvisoPreforma()` conserva el `► Resumen` que ya trajera la fila y nunca
pisa un `⛔` ni un `🛑`.

---

## Prioridad de alertas: lo grave no lo tapa lo informativo

El arreglo anterior fue un parche: un `if` que buscaba la palabra `DUPLICAD`
dentro del barrido de M-S. Resolvía ese caso y dejaba abiertos todos los demás
—`❌ Guía Inválida`, `❌ Va en: X`, `🛑 ERROR`— que podían borrarse igual.

Ahora hay una regla, no una excepción. La distinción no es qué mensaje es más
importante, es **quién escribe**:

- **Los tres cerebros** recalculan la fila entera desde cero. Saben todo lo que
  hay que saber, así que escriben lo que calculen. Ahí es donde una alerta ya
  resuelta se limpia sola — sigue sin haber alertas eternas.
- **Los pases parciales** (el barrido de salidas M-S, los avisos de la preforma)
  conocen un solo aspecto de la fila. Esos no pueden **bajar** el nivel: si lo
  escrito es más grave que lo que traen, se callan.

| Nivel | Prefijo | Ejemplos |
|---|---|---|
| 4 · Crítico | `🛑` | Error de estructura, pedimento repetido |
| 3 · Alto | `⛔` | Duplicado entre hojas o entre pedimentos |
| 2 · Medio | `❌` | Guía inválida, guía que va en otro pedimento |
| 1 · Aviso | `⚠️` `🔄` | Sobra, sin registrar en M-S, duplicado local |
| 0 · Info | `✅` `➡` `⏳` `►` | Ok, salió en, esperando, resumen, vacío |

`nivelAlerta()` lo deduce del emoji con el que empieza el mensaje, que el
sistema ya usaba de forma consistente, y `puedePisar(previo, nuevo)` decide.

Consecuencia práctica: una guía duplicada en una M-S que además salió en una
Global **se queda en `⛔ DUPLICADO`** y no pasa a `➡ Salió en …`. La alerta
aguanta hasta que el operador arregla la fila; en cuanto la arregla, el
recálculo de esa hoja la retira y entonces sí aparece el estado normal.

El `🔄 Duplicado local` gris también está protegido: es discreto a propósito,
pero desaparecer solo era justo lo que se estaba reportando.

---

## Diagnóstico de una guía o un pedimento concreto

Dos casos de producción que no se podían resolver mirando el código, porque la
lógica estaba bien y la causa estaba en los datos:

- Guías escaneadas en A1 salían `⚠️ Sobra (Ajena)` y `⚠️ Sin registrar en M-S`
  aunque el operador las tuviera en M-S CUENTAS ESPECIALES. En el **mismo
  bloque**, unas se reconocían y otras no.
- Un pedimento repetido «apareció marcado primero y luego se puso
  ⏳ Esperando guías».

`🔍 ¿Por qué esta guía sale así?` responde con datos. Se pone el cursor en la
celda y el informe cambia según lo que haya:

**Si es una guía:** dónde la tiene el caché (pestaña, fila y tipo de cada
aparición), si alguna M-S la registra y con qué origen, qué pedimento le asigna
la M-S, qué pedimento tiene el bloque donde está escaneada y qué espera ese
bloque. Cierra distinguiendo las tres causas de «Sin registrar en M-S»: el caché
no la conoce, la conoce pero en ninguna pestaña M-S, o está en una M-S **sin
pedimento de 7 dígitos encima** — que es el caso silencioso, porque las guías se
asignan al último pedimento que aparece *arriba* de ellas.

**Si son 7 dígitos**, se trata como pedimento: los pedimentos no están en el
índice de guías, así que se busca a mano por todas las columnas del caché y se
lista cada aparición, separando escaneo (col A) de preforma (col O). Después
dice si está repetido, y aquí hay una limitación que conviene tener escrita:

> El aviso `🛑 PEDIMENTO REPETIDO` solo mira **dentro de cada pestaña**. Un
> mismo pedimento en dos M-S distintas no se marca hoy. El diagnóstico sí lo
> detecta y lo avisa.

Por último enseña cuántas guías le cuelgan según las M-S, que es la forma rápida
de ver si el pedimento quedó desconectado de sus guías.

---

## «Esperando guías» mentía cuando la guía sí estaba

Un pedimento con una sola guía debajo, y esa guía marcada
`⛔ DUPLICADO (En: M-S A1 Fila 37)`, mostraba `⏳ Esperando guías...` con la guía
ahí delante.

No era un fallo del mensaje sino de lo que contaba: las filas con alerta
—duplicado, error de estructura, guía inválida— **no entran en el bloque**, así
que no cuentan como bulto. Con la única guía fuera, el bloque quedaba en cero y
el resumen decía que esperaba guías.

Dos cambios:

1. **Fuera `⏳ Esperando guías...`** en los tres cerebros. El número de bultos ya
   va delante en el resumen y dice lo mismo sin dar a entender que no hay nada
   escaneado. Un pedimento recién puesto ahora dice `Bultos: 0`.
2. **Las filas excluidas se cuentan aparte** (`conAlerta` en cada bloque) y el
   resumen lo dice: `Bultos: 0 | ⚠️ 1 con alerta`. Así el descuadre entre lo que
   se ve y lo que se cuenta queda explicado en la propia celda.

La nota se añade a cualquier estado, no solo al de cero: un bloque puede decir
`Bultos: 12 | ✅ COMPLETO | ⚠️ 1 con alerta`.

---

## El pedimento repetido entre pestañas tampoco se avisaba

`🛑 PEDIMENTO REPETIDO` solo comparaba **dentro de cada hoja**
(`pedimentosVistosFisico`). El mismo pedimento en dos pestañas pasaba sin aviso,
que es lo que se vio en producción con el 6035443.

Los pedimentos ya estaban indexados en el caché —el índice salta los marcadores
estructurales pero no los números de 7 dígitos—, así que la detección sale del
mismo sitio que la de guías, con **el mismo aislamiento de dominios**, y aquí es
imprescindible:

| Dónde está repetido | ¿Se avisa? |
|---|---|
| Dos veces en la misma hoja | Sí (ya funcionaba) |
| En dos destinos distintos | Sí, nuevo |
| En dos M-S distintas | Sí, nuevo |
| **En una M-S y en su destino** | **No** |

El último caso es el flujo normal: primero se preregistra en la M-S y luego se
embarca en el destino. Marcarlo sería un falso positivo en **cada pedimento del
archivo**.

El aviso dice dónde está la otra: `🛑 PEDIMENTO REPETIDO (En: GLOBAL 3 Fila 120)`.
No pisa el aviso de repetido dentro de la propia hoja, que es más urgente de
resolver.

Interruptor: `DETECTAR_PEDIMENTO_REPETIDO_ENTRE_PESTANAS = false` si resulta que
un pedimento sí puede repartirse legítimamente entre dos pestañas del mismo tipo.

---

## Guías que sí estaban en M-S salían como «Ajena»

Síntoma en producción: guías idénticas a las de una M-S salían
`⚠️ Sobra (Ajena)` / `⚠️ Sin registrar en M-S` en las hojas destino, **y
«Forzar Actualización» las arreglaba**.

Ese último detalle es el que resuelve el caso. `forzarActualizacionHojaActiva`
hace dos cosas que el escaneo normal no hacía, y una de ellas es
`invalidarCacheRAM()`.

El caché vive en variables globales de V8 (`globalCacheData`, `globalCacheMap`),
y esas **pueden sobrevivir de una ejecución a la siguiente** cuando Google
reutiliza la instancia del script. `getCacheData()` las devolvía tal cual sin
comprobar nada:

```js
if (globalCacheData && globalCacheMap) return { data: globalCacheData, ... };
```

Así que un operador escaneando seguido en la misma pestaña se quedaba con una
foto vieja **del resto del archivo**. Las guías que otro acababa de meter en una
M-S no estaban en su copia: para él, no existían.

Ahora `procesarEdicion` descarta el caché en RAM al empezar. Dentro de una misma
ejecución se sigue reutilizando —que es donde de verdad importaba, al recalcular
varias pestañas sin releerlo cada vez— pero nunca se hereda de la edición
anterior. La carga entra en el desglose del cronómetro como `cargar caché`, para
poder ver lo que cuesta.

**Coste:** una relectura del caché por escaneo. En la última medición eran
~390 ms con 1,120 guías indexadas. Es el precio de que el dato sea correcto; si
pesa demasiado, el paso siguiente sería un contador de versión en el propio
CACHE_SISTEMA para releer solo cuando alguien lo haya tocado.

---

## MAYÚSCULAS y solo A-Z y 0-9 en todo lo que se teclea

Antes la limpieza solo se aplicaba a las columnas A y O, y solo quitaba
caracteres raros: un valor tecleado en minúsculas se quedaba en minúsculas en la
celda (aunque el sistema lo comparara en mayúsculas por dentro).

Ahora se normaliza todo lo que se captura: **MAYÚSCULAS y fuera todo lo que no
sea A-Z o 0-9**, en las cinco columnas de captura (1 A, 4 D, 14 N, 15 O, 17 Q).

Las columnas de hora (**L** y **S**) no están entre las de captura y ni siquiera
pasan por el editor, así que los `:` de la hora están a salvo por construcción,
no por una excepción que se pueda olvidar.

Dos detalles que hacían falta para que funcionara:

- La comparación se hace contra el valor **crudo**, no contra el ya normalizado.
  Comparando contra el normalizado, un cambio que solo fuera de minúscula a
  mayúscula no se detectaba y la celda se quedaba como se tecleó.
- `aplicarBatchUpdates` solo sabía escribir en `[1, 2, 12, 15, 16, 19]`. Las
  columnas 4, 14 y 17 se habrían descartado **en silencio**. La lista pasa a ser
  `COLS_BATCH` e incluye las cinco de captura.
