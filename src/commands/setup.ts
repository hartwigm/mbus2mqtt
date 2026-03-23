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

function detectServiceManager(): 'systemd' | 'openrc' {
  if (fs.existsSync('/run/systemd/system')) return 'systemd';
  return 'openrc';
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

  // Step 4: Ask for property name
  const targetPath = configPath || '/etc/mbus2mqtt/config.yaml';
  console.log(`\n  ${'─'.repeat(50)}`);

  // Read existing config for defaults
  let existingProperty = '';
  let existingMqtt: Record<string, unknown> = {};
  if (fs.existsSync(targetPath)) {
    try {
      const raw = fs.readFileSync(targetPath, 'utf-8');
      const cfg = yaml.load(raw) as Record<string, unknown>;
      existingProperty = (cfg.property as string) || '';
      existingMqtt = (cfg.mqtt as Record<string, unknown>) || {};
    } catch { /* ignore */ }
  }

  const propertyDefault = existingProperty || 'M47';
  const property = (await ask(rl, `  Property-Name [${propertyDefault}]: `)).trim() || propertyDefault;

  // Step 5: Ask for MQTT config
  const mqttBrokerDefault = (existingMqtt.broker as string) || 'mqtt://localhost:1883';
  const mqttBroker = (await ask(rl, `  MQTT Broker [${mqttBrokerDefault}]: `)).trim() || mqttBrokerDefault;

  const mqttUserDefault = (existingMqtt.username as string) || 'mbus2mqtt';
  const mqttUser = (await ask(rl, `  MQTT User [${mqttUserDefault}]: `)).trim() || mqttUserDefault;

  const mqttPassDefault = (existingMqtt.password as string) || 'changeme';
  const mqttPass = (await ask(rl, `  MQTT Passwort [${mqttPassDefault}]: `)).trim() || mqttPassDefault;

  // Step 6: Write fresh config
  const answer = await ask(rl, `\n  Config schreiben? (${targetPath}) [j/N] `);

  if (answer.toLowerCase() !== 'j' && answer.toLowerCase() !== 'y') {
    console.log('\n  Abgebrochen.\n');
    rl.close();
    return;
  }

  const newConfig = {
    property,
    mqtt: {
      broker: mqttBroker,
      username: mqttUser,
      password: mqttPass,
      client_id: `mbus2mqtt-${property}`,
    },
    read_interval_minutes: 15,
    ports: portConfigs,
    devices: [] as unknown[],
    logging: {
      level: 'info',
      file: '/var/log/mbus2mqtt.log',
    },
    state_file: '/var/lib/mbus2mqtt/state.json',
  };

  // Ensure config directory exists
  const configDir = path.dirname(targetPath);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  const configYaml = yaml.dump(newConfig, { lineWidth: 120, noRefs: true });
  fs.writeFileSync(targetPath, configYaml, 'utf-8');

  const svcMgr = detectServiceManager();
  const restartCmd = svcMgr === 'systemd'
    ? 'sudo systemctl restart mbus2mqtt'
    : 'rc-service mbus2mqtt restart';

  console.log(`\n  ✅ Config geschrieben: ${targetPath}`);
  console.log(`\n  Nächste Schritte:`);
  console.log(`  1. m2q scan              Geräte auf dem Bus finden`);
  console.log(`  2. Config bearbeiten     Gefundene Geräte eintragen`);
  console.log(`  3. ${restartCmd}`);
  console.log('');

  rl.close();
}
