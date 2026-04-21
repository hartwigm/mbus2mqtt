import { Config } from '../types';
import { PortManager } from '../mbus/port-manager';
import { getLogger } from '../util/logger';

export async function cmdRead(config: Config, deviceId: string): Promise<void> {
  const log = getLogger();
  const device = config.devices.find(d => d.secondary_address === deviceId);

  if (!device) {
    console.error(`Device ${deviceId} not found in config.`);
    console.log('Configured devices:');
    config.devices.forEach(d => console.log(`  ${d.secondary_address}  ${d.name}`));
    process.exit(1);
  }

  const pm = new PortManager(config);
  try {
    await pm.connectAll();
    const reading = await pm.readSingleDevice(deviceId);

    if (!reading) {
      console.error(`Failed to read device ${deviceId}`);
      process.exit(1);
    }

    console.log(`\n  Device:    ${reading.name}`);
    console.log(`  ID:        ${reading.device_id}`);
    console.log(`  Medium:    ${reading.medium}`);
    console.log(`  Value:     ${reading.value} ${reading.unit}`);
    console.log(`  Timestamp: ${reading.timestamp}`);

    if (reading.attributes && Object.keys(reading.attributes).length > 0) {
      console.log(`\n  Attributes (für HA):`);
      for (const [k, v] of Object.entries(reading.attributes)) {
        console.log(`    ${k.padEnd(22)} ${v}`);
      }
    }

    if (reading.raw_records) {
      console.log(`\n  All records:`);
      for (const rec of reading.raw_records) {
        const r = rec as { Function?: string; StorageNumber?: number; Unit?: string; Value?: unknown };
        console.log(`    [${r.StorageNumber}] ${r.Function}: ${r.Value} ${r.Unit || ''}`);
      }
    }
    console.log();
  } finally {
    await pm.disconnectAll();
  }
}
