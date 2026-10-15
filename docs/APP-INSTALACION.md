# Instalar, alojar y mantener la app

Para sistemas. La arquitectura y el porqué están en
[`APP-ARQUITECTURA.md`](APP-ARQUITECTURA.md).

---

> **Para probar antes de instalar en un servidor** (en una Raspberry, en la red
> local, sin internet): [`APP-PRUEBAS.md`](APP-PRUEBAS.md).

## 1. Requisitos

- **Node.js 22.13 o más** (la app usa el SQLite que ya trae Node). Nada más:
  `npm install` no descarga nada.
- Un disco donde guardar el archivo de la base y que se respalde.
- Para producción: nombre con HTTPS e inicio de sesión de la empresa
  (ver §4).

## 2. Correrla

```bash
cd app
npm start                 # http://localhost:3000
npm test                  # las pruebas
```

Variables de entorno (todas opcionales):

| Variable | Qué hace | Por defecto |
|---|---|---|
| `PORT` | Puerto en el que escucha | `3000` |
| `HOST` | `0.0.0.0` = toda la red local (para que lleguen las pistolas); `127.0.0.1` = solo este equipo | `0.0.0.0` |
| `DB_PATH` | Archivo de la base | `app/datos/wms.sqlite` |
| `TZ` | Zona horaria de las horas de escaneo | `America/Mexico_City` |
| `DB_JOURNAL` | `WAL` o `DELETE`. **`DELETE` si la base está en un disco de red** (ver §4) | `WAL` |
| `EXIGIR_SSO` | `1` en producción: solo vale el usuario que pone el inicio de sesión de la empresa; el nombre escrito en la pantalla se ignora y, sin cabecera, la petición es un 401 | *(apagado)* |
| `AUTH_HEADER` | Cabecera donde el proxy pone el usuario | `x-ms-client-principal-name` |
| `RESPALDOS_CONSERVAR` | Cuántos respaldos guarda `npm run respaldar` | `30` |

La carpeta `datos/` está en `.gitignore`: **la base nunca va al repositorio**.

## 3. Con Docker

```bash
cd app
docker build -t wms-salidas .
docker run -d --name wms -p 3000:3000 -v wms-datos:/datos --restart unless-stopped wms-salidas
```

- El volumen `/datos` guarda la base. **Sin volumen, se pierde al actualizar.**
- La imagen trae un `HEALTHCHECK` que consulta `/api/estado`.

## 4. Dónde alojarla (y una advertencia sobre la base)

**La advertencia primero.** La base de hoy es un archivo SQLite. SQLite necesita
un disco **local** para ser confiable: sobre una carpeta de red (Azure Files,
SMB/NFS) los bloqueos de archivo fallan de formas raras, sobre todo en modo WAL.
Por eso, **con la base de hoy**, lo sólido es un servidor con disco propio.
Para App Service o Container Apps, lo sólido es una base en red (PostgreSQL o
Azure SQL), que es un cambio acotado a `db.js` y `servicio.js`
([arquitectura §8](APP-ARQUITECTURA.md)) y **todavía no está hecho**.

### A. Lo que hoy está listo: un servidor con disco propio

- Una **máquina virtual de Azure** (Linux, un disco administrado) o un
  servidor de la empresa, con Node 22 o con Docker (§3).
- La app escuchando en un puerto interno y un **proxy con inicio de sesión de la
  empresa** delante (por ejemplo *Microsoft Entra Application Proxy*, un
  *Application Gateway* con autenticación, o *oauth2-proxy*), con HTTPS y un
  nombre (`wms.empresa.com`).
- Variables: `EXIGIR_SSO=1` y `AUTH_HEADER=<la cabecera con el correo que ponga
  tu proxy>` (`x-ms-client-principal-name` en Azure, `x-forwarded-email` con
  oauth2-proxy). Con `EXIGIR_SSO=1`, sin esa cabecera la app contesta 401.
- **La app debe ser alcanzable solo a través del proxy** (puerto cerrado al resto
  de la red). Si se puede llegar directo, cualquiera puede escribir la cabecera
  del usuario.
- Disco de la VM con respaldo (§7).

