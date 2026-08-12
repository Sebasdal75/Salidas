# Manual del operador — Salidas ESCANEOS UPS

Guía práctica para quien escanea. No hace falta saber nada de programación.

---

## 1. Qué hace el sistema

Tú escaneas guías con la pistola en la **columna A**. El sistema responde en la
**columna B**, al instante, contestando tres preguntas:

1. ¿Esta guía es válida?
2. ¿Ya estaba escaneada en otro lado?
3. ¿Este pedimento está completo?

Tú **solo escribes en la columna A** (y en la O si estás capturando preforma).
Todo lo demás lo escribe el sistema solo. **No hay que escribir nada en la
columna B.**

---

## 2. Las pestañas

| Pestaña | Para qué es | ¿Lleva preforma? |
|---|---|---|
| **GLOBAL PENDIENTE** y similares | Salida final. Aquí se cuadra contra la preforma | Sí (columna O) |
| **M-S T1**, **M-S GLOBALES**, **M-S A1**, **M-S SEGUIMIENTOS**, **M-S CUENTAS ESPECIALES** | Registro previo: escaneas el bulto cuando ya lo tienes pero aún no sabes en qué unidad se va | **No** |
| **INVENTARIO...** | Ubicaciones finales (empiezan con `IW`) | No |
| **MACHO** | Lista de guías retenidas por la Guardia Nacional | — |
| **CACHE_SISTEMA**, **HISTORIAL_BORRADOS** | Del sistema. **No tocar** | — |

Una guía **puede** estar en una M-S y luego en una Global: eso es normal y no
da alerta. Lo que sí avisa es la misma guía **dos veces en el mismo tipo de
sitio**.

---

## 3. Cómo se escanea

1. Escanea el **pedimento** (7 dígitos, por ejemplo `6100166`). Eso abre el bloque.
2. Escanea debajo todas las **guías** de ese pedimento.
3. Repite con el siguiente pedimento.

El sistema entiende que todo lo que va debajo de un pedimento pertenece a ese
pedimento, hasta que aparece el siguiente.

La **hora** se guarda sola en la columna L. Se pone una sola vez, cuando escaneas;
después ya no cambia.

---

## 4. Qué significa cada mensaje

### Todo va bien

| Mensaje | Qué significa | Qué hacer |
|---|---|---|
| **✅ Ok** | La guía estaba en la preforma. Cuadra | Nada |
| **✅ Guía** | Guía correcta, pero ese pedimento no tiene preforma cargada | Nada. Si debería tenerla, avisa |
| **✅ Ok (Escaneado en M-S T1)** | Además ya se había registrado en esa M-S | Nada. Es lo esperado |
| **✅ COMPLETO** | En la cabecera: llegaron todas las guías del pedimento | Cerrar el pedimento |
| **✅ TODO SALIÓ** | En una M-S: todas las guías ya salieron en su unidad | Nada |

### Ojo con esto

| Mensaje | Qué significa | Qué hacer |
|---|---|---|
| **⛔ DUPLICADO (En: ...)** | Esta guía **ya está escaneada en otra pestaña** del mismo tipo. Te dice cuál y en qué fila | Ve a esa fila. Decide cuál es la buena y **borra la otra** |
| **🔄 Duplicado local** (gris) | La escaneaste **dos veces dentro del mismo pedimento**, o dos veces en la misma ubicación IW. Sin drama | Borra la de abajo |
| **⛔ DUPLICADO (ya en Ped: X, fila N)** (naranja) | La misma guía está en **dos pedimentos distintos** de esta hoja. Te dice en cuál quedó la primera y en qué fila | Ve a esa fila, decide a cuál pertenece y borra la otra |
| **⚠️ DUPLICADO (repetida en la fila N)** (naranja) | El aviso que aparece en la **primera** de las dos, solo en el caso de arriba. Se pintan las dos para que veas la pareja | Compara las dos filas y borra la que sobra |
| **❌ Va en: 6098352** | La guía es buena, pero pertenece a **otro pedimento** | Muévela al bloque correcto |
| **⚠️ Sobra (Ajena)** | Esta guía no está en ninguna preforma | Verifica el paquete. Puede ser de otro embarque |
| **❌ Faltan 3 (1ZAB..., 1ZCD...)** | En la cabecera: faltan por llegar esas guías | Búscalas. El pedimento no está completo |
| **⚠️ Sobran 2** | Hay más guías escaneadas que las que dice la preforma | Revisa cuáles sobran |

