import * as fs from 'fs';
import * as yaml from 'js-yaml';
import { Config, DeviceConfig } from '../types';
import { scanAllPorts, scanAllPortsExtended, MBUS_BAUD_RATES } from '../mbus/scanner';

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
          console.log(`  ${id}  + neu`);
          // Extract short ID from secondary address for default name
          const shortId = id.substring(0, 8);
          newDevices.push({
            secondary_address: id,
            port: result.port,
            name: `WZ ${shortId}`,
            medium: 'water',
          });
        }
      }
    }
    console.log(`  Gefunden: ${result.devices.length} Gerät(e)\n`);
  }

  // Auto-add new devices to config
  if (newDevices.length > 0) {
    if (autoAdd) {
      addDevicesToConfig(config, newDevices, configPathOpt);
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

function addDevicesToConfig(config: Config, newDevices: DeviceConfig[], configPathOpt?: string): void {
  // Find config file
  const candidates = configPathOpt ? [configPathOpt] : CONFIG_PATHS;
  const configPath = candidates.find(p => fs.existsSync(p));
  if (!configPath) {
    console.log('  ❌ Config-Datei nicht gefunden.\n');
    return;
  }

  const raw = fs.readFileSync(configPath, 'utf-8');
  const cfg = yaml.load(raw) as Record<string, unknown>;
  const devices = (cfg.devices as unknown[]) || [];

  for (const dev of newDevices) {
    devices.push({
      secondary_address: dev.secondary_address,
      port: dev.port,
      name: dev.name,
      medium: dev.medium,
    });
    console.log(`  ✅ ${dev.secondary_address} → ${dev.name} (${dev.port})`);
  }

  cfg.devices = devices;
  const updated = yaml.dump(cfg, { lineWidth: 120, noRefs: true });
  fs.writeFileSync(configPath, updated, 'utf-8');

  const svcMgr = fs.existsSync('/run/systemd/system') ? 'systemd' : 'openrc';
  const restartCmd = svcMgr === 'systemd'
    ? 'sudo systemctl restart mbus2mqtt'
    : 'rc-service mbus2mqtt restart';

  console.log(`\n  ${newDevices.length} Gerät(e) zur Config hinzugefügt: ${configPath}`);
  console.log(`  Medium: water (Standard) — bei Bedarf in Config anpassen.`);
  console.log(`  Neustart: ${restartCmd}\n`);
}