### B. App Service / Container Apps (cuando exista la base en red)

Con la imagen Docker o el código de `app/`, comando de inicio `npm start`,
**Autenticación** de Entra ID activada («Requerir autenticación»), `EXIGIR_SSO=1`
y la cadena de conexión de la base en variables de entorno o en Key Vault.
**Una sola instancia hasta que la base sea en red.** Hasta entonces, si se
decide usarlo con SQLite sobre almacenamiento de la plataforma: `DB_JOURNAL=DELETE`,
una instancia, y probarlo con carga de los siete operadores antes de confiar en
él; no recomendado para producción.

## 5. Como servicio

En el servidor, `npm start` debe correr como servicio que arranque solo y se
reinicie si falla: `systemd` en Linux, NSSM o el programador de servicios en
Windows, o `docker run --restart unless-stopped` (§3). Un solo proceso por base.

## 6. Las pistolas Zebra

La app es una página web: en la pistola se abre la dirección en Chrome (o en el
navegador que traiga) y se «agrega a la pantalla de inicio». El lector debe estar
en modo **teclado** (*keystroke*) con **Enter** al final: es la configuración con
la que ya trabajan en la hoja.

- El campo de escaneo siempre tiene el cursor; si el operador toca otra parte de
  la pantalla, vuelve solo.
- Sin red, los escaneos se guardan y salen en orden al volver. **No cerrar la
  pestaña con escaneos pendientes**: la cola vive en la pantalla, no en el servidor.

## 7. Respaldo

La base es **un archivo** (más `-wal` y `-shm` mientras corre).

- **Diario**, con el script incluido (no necesita instalar nada):
  ```bash
  cd app && DB_PATH=/datos/wms.sqlite npm run respaldar /respaldos
  ```
  Crea `wms-AAAAMMDD-HHMMSSmmm.sqlite`, comprueba que la copia se puede leer y
  conserva las últimas 30 (`RESPALDOS_CONSERVAR`). Es una copia consistente aunque
  la app esté escribiendo. Programarlo con `cron`, el Programador de tareas o un
  trabajo de Azure.
- **No copiar el archivo de la base con `cp`/Explorador mientras la app corre**:
  puede salir a medias.
- Los respaldos se guardan **en otro disco o servicio** que la base: uno en el
  mismo disco no protege de perder el disco.
- **Probar restaurar una vez**: un respaldo que nunca se restauró no es un respaldo.
- Restaurar: detener la app, poner el archivo en `DB_PATH` (borrando los `-wal` y
  `-shm`), iniciar.

## 8. Actualizar

1. Respaldar.
2. Correr `npm test` en el código nuevo.
3. Reemplazar `src/` (o la imagen) y reiniciar. El esquema se crea solo con
   `CREATE TABLE IF NOT EXISTS`; **cuando una versión cambie el esquema, traerá su
   propio paso de migración** y se documentará aquí.

## 9. Salud y problemas comunes

- **`/api/estado`** devuelve `{ ok: true, hora }`: sirve de comprobación del
  balanceador o de Azure.
- **«Falta decir quién escanea» (401)**: la pantalla no mandó nombre (navegador
  sin almacenamiento) o, con `EXIGIR_SSO=1`, el proxy no está pasando la cabecera
  del usuario (`AUTH_HEADER`).
- **«Ya hay una unidad abierta con ese nombre» (409)**: el nombre se compara en
  mayúsculas y con un espacio entre palabras; usar el otro o cerrar la anterior.
- **«database is locked»**: dos procesos usan el mismo archivo, o la base está en
  un disco de red. Debe haber un solo proceso de la app por base y la base en un
  disco local (o `DB_JOURNAL=DELETE`).
- **Las horas salen corridas**: revisar `TZ`.
- **«Esta app necesita Node.js 22.13 o más nuevo»**: actualizar Node.

## 10. Qué guardar fuera del repositorio

La base, los respaldos y cualquier credencial (futuras conexiones a OneDrive,
SharePoint o una base en red) **no se suben a git**: el repositorio lo ve más gente
que la base, y una dirección o una clave en el código es una llave.
Van en variables de entorno o en Azure Key Vault.
