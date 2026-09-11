# Llevar el WMS de Salidas al archivo de costales («Actual cuadre de bolsas»)

> Documento de traspaso. Pégalo entero como primer mensaje en una sesión nueva,
> sobre la rama que corresponda.

---

## 0. Antes de tocar nada

**Este archivo YA tiene un script propio corriendo.** En sus hojas hay `✅ Ok`,
`Bultos: 122 | ✅ MÚLTIPLE` y colas de resumen con el separador `►`, que es el
mismo vocabulario del WMS de Salidas pero **no sale de `Codigo.gs`**: la palabra
`MÚLTIPLE` no existe en ese archivo. Es un pariente, no el mismo código.

**Primera tarea, sin excepción: conseguir el código actual de ese archivo y
leerlo antes de proponer nada.** Extensiones → Apps Script, en
`https://docs.google.com/spreadsheets/d/1rrRDkkIfvoK_OAXT_5zYFT_LJBn7sKvSIBqx8PCyMDY`.

Sin eso, cualquier plan es adivinar, y aquí ya se perdió tiempo adivinando.

---

## 1. Cómo está montado el archivo

Archivo: **«Actual cuadre de bolsas»**
ID: `1rrRDkkIfvoK_OAXT_5zYFT_LJBn7sKvSIBqx8PCyMDY`
Dueño: `salidasterminalups@gmail.com`

**Cuatro pestañas**: una `macho` (plantilla + lista de retenidas) y varias
`Global 3 <fecha>` (una por día). Todas con la MISMA forma:

| Col | Contenido |
|-----|-----------|
| A | Guía — destino **GLOBAL H** |
| B | RESUMEN de A |
| C | Guía — destino **EXCENTO H** |
| D | RESUMEN de C |
| E | Guía — destino **GLOBAL G** |
| F | RESUMEN de E |
| G | Guía — destino **EXCENTO G** |
| H | RESUMEN de G |
| I | Guía — destino **ESLAM** |
| J | RESUMEN de I |
| K:L | Tabla `📊 RESUMEN PEDIMENTOS` (combinada). Filas: GLOBAL H, EXCENTO H, GLOBAL G, EXCENTO G, ESLAM, TOTAL UNIDAD, TOTAL PIEZAS |
| M | Lista de guías **RETENIDAS** (FEMAD), igual que la columna M del archivo de Salidas |

**Fila 1** = títulos. **Fila 2** = el PEDIMENTO de cada columna (`6108725`,
`6108732`, …) y en su RESUMEN el total del bloque (`Bultos: 60 | ✅ MÚLTIPLE`).
De la fila 3 hacia abajo, las guías con su `✅ Ok`.

La última guía de cada columna lleva la cola:
`✅ Ok   ►   Bultos: 122 | ✅ MÚLTIPLE`.

### La diferencia que lo condiciona todo

> **Salidas:** UNA columna de escaneo por pestaña (A), y las demás columnas
> tienen significado fijo (B estado, C house, D totales, L hora, M FEMAD,
> O preforma, P estado, Q house, R totales).
>
> **Costales:** CINCO pares (guía, resumen) en la MISMA pestaña, uno por
> destino, y cada par es un bloque de un solo pedimento.

Todo el motor de `Codigo.gs` está escrito contra la primera forma:
`datosMasivos[i][0]` es la guía, `[1]` el estado, `getRange(1, 1, lr, 12)`,
`aplicarCambiosOptimizado(hoja, 2, 12, 1, 11, …)`, y el caché guarda una sola
columna por pestaña (`<HOJA>_FISICO`).

**Pegar `Codigo.gs` en este archivo no funciona.** No es cuestión de ajustes:
hay que introducir el concepto de «par» (columna de guía + columna de estado) y
hacer que el motor itere sobre los pares de la hoja.

---

## 2. Qué SÍ se puede

### 2.1 Portable casi tal cual — funciones puras, sin tocar Sheets

Se copian y funcionan. Están probadas en `tests/harness.js` (1.241 asserts).

- **`esGuiaUPSValida`** — dígito verificador de UPS. Rechaza pedimentos de 7
  dígitos y marcadores. Es la base de todo lo demás.
