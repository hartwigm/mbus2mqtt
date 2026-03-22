import { MbusConnection } from './connection';
import { PortConfig } from '../types';
import { getLogger } from '../util/logger';

export interface ScanResult {
  port: string;
  baud_rate: number;
  devices: string[];
  error?: string;
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
