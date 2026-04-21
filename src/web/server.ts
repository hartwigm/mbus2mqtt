import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { Config } from '../types';
import { PortManager } from '../mbus/port-manager';
import { ReadingsStore } from '../store/readings-store';
import { Scheduler } from '../scheduler/scheduler';
import { scanAllPorts, ScanResult } from '../mbus/scanner';
import { getLogger } from '../util/logger';
import { INDEX_HTML, loginHtml } from './ui';
import { AuthManager } from './auth';

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
  private auth: AuthManager;
  private job: ScanJob = { status: 'idle', started_at: '', entries: [] };

  constructor(config: Config, portManager: PortManager, store: ReadingsStore, scheduler: Scheduler) {
    this.config = config;
    this.portManager = portManager;
    this.store = store;
    this.scheduler = scheduler;
    this.auth = new AuthManager(config.web.password, config.web.auth_log);
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
    const rawUrl = req.url || '/';
    const method = req.method || 'GET';
    const ip = this.auth.getClientIp(req);
    const parsed = new URL(rawUrl, 'http://localhost');
    const pathname = parsed.pathname;

    // Shortcut: ?pw=<password> in the URL. On match, issue a session cookie
    // and 303 to /, so the password isn't kept in history past the first hit
    // and /login?pw=... doesn't just reshow the login form. Also runs when
    // the caller already has a session so an explicit ?pw= can refresh it.
    if (method === 'GET' && parsed.searchParams.has('pw')) {
      const pw = parsed.searchParams.get('pw') || '';
      if (this.auth.verifyPassword(pw)) {
        const { cookie } = this.auth.createSession(ip);
        this.auth.logAttempt(ip, 'LOGIN_SUCCESS', 'via URL');
        res.writeHead(303, { 'set-cookie': cookie, location: '/' });
        res.end();
        return;
      }
      this.auth.logAttempt(ip, 'LOGIN_FAILURE', 'via URL');
      // fall through — user will see /login redirect or 401
    }

    // Login endpoints — no auth required
    if (method === 'GET' && pathname === '/login') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(loginHtml());
      return;
    }

    if (method === 'POST' && pathname === '/login') {
      await this.handleLogin(req, res, ip);
      return;
    }

    if (method === 'POST' && pathname === '/logout') {
      const { cookie, sid } = this.auth.destroySession(req);
      if (sid) this.auth.logAttempt(ip, 'LOGOUT');
      res.writeHead(200, { 'set-cookie': cookie, 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // All other routes require auth
    if (!this.auth.isAuthenticated(req)) {
      if (pathname.startsWith('/api/')) {
        this.json(res, 401, { error: 'not authenticated' });
      } else {
        res.writeHead(302, { location: '/login' });
        res.end();
      }
      return;
    }

    if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(INDEX_HTML);
      return;
    }

    if (method === 'GET' && pathname === '/api/devices') {
      this.json(res, 200, this.devicesPayload());
      return;
    }

    if (method === 'POST' && pathname === '/api/scan') {
      if (this.job.status === 'running') {
        this.json(res, 409, { error: 'Scan läuft bereits' });
        return;
      }
      this.startScanJob();
      this.json(res, 202, { status: 'running', started_at: this.job.started_at });
      return;
    }

    if (method === 'GET' && pathname === '/api/scan') {
      this.json(res, 200, this.job);
      return;
    }

    if (method === 'POST' && pathname === '/api/restart') {
      this.auth.logAttempt(ip, 'LOGOUT', 'RESTART requested');
      this.json(res, 202, { status: 'restarting' });
      // Give the response a tick to flush before the process dies
      setTimeout(() => this.triggerRestart(), 200);
      return;
    }

    if (method === 'POST' && pathname === '/api/update') {
      this.auth.logAttempt(ip, 'LOGOUT', 'UPDATE requested');
      this.json(res, 202, { status: 'updating' });
      setTimeout(() => this.triggerUpdate(), 200);
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  }

  private triggerRestart(): void {
    const log = getLogger();
    log.info('Web UI: restart requested');
    // Detached so we survive our own SIGTERM long enough to exec systemctl;
    // systemd/openrc will restart us right after.
    const child = fs.existsSync('/run/systemd/system')
      ? spawn('systemctl', ['restart', 'mbus2mqtt'], { detached: true, stdio: 'ignore' })
      : spawn('rc-service', ['mbus2mqtt', 'restart'], { detached: true, stdio: 'ignore' });
    child.unref();
  }

  private triggerUpdate(): void {
    const log = getLogger();
    const script = path.resolve(__dirname, '..', '..', 'deploy', 'update.sh');
    if (!fs.existsSync(script)) {
      log.error(`update.sh not found at ${script}`);
      return;
    }
    log.info(`Web UI: update requested — running ${script}`);
    // Detach fully: update.sh stops our service, rebuilds, and starts it again.
    // We must not be a child of this process once systemctl stop fires.
    const child = spawn('sh', [script], {
      detached: true,
      stdio: 'ignore',
      cwd: path.dirname(script),
    });
    child.unref();
  }

  private async handleLogin(req: http.IncomingMessage, res: http.ServerResponse, ip: string): Promise<void> {
    const body = await readBody(req, 4096);
    const params = new URLSearchParams(body);
    const pw = params.get('password') || '';

    if (!this.auth.verifyPassword(pw)) {
      this.auth.logAttempt(ip, 'LOGIN_FAILURE');
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
      res.end(loginHtml('Falsches Passwort'));
      return;
    }

    const { cookie } = this.auth.createSession(ip);
    this.auth.logAttempt(ip, 'LOGIN_SUCCESS');
    res.writeHead(303, { 'set-cookie': cookie, location: '/' });
    res.end();
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

function readBody(req: http.IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', chunk => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
