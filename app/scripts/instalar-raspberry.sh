#!/usr/bin/env bash
# =========================================================================
# Deja la app corriendo en una Raspberry Pi, SOLO EN LA RED LOCAL.
#
#   cd app && bash scripts/instalar-raspberry.sh
#
# Qué hace, en orden (se detiene en cuanto algo falla):
#   1. Comprueba que el sistema es de 64 bits.
#   2. Instala Node.js 22 si no está (pide la contraseña de la Raspberry).
#   3. Corre las pruebas. Si alguna falla, NO instala nada más.
#   4. Crea el servicio «wms-salidas»: arranca solo al prender la Raspberry
#      y se levanta solo si se cae.
#   5. Programa un respaldo diario de la base a las 23:30.
#   6. Dice qué dirección abrir en la pistola.
#
# La app escucha en la red local (la misma WiFi que las pistolas). No abre
# nada hacia internet: para eso habría que abrir un puerto en el módem a
# propósito, y no hay que hacerlo.
#
# Variables opcionales: PORT (3000), DATOS (~/wms-datos), ZONA (America/Mexico_City).
# =========================================================================
set -euo pipefail

CARPETA="$(cd "$(dirname "$0")/.." && pwd)"
PUERTO="${PORT:-3000}"
DATOS="${DATOS:-$HOME/wms-datos}"
ZONA="${ZONA:-America/Mexico_City}"
USUARIO="$(id -un)"

paso() { echo; echo "▶ $*"; }

paso "1/6 Sistema"
ARQ="$(uname -m)"
if [ "$ARQ" != "aarch64" ] && [ "$ARQ" != "x86_64" ]; then
  echo "Este sistema es $ARQ. Hace falta Raspberry Pi OS de 64 bits (Raspberry Pi 3, 4 o 5)."
  echo "Instálalo con Raspberry Pi Imager eligiendo «Raspberry Pi OS (64-bit)»."
  exit 1
fi
echo "OK: $ARQ"

paso "2/6 Node.js 22"
version_ok() {
  command -v node >/dev/null 2>&1 || return 1
  node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)'
}
if version_ok; then
  echo "OK: Node $(node --version)"
else
  echo "Instalando Node.js 22 (necesita internet una sola vez)…"
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
  version_ok || { echo "No se pudo instalar Node 22.13 o más."; exit 1; }
  echo "OK: Node $(node --version)"
fi
NODE="$(command -v node)"

paso "3/6 Pruebas"
cd "$CARPETA"
if ! npm test >/tmp/wms-pruebas.txt 2>&1; then
  grep -E "^not ok|^# (pass|fail)" /tmp/wms-pruebas.txt || true
  echo "Alguna prueba falló: NO se instala. El detalle está en /tmp/wms-pruebas.txt"
  exit 1
fi
grep -E "^# (pass|fail)" /tmp/wms-pruebas.txt

paso "4/6 Servicio wms-salidas"
mkdir -p "$DATOS"
sudo tee /etc/systemd/system/wms-salidas.service >/dev/null <<UNIDAD
[Unit]
Description=WMS Salidas (pruebas en red local)
After=network-online.target
Wants=network-online.target

[Service]
User=$USUARIO
WorkingDirectory=$CARPETA
Environment=PORT=$PUERTO
Environment=HOST=0.0.0.0
Environment=DB_PATH=$DATOS/wms.sqlite
Environment=TZ=$ZONA
ExecStart=$NODE --disable-warning=ExperimentalWarning src/servidor.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIDAD
sudo systemctl daemon-reload
sudo systemctl enable --now wms-salidas
sleep 2
systemctl is-active --quiet wms-salidas || { sudo journalctl -u wms-salidas -n 30 --no-pager; echo "El servicio no arrancó."; exit 1; }
echo "OK: el servicio está corriendo"

paso "5/6 Respaldo diario (23:30)"
LINEA="30 23 * * * cd $CARPETA && DB_PATH=$DATOS/wms.sqlite $NODE --disable-warning=ExperimentalWarning scripts/respaldar.js $DATOS/respaldos >> $DATOS/respaldos.log 2>&1"
( crontab -l 2>/dev/null | grep -v "scripts/respaldar.js" ; echo "$LINEA" ) | crontab -
echo "OK: respaldos en $DATOS/respaldos (se guardan los últimos 30)"

paso "6/6 Listo"
curl -fsS "http://127.0.0.1:$PUERTO/api/estado" >/dev/null && echo "La app responde."
echo
echo "Abre esto en la pistola (conectada a la MISMA WiFi que la Raspberry):"
for IP in $(hostname -I); do
  case "$IP" in *:*) ;; *) echo "   http://$IP:$PUERTO" ;; esac
done
echo
echo "Ver si está corriendo:   systemctl status wms-salidas"
echo "Ver lo que va pasando:   journalctl -u wms-salidas -f"
echo "Detenerla:               sudo systemctl stop wms-salidas"
echo "Quitarla del arranque:   sudo systemctl disable --now wms-salidas"