- **`nivelAlerta` / `puedePisar` / `conservarAlertasGraves`** — la regla de que
  una alerta grave no se cae sola. Sin esto, un recálculo borra un `⛔` que nadie
  volvió a mirar.
- **`duplicadoLocal`** — el texto y el color según el duplicado sea dentro del
  mismo pedimento (gris, discreto) o entre pedimentos (naranja, se marcan las
  dos filas).
- **`pedimentoConserva`** — si a un pedimento le quedan guías tras una limpieza.
- **`cabezaEstado` / `colaResumen` / `SEP_RESUMEN`** — separar el estado de su
  cola de resumen. **Imprescindible**: sin `cabezaEstado` la celda acumula un
  resumen por recálculo y crece sin fin. Ya causó un bucle infinito una vez.
- **`horaPreservada`** — no repisar la hora de una guía que no cambió.
- **`esMarcadorEstructural`** — `COSTALES`, `FIN`, `SIN_CABECERA`, `SIN PEDIMENTO`.

### 2.2 Portable con adaptación

- **RETENIDAS (`🛑 RETENIDA (FEMAD)`)** — *el más fácil de todos aquí.* En
  Salidas la lista tiene que viajar en el caché porque el recálculo lee A:L y la
  lista puede ser más larga. **En costales la lista ya está en la columna M de
  la propia hoja**, que se lee de todas formas. Se resuelve leyendo M y
  construyendo un `Set` una vez por recálculo. Empezar por aquí.

- **HOUSE (`House.gs`)** — el índice vive en un archivo APARTE
  (`archivoDelIndice()` / `PROP_ID_INDICE`), así que se comparte sin copiar
  nada. Lo que hay que decidir es **dónde se escribe la house**: aquí no hay
  columnas libres entre los pares. Dos opciones, y es una decisión del usuario:
  1. Insertar una columna por par → `guía | house | estado` (15 columnas).
  2. Llevarlas todas a la derecha de M → no estorban, pero quedan lejos de su
     guía y hay que leerlas cruzando la fila.

- **YA SALIÓ / PEDIMENTO YA USADO (`Salidas.gs`)** — la lista rápida es una
  pestaña oculta (`SALIDAS_RAPIDO`) con el texto comprimido. Se copia igual.
  Hay que enganchar `avisoDeYaSalio` y `avisoDePedimentoUsado` **en cada uno de
  los cinco pares**, no solo en el primero.

- **Caché de duplicados** — es lo que más trabajo lleva. Hoy `<HOJA>_FISICO`
  guarda UNA columna por pestaña. Aquí hacen falta cinco por pestaña, con nombre
  tipo `<HOJA>_GLOBAL_H`, `<HOJA>_EXCENTO_H`… y `construirIndiceCache` tiene que
  saber qué dominio es cada una. Sin esto no hay detección de duplicados entre
  destinos, que probablemente es lo que más valor tiene en un cuadre de bolsas.

- **Crecimiento automático de filas**, **historial auditado de borrados**,
  **limpieza de guías movidas**, **protecciones / diagnóstico de solo lectura**
  — todos portables; el historial y la limpieza necesitan saber de qué par viene
  cada fila.

---

## 3. Qué NO se puede (o no conviene)

- **Pegar `Codigo.gs` tal cual.** Ver §1.

- **Duplicados ENTRE los dos archivos en tiempo de escaneo** (una guía en
  Salidas y en costales). Obligaría a abrir el otro Sheets dentro del escaneo:
  `SpreadsheetApp.openById()` cuesta cientos de milisegundos y un escaneo entero
  dura ~500 ms. **Solo viable como botón manual o disparador por tiempo**, nunca
  al escanear.

- **Compartir `CACHE_SISTEMA` entre los dos archivos.** El caché se lee entero
  en cada escaneo; tiene que estar en el mismo archivo. Cada archivo lleva el
  suyo. Lo que SÍ se comparte es el archivo de índices (houses y salidas).

- **Un solo `onEdit` para los dos archivos.** Son proyectos distintos. Y ojo:
  **dos `onEdit` en el MISMO proyecto no conviven** — gana el último que cargue
  y el otro menú desaparece entero. Ya pasó en este proyecto y costó una mañana.

---

## 4. Trampas ya conocidas — no volver a pisarlas

