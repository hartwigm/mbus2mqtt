import { Config } from '../types';
import { scanAllPorts } from '../mbus/scanner';

export async function cmdScan(config: Config): Promise<void> {
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
