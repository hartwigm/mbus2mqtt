import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import * as yaml from 'js-yaml';
import { MbusConnection } from '../mbus/connection';

interface DetectedAdapter {
  path: string;
  name: string;
  chip: string;
}

const COMMON_BAUD_RATES = [2400, 9600];
const SERIAL_BY_ID_PATH = '/dev/serial/by-id';

function detectUsbAdapters(): DetectedAdapter[] {
  if (!fs.existsSync(SERIAL_BY_ID_PATH)) {
    return [];
  }

  const entries = fs.readdirSync(SERIAL_BY_ID_PATH);
  return entries.map(name => {
    const fullPath = path.join(SERIAL_BY_ID_PATH, name);
    // Extract chip type from name
    let chip = 'Unbekannt';
    if (name.includes('FTDI')) chip = 'FTDI';
    else if (name.includes('Prolific')) chip = 'Prolific';
    else if (name.includes('CH340')) chip = 'CH340';
    else if (name.includes('CP210')) chip = 'CP210x';

    return { path: fullPath, name, chip };
  });
}

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise(resolve => rl.question(question, resolve));
}

async function tryConnect(adapterPath: string, baudRate: number, alias: string): Promise<boolean> {
  const conn = new MbusConnection(adapterPath, baudRate, alias);
  try {
    await conn.connect();
    await conn.disconnect();
    return true;
  } catch {
    return false;
  }
}

export async function cmdSetup(configPath?: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log('\n  M-Bus Setup — USB-Adapter erkennen und konfigurieren\n');
  console.log(`  ${'─'.repeat(50)}`);

  // Step 1: Detect USB adapters
  const adapters = detectUsbAdapters();
  if (adapters.length === 0) {
    console.log('  ❌ Keine USB-Seriell-Adapter gefunden in /dev/serial/by-id/');
    console.log('  Prüfe ob ein M-Bus USB-Adapter angeschlossen ist.\n');
    rl.close();
    return;
  }

  console.log(`  ${adapters.length} USB-Seriell-Adapter gefunden:\n`);
  for (let i = 0; i < adapters.length; i++) {
    const a = adapters[i];
    console.log(`  [${i + 1}] ${a.chip} — ${a.name}`);
    console.log(`      ${a.path}`);
  }

  // Step 2: Test connections at common baud rates
  console.log(`\n  ${'─'.repeat(50)}`);
  console.log('  Verbindungstest...\n');

  interface ValidAdapter extends DetectedAdapter {
    baudRate: number;
  }
  const validAdapters: ValidAdapter[] = [];

  for (const adapter of adapters) {
    const alias = `test-${adapters.indexOf(adapter)}`;
    let connected = false;
    for (const baud of COMMON_BAUD_RATES) {
      process.stdout.write(`  ${adapter.chip}: teste ${baud} baud... `);
      const ok = await tryConnect(adapter.path, baud, alias);
      if (ok) {
        console.log('✅ OK');
        validAdapters.push({ ...adapter, baudRate: baud });
        connected = true;
        break;
      } else {
        console.log('❌');
      }
    }
    if (!connected) {
      console.log(`  ⚠️  ${adapter.chip}: Keine Verbindung möglich`);
    }
  }

  if (validAdapters.length === 0) {
    console.log('\n  ❌ Kein Adapter konnte verbunden werden.\n');
    rl.close();
    return;
  }

  // Step 3: Build port config
  console.log(`\n  ${'─'.repeat(50)}`);
  console.log(`  ${validAdapters.length} Adapter bereit:\n`);

  const portConfigs: Array<{ path: string; alias: string; baud_rate: number }> = [];
  for (let i = 0; i < validAdapters.length; i++) {
    const a = validAdapters[i];
    const alias = `usb${i}`;
    console.log(`  ${alias}: ${a.chip} @${a.baudRate} baud`);
    console.log(`         ${a.path}`);
    portConfigs.push({ path: a.path, alias, baud_rate: a.baudRate });
  }

  // Step 4: Ask to update config
  const targetPath = configPath || '/opt/mbus2mqtt/config/config.yaml';
  console.log(`\n  ${'─'.repeat(50)}`);
  const answer = await ask(rl, `  Config aktualisieren? (${targetPath}) [j/N] `);

  if (answer.toLowerCase() !== 'j' && answer.toLowerCase() !== 'y') {
    console.log('\n  Abgebrochen. Port-Konfiguration zum manuellen Einfügen:\n');
    console.log('  ports:');
    for (const p of portConfigs) {
      console.log(`    - path: "${p.path}"`);
      console.log(`      alias: "${p.alias}"`);
      console.log(`      baud_rate: ${p.baud_rate}`);
    }
    console.log('');
    rl.close();
    return;
  }

  // Step 5: Update config file
  if (fs.existsSync(targetPath)) {
    const raw = fs.readFileSync(targetPath, 'utf-8');
    const cfg = yaml.load(raw) as Record<string, unknown>;
    cfg.ports = portConfigs;
    const updated = yaml.dump(cfg, { lineWidth: 120, noRefs: true });
    fs.writeFileSync(targetPath, updated, 'utf-8');
    console.log(`\n  ✅ Ports in ${targetPath} aktualisiert.`);
    console.log('  ⚠️  Prüfe ob die Device-Zuordnung (port: usbX) noch stimmt!');
    console.log('  Neustart: rc-service mbus2mqtt restart\n');
  } else {
    console.log(`\n  ❌ Config-Datei nicht gefunden: ${targetPath}`);
    console.log('  Port-Konfiguration zum manuellen Einfügen:\n');
    console.log('  ports:');
    for (const p of portConfigs) {
      console.log(`    - path: "${p.path}"`);
      console.log(`      alias: "${p.alias}"`);
      console.log(`      baud_rate: ${p.baud_rate}`);
    }
    console.log('');
  }

  rl.close();
}
