import { MbusConnection } from './connection';
import { readDevice } from './reader';
import { Config, DeviceConfig, MeterReading } from '../types';
import { getLogger } from '../util/logger';

export class PortManager {
  private connections = new Map<string, MbusConnection>();
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  async connectAll(): Promise<void> {
    const log = getLogger();
    for (const port of this.config.ports) {
      const conn = new MbusConnection(port.path, port.baud_rate, port.alias);
      try {
        await conn.connect();
        this.connections.set(port.alias, conn);
      } catch (err) {
        log.error(`Failed to connect ${port.alias}: ${err}`);
      }
    }
  }

  async disconnectAll(): Promise<void> {
    for (const conn of this.connections.values()) {
      await conn.disconnect();
    }
    this.connections.clear();
  }

  async readAllDevices(): Promise<MeterReading[]> {
    const log = getLogger();

    // Group devices by port
    const byPort = new Map<string, DeviceConfig[]>();
    for (const dev of this.config.devices) {
      const list = byPort.get(dev.port) || [];
      list.push(dev);
      byPort.set(dev.port, list);
    }

    // Read ports in parallel, devices per port sequentially
    const portReads = Array.from(byPort.entries()).map(async ([portAlias, devices]) => {
      const conn = this.connections.get(portAlias);
      if (!conn) {
        log.error(`No connection for port ${portAlias}`);
        return [];
      }

      const readings: MeterReading[] = [];
      for (const dev of devices) {
        try {
          const reading = await readDevice(conn, dev);
          readings.push(reading);
        } catch (err) {
          log.error(`Error reading ${dev.name} (${dev.secondary_address}): ${err}`);
        }
      }
      return readings;
    });

    const results = await Promise.all(portReads);
    return results.flat();
  }

  async readSingleDevice(secondaryAddress: string): Promise<MeterReading | null> {
    const device = this.config.devices.find(d => d.secondary_address === secondaryAddress);
    if (!device) return null;

    const conn = this.connections.get(device.port);
    if (!conn) return null;

    return readDevice(conn, device);
  }

  isConnected(portAlias: string): boolean {
    return this.connections.has(portAlias);
  }
}
