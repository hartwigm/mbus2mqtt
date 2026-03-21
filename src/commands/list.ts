import { Config } from '../types';
import { ReadingsStore } from '../store/readings-store';

export async function cmdList(config: Config): Promise<void> {
  const store = new ReadingsStore(config.state_file);
  const allState = store.getAll();

  console.log(`\n  Property: ${config.property}`);
  console.log(`  Devices:  ${config.devices.length}`);
  console.log(`  ${'─'.repeat(80)}`);
  console.log(
    `  ${'Name'.padEnd(30)} ${'Medium'.padEnd(12)} ${'Value'.padEnd(14)} ${'Last Read'.padEnd(20)} Errors`
  );
  console.log(`  ${'─'.repeat(80)}`);

  for (const dev of config.devices) {
    const state = allState[dev.secondary_address];
    const name = dev.name.slice(0, 28).padEnd(30);
    const medium = dev.medium.padEnd(12);
    let value = '—'.padEnd(14);
    let lastRead = '—'.padEnd(20);
    let errors = '0';

    if (state) {
      if (state.last_value !== null) {
        const v = parseFloat(state.last_value.toPrecision(10));
        value = `${v} ${state.last_unit}`.padEnd(14);
      }
      if (state.last_read) {
        lastRead = state.last_read.slice(0, 19).replace('T', ' ').padEnd(20);
      }
      errors = String(state.read_errors);
    }

    console.log(`  ${name} ${medium} ${value} ${lastRead} ${errors}`);
  }
  console.log();
}
