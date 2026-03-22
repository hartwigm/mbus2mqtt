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

/**
 * Installs a single stderr interceptor that:
 * - Detects mbus_serial_recv_frame messages (bus activity)
 * - Suppresses all native mbus stderr output
 * - Calls onActivity() when first activity is detected
 *
 * Returns a cleanup function that MUST be called to restore stderr.
 */
function installStderrMonitor(onActivity: () => void): { cleanup: () => void } {
  const origWrite = process.stderr.write.bind(process.stderr);
  let activityDetected = false;

  process.stderr.write = ((chunk: any, ...args: any[]): boolean => {
    const str = typeof chunk === 'string' ? chunk : chunk.toString();
    if (str.includes('mbus_serial') || str.includes('mbus_frame')) {
      if (!activityDetected) {
        activityDetected = true;
        onActivity();
      }
      return true; // suppress all native mbus output
    }
    return origWrite(chunk, ...args);
  }) as any;

  return {
    cleanup: () => { process.stderr.write = origWrite; },
  };
}

export async function scanPortExtended(portConfig: PortConfig): Promise<ExtendedScanResult> {
  const result: ExtendedScanResult = {
    port: portConfig.alias,
    port_path: portConfig.path,
    devices: [],
    errors: [],
  };

  const seen = new Set<string>();

  for (const baudRate of MBUS_BAUD_RATES) {
    const conn = new MbusConnection(portConfig.path, baudRate, portConfig.alias);
    const startTime = Date.now();
    let busActivity = false;
    let currentTimeout = INITIAL_TIMEOUT_MS;

    // Install stderr monitor for this baud rate scan
    const monitor = installStderrMonitor(() => {
      busActivity = true;
      currentTimeout = EXTENDED_TIMEOUT_MS;
      process.stdout.write(`\n  📡 ${portConfig.alias} @${baudRate}: Bus-Aktivität erkannt — Timeout auf ${EXTENDED_TIMEOUT_MS / 1000}s verlängert\n`);
    });

    const progressInterval = setInterval(() => {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const timeoutLabel = busActivity ? `${EXTENDED_TIMEOUT_MS / 1000}s` : `${INITIAL_TIMEOUT_MS / 1000}s`;
      process.stdout.write(`\r  ⏳ ${portConfig.alias} @${baudRate}: Scan läuft... ${elapsed}s (max ${timeoutLabel})   `);
    }, 3000);

    try {
      console.log(`\n  🔌 ${portConfig.alias}: Teste ${baudRate} baud...`);
      await conn.connect();
      console.log(`  ⏳ ${portConfig.alias} @${baudRate}: Scan (${INITIAL_TIMEOUT_MS / 1000}s, verlängert auf ${EXTENDED_TIMEOUT_MS / 1000}s bei Aktivität)...`);

      // Use a scan loop that checks bus activity for dynamic timeout
      const devices = await new Promise<string[]>((resolve, reject) => {
        const checkTimeout = () => {
          const elapsed = Date.now() - startTime;
          if (elapsed >= currentTimeout) {
            reject(new Error(`Scan timeout on ${portConfig.alias} @${baudRate}`));
          }
        };
        const timeoutChecker = setInterval(checkTimeout, 1000);

        conn.scanSecondary(EXTENDED_TIMEOUT_MS + 10000).then(ids => {
          clearInterval(timeoutChecker);
          resolve(ids);
        }).catch(err => {
          clearInterval(timeoutChecker);
          reject(err);
        });
      });

      clearInterval(progressInterval);
      const elapsed = Math.round((Date.now() - startTime) / 1000);

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
      process.stdout.write(`\r  ⚠️  ${portConfig.alias} @${baudRate}: Timeout nach ${elapsed}s — weiter\n`);
      result.errors.push({ baud_rate: baudRate, error: err instanceof Error ? err.message : String(err) });
    }

    // Force close, wait for settle, THEN restore stderr
    await conn.forceClose();
    await new Promise(r => setTimeout(r, SETTLE_DELAY_MS));
    monitor.cleanup();
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
