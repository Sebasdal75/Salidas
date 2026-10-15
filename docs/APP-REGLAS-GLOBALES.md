# Reglas de una Global — qué mensaje sale y por qué

Es la referencia de lo que hace el motor (`app/src/motor.js` y
`app/src/reglas.js`). Los textos y colores son los de la hoja de Google actual:
si un mensaje aquí no coincide con la pantalla, es un error de la app.

Cada regla indica la función del sistema actual de la que viene (`Codigo.gs`)
para poder compararlas.

---

## 1. Qué se escanea

Lo que llega del lector se limpia primero: mayúsculas y solo letras y números
(`normalizacionAEscribir`). Después, cada valor es una de estas cosas:

| Es… | Cuando… | Ejemplo |
|---|---|---|
| **Pedimento** | exactamente 7 dígitos | `6100001` |
| **Pedimento incompleto** | de 1 a 6 dígitos | `61000` → `🛑 ERROR: Faltan 2 números` |
| **Guía UPS larga** | empieza por `1Z`, mide 18 y **el último dígito cuadra** con los demás | `1Z999AA10123456784` |
| **Guía corta** | 11 letras o números (no importa cuáles) | `H6620215136` |
| **Marcador** | `COSTALES`, `FIN`, `SIN_CABECERA` o algo que contenga `SIN PEDIMENTO` | `SIN PEDIMENTO` |
| **Dos pegadas** | dos guías en una celda (el lector leyó dos veces) | `❌ DOS PEGADAS: 1Z… + 1Z…` |
| **Inválido** | cualquier otra cosa | `❌ Guía Inválida` |

Una guía larga con el dígito de control mal **no** es válida: es la forma de
detectar una lectura a medias (`esGuiaUPSValida`).

## 2. Estructura: el pedimento arriba, sus guías debajo

En lo escaneado (columna A) cada **pedimento abre su bloque**: todo lo que va
debajo es de él hasta el siguiente pedimento o marcador.

```
6100001          ← pedimento (azul)
1Z…              ← guía
1Z…              ← guía
6100002          ← nuevo pedimento: cierra el bloque anterior
```

Un marcador abre bloque pero **no cuenta como pedimento** ni puede salir como
«repetido». Las guías sin pedimento arriba forman un bloque `SIN_CABECERA`: se
revisan como guías, pero no tienen resumen.

En la **lista esperada** (columna O) es al revés: el pedimento va **debajo** de
sus guías y las cierra (salvo en el rezago, donde va arriba). Es una trampa
conocida; el motor las lee cada una en su sentido.

## 3. El estado de cada guía

Se calcula en este orden; **lo primero que aplica, gana**:

| # | Situación | Estado | Color |
|---|---|---|---|
| 1 | Fila vacía | *(nada, sin hora)* | blanco |
| 2 | Quedó como error de captura (`🛑 ERROR…`) | se conserva | amarillo |
| 3 | Retenida *(fase 2)* | `🛑 RETENIDA (FEMAD)` | rojo |
| 4 | La misma guía está en **otra Global** | `⛔ DUPLICADO (En: <unidad> Fila N)` | naranja |
| 5 | Ya salió *(fase 2)* | `⛔ YA SALIÓ el …` | naranja |

Si ninguna de esas aplica, la decide su relación con la lista esperada:

| Situación | Estado | Color |
|---|---|---|
| Hay lista esperada para ese pedimento y la guía **está** | `✅ Ok` | verde |
| Hay lista, la guía **no está**, pero la lista de **otro** pedimento sí la trae | `❌ Va en: <pedimento>` | rosa |
| Hay lista, la guía no está en ninguna | `⚠️ Sobra (Ajena)` | rojo |
| **No** hay lista para ese pedimento y la guía no es de otro | `✅ Guía` | azul |
| No hay lista y la guía sí pertenece a **otro** pedimento | `❌ Va en: <pedimento>` | rosa |
| Es una guía de costales *(fase 2)* | `✅ Guía` | azul |
| La misma guía ya estaba antes **en el mismo pedimento** | `🔄 Duplicado local` | gris |
| La misma guía ya estaba antes **en otro pedimento** | `⛔ DUPLICADO (ya en Ped: X, fila N)` | naranja |
| Inválida | `❌ Guía Inválida` / `❌ DOS PEGADAS: …` | rojo |

La **última guía de cada bloque** lleva pegado, después de `   ►   `, el resumen
del bloque. Es una sola celda con dos cosas; el sistema siempre las separa por
esa marca.

