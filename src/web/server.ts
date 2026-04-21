import * as http from 'http';
import { Config } from '../types';
import { PortManager } from '../mbus/port-manager';
import { ReadingsStore } from '../store/readings-store';
import { Scheduler } from '../scheduler/scheduler';
import { scanAllPorts, ScanResult } from '../mbus/scanner';
import { getLogger } from '../util/logger';
import { INDEX_HTML } from './ui';

type ScanState = 'idle' | 'running' | 'done' | 'error';

interface ScanEntry {
  secondary_address: string;
  state: 'found' | 'missing' | 'new';
  port?: string;
  name?: string;
}

interface ScanJob {
  status: ScanState;
  started_at: string;
  finished_at?: string;
  entries: ScanEntry[];
  error?: string;
}

export class WebServer {
  private server: http.Server | null = null;
  private config: Config;
  private portManager: PortManager;
  private store: ReadingsStore;
  private scheduler: Scheduler;
  private job: ScanJob = { status: 'idle', started_at: '', entries: [] };

  constructor(config: Config, portManager: PortManager, store: ReadingsStore, scheduler: Scheduler) {
    this.config = config;
    this.portManager = portManager;
    this.store = store;
    this.scheduler = scheduler;
  }

  async start(): Promise<void> {
    const log = getLogger();
    const { port, bind } = this.config.web;

    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch(err => {
        log.error(`Web handler error: ${err}`);
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
    });

    return new Promise((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(port, bind, () => {
        log.info(`Web UI on http://${bind}:${port}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    return new Promise(resolve => this.server!.close(() => resolve()));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = req.url || '/';
    const method = req.method || 'GET';

    if (method === 'GET' && (url === '/' || url === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(INDEX_HTML);
      return;
    }

    if (method === 'GET' && url === '/api/devices') {
      this.json(res, 200, this.devicesPayload());
      return;
    }

    if (method === 'POST' && url === '/api/scan') {
      if (this.job.status === 'running') {
        this.json(res, 409, { error: 'Scan läuft bereits' });
        return;
      }
      this.startScanJob();
      this.json(res, 202, { status: 'running', started_at: this.job.started_at });
      return;
    }

    if (method === 'GET' && url === '/api/scan') {
      this.json(res, 200, this.job);
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  }

  private json(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  }

  private devicesPayload() {
    const devices = this.config.devices.map(d => {
      const s = this.store.get(d.secondary_address);
      return {
        secondary_address: d.secondary_address,
        name: d.name,
        medium: d.medium,
        port: d.port,
        last_value: s.last_value,
        last_unit: s.last_unit,
        last_read: s.last_read,
        errors: s.read_errors,
      };
    });
    return { property: this.config.property, devices };
  }

  private startScanJob(): void {
    const log = getLogger();
    this.job = { status: 'running', started_at: new Date().toISOString(), entries: [] };

    (async () => {
      // Pause scheduler + release serial ports so the scanner can own them
      this.scheduler.stop();
      await this.portManager.disconnectAll();

      let results: ScanResult[];
      try {
        results = await scanAllPorts(this.config.ports);
      } catch (err) {
        log.error(`Scan error: ${err}`);
        this.job.status = 'error';
        this.job.error = String(err);
        this.job.finished_at = new Date().toISOString();
        await this.resume();
        return;
      }

      this.job.entries = this.buildEntries(results);
      this.job.status = 'done';
      this.job.finished_at = new Date().toISOString();

      await this.resume();
    })().catch(err => {
      log.error(`Scan job fatal: ${err}`);
      this.job.status = 'error';
      this.job.error = String(err);
      this.job.finished_at = new Date().toISOString();
    });
  }

  private async resume(): Promise<void> {
    const log = getLogger();
    try {
      await this.portManager.connectAll();
    } catch (err) {
      log.error(`Reconnect after scan failed: ${err}`);
    }
    this.scheduler.start();
  }

  private buildEntries(results: ScanResult[]): ScanEntry[] {
    const foundByAddr = new Map<string, string>(); // addr → port alias
    for (const r of results) {
      for (const id of r.devices) foundByAddr.set(id, r.port);
    }

    const entries: ScanEntry[] = [];
    const configuredAddrs = new Set<string>();

    for (const dev of this.config.devices) {
      configuredAddrs.add(dev.secondary_address);
      const foundPort = foundByAddr.get(dev.secondary_address);
      entries.push({
        secondary_address: dev.secondary_address,
        name: dev.name,
        port: foundPort || dev.port,
        state: foundPort ? 'found' : 'missing',
      });
    }

    for (const [addr, port] of foundByAddr) {
      if (configuredAddrs.has(addr)) continue;
      entries.push({ secondary_address: addr, port, state: 'new' });
    }

    return entries;
  }
}
