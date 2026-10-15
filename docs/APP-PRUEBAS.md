# Probar la app antes de ponerla en un servidor

Todo esto se hace **en tu red local**, sin publicar nada en internet. La hoja de
Google se sigue usando igual mientras tanto.

Son tres pruebas, en este orden:

1. **Comparar contra tu hoja** (no estorba a nadie): ¿la app dice lo mismo que la hoja con tus datos reales?
2. **Instalar en la Raspberry** y abrirla desde una pistola.
3. **Probar en piso** con una unidad de prueba.

---

## Lo que necesitas

- Una **Raspberry Pi 3, 4 o 5** con **Raspberry Pi OS de 64 bits** (con Raspberry
  Pi Imager eliges «Raspberry Pi OS (64-bit)»).
- Que la Raspberry esté en **la misma WiFi que las pistolas**.
- Internet en la Raspberry **solo para instalar** (una vez).
- El código: en GitHub, en la rama `claude/wms-apps-script-refactor-bcjpnc`.
  En la Raspberry, abre la terminal y escribe:
  ```bash
  git clone -b claude/wms-apps-script-refactor-bcjpnc https://github.com/Sebasdal75/Salidas.git
  cd Salidas/app
  ```
  (Si el repositorio es privado te pedirá tu usuario de GitHub. También puedes
  bajarlo como ZIP desde la página de GitHub —botón *Code* → *Download ZIP*— y
  copiarlo con una memoria USB.)

---

## Prueba 1 — ¿Dice lo mismo que la hoja?

No se escanea nada extra: usas lo que ya escanearon hoy en la hoja.

1. En la hoja de Google, abre la pestaña de una Global.
   **Archivo → Descargar → Valores separados por comas (.csv)**.
   Repite con **todas las Globales del día** (los duplicados entre unidades solo
   se pueden revisar si están todas). No le cambies el nombre a los archivos: la
   app saca de ahí el nombre de la unidad.
2. Copia los archivos a la Raspberry, en una carpeta, por ejemplo `~/csv-hoy`.
3. En la terminal, dentro de `Salidas/app`:
   ```bash
   npm run comparar -- ~/csv-hoy/*.csv --salida ~/comparacion
   ```
4. Lee el final:
   - `RESULTADO: la app dice lo mismo que la hoja…` → bien.
   - `N diferencia(s) a revisar` → **mándame lo que sale en pantalla** (o el
     archivo `~/comparacion/diferencias.csv`).

Las diferencias «**ESPERADAS**» (M-S, houses, «sin información», costales,
retenidas, salidas) no son errores: son módulos que la app todavía no tiene. Solo
importan las de «**A REVISAR**».

> Hazlo con **varios días distintos**: cada día trae casos nuevos.

---

## Prueba 2 — Instalarla en la Raspberry

Dentro de `Salidas/app`:

```bash
bash scripts/instalar-raspberry.sh
```

El instalador, en orden: instala Node.js 22 (te pide la contraseña de la
Raspberry), **corre todas las pruebas y no instala nada si alguna falla**, deja
la app corriendo como servicio (arranca sola al prender la Raspberry), programa
un respaldo diario y al final te dice la dirección, algo como:

```
Abre esto en la pistola (conectada a la MISMA WiFi que la Raspberry):
   http://192.168.1.50:3000
```

**Importante: dale a la Raspberry una IP fija.** En el módem o router, busca
«reserva DHCP» (o «IP estática») y reserva la IP de la Raspberry. Si no, la
dirección puede cambiar al reiniciar y las pistolas dejan de encontrarla.

**No abras ningún puerto en el módem.** Así la app solo se ve dentro de tu red.

---

## Prueba 3 — En piso, con una pistola

Abre la dirección en el navegador de la pistola. Escribe tu nombre y crea una
unidad de prueba: `PRUEBA 1`. Revisa esto, en orden:

| # | Haz esto | Debe pasar |
|---|---|---|
| 1 | Escanea un pedimento | Azul; dice `Bultos: 0 \| ⚠️ No en preforma` (normal mientras no tenga guías) |
| 2 | Escanea 3 guías | Verdes; pitido corto |
| 3 | Escanea otra vez una de esas guías | `🔄 Duplicado local`, gris; dos pitidos |
| 4 | Escanea un código que no sea guía (una etiqueta cualquiera) | `❌ Guía Inválida`, rojo; pitido grave |
| 5 | Escribe `61000` y Enter | `🛑 ERROR: Faltan 2 números`, amarillo |
| 6 | Toca esa fila, escribe el pedimento completo, Guardar | Se corrige |
| 7 | Toca una fila, bórrala (vacío), Guardar | Desaparece y sale en **Historial** |
| 8 | Crea `PRUEBA 2` y escanea ahí una guía que ya está en `PRUEBA 1` | `⛔ DUPLICADO (En: PRUEBA 1 Fila N)`; en `PRUEBA 1`, al volver, también lo dice |
| 9 | Apaga la WiFi de la pistola, escanea 3 guías, vuelve a prenderla | Aviso amarillo «Sin conexión: 3»; al volver se mandan solas y en orden |
| 10 | Dos pistolas escaneando a la vez la misma unidad | Nada se pierde ni se repite; las dos ven lo mismo en 2 segundos |
| 11 | En **Lista esperada**, pega guías y debajo su pedimento | El pedimento dice `✅ COMPLETO` o `❌ Faltan N (…)` |
| 12 | Desconecta la Raspberry de la luz y vuelve a conectarla | Al minuto la app vuelve sola y los datos siguen ahí |

Anota lo que no pase como dice la tabla, con foto de la pantalla.

---

## Qué me mandas

1. El resultado de la **prueba 1** (de uno o varios días).
2. La tabla de la **prueba 3** con lo que falló, y fotos.
3. Cómo se siente en la pistola: ¿se lee bien?, ¿el sonido ayuda?, ¿qué estorba?

Con eso corrijo lo que salga, y después seguimos con la fase 2 (las M-S).

---

## Si algo no funciona

| Pasa esto | Haz esto |
|---|---|
| La pistola no abre la dirección | Que esté en la misma WiFi que la Raspberry; revisa la IP con `hostname -I` en la Raspberry |
| «Este sistema es armv7l» | La Raspberry tiene el sistema de 32 bits: instala Raspberry Pi OS (64-bit) |
| El instalador dice que falló una prueba | Mándame el archivo `/tmp/wms-pruebas.txt` |
| La app no responde | En la Raspberry: `systemctl status wms-salidas` y `journalctl -u wms-salidas -n 50` |
| Quiero empezar de cero | `sudo systemctl stop wms-salidas`, borra la carpeta `~/wms-datos`, `sudo systemctl start wms-salidas` |
| Quiero quitarla | `sudo systemctl disable --now wms-salidas` |

Los datos de las pruebas viven en `~/wms-datos` en la Raspberry y no tocan la
hoja de Google para nada.