Esto es lo que costó caro en el archivo de Salidas. Todo aplica aquí.

1. **`perf()` NO atrapa excepciones.** Lo que reviente dentro mata
   `procesarEdicion` en silencio: el operador escanea y no pasa nada, sin error.
   Todo lo que se enganche al escaneo va con `try/catch` propio y `typeof` si
   vive en otro archivo `.gs`.

2. **Columnas de sistema en el caché: prefijo `__`.** El podado de columnas
   huérfanas borra cualquier columna cuyo nombre no sea una pestaña existente, y
   el índice de duplicados solo mira las que acaban en `_FISICO`. Una columna sin
   `__` desaparece sola cada pocos minutos, y una que entre al índice hace que
   cada guía choque contra su propia copia.

3. **Hojas internas.** Cualquier pestaña que el motor no deba escanear tiene que
   estar en `HOJAS_INTERNAS` **y comprobarse por prefijo**. Si una hoja con guías
   se cuela como hoja de escaneo, cada guía sale `⛔ DUPLICADO` contra sí misma.
   Pasó con `INDICE_HOUSE` y volvió a pasar porque su columna del caché seguía
   viva después de marcarla interna: **marcar una hoja como interna no borra su
   columna**, hay que podarla explícitamente.

4. **Celdas grandes rompen la app móvil.** Los escáneres abren esto en la app de
   Sheets, que pasa a SOLO LECTURA cuando no puede cargar el archivo. Nada de
   celdas de 45.000 caracteres: máximo ~5.000.

5. **Protecciones «solo aviso» = solo lectura en el móvil.** La app no sabe
   mostrar el cuadro de confirmación y se planta. Desde el PC parece que no pasa
   nada. Si una pestaña no deja escanear en el escáner pero sí en el ordenador,
   es esto.

6. **Escritura diferencial.** `aplicarCambiosOptimizado` solo repinta filas cuyo
   texto cambió. Si una fila necesita color nuevo SIN cambiar texto (por ejemplo
   la primera de una pareja duplicada), hay que forzarla explícitamente o se
   queda con el color viejo para siempre.

7. **Nunca hacer read-modify-write sobre un rango que incluya una columna de
   captura.** `onEdit` corre sin lock cuando `waitLock` falla, y se pisan
   escaneos. En costales las columnas de captura son **A, C, E, G, I**.

8. **La cuota de disparadores es por CUENTA.** Si se agota, Google apaga TODOS
   los disparadores, incluido el del escaneo. Menos disparadores, mejor.

9. **Cada llamada a la API cuesta 50-250 ms** según el peso del archivo. El
   presupuesto de un escaneo es ~500 ms. Leer una vez y escribir por bloques.

---

## 5. Orden sugerido

Por valor entregado y riesgo creciente. **Nada de esto va a producción sin que
el usuario lo pruebe en una copia primero.**

1. **Leer el script actual del archivo.** Sin esto no se empieza.
2. **Retenidas** — la lista ya está en la columna M. Poco código, valor inmediato.
3. **Validación de guía + prioridad de alertas** — funciones puras.
4. **El concepto de «par»**: una función que, dada la hoja, devuelva
   `[{guia: 1, estado: 2, nombre: "GLOBAL H"}, {guia: 3, estado: 4, …}, …]`.
   Todo lo demás se apoya en esto, así que hacerlo bien primero.
5. **Duplicados dentro de la hoja** (entre los cinco destinos) — sin caché
   todavía: la hoja ya está leída entera.
6. **Caché multi-columna** → duplicados entre pestañas/días.
7. **Salidas** (`⛔ YA SALIÓ`, `🛑 PEDIMENTO YA USADO`).
8. **House** — decidir antes dónde se escribe.

---

## 6. Reglas de trabajo

- **Producción en vivo**: 7 operadores con escáneres Zebra, terminal aduanal en
  México. Un fallo aquí para la operación.
- **Todo lo que sea lógica pura va con test** en `tests/harness.js`. Se corre con
  `node tests/harness.js` y tiene que quedar en verde.
- **Los comentarios explican POR QUÉ**, no qué. Especialmente cuando algo parece
  raro: casi siempre es que arregla un fallo concreto.
