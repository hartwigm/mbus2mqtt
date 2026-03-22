import { Config } from '../types';
import { scanAllPorts, scanAllPortsExtended, MBUS_BAUD_RATES } from '../mbus/scanner';

export async function cmdScan(config: Config, extended: boolean): Promise<void> {
  if (extended) {
    return cmdScanExtended(config);
  }

  console.log('\n  M-Bus Scan — alle konfigurierten Ports\n');
  console.log(`  Ports: ${config.ports.map(p => p.alias).join(', ')}`);
  console.log(`  ${'─'.repeat(50)}`);

  const results = await scanAllPorts(config.ports);

  console.log(`\n  ${'═'.repeat(50)}`);
  console.log('  Ergebnisse:\n');

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
        const status = configured ? `  ✓ ${configured.name}` : '  (nicht konfiguriert)';
        console.log(`  ${id}${status}`);
      }
    }
    console.log(`  Gefunden: ${result.devices.length} Gerät(e)\n`);
  }
}

async function cmdScanExtended(config: Config): Promise<void> {
  console.log('\n  M-Bus Extended Scan — alle Baudraten testen\n');
  console.log(`  Ports: ${config.ports.map(p => p.alias).join(', ')}`);
  console.log(`  Baudraten: ${MBUS_BAUD_RATES.join(', ')}`);
  console.log(`  ${'─'.repeat(50)}`);
  console.log('  ⚠️  Jeder Port wird nacheinander mit jeder Baudrate gescannt.');
  console.log('  Das kann pro Port bis zu 80 Minuten dauern.\n');

  const results = await scanAllPortsExtended(config.ports);

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
