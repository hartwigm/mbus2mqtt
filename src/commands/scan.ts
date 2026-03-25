import * as fs from 'fs';
import * as yaml from 'js-yaml';
import { Config, DeviceConfig } from '../types';
import { scanAllPorts, scanAllPortsExtended, MBUS_BAUD_RATES } from '../mbus/scanner';
import { MbusConnection } from '../mbus/connection';

// M-Bus medium codes (EN 13757-3, last byte of secondary address)
const MEDIUM_MAP: Record<number, { medium: DeviceConfig['medium']; prefix: string }> = {
  0x02: { medium: 'electricity', prefix: 'EZ' },
  0x03: { medium: 'gas', prefix: 'GZ' },
  0x04: { medium: 'heat', prefix: 'WMZ' },
  0x06: { medium: 'warm_water', prefix: 'WWZ' },
  0x07: { medium: 'water', prefix: 'WZ' },
  0x0C: { medium: 'heat', prefix: 'WMZ' },
  0x0D: { medium: 'heat', prefix: 'WMZ' },
};

// Unit strings from node-mbus that carry a multiplier
const UNIT_FACTOR_MAP: Record<string, { factor: number; unit: string }> = {
  'Energy (10 Wh)': { factor: 10, unit: 'Wh' },
  'Energy (100 Wh)': { factor: 100, unit: 'Wh' },
  'Energy (Wh)': { factor: 1, unit: 'Wh' },
  'Energy (kWh)': { factor: 1, unit: 'kWh' },
  'Energy (MWh)': { factor: 1, unit: 'MWh' },
  'Energy (J)': { factor: 1, unit: 'J' },
  'Energy (kJ)': { factor: 1, unit: 'kJ' },
  'Energy (10 kJ)': { factor: 10, unit: 'kJ' },
  'Energy (100 kJ)': { factor: 100, unit: 'kJ' },
  'Volume (m m^3)': { factor: 1, unit: 'm³' },
  'Volume (m^3)': { factor: 1, unit: 'm³' },
  'Volume (1e-1  m^3)': { factor: 0.1, unit: 'm³' },
  'Volume (1e-2  m^3)': { factor: 0.01, unit: 'm³' },
  'Volume (1e-3  m^3)': { factor: 0.001, unit: 'm³' },
  'Volume (10 m^3)': { factor: 10, unit: 'm³' },
  'Volume (100 m^3)': { factor: 100, unit: 'm³' },
};

function parseMediumFromAddress(secondaryAddress: string): { medium: DeviceConfig['medium']; prefix: string } {
  // Secondary address format: 8 chars ID + 4 chars Manufacturer + 2 chars Version + 2 chars Medium
  if (secondaryAddress.length >= 16) {
    const mediumByte = parseInt(secondaryAddress.substring(14, 16), 16);
    if (MEDIUM_MAP[mediumByte]) {
      return MEDIUM_MAP[mediumByte];
    }
  }
  return { medium: 'water', prefix: 'WZ' };
}

const CONFIG_PATHS = ['/etc/mbus2mqtt/config.yaml', './config.yaml'];

export async function cmdScan(config: Config, extended: boolean, portFilter?: string, autoAdd?: boolean, configPathOpt?: string): Promise<void> {
  const ports = portFilter
    ? config.ports.filter(p => p.alias === portFilter)
    : config.ports;

  if (portFilter && ports.length === 0) {
    console.log(`\n  ❌ Port "${portFilter}" nicht gefunden. Verfügbar: ${config.ports.map(p => p.alias).join(', ')}\n`);
    return;
  }

  if (extended) {
    return cmdScanExtended(config, ports);
  }

  console.log('\n  M-Bus Scan — alle konfigurierten Ports\n');
  console.log(`  Ports: ${ports.map(p => p.alias).join(', ')}`);
  console.log(`  ${'─'.repeat(50)}`);

  const results = await scanAllPorts(ports);

  console.log(`\n  ${'═'.repeat(50)}`);
  console.log('  Ergebnisse:\n');

  const newDevices: DeviceConfig[] = [];

  for (const result of results) {
    console.log(`  Port: ${result.port} (@${result.baud_rate} baud)`);
    console.log(`  ${'─'.repeat(50)}`);
    if (result.error) {
      console.log(`  ❌ Fehler: ${result.error}`);
    } else if (result.devices.length === 0) {
      console.log('  Keine Geräte gefunden.');
    } else {
      for (const id of result.devices) {
        const configured = config.devices.find(d => d.secondary_address === id);
        if (configured) {
          console.log(`  ${id}  ✓ ${configured.name}`);
        } else {
          const { medium, prefix } = parseMediumFromAddress(id);
          const shortId = id.substring(0, 8);
          console.log(`  ${id}  + neu (${medium})`);
          newDevices.push({
            secondary_address: id,
            port: result.port,
            name: `${prefix} ${shortId}`,
            medium,
            value_factor: 1,
          });
        }
      }
    }
    console.log(`  Gefunden: ${result.devices.length} Gerät(e)\n`);
  }

  // Auto-add new devices to config
  if (newDevices.length > 0) {
    if (autoAdd) {
      await addDevicesToConfig(config, newDevices, configPathOpt);
    } else {
      console.log(`  ${newDevices.length} neue(s) Gerät(e) gefunden.`);
      console.log(`  Erneut mit --add ausführen um sie zur Config hinzuzufügen:\n`);
      console.log(`    m2q scan --add\n`);
    }
  }
}

