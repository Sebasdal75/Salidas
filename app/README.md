# WMS Salidas — la app

La app web que reemplaza la hoja de Google Sheets «Salidas ESCANEOS UPS».
Corre en cualquier servidor con Node.js 22 y no depende de Google: se puede
alojar en Microsoft Azure, en un servidor de la empresa o en Docker.

**Estado: fase 1.** Escaneo de las Globales completo (pedimentos, guías,
lista esperada, duplicados, rezago, historial). Lo que falta, por fases, está
en [`docs/APP-FASES.md`](../docs/APP-FASES.md).

## Probarla en 1 minuto

```bash
cd app
npm start            # http://localhost:3000
npm test             # las pruebas
```

Abre la dirección en el navegador, escribe tu nombre, crea una unidad
(por ejemplo `GLOBAL 1 20-AE-3H`) y escanea. En la pistola Zebra funciona igual:
el campo de escaneo siempre tiene el cursor.

## Qué hay aquí

```
app/
  src/
    reglas.js      qué es cada cosa que se escanea (guía, pedimento, marcador),
                   textos, colores y prioridad de las alertas
    motor.js       el cerebro de una Global: de lo escaneado a estado y color
                   de cada fila (es `actualizarGlobalPreforma` del sistema actual)
    servicio.js    lo que pasa al escanear, borrar o pegar: guardar, recalcular,
                   historial; todo dentro de una transacción
    db.js          la base de datos (SQLite; ÚNICO archivo que cambia al pasar a
                   PostgreSQL o Azure SQL)
    servidor.js    HTTP: la pantalla y la API
    web/           la pantalla (HTML + CSS + JS, sin compilar)
  tests/           pruebas (motor, servicio, servidor)
  Dockerfile
```

## Documentación

| Documento | Para quién |
|---|---|
| [`APP-ARQUITECTURA.md`](../docs/APP-ARQUITECTURA.md) | Sistemas y quien mantenga la app: cómo está hecha y por qué |
| [`APP-INSTALACION.md`](../docs/APP-INSTALACION.md) | Sistemas: instalar, alojar, respaldar, actualizar |
| [`APP-REGLAS-GLOBALES.md`](../docs/APP-REGLAS-GLOBALES.md) | Todos: qué mensaje sale y por qué (la «constitución» de una Global) |
| [`APP-FASES.md`](../docs/APP-FASES.md) | Quien decida: qué está hecho y qué falta |
| [`APP-MANUAL-OPERADOR.md`](../docs/APP-MANUAL-OPERADOR.md) | Los operadores |