### Errores que hay que corregir

| Mensaje | Qué significa | Qué hacer |
|---|---|---|
| **❌ Guía Inválida** | El código no pasa la validación. Suele ser una lectura mala de la pistola | **Vuelve a escanear.** Si insiste, tecléala |
| **🛑 ERROR: Faltan 2 números** | Escribiste un pedimento incompleto | Complétalo a 7 dígitos |
| **🛑 PEDIMENTO REPETIDO** | El mismo pedimento aparece dos veces en esta hoja | Junta los dos bloques en uno |
| **🛑 PEDIMENTO REPETIDO (En: hoja Fila N)** | El mismo pedimento está en **otra pestaña del mismo tipo** (otro destino, u otra M-S). No salta entre una M-S y su destino: eso es normal | Ve a esa hoja y decide en cuál va |
| **⚠️ PEDIMENTO REPETIDO** | Lo mismo, pero en la preforma (columna P) | Corrige la preforma |
| **⚠️ GUÍA REPETIDA EN PREFORMA** | Esa guía ya la habías capturado antes en la columna O | Borra la de abajo: repetirla infla el total de bultos esperados |

### Informativos

| Mensaje | Qué significa | Qué hacer |
|---|---|---|
| **Bultos: 0** | Pedimento escaneado, todavía sin guías debajo | Nada, sigue escaneando |
| **Bultos: 0 \| ⚠️ 1 con alerta** | Sí hay guías debajo, pero llevan alerta (duplicada, inválida) y por eso no cuentan como bulto | Resuelve la alerta de esa fila |
| **➡ Salió en GLOBAL PENDIENTE** | En una M-S: esa guía ya salió en esa unidad. Sale tachada y en gris | Nada. Puedes limpiarla con el menú |
| **⚠️ Faltan 3 por salir** | En una M-S: quedan 3 guías registradas que aún no salen | Nada, es informativo |
| **⚠️ Sin registrar en M-S** | Llegó a la Global sin haberse registrado antes en ninguna M-S | Verifica si se saltó un paso |
| **⚠️ No en preforma** | El pedimento no aparece en ninguna preforma | Verifica que sea el pedimento correcto |
| **⏳ Pendiente (reintenta)** | El sistema estaba ocupado y no alcanzó a validar | **Vuelve a escribir la guía.** Se corrige solo en 5 minutos |

### Solo en pestañas de REZAGO

| Mensaje | Qué significa |
|---|---|
| **✅ Recuperado (Ped: X)** | Guía de rezago recuperada, pertenece a ese pedimento |
| **🌟 COMPLETO** | Con esa, el pedimento quedó completo |
| **❌ Va en: OTRA HOJA (Ped: X)** | Esa guía es de otro rezago |
| **⚠️ Ajena (No es de rezago)** | No pertenece a ningún rezago |

---

## 5. Los colores

| Color | Significa |
|---|---|
| 🟩 Verde | Correcto, cuadra |
| 🟦 Azul claro | Guía correcta, sin preforma que comparar |
| 🟧 Naranja | Duplicado — **hay que resolverlo** |
| 🟨 Amarillo | Aviso: error de captura o falta un paso |
| 🟥 Rojo | Guía inválida o ajena |
| 🩶 Gris | Repetida en la misma hoja, o ya salida |

**Regla rápida: verde y azul, sigues. Naranja y rojo, te detienes y revisas.**

---

## 6. Los contadores de arriba

**Columna C (filas 1 a 3):**
- `Total bultos: 67` — guías distintas escaneadas
- `Total pedimentos: 3`
- En hojas M-S: `M-S T1: 92` — pedimentos de esa M-S
- En hojas M-S, si algunas ya salieron: `Total bultos: 120 (salieron: 45 | en piso: 75)`
- En inventarios: `Ubicaciones (IW): 12`

**Columna Q (filas 1 y 2), solo en Globales:**
- `Bultos (Preforma): 67` — lo que **debería** llegar
- `Pedimentos (Preforma): 3`

Si `Total bultos` y `Bultos (Preforma)` coinciden, llegó todo.

---

## 7. La preforma (solo Globales)