async function cmdScanExtended(config: Config, ports: typeof config.ports): Promise<void> {
  console.log('\n  M-Bus Extended Scan — alle Baudraten testen\n');
  console.log(`  Ports: ${ports.map(p => p.alias).join(', ')}`);
  console.log(`  Baudraten: ${MBUS_BAUD_RATES.join(', ')}`);
  console.log(`  ${'─'.repeat(50)}`);
  console.log('  ⚠️  Jeder Port wird nacheinander mit jeder Baudrate gescannt.');
  console.log('  Das kann pro Port bis zu 80 Minuten dauern.\n');

  const results = await scanAllPortsExtended(ports);

  console.log(`\n  ${'═'.repeat(50)}`);
  console.log('  Ergebnisse Extended Scan:\n');

  for (const result of results) {
    console.log(`  Port: ${result.port}`);
    console.log(`  Pfad: ${result.port_path}`);
    console.log(`  ${'─'.repeat(50)}`);

    if (result.devices.length === 0) {
      console.log('  Keine Geräte gefunden bei keiner Baudrate.\n');
      continue;
    }

    for (const dev of result.devices) {
      const configured = config.devices.find(d => d.secondary_address === dev.secondary_address);
      const name = configured ? configured.name : '(nicht konfiguriert)';
      const baudMatch = configured?.baud_rate
        ? (configured.baud_rate === dev.baud_rate ? ' ✓' : ` ⚠️  Config: ${configured.baud_rate}`)
        : '';
      console.log(`  ${dev.secondary_address}  @${dev.baud_rate} baud  ${name}${baudMatch}`);
    }

    console.log(`\n  Gefunden: ${result.devices.length} Gerät(e)\n`);

    // Show config snippet for devices that need baud_rate override
    const portConfig = config.ports.find(p => p.alias === result.port);
    const needsOverride = result.devices.filter(d => portConfig && d.baud_rate !== portConfig.baud_rate);
    if (needsOverride.length > 0) {
      console.log('  💡 Diese Geräte brauchen eine eigene Baudrate in der Config:');
      console.log('  Füge "baud_rate: XXXX" zum Device-Eintrag hinzu:\n');
      for (const dev of needsOverride) {
        const configured = config.devices.find(d => d.secondary_address === dev.secondary_address);
        console.log(`    - secondary_address: "${dev.secondary_address}"`);
        console.log(`      port: "${result.port}"`);
        console.log(`      baud_rate: ${dev.baud_rate}`);
        if (configured) {
          console.log(`      name: "${configured.name}"`);
          console.log(`      medium: "${configured.medium}"`);
        }
        console.log('');
      }
    }
  }
}

