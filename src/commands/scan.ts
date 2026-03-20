import { Config } from '../types';
import { scanAllPorts } from '../mbus/scanner';
import { getLogger } from '../util/logger';

export async function cmdScan(config: Config): Promise<void> {
  const log = getLogger();
  log.info('Scanning all configured ports for M-Bus devices...\n');

  const results = await scanAllPorts(config.ports);

  for (const result of results) {
    console.log(`\n  Port: ${result.port} (@${result.baud_rate} baud)`);
    console.log(`  ${'─'.repeat(50)}`);
    if (result.devices.length === 0) {
      console.log('  No devices found.');
    } else {
      for (const id of result.devices) {
        const configured = config.devices.find(d => d.secondary_address === id);
        const status = configured ? `  ✓ ${configured.name}` : '  (not configured)';
        console.log(`  ${id}${status}`);
      }
    }
    console.log(`  Found: ${result.devices.length} device(s)\n`);
  }
}
