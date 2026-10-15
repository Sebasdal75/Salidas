# La app, por fases

Reconstruir un sistema vivo se hace por partes, probando cada una con las
pistolas **antes** de seguir y sin apagar la hoja actual hasta que la app la
reemplace de verdad. Cada fase se puede aprobar o descartar sola.

La referencia de qué hace el sistema de hoy es el código de Google
(`Codigo.gs` y compañía) y sus manuales (`MANUAL-TECNICO.md`,
`MANUAL-OPERADORES.md`).

---

## Fase 1 — El escaneo de las Globales ✅ (hecha)

Lo que ya hay y está probado:

- Captura: limpieza del lector, pedimento, guía larga con dígito de control,
  guía corta, marcadores, dos pegadas, pedimento incompleto.
- El cerebro de una Global: estados, colores y orden de prioridad de la hoja.
- Lista esperada (preforma): faltantes, sobrantes, «Va en…», pedimento repetido,
  guía repetida, «mismos 1Z con otro número», color de bloque por letra.
- Duplicados dentro de la unidad y entre Globales; pedimentos repetidos.
- Alertas graves que no se caen solas; «Forzar actualización».
- Rezago.
- Hora de escaneo, quién escaneó, historial de borrados y sobrescrituras.
- Pantalla para la pistola (cola sin red, sonido, foco fijo), varios operadores.
- Servidor, base de datos, Docker, documentación.

**Se parece a la hoja, pero no la reemplaza todavía**: sin las fases 2 y 3 las
Globales no cruzan contra las M-S, que es de donde sale su lista esperada en el
día a día.

## Fase 2 — Lo que rodea a una Global

Entran por los **ganchos del motor** (`hooks` y `ms` en `motor.js`), así que el
motor casi no cambia:

| Pieza | Qué es | Gancho |
|---|---|---|
| **M-S** (registro previo) | Pestañas M-S T1, M-S GLOBALES… Su contenido alimenta la lista esperada de las Globales; las Globales marcan en la M-S lo que ya salió (`➡ Salió en …`). Tienen su propio cerebro (`actualizarMS`) y sus reglas de duplicados (M-S contra M-S) | `ms.guiasOrigen`, `ms.registroMS` |
| **Retenidas (FEMAD)** | Lista de guías retenidas que sale en rojo aunque ya hayan salido | `hooks.retenida` |
| **Salidas / ya salió** | Si una guía o un pedimento ya salió otro día | `hooks.yaSalio`, `hooks.pedimentoUsado` |
| **Costales** | Bultos que no están en la lista de la unidad y no son ajenos | `hooks.costal` |
| **Houses** y **«Sin información»** | Cada guía con su house; las que no la tienen salen avisadas | por definir (son columnas nuevas) |
| **Cierre del día** | Mover lo cerrado al histórico y dejar la unidad lista | — |

Es la fase más grande: aquí viven la mayoría de las reglas que se fueron
añadiendo con la operación.

## Fase 3 — Los módulos de pedimentos

- **Inventarios** (ubicaciones `IW…`) con su regla de duplicados propia.
- **Confronta de referencias** contra el archivo de la empresa (la carpeta de
  Drive hoy; aquí, OneDrive/SharePoint o carga manual): piezas, houses, atadura a
  pedimento, borrar lo de días anteriores sin quitar las «sin empezar».
- **Pedimentos finales**: cuadrar los papeles de cada unidad, con bloques,
  horas, fecha y hora aparte, y el registro y reporte de tiempos por unidad.
- **Reportes de la columna D** (`ERROR FALTARON 2 BULTOS`) al registro.
- **Comandos**: los que hoy son códigos de barras (`WMSACT`…) pasan a ser botones;
  si se quieren los códigos, se vuelven a añadir.

## Fase 4 — Pasar de la hoja a la app

1. **Datos**: importar las unidades y las listas de hoy a la base (un script de
   una sola vez, con prueba contra una copia de la hoja).
2. **En paralelo**: unos días con las dos (la hoja manda, la app se compara) y
   comparar mensaje por mensaje.
3. **Capacitación**: los textos y colores son los mismos; cambia la pantalla.
4. **Corte**: la hoja pasa a solo lectura y queda de histórico.

## Cómo se sabe que una fase terminó

- Las pruebas del motor cubren cada regla nueva **con los textos de la hoja**.
- Una unidad real se escanea en las dos y los estados coinciden.
- Los operadores la usan en la pistola un turno completo sin volver a la hoja.

## Qué sigue

Lo que más reduce el riesgo es **empezar la fase 2 por las M-S**: sin ellas, el
día a día de las Globales no se puede probar de punta a punta. Antes de
empezar conviene escoger una unidad real y un turno para la primera prueba en
paralelo.