async function probeDevices(config: Config, devices: DeviceConfig[]): Promise<void> {
  // Group devices by port for efficient probing
  const byPort = new Map<string, DeviceConfig[]>();
  for (const dev of devices) {
    const list = byPort.get(dev.port) || [];
    list.push(dev);
    byPort.set(dev.port, list);
  }

  for (const [portAlias, devs] of byPort) {
    const portConfig = config.ports.find(p => p.alias === portAlias);
    if (!portConfig) continue;

    const conn = new MbusConnection(portConfig.path, portConfig.baud_rate, portAlias);
    try {
      await conn.connect();
      for (const dev of devs) {
        try {
          process.stdout.write(`  🔍 ${dev.secondary_address}: Lese Zählerdaten... `);
          const data = await conn.getData(dev.secondary_address);

          // Detect medium from SlaveInformation
          const slaveMedium = data.SlaveInformation?.Medium?.toLowerCase() || '';
          if (slaveMedium.includes('electricity') || slaveMedium.includes('energy')) {
            dev.medium = 'electricity';
            dev.name = dev.name.replace(/^WZ /, 'EZ ');
          } else if (slaveMedium.includes('heat') || slaveMedium.includes('wärme')) {
            dev.medium = 'heat';
            dev.name = dev.name.replace(/^WZ /, 'WMZ ');
          } else if (slaveMedium.includes('warm')) {
            dev.medium = 'warm_water';
            dev.name = dev.name.replace(/^WZ /, 'WWZ ');
          } else if (slaveMedium.includes('gas')) {
            dev.medium = 'gas';
            dev.name = dev.name.replace(/^WZ /, 'GZ ');
          }

          // Detect unit factor from primary data record
          const records = data.DataRecord || [];
          const primary = records.find(r =>
            r.Function === 'Instantaneous value' &&
            r.StorageNumber === 0 &&
            typeof r.Value === 'number'
          ) || records.find(r => typeof r.Value === 'number');

          if (primary) {
            const unitInfo = UNIT_FACTOR_MAP[primary.Unit];
            let factor = unitInfo?.factor ?? 1;

            // Electricity: always normalize to kWh
            if (dev.medium === 'electricity' && unitInfo) {
              if (unitInfo.unit === 'Wh') {
                factor = factor / 1000;  // e.g. "Energy (10 Wh)" → 10/1000 = 0.01
              } else if (unitInfo.unit === 'MWh') {
                factor = factor * 1000;
              }
              // kWh stays as-is
            }

            dev.value_factor = factor;
            if (factor !== 1) {
              console.log(`${dev.medium}, ${primary.Unit} → Faktor ${factor} (kWh)`);
            } else {
              console.log(`${dev.medium}, ${primary.Unit}`);
            }
          } else {
            console.log(`${dev.medium}`);
          }
        } catch {
          console.log('Fehler beim Lesen — verwende Standardwerte');
        }
      }
    } catch {
      console.log(`  ⚠️  Port ${portAlias}: Verbindung fehlgeschlagen — verwende Standardwerte`);
    } finally {
      await conn.disconnect();
    }
  }
}

async function addDevicesToConfig(config: Config, newDevices: DeviceConfig[], configPathOpt?: string): Promise<void> {
  // Find config file
  const candidates = configPathOpt ? [configPathOpt] : CONFIG_PATHS;
  const configPath = candidates.find(p => fs.existsSync(p));
  if (!configPath) {
    console.log('  ❌ Config-Datei nicht gefunden.\n');
    return;
  }

  // Probe each new device to detect medium and unit factor
  console.log('\n  Erkenne Zählertypen...\n');
  await probeDevices(config, newDevices);

  const raw = fs.readFileSync(configPath, 'utf-8');
  const cfg = yaml.load(raw) as Record<string, unknown>;
  const devices = (cfg.devices as unknown[]) || [];

  console.log('');
  for (const dev of newDevices) {
    const entry: Record<string, unknown> = {
      secondary_address: dev.secondary_address,
      port: dev.port,
      name: dev.name,
      medium: dev.medium,
      value_factor: dev.value_factor ?? 1,
    };
    devices.push(entry);
    console.log(`  ✅ ${dev.secondary_address} → ${dev.name} (${dev.medium}, Faktor ${entry.value_factor})`);
  }

  cfg.devices = devices;
  const updated = yaml.dump(cfg, { lineWidth: 120, noRefs: true });
  fs.writeFileSync(configPath, updated, 'utf-8');

  const svcMgr = fs.existsSync('/run/systemd/system') ? 'systemd' : 'openrc';
  const restartCmd = svcMgr === 'systemd'
    ? 'sudo systemctl restart mbus2mqtt'
    : 'rc-service mbus2mqtt restart';

  console.log(`\n  ${newDevices.length} Gerät(e) zur Config hinzugefügt: ${configPath}`);
  console.log(`  Neustart: ${restartCmd}\n`);
}