## 4. El resumen del pedimento

Sale en la fila del pedimento, como `Bultos: N | <estado>`. `N` cuenta guías
**únicas y sin alerta**.

| Situación | Estado |
|---|---|
| Hay lista, no falta nada, no sobra nada, hay algo escaneado, sin alertas | `✅ COMPLETO` (verde) |
| Hay lista y faltan | `❌ Faltan N (guía, guía…)` (amarillo claro) |
| Hay lista y sobran | `⚠️ Sobran N` |
| Faltan y sobran | `❌ Faltan N (…) y ⚠️ Sobran M` |
| No hay lista, escaneado | `✅ Escaneado` (o `✅ A1 COMPLETO` en una pestaña con «A1» en el nombre) |
| No hay lista y no hay ninguna guía sin alerta debajo | `⚠️ No en preforma` (si hay alertas, en su lugar `⚠️ N con alerta`) |
| Mismas guías que la lista de **otro** pedimento | `⚠️ PEDIMENTOS NO COINCIDEN: estos mismos N 1Z están registrados bajo el pedimento X` |
| Hay alertas sin resolver en el bloque | se añade `⚠️ N con alerta` |

**Con alertas no se firma nada.** Si un bloque tiene una guía duplicada en otro
pedimento, una inválida o un error, el resumen **no** dice `✅ COMPLETO` aunque
el conteo cuadre: invitaría a cerrar el pedimento con la alerta sin mirar.
(El duplicado dentro del mismo pedimento, gris, **no** cuenta como alerta: el
conteo ya lo cuenta una vez.)

El caso «mismos 1Z, otro número» es un **dedazo en el pedimento**, no guías mal
puestas: se dice una vez en la fila del pedimento en lugar de «Va en» en cada
guía.

## 5. Prioridad de las alertas

Cuando dos reglas hablan de la misma fila, gana la más grave
(`nivelAlerta`, por el primer símbolo del texto):

| Nivel | Símbolo | Ejemplos |
|---|---|---|
| 4 crítico | 🛑 | error de captura, pedimento repetido |
| 3 alto | ⛔ | duplicado entre unidades o entre pedimentos |
| 2 medio | ❌ | guía inválida, va en otro pedimento |
| 1 aviso | ⚠️ 🔄 | sobra, duplicado local |
| 0 info | ✅ ➡ ⏳ | ok, ya salió |

### Una alerta grave no se cae sola

Cada recálculo reconstruye los estados desde cero. Si eso bastara, un ⛔ saldría
cuando se detecta el duplicado y desaparecería en cuanto *otra persona* escaneara
cualquier cosa. La regla (`conservarAlertasGraves`): **lo recalculado solo pisa a
lo que había si es igual de grave o más.** Se conservan los ⛔ y 🛑 y cualquier
duplicado, aunque sea gris. Se salta cuando:

- la celda está vacía (borrar limpia la fila entera);
- la fila se acaba de editar («hasta que se modifique»);
- se pulsa **Forzar actualización** (no conserva nada).

No se conservan `❌ Guía Inválida` ni `⚠️ Sobra`: salen del contenido de la
propia celda o cambian solos con el trabajo, y pegarlos estorbaría.

## 6. Duplicados

**El dominio:** una guía se compara solo contra otras **Globales** abiertas
(nunca contra M-S ni inventarios; eso llega en la fase 2 con sus propias reglas,
iguales a las de la hoja: M-S contra M-S, inventario contra inventario, destino
contra destino). Una guía puede estar a la vez en una M-S y en su destino: es el
flujo normal.

- **Dentro de la misma unidad**, mismo pedimento → `🔄 Duplicado local`, gris.
  Es un doble escaneo: se borra la de abajo y listo; la primera ni se marca.
- **Dentro de la misma unidad**, otro pedimento → `⛔ DUPLICADO (ya en Ped: X,
  fila N)`, y la **primera** de la pareja pasa a `⚠️ DUPLICADO (repetida en la
  fila M)`. Las dos celdas se pintan en rojo para ver la pareja de un vistazo.
- **En otra Global** → `⛔ DUPLICADO (En: <unidad> Fila N)`. La otra unidad
  también se recalcula y lo dice.
- **Pedimento repetido** dentro de la misma unidad → `🛑 PEDIMENTO REPETIDO
  (también en la fila N)` en las **dos** filas; en otra Global → `🛑 PEDIMENTO
  REPETIDO (En: <unidad> Fila N)`.
