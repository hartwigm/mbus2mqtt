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

  private getPortConfig(alias: string) {
    return this.config.ports.find(p => p.alias === alias);
  }

  private async ensureBaudRate(portAlias: string, requiredBaud: number): Promise<MbusConnection | null> {
    const log = getLogger();
    const conn = this.connections.get(portAlias);
    if (!conn) return null;

    if (conn.getBaudRate() === requiredBaud) return conn;

    // Need to reconnect at different baud rate
    const portConfig = this.getPortConfig(portAlias);
    if (!portConfig) return null;

    log.info(`${portAlias}: Baudrate wechseln ${conn.getBaudRate()} → ${requiredBaud}`);
    await conn.disconnect();

    const newConn = new MbusConnection(portConfig.path, requiredBaud, portAlias);
    try {
      await newConn.connect();
      this.connections.set(portAlias, newConn);
      return newConn;
    } catch (err) {
      log.error(`Failed to reconnect ${portAlias} @${requiredBaud}: ${err}`);
      // Try to restore original connection
      const restoreConn = new MbusConnection(portConfig.path, portConfig.baud_rate, portAlias);
      try {
        await restoreConn.connect();
        this.connections.set(portAlias, restoreConn);
      } catch {
        this.connections.delete(portAlias);
      }
      return null;
    }
  }

  async readDevices(devices?: DeviceConfig[]): Promise<MeterReading[]> {
    const log = getLogger();
    const toRead = devices || this.config.devices;

    // Group devices by port and baud rate
    const byPortAndBaud = new Map<string, DeviceConfig[]>();
    for (const dev of toRead) {
      const portConfig = this.getPortConfig(dev.port);
      const baud = dev.baud_rate || portConfig?.baud_rate || 2400;
      const key = `${dev.port}:${baud}`;
      const list = byPortAndBaud.get(key) || [];
      list.push(dev);
      byPortAndBaud.set(key, list);
    }

    // Group keys by port for parallel port access
    const portGroups = new Map<string, string[]>();
    for (const key of byPortAndBaud.keys()) {
      const portAlias = key.split(':')[0];
      const keys = portGroups.get(portAlias) || [];
      keys.push(key);
      portGroups.set(portAlias, keys);
    }

    // Read ports in parallel, baud groups and devices per port sequentially
    const portReads = Array.from(portGroups.entries()).map(async ([portAlias, keys]) => {
      const readings: MeterReading[] = [];

      // Sort keys so default baud rate comes first (less reconnecting)
      const portConfig = this.getPortConfig(portAlias);
      const defaultBaud = portConfig?.baud_rate || 0;
      keys.sort((a, b) => {
        const baudA = parseInt(a.split(':')[1]);
        const baudB = parseInt(b.split(':')[1]);
        if (baudA === defaultBaud) return -1;
        if (baudB === defaultBaud) return 1;
        return baudA - baudB;
      });

      for (const key of keys) {
        const baud = parseInt(key.split(':')[1]);
        const devices = byPortAndBaud.get(key)!;

        const conn = await this.ensureBaudRate(portAlias, baud);
        if (!conn) {
          log.error(`No connection for port ${portAlias} @${baud}`);
          continue;
        }

        for (const dev of devices) {
          try {
            const reading = await readDevice(conn, dev);
            readings.push(reading);
          } catch (err) {
            log.error(`Error reading ${dev.name} (${dev.secondary_address}): ${err}`);
          }
        }
      }

      // Restore default baud rate
      if (portConfig) {
        await this.ensureBaudRate(portAlias, portConfig.baud_rate);
      }

      return readings;
    });

    const results = await Promise.all(portReads);
    return results.flat();
  }

  async readSingleDevice(secondaryAddress: string): Promise<MeterReading | null> {
    const log = getLogger();
    const device = this.config.devices.find(d => d.secondary_address === secondaryAddress);
    if (!device) return null;

    const portConfig = this.getPortConfig(device.port);
    const requiredBaud = device.baud_rate || portConfig?.baud_rate;

    if (requiredBaud) {
      const conn = await this.ensureBaudRate(device.port, requiredBaud);
      if (!conn) return null;
      const reading = await readDevice(conn, device);
      // Restore default baud rate
      if (portConfig && requiredBaud !== portConfig.baud_rate) {
        await this.ensureBaudRate(device.port, portConfig.baud_rate);
      }
      return reading;
    }

    const conn = this.connections.get(device.port);
    if (!conn) return null;
    return readDevice(conn, device);
  }

  isConnected(portAlias: string): boolean {
    return this.connections.has(portAlias);
  }
}
