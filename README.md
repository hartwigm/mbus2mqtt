# mbus2mqtt

M-Bus to MQTT Gateway — liest Smartmeter (Wasser, Wärme, Gas, Strom) über M-Bus USB-Adapter aus und publiziert die Werte per MQTT. Unterstützt Home Assistant Auto-Discovery und house.ai Integration.

## Features

- Automatische Erkennung von M-Bus USB-Adaptern (FTDI, Prolific, CH340)
- Scan mit Fortschrittsanzeige und Extended Scan über alle Baudraten
- Pro-Gerät konfigurierbare Baudrate (für gemischte Busse)
- Home Assistant MQTT Auto-Discovery
- Scheduler mit konfigurierbaren Leseintervallen pro Gerät
- Persistenter State (überlebt Neustarts)
- CLI-Tool `m2q` für Scan, Setup, Lesen und Daemon-Betrieb

## Installation

### Raspberry Pi (empfohlen für Standalone-Betrieb)

Auf einem frisch installierten **Raspberry Pi OS Lite** (Bookworm oder Trixie):

```bash
curl -fsSL https://raw.githubusercontent.com/hartwigm/mbus2mqtt/main/deploy/rpi/setup-rpi.sh | sudo bash -s -- M47 2412
```

> 1. Parameter: Property-Name (z.B. `M47`).
> 2. Parameter: Passwort für die Web-UI (Default `2412`, wenn weggelassen).

Unterstützt **Raspberry Pi 2/3/4/5** (armhf und arm64).

Nach der Installation:

```bash
m2q setup                              # USB-Adapter erkennen
sudo nano /etc/mbus2mqtt/config.yaml   # Config anpassen
sudo systemctl start mbus2mqtt         # Dienst starten
```

### Proxmox LXC Container (Alpine Linux)

Auf dem Proxmox Host:

```bash
curl -fsSL https://raw.githubusercontent.com/hartwigm/mbus2mqtt/main/deploy/create-lxc.sh | bash -s -- 200 M47 vmbr0
```

> Parameter: `CTID` `PROPERTY` `BRIDGE`

### Manuelle Installation

```bash
git clone https://github.com/hartwigm/mbus2mqtt.git
cd mbus2mqtt
npm install
npm run build
cp config/config.example.yaml /etc/mbus2mqtt/config.yaml
```

## CLI-Befehle

```
m2q setup                  USB-Adapter erkennen und konfigurieren
m2q scan                   Alle Ports scannen (konfigurierte Baudrate)
m2q scan -e                Extended Scan (alle Baudraten 300–921600)
m2q scan -e -p usb1        Extended Scan nur auf einem Port
m2q list                   Konfigurierte Geräte und letzte Werte
m2q read <device-id>       Einzelnes Gerät auslesen
m2q run                    Daemon starten (liest + publiziert)
m2q update                 Update von GitHub (nur LXC)
```

## Konfiguration

Konfigurationsdatei: `/etc/mbus2mqtt/config.yaml`

```yaml
property: "M47"

mqtt:
  broker: "mqtt://192.168.133.11:1883"
  username: "mbus2mqtt"
  password: "changeme"

ports:
  - path: "/dev/serial/by-id/usb-FTDI_FT232R_USB_UART_AQ03MP6X-if00-port0"
    alias: "usb0"
    baud_rate: 2400
  - path: "/dev/serial/by-id/usb-Prolific_Technology_Inc._USB-Serial_Controller_DTEAt114J20-if00-port0"
    alias: "usb1"
    baud_rate: 2400

read_interval_minutes: 15

devices:
  - secondary_address: "20135442523B0307"
    port: "usb0"
    name: "WZ 20135442"
    medium: "water"

  # Gerät mit abweichender Baudrate
  - secondary_address: "21000094523B0504"
    port: "usb1"
    name: "Wärmemengenzähler"
    medium: "heat"
    baud_rate: 9600
    read_interval_minutes: 5
```

### Device-Optionen

| Option | Beschreibung |
|--------|-------------|
| `secondary_address` | M-Bus Sekundäradresse (16-stellig hex) |
| `port` | Port-Alias (z.B. `usb0`) |
| `name` | Anzeigename |
| `medium` | `water`, `warm_water`, `heat`, `gas`, `electricity` |
| `baud_rate` | Baudrate für dieses Gerät (überschreibt Port-Standard) |
| `value_factor` | Multiplikator für Rohwert (Default: 0.001 für Wasser) |
| `read_interval_minutes` | Leseintervall (überschreibt globalen Wert) |

## MQTT Topics

```
mbus2mqtt/{property}/{device_id}/state          # Messwerte (HA)
homeassistant/sensor/{uid}/config               # HA Auto-Discovery
property/{property}/meters/{device_id}          # house.ai
mbus2mqtt/status                                # online/offline
```

## Hardware

### Getestete USB-Adapter

- **FTDI FT232R** — Standard M-Bus USB-Adapter
- **Prolific PL2303** — günstiger USB-Seriell-Adapter
- **CH340** — China-Adapter

### Getestete Zähler

- Wasserzähler (Sensus, div. Hersteller, 2400 baud)
- Wärmemengenzähler (9600 baud)

## Entwicklung

```bash
npm run dev      # Dev-Mode mit Hot-Reload (tsx watch)
npm run build    # TypeScript kompilieren
npm start        # Daemon starten
```

## Lizenz

MIT
