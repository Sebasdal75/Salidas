# Cómo se usa la app — para el operador

La pantalla es la misma en la pistola, en la computadora y en el teléfono.
**Los mensajes y los colores son los de la hoja de siempre.**

---

## 1. Entrar

1. Abre la dirección que te dio sistemas.
2. Si te pide nombre, escribe el tuyo. (Si entras con tu cuenta de la empresa, ya
   sabe quién eres.)
3. Verás las **unidades abiertas**. Toca la tuya, o crea una nueva con su nombre
   (por ejemplo `GLOBAL 1 20-AE-3H`).

## 2. Escanear

- El cuadro de arriba **siempre tiene el cursor**: solo escanea.
- Primero el **pedimento** (7 dígitos) y debajo sus **guías**. Cuando cambie el
  pedimento, escanea el siguiente.
- Después de cada escaneo, arriba sale **el resultado grande, con su color**, y
  suena:
  - un pitido corto: está bien;
  - dos pitidos medios: aviso, mira el mensaje;
  - un pitido grave: error, **hay que arreglarlo**.

## 3. Qué significan los colores

| Color de la guía | Qué es |
|---|---|
| Verde | Guía válida |
| Azul fuerte | Pedimento |
| **Rojo** | Duplicada, inválida o con problema |
| Gris (estado) | La misma guía otra vez en el mismo pedimento: bórrala |
| Naranja (estado) | Duplicada en otro pedimento u otra unidad |
| Amarillo | Error de captura: pedimento incompleto |

La fila del **pedimento** dice el resumen: `Bultos: 12 | ✅ COMPLETO` cuando está
todo; `❌ Faltan 2 (…)` te dice cuáles; `⚠️ 1 con alerta` quiere decir que hay una
guía con problema dentro del bloque y **todavía no se puede dar por bueno**.

## 4. Corregir

- **Toca una fila** → puedes escribir el valor correcto o dejarlo vacío para
  borrarla. Todo lo que borras o cambias **queda anotado** (quién, cuándo y por qué).
- Si un aviso rojo ya no corresponde (por ejemplo, ya borraste el duplicado en
  la otra unidad), toca **Forzar actualización**.
- Un pedimento incompleto (de 1 a 6 dígitos) sale `🛑 ERROR: Faltan N números`:
  toca la fila y escríbelo completo.

## 5. La lista esperada

En **Lista esperada** se pega lo que debería llevar la unidad: un valor por
renglón, con el pedimento **debajo** de sus guías. Con ella, cada guía dice
`✅ Ok`, `❌ Va en: …` o `⚠️ Sobra`, y cada pedimento dice `✅ COMPLETO` o cuáles
faltan.

## 6. Si se cae la red

Sigue escaneando. Arriba sale un aviso amarillo («Sin conexión: N escaneos
esperando»). Se mandan **solos, en orden**, al volver la red.
**No cierres la pestaña** mientras haya escaneos esperando.

## 7. Historial

La pestaña **Historial** muestra qué se borró o se cambió en la unidad, quién y
cuándo.
