import { MbusConnection } from './connection';
import { PortConfig } from '../types';
import { getLogger } from '../util/logger';

export interface ScanResult {
  port: string;
  baud_rate: number;
  devices: string[];
}

export async function scanPort(portConfig: PortConfig): Promise<ScanResult> {
  const log = getLogger();
  const conn = new MbusConnection(portConfig.path, portConfig.baud_rate, portConfig.alias);

  try {
    await conn.connect();
    log.info(`Scanning ${portConfig.alias} (${portConfig.path} @${portConfig.baud_rate})...`);
    const devices = await conn.scanSecondary();
    return { port: portConfig.alias, baud_rate: portConfig.baud_rate, devices };
  } finally {
    await conn.disconnect();
  }
}

export async function scanAllPorts(ports: PortConfig[]): Promise<ScanResult[]> {
  // Scan ports in parallel since they are independent buses
  return Promise.all(ports.map(p => scanPort(p)));
}