- **Español**, tanto en el código como al hablar con el usuario.
- **Un archivo por cambio**, y decir siempre cuál hay que pegar y si hace falta
  reconstruir el caché.

---

# ANEXO — Traer los costales a la unidad (decidido con el usuario)

Esta parte ya está cerrada. No hay nada que preguntar: se implementa así.

## Qué hace

Un botón en el menú de una pestaña de unidad (`Global1`, `Global 3`…) que trae
de «Actual cuadre de bolsas» los bloques de esa unidad y los **pega al final de
la columna A**, como escaneos normales.

```
1ZW612R60452089266   ← último escaneo del operador
                     ← UN renglón en blanco (solo este)
6108725              ← pedimento del 1er destino del cuadre
1Z0RA8120413775919
1Z…
6108732              ← 2º destino, SIN renglón en blanco entre bloques
1Z0638E80473695114
1Z…
```

- **Un solo renglón en blanco**, antes del primer bloque. Entre bloques NO: el
  pedimento ya abre bloque por sí mismo.
- **Sin marcador `COSTALES`.** Se pidió expresamente.
- **Sin resumen.** No se trae la tabla `RESUMEN PEDIMENTOS` ni los totales del
  cuadre.

## Por qué no hay que tocar el motor

Porque lo pegado **es** un bloque normal de la columna A. De ahí sale todo solo:
entra al índice del caché, recibe su estado en la B, **recibe su house en la C**
—que es el motivo principal de querer esto—, cuenta en los totales y choca como
duplicado si esa guía está en otra pestaña.

No hay que enseñarle nada nuevo al recálculo. Es un importador que escribe en la
columna A, y ya.

## Qué pestañas del cuadre le tocan a cada unidad

El usuario **renombra a mano** las pestañas del cuadre: todo lo que salga ese
día se llama como la unidad. **Las fechas se ignoran por completo** — no hay que
buscar por prefijo ni elegir la más reciente.

Para una unidad `Global 1`:

1. La pestaña `Global 1` del cuadre.
2. Y `Global 1 complemento`, **si existe**.
3. Si no existe la primera, no se pega nada y se dice cuál se buscó.

### Comparar SIN ESPACIOS

`claveHoja()` solo hace `trim` + `toUpperCase`, así que `GLOBAL1` y `GLOBAL 1`
**no** son iguales para él. Y en el archivo de Salidas conviven las dos formas:
la pestaña real se llama `Global1` (sin espacio) y también hay `Global 3` (con
espacio).

El emparejamiento compara quitando los espacios (`GLOBAL1` ≡ `GLOBAL 1`). Sin
eso, el botón no encontraría nada y no habría forma de saber por qué: los dos
nombres se ven idénticos en pantalla.

## Reglas de implementación

- **Con lock.** Se escribe en la columna A, que es columna de captura. Escribir
  ahí mientras alguien escanea es la única forma de perder un escaneo en este
  sistema.
- **Idempotente.** Apretar dos veces no puede pegar dos veces. Antes de escribir,
  comprobar si esos pedimentos ya están en la hoja y saltar los que sí.
- **Ruidoso al fallar.** Si no encuentra la pestaña, o el cuadre no se puede
  abrir, se dice qué se buscó y no se escribe nada. Nunca pegar «lo más parecido».
- **Fuera del escaneo.** `openById` sobre otro archivo cuesta cientos de ms
  contra un presupuesto de ~500 ms por escaneo. Solo botón.
- **La house llega con retraso.** Al escanear, la house sale del caché en el
  momento; estas guías las escribe el script, así que las recoge el relleno
  automático del minuto siguiente. Conviene decirlo en el aviso final del botón
  para que nadie piense que falló.
- **Permisos.** El cuadre es de `salidasterminalups@gmail.com`. Quien apriete el
  botón necesita lectura sobre ese archivo.

## Dato del archivo

ID del cuadre: `1rrRDkkIfvoK_OAXT_5zYFT_LJBn7sKvSIBqx8PCyMDY`

Cada pestaña trae **cinco pares** (guía, resumen) en A/B, C/D, E/F, G/H, I/J. El
pedimento de cada destino está en la **fila 2** de su columna de guías, y de la
fila 3 hacia abajo van las guías. Se leen las cinco columnas; las vacías se
saltan.
