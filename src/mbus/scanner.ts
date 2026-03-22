import { MbusConnection } from './connection';
import { PortConfig } from '../types';
import { getLogger } from '../util/logger';

export const MBUS_BAUD_RATES = [300, 600, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

export interface ScanResult {
  port: string;
  baud_rate: number;
  devices: string[];
  error?: string;
}

export interface ExtendedScanDevice {
  secondary_address: string;
  baud_rate: number;
}

export interface ExtendedScanResult {
  port: string;
  port_path: string;
  devices: ExtendedScanDevice[];
  errors: Array<{ baud_rate: number; error: string }>;
}

export async function scanPort(portConfig: PortConfig): Promise<ScanResult> {
  const log = getLogger();
  const conn = new MbusConnection(portConfig.path, portConfig.baud_rate, portConfig.alias);
  const startTime = Date.now();

  // Progress indicator while scan runs
  const progressInterval = setInterval(() => {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    process.stdout.write(`\r  ⏳ ${portConfig.alias}: Scan läuft... ${elapsed}s`);
  }, 3000);

  try {
    await conn.connect();
    console.log(`  🔌 ${portConfig.alias}: Verbunden (${portConfig.path} @${portConfig.baud_rate})`);
    console.log(`  ⏳ ${portConfig.alias}: Scan gestartet (kann bis zu 10 Min. dauern)...`);
    const devices = await conn.scanSecondary();
    clearInterval(progressInterval);
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    process.stdout.write(`\r  ✅ ${portConfig.alias}: Scan abgeschlossen nach ${elapsed}s — ${devices.length} Gerät(e) gefunden\n`);
    return { port: portConfig.alias, baud_rate: portConfig.baud_rate, devices };
  } catch (err) {
    clearInterval(progressInterval);
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(`\r  ❌ ${portConfig.alias}: Fehler nach ${elapsed}s — ${message}\n`);
    return { port: portConfig.alias, baud_rate: portConfig.baud_rate, devices: [], error: message };
  } finally {
    await conn.disconnect();
  }
}

export async function scanAllPorts(ports: PortConfig[]): Promise<ScanResult[]> {
  // Scan ports in parallel since they are independent buses
  return Promise.all(ports.map(p => scanPort(p)));
}

const INITIAL_TIMEOUT_MS = 120000;   // 2 min — no activity = skip
const EXTENDED_TIMEOUT_MS = 600000;  // 10 min — bus activity detected, full scan
const SETTLE_DELAY_MS = 3000;        // delay between baud rate switches

export async function scanPortExtended(portConfig: PortConfig): Promise<ExtendedScanResult> {
  const result: ExtendedScanResult = {
    port: portConfig.alias,
    port_path: portConfig.path,
    devices: [],
    errors: [],
  };

  const seen = new Set<string>();
  // Global stderr suppressor for mbus native output between scans
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  let suppressStderr = false;
  const stderrGuard = (chunk: any, ...args: any[]): boolean => {
    const str = typeof chunk === 'string' ? chunk : chunk.toString();
    if (suppressStderr && (str.includes('mbus_serial') || str.includes('mbus_frame'))) {
      return true; // suppress
    }
    return origStderrWrite(chunk, ...args);
  };
  process.stderr.write = stderrGuard as any;

  try {
    for (const baudRate of MBUS_BAUD_RATES) {
      const conn = new MbusConnection(portConfig.path, baudRate, portConfig.alias);
      const startTime = Date.now();
      let restoreStderr: (() => void) | null = null;

      const progressInterval = setInterval(() => {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        process.stdout.write(`\r  ⏳ ${portConfig.alias} @${baudRate}: Scan läuft... ${elapsed}s   `);
      }, 3000);

      try {
        console.log(`\n  🔌 ${portConfig.alias}: Teste ${baudRate} baud...`);
        await conn.connect();
        console.log(`  ⏳ ${portConfig.alias} @${baudRate}: Scan (${INITIAL_TIMEOUT_MS / 1000}s, +${EXTENDED_TIMEOUT_MS / 1000}s bei Aktivität)...`);
        const scanResult = await conn.scanSecondaryDynamic(INITIAL_TIMEOUT_MS, EXTENDED_TIMEOUT_MS);
        restoreStderr = scanResult.restoreStderr;
        clearInterval(progressInterval);
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        const devices = scanResult.devices;

        const newDevices = devices.filter(id => !seen.has(id));
        for (const id of devices) seen.add(id);

        if (devices.length > 0) {
          process.stdout.write(`\r  ✅ ${portConfig.alias} @${baudRate}: ${devices.length} Gerät(e) gefunden nach ${elapsed}s`);
          if (newDevices.length < devices.length) {
            process.stdout.write(` (${newDevices.length} neu)`);
          }
          process.stdout.write('\n');
          for (const id of devices) {
            const isNew = newDevices.includes(id);
            console.log(`     ${isNew ? '🆕' : '  '} ${id}`);
            if (isNew) {
              result.devices.push({ secondary_address: id, baud_rate: baudRate });
            }
          }
        } else {
          process.stdout.write(`\r  ⚪ ${portConfig.alias} @${baudRate}: Keine Geräte (${elapsed}s)\n`);
        }
      } catch (err) {
        clearInterval(progressInterval);
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        const message = err instanceof Error ? err.message : String(err);
        process.stdout.write(`\r  ⚠️  ${portConfig.alias} @${baudRate}: Timeout nach ${elapsed}s — weiter\n`);
        result.errors.push({ baud_rate: baudRate, error: message });
      }

      // Suppress stderr during close + settle to catch leftover native output
      suppressStderr = true;
      await conn.forceClose();
      await new Promise(r => setTimeout(r, SETTLE_DELAY_MS));
      if (restoreStderr) restoreStderr();
      suppressStderr = false;
    }
  } finally {
    // Always restore original stderr
    process.stderr.write = origStderrWrite;
  }

  return result;
}

export async function scanAllPortsExtended(ports: PortConfig[]): Promise<ExtendedScanResult[]> {
  // Sequential: each port needs exclusive access to the serial device
  const results: ExtendedScanResult[] = [];
  for (const port of ports) {
    results.push(await scanPortExtended(port));
  }
  return results;
}