- Los duplicados **se reevalúan en cada recálculo**: al borrar el original, el
  aviso se limpia (con **Forzar actualización**, por la regla de arriba).

## 7. La lista esperada (preforma)

Se pega en la pestaña «Lista esperada»: un valor por renglón, el pedimento
**debajo** de sus guías. En cada renglón se aplican las mismas reglas de captura
(`6100` → error de captura; guía mal → `❌ Guía Inválida`).

| Dónde | Estado |
|---|---|
| El pedimento | `N bultos` |
| La última guía del bloque | `► Resumen: N bultos` |
| Pedimento repetido en la lista | `⚠️ PEDIMENTO REPETIDO` |
| Guía repetida en la lista, en el mismo pedimento | `🔄 Duplicado local` |
| Guía repetida en la lista, en otro pedimento | `⛔ GUÍA REPETIDA (ya en Ped: X, fila N)`; en la primera, `⚠️ GUÍA REPETIDA (repetida en la fila N)` |
| Guías sin pedimento debajo, y esa guía ya se escaneó | `⚠️ SIN PEDIMENTO: falta ponerlo DEBAJO, en la O` (solo en las guías escaneadas, no en las veinticuatro) |
| Una guía se escaneó bajo otro pedimento | `⚠️ PEDIMENTOS NO COINCIDEN: se escaneó en X` |
| Mismos 1Z escaneados bajo otro número | `⚠️ PEDIMENTOS NO COINCIDEN: los mismos 1Z se escanearon bajo X` (una vez, en el pedimento) |

El aviso nunca pisa uno más grave ni se apila sobre otro aviso.

La **letra de la columna N** (`a`, `b`, `c`) da el color del bloque en la lista:
`a` verde, `b` magenta, `c` turquesa, otra cosa verde claro.

## 8. Rezago

Una unidad con «REZAGO» en el nombre usa la lista esperada de otra manera
(el pedimento va arriba y abre su bloque):

| Situación | Estado |
|---|---|
| La guía está en la lista | `✅ Recuperado (Ped: X)` (verde); si ya está todo el pedimento, añade `\| 🌟 COMPLETO` |
| La guía no está en la lista | `⚠️ Ajena (No es de rezago)` |
| En la lista, el pedimento | `✅ REZAGO COMPLETO` o `⏳ Faltan N (…)` |
| Total de pedimentos | cuenta los **completos** (`Pedimentos (Completos)`) |

El rezago no tiene resumen `Bultos: N | …` por pedimento.

## 9. Colores de la celda escaneada

| Valor | Color |
|---|---|
| Pedimento | azul |
| Guía válida | verde |
| Cualquier valor con «duplicad» en el estado, o la pareja de un duplicado | rojo |
| Guía inválida | rojo |
| Marcador | blanco |
| Ubicación `IW…` *(fase 3, inventarios)* | azul claro |

## 10. Hora y usuario

- La hora (`HH:mm:ss`, en la zona horaria configurada) se **sella la primera vez**
  que la fila tiene algo y **no cambia** aunque se recalcule.
- Una fila vacía no lleva hora; si se borra, se va con ella.
- Cada renglón guarda **quién** lo escaneó.

## 11. Totales

- **Bultos**: guías **únicas y válidas** en lo escaneado (un duplicado cuenta una).
- **Total pedimentos**: pedimentos sin error de captura (en el rezago, los completos).
- **Esperados / Pedimentos esperados**: lo que trae la lista esperada.

## 12. Historial

Se apunta, con fecha, quién, unidad, lista, fila, valor, estado de entonces y
motivo, cuando:

- una celda se **borra** → `BORRADO MANUAL (Celda vaciada)`;
- una celda se **sobrescribe** con otro valor → `SOBRESCRITA con «X» (la celda ya tenía otra guía)`;
- se **pega una lista esperada nueva** → `PREFORMA REEMPLAZADA`.

Escribir la misma guía otra vez en la misma celda no es un cambio.

## 13. Lo que todavía no hace

Ver [`APP-FASES.md`](APP-FASES.md): las M-S y su registro previo, los inventarios,
las houses, los costales, las retenidas (FEMAD), «sin información», los
pedimentos ya usados otro día, las guías que ya salieron, la confronta contra el
archivo de referencias, los pedimentos finales y sus tiempos, y el cierre del día.