La preforma es la lista de lo que **debería** venir. Va en la **columna O**, con
el mismo formato: pedimento y debajo sus guías. El sistema compara la columna A
contra la O y te dice qué falta y qué sobra.

**Columna N:** poniendo `a`, `b` o `c` junto al pedimento, su bloque en la
preforma se pinta de otro color. Sirve para distinguir grupos de un vistazo.

> Se retiraron dos cosas que ya no se usaban: el proceso de **costales** y la
> marca **T1** de la columna D. Las columnas **D** y **Q** quedan libres — los
> totales de preforma de Q1:Q2 se siguen escribiendo solos.
>
> El sistema ahora solo vigila tres columnas: **A** (escaneo), **N** (letra de
> color del bloque) y **O** (preforma).

---

## 8. El menú `📦 Opciones Avanzadas`

El menú está arriba, a la derecha de **Ayuda / Help**. Las tres del día a día
están sueltas al principio; el resto va agrupado en cuatro submenús:
`🔍 Revisar`, `🌙 Cierre y limpieza`, `⚙️ Disparadores` y `🔧 Mantenimiento`.

Aquí va cada opción con detalle: qué hace, cuándo usarla y qué esperar.

### 📋 Agrupar Guías por Pedimento (Col A)

**Qué hace:** toma toda la columna A y la reordena. Junta cada guía debajo de
su pedimento y sube todos los bloques a la parte de arriba, sin huecos.

**Cuándo:** cuando escaneaste en desorden — guías sueltas, pedimentos
mezclados — y quieres dejar la hoja limpia. Usa la preforma y las M-S para
saber a qué pedimento va cada guía, así que aunque una guía la hayas escaneado
lejos de su pedimento, la reacomoda en su sitio.

**Después:** la hoja se recalcula sola. Es seguro correrla las veces que
quieras.

### 🧹 Limpiar guías movidas (Rango seleccionado)

**Qué hace:** en una hoja M-S, borra las guías que ya salieron (las que dicen
`➡ Salió en …`, tachadas y en gris) del rango que tengas seleccionado. También
borra las cabeceras de pedimento que se quedan sin ninguna guía.

**Cuándo:** al final del día o cuando una M-S se llena de guías ya despachadas y
estorban. Primero **selecciona** las filas, luego corre la opción.

**Importante:** solo borra lo que ya salió. Una guía que todavía no se despacha
**no** la toca. Cada borrado queda anotado en `HISTORIAL_BORRADOS` con tu
usuario, así que hay rastro de qué se limpió.

### 🔄 Forzar Actualización de esta pestaña

**Qué hace:** recalcula la pestaña en la que estás parado, de cero. Repasa
estados, colores, contadores y duplicados.

**Cuándo:** siempre que algo se vea raro y no sepas por qué — un color que no
cuadra, un contador viejo, un duplicado que crees que ya no debería estar. Es
la opción de "arréglate". No borra ni mueve nada; solo repinta.

**Es tu primer recurso.** Antes de asustarte por cualquier cosa, prueba esto.

### ♻️ Reconstruir caché completo

**Qué hace:** rehace desde cero el índice interno de duplicados (la pestaña
oculta `CACHE_SISTEMA`), leyendo todas las hojas otra vez. También limpia
columnas sobrantes de pestañas viejas.

**Cuándo:** cuando los duplicados dejan de detectarse, o cuando una guía marca
`⛔ DUPLICADO` señalando una fila que **ya está vacía**. Es más pesada que la
anterior; corre unos segundos.

**Cuándo NO:** para el día a día. Con **Forzar Actualización** basta casi
siempre. Reserva ésta para cuando el índice de verdad se descuadró.

### 🩺 Diagnóstico del sistema

**Qué hace:** abre un cuadro con el estado del sistema en texto: cuántas
pestañas hay indexadas, cuántas guías, si hay columnas sobrantes, cuántas filas
quedaron sin validar en cada hoja, qué disparadores están activos y qué hojas
están protegidas.

**Cuándo:** cuando algo no cuadra y quieres ver qué está pasando por dentro
antes de tocar nada. No cambia nada: solo informa. Si te toca reportar un
problema, la información de aquí es justo lo que hay que copiar.

### 🔒 Proteger hojas del sistema

