import { getLogger } from '../util/logger';

// node-mbus has no types, declare what we need
interface MbusMasterOptions {
  serialPort: string;
  serialBaudRate: number;
  autoConnect: boolean;
}

interface MbusSlaveInfo {
  Id: number;
  Manufacturer: string;
  Medium: string;
  Version: number;
  AccessNumber: number;
  Status: number;
}

export interface MbusDataRecord {
  id: number;
  Function: string;
  StorageNumber: number;
  Unit: string;
  Value: number | string;
  Timestamp: string;
}

export interface MbusData {
  SlaveInformation: MbusSlaveInfo;
  DataRecord: MbusDataRecord[];
}

interface MbusMasterInstance {
  connect(cb?: (err: Error | null) => void): boolean;
  close(cb?: (err: Error | null) => void, wait?: boolean): boolean | undefined;
  getData(address: string | number, cb: (err: Error | null, data: MbusData) => void): void;
  scanSecondary(cb: (err: Error | null, ids: string[]) => void): void;
}

interface MbusMasterConstructor {
  new (options: MbusMasterOptions): MbusMasterInstance;
}

let MbusMaster: MbusMasterConstructor;
try {
  MbusMaster = require('node-mbus');
} catch {
  // Will fail at runtime if not installed
}

export class MbusConnection {
  private master: MbusMasterInstance | null = null;
  private readonly serialPort: string;
  private readonly baudRate: number;
  private readonly alias: string;

  constructor(serialPort: string, baudRate: number, alias: string) {
    this.serialPort = serialPort;
    this.baudRate = baudRate;
    this.alias = alias;
  }

  async connect(): Promise<void> {
    const log = getLogger();

    if (!MbusMaster) {
      throw new Error('node-mbus not installed. Run: npm install node-mbus');
    }

    this.master = new MbusMaster({
      serialPort: this.serialPort,
      serialBaudRate: this.baudRate,
      autoConnect: true,
    });

    const connected = this.master.connect();
    if (!connected) {
      throw new Error(`Failed to connect to ${this.alias} (${this.serialPort} @${this.baudRate})`);
    }

    // node-mbus needs a short delay after connect
    await new Promise(r => setTimeout(r, 1000));
    log.info(`Connected to ${this.alias} (${this.serialPort} @${this.baudRate})`);
  }

  async disconnect(): Promise<void> {
    if (!this.master) return;
    return new Promise((resolve) => {
      this.master!.close(() => {
        this.master = null;
        resolve();
      }, true);
    });
  }

  async getData(address: string): Promise<MbusData> {
    if (!this.master) throw new Error(`Not connected to ${this.alias}`);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timeout reading ${address} on ${this.alias}`));
      }, 30000);

      this.master!.getData(address, (err, data) => {
        clearTimeout(timeout);
        if (err) reject(err);
        else resolve(data);
      });
    });
  }

  async scanSecondary(timeoutMs: number = 600000): Promise<string[]> {
    if (!this.master) throw new Error(`Not connected to ${this.alias}`);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Scan timeout on ${this.alias} @${this.baudRate}`));
      }, timeoutMs);

      this.master!.scanSecondary((err, ids) => {
        clearTimeout(timeout);
        if (err) reject(err);
        else resolve(ids);
      });
    });
  }

  /**
   * Scan with dynamic timeout: starts with initialTimeoutMs.
   * If stderr activity (e.g. mbus_serial_recv_frame) is detected,
   * the timeout extends to extendedTimeoutMs since bus activity means
   * devices are present and the scan needs more time.
   *
   * Returns { devices, busActivity, restoreStderr } — caller MUST call
   * restoreStderr() after forceClose + settle delay to suppress leftover
   * native library output.
   */
  async scanSecondaryDynamic(initialTimeoutMs: number, extendedTimeoutMs: number): Promise<{ devices: string[]; busActivity: boolean; restoreStderr: () => void }> {
    if (!this.master) throw new Error(`Not connected to ${this.alias}`);

    return new Promise((resolve, reject) => {
      let busActivity = false;
      let timer: NodeJS.Timeout;
      let settled = false;

      // Intercept stderr to detect native libmbus output
      const origStderrWrite = process.stderr.write.bind(process.stderr);
      const restoreStderr = () => {
        if (!settled) {
          settled = true;
          process.stderr.write = origStderrWrite;
        }
      };

      const stderrHook = (chunk: any, ...args: any[]): boolean => {
        const str = typeof chunk === 'string' ? chunk : chunk.toString();
        if (str.includes('mbus_serial_recv_frame') || str.includes('mbus_serial')) {
          if (!busActivity) {
            busActivity = true;
            // Extend timeout — activity detected on bus
            clearTimeout(timer);
            timer = setTimeout(() => {
              reject(new Error(`Scan timeout on ${this.alias} @${this.baudRate} (extended, bus activity detected)`));
            }, extendedTimeoutMs);
            process.stdout.write(`\n  📡 ${this.alias} @${this.baudRate}: Bus-Aktivität erkannt — Timeout auf ${extendedTimeoutMs / 1000}s verlängert\n`);
          }
          // Suppress native mbus output
          return true;
        }
        return origStderrWrite(chunk, ...args);
      };

      process.stderr.write = stderrHook as any;

      timer = setTimeout(() => {
        // Don't restore stderr here — caller does it after settle delay
        reject(new Error(`Scan timeout on ${this.alias} @${this.baudRate}`));
      }, initialTimeoutMs);

      this.master!.scanSecondary((err, ids) => {
        clearTimeout(timer);
        if (err) reject(err);
        else resolve({ devices: ids, busActivity, restoreStderr });
      });
    });
  }

  async forceClose(): Promise<void> {
    if (!this.master) return;
    try {
      this.master.close(() => {}, true);
    } catch {
      // ignore errors during force close
    }
    this.master = null;
  }

  getAlias(): string { return this.alias; }
  getPort(): string { return this.serialPort; }
  getBaudRate(): number { return this.baudRate; }
}