**Qué hace:** pone un **aviso** sobre `CACHE_SISTEMA` e `HISTORIAL_BORRADOS`. Si
alguien intenta editarlas a mano, Sheets le pregunta "¿seguro?". No bloquea al
sistema ni a nadie: solo evita el borrón accidental.

**Cuándo:** una sola vez, al montar el archivo. No hay que repetirlo.

### ⚙️ Instalar trigger avanzado (recomendado)

**Qué hace:** cambia el motor a su modo bueno. Sube el límite de tiempo de cada
operación de 30 segundos a 6 minutos, activa el registro del usuario en el
historial y enciende un repaso automático cada 5 minutos que recoge los
escaneos que se hayan quedado sin validar.

**Cuándo:** una vez, al configurar. Después de instalarlo, revisa que no haya
quedado un disparador duplicado (ícono del reloj ⏰ en el editor de Apps
Script). El **Diagnóstico** también te lo dice.

### ↩️ Volver al trigger simple

**Qué hace:** deshace lo anterior. Vuelve al modo básico y quita el repaso
automático.

**Cuándo:** casi nunca. Solo si el trigger avanzado da problemas y quieres
descartar que sea la causa.

---

## 9. Si algo se ve mal

1. **Menú → 🔄 Forzar Actualización.** Resuelve casi todo.
2. Si los duplicados no salen o salen de más: **♻️ Reconstruir caché completo**.
3. Si una guía marca `⛔ DUPLICADO` de una fila que ya está vacía: reconstruye el
   caché. No debería pasar, pero se arregla así.
4. Si una alerta grave sigue puesta después de arreglar el problema: **🔄 Forzar
   Actualización**. Las alertas graves aguantan a propósito (ver abajo), y esa es
   la forma de retirarlas.
5. Si la pistola dejó de avisar de una guía retenida: **🛡️ Reponer validación
   (solo esta pestaña)**. Casi siempre es que alguien pegó encima.
6. Si el archivo va lento, cierra pestañas del navegador. Sheets es pesado.

---

## 9 bis. Tres cosas que cambiaron

**Las alertas graves ya no se borran solas.** Un `⛔` o un `🛑` se quedan puestos
hasta que se arregle lo que los provocó. Antes se podían caer en un recálculo y
la fila aparecía en verde sin que nadie hubiera hecho nada. Se quitan vaciando
la celda, corrigiendo esa misma fila, o con `🔄 Forzar Actualización`.

> Si resolviste el problema borrando **la otra** fila del par, esta no se
> enteró: dale a Forzar Actualización y se limpia.

**Un pedimento con alertas sin resolver ya no dice `✅ COMPLETO`.** Se queda en
ámbar con `⚠️ 1 con alerta`. Antes podía firmarse en verde teniendo un duplicado
dos filas más abajo, y eso invitaba a cerrarlo sin mirar.

**Las hojas crecen solas.** Ya no hace falta reservar filas de más: cuando el
escaneo llega a menos de 20 filas del final, se añaden 50 más, con su validación
puesta. El cierre del día las devuelve a 200, sin bajar nunca de 20 filas libres
por debajo del último dato.

---

## 10. Lo que NO hay que hacer

- ❌ **No escribas en la columna B.** El sistema la sobrescribe.
- ❌ **No borres ni edites `CACHE_SISTEMA` ni `HISTORIAL_BORRADOS`.**
- ❌ **No borres la columna M.** Es la lista de la Guardia Nacional.
- ❌ **No pegues guías con formato** desde otro lado. Pega solo valores
  (`Ctrl+Shift+V`). Pegar una celda sin validación **borra la validación que
  hubiera debajo**, y desde ahí la pistola deja de avisar de las guías retenidas
  sin decir nada. Si ya pasó: `🔧 Mantenimiento → 🛡️ Reponer validación`.
- ❌ **No renombres las pestañas** sin avisar. El sistema las reconoce por su
  nombre: `M-S ...` son de registro previo, las que dicen `INVENTARIO` son inventarios.

---

## 11. Se queda registrado

Cada vez que alguien **borra** una guía, queda anotado en `HISTORIAL_BORRADOS`:
fecha, hora, usuario, pestaña, fila, qué se borró y qué estado tenía.

No es para vigilar a nadie: sirve para reconstruir qué pasó cuando un bulto no
aparece.
