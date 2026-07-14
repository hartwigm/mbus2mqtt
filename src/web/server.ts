import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { Config, ImmediateReadResult } from '../types';
import { PortManager } from '../mbus/port-manager';
import { MqttPublisher } from '../mqtt/client';
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

type ReadoutState = 'idle' | 'running' | 'done' | 'error';

interface ReadoutJob {
  status: ReadoutState;
  started_at: string;
  finished_at?: string;
  trigger: 'web' | 'http';
  results: ImmediateReadResult[];
  error?: string;
}

export class WebServer {
  private server: http.Server | null = null;
  private config: Config;
  private portManager: PortManager;
  private store: ReadingsStore;
  private scheduler: Scheduler;
  private mqtt: MqttPublisher;
  private auth: AuthManager;
  private job: ScanJob = { status: 'idle', started_at: '', entries: [] };
  private readout: ReadoutJob = { status: 'idle', started_at: '', trigger: 'web', results: [] };

  constructor(config: Config, portManager: PortManager, store: ReadingsStore, scheduler: Scheduler, mqtt: MqttPublisher) {
    this.config = config;
    this.portManager = portManager;
    this.store = store;
    this.scheduler = scheduler;
    this.mqtt = mqtt;
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

    // Open trigger for external automation (e.g. house.ai). No auth: all
    // mbus2mqtt instances live inside a VPN and are never publicly reachable,
    // and the worst an unexpected call can do is publish fresh meter readings.
    // GET is allowed too so it can be triggered straight from a browser bar.
    if ((method === 'POST' || method === 'GET') && pathname === '/api/trigger/readout') {
      await this.handleTriggerReadout(res, ip);
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

    if (method === 'POST' && pathname === '/api/readout') {
      if (this.readout.status === 'running') {
        this.json(res, 409, { error: 'Lesung läuft bereits' });
        return;
      }
      this.startReadoutJob('web');
      this.auth.logAttempt(ip, 'READOUT', 'via Web-UI');
      this.json(res, 202, { status: 'running', started_at: this.readout.started_at });
      return;
    }

    if (method === 'GET' && pathname === '/api/readout') {
      this.json(res, 200, this.readout);
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
    const logFile = '/tmp/mbus2mqtt-update.log';
    // update.sh stops our service, rebuilds and starts it again — so it MUST
    // outlive our own process. `detached` alone is not enough under systemd:
    // the default KillMode=control-group means `systemctl stop mbus2mqtt`
    // tears down our whole cgroup, and a mere child (even detached) dies with
    // it. Run the script in its own transient unit via systemd-run so it lives
    // in a separate cgroup and survives the stop. Logs go to `journalctl -u
    // mbus2mqtt-update` and are also teed to the log file for OpenRC parity.
    let child: ChildProcess;
    if (fs.existsSync('/run/systemd/system') && this.hasSystemdRun()) {
      log.info(`Web UI: update requested — via systemd-run, log → journalctl -u mbus2mqtt-update`);
      child = spawn(
        'systemd-run',
        ['--unit=mbus2mqtt-update', '--collect', '--quiet',
         'sh', '-c', `exec sh '${script}' > '${logFile}' 2>&1`],
        { detached: true, stdio: 'ignore' },
      );
    } else {
      // OpenRC (Alpine): rc-service stop does not cgroup-kill, so a fully
      // detached child survives. Tee output to the log file for diagnosis.
      log.info(`Web UI: update requested — running ${script}, log → ${logFile}`);
      child = spawn('sh', ['-c', `exec sh '${script}' > '${logFile}' 2>&1`], {
        detached: true,
        stdio: 'ignore',
        cwd: path.dirname(script),
      });
    }
    child.unref();
  }

  private hasSystemdRun(): boolean {
    return ['/usr/bin/systemd-run', '/bin/systemd-run', '/usr/sbin/systemd-run']
      .some(p => fs.existsSync(p));
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
    return {
      property: this.config.property,
      mqtt: { connected: this.mqtt.isConnected(), broker: this.config.mqtt.broker },
      ports: this.portsPayload(),
      devices,
    };
  }

  // Per-USB-port status: is the serial port connected, plus a health signal
  // aggregated from the readings of the devices on that port (recent errors /
  // whether anything has been read at all).
  private portsPayload() {
    return this.config.ports.map(p => {
      const connected = this.portManager.isConnected(p.alias);
      // Live presence check: on Linux an unplugged USB-serial adapter makes its
      // /dev node vanish immediately. Testing the path each poll is a cheap,
      // real-time signal that the physical device is still there — node-mbus
      // won't surface this on its own. Returns null for non-Unix paths (e.g.
      // Windows COMx) where we can't tell.
      const present = this.portPresent(p.path);
      const devices = this.config.devices.filter(d => d.port === p.alias);
      let errorDevices = 0;
      let readDevices = 0;
      let lastRead: string | null = null;
      for (const d of devices) {
        const s = this.store.get(d.secondary_address);
        if (s.read_errors > 0) errorDevices++;
        if (s.last_read) {
          readDevices++;
          if (!lastRead || s.last_read > lastRead) lastRead = s.last_read;
        }
      }

      let health: 'ok' | 'degraded' | 'offline' | 'idle' | 'missing';
      if (present === false) health = 'missing';   // USB node gone → unplugged
      else if (!connected) health = 'offline';
      else if (errorDevices > 0) health = 'degraded';
      else if (readDevices === 0 && devices.length > 0) health = 'idle';
      else health = 'ok';

      return {
        alias: p.alias,
        path: p.path,
        baud_rate: p.baud_rate,
        connected,
        present,
        health,
        device_count: devices.length,
        error_devices: errorDevices,
        last_read: lastRead,
      };
    });
  }

  // fs check for the serial device node. Only meaningful for Unix device paths;
  // returns null (unknown) for anything else so we don't false-flag COM ports.
  private portPresent(portPath: string): boolean | null {
    if (!portPath.startsWith('/')) return null;
    try {
      return fs.existsSync(portPath);
    } catch {
      return null;
    }
  }

  // Synchronous readout for external automation. Responds once the readout
  // completes, with the exact values as JSON, so a caller like house.ai gets
  // the meter readings directly in the response.
  private async handleTriggerReadout(
    res: http.ServerResponse,
    ip: string,
  ): Promise<void> {
    if (this.readout.status === 'running') {
      this.json(res, 409, { error: 'Lesung läuft bereits' });
      return;
    }

    this.auth.logAttempt(ip, 'READOUT', 'via HTTP-Trigger');
    const job = await this.runReadout('http');
    const status = job.status === 'error' ? 500 : 200;
    this.json(res, status, job);
  }

  private startReadoutJob(trigger: 'web' | 'http'): void {
    this.runReadout(trigger).catch(err => {
      getLogger().error(`Readout job fatal: ${err}`);
    });
  }

  // Read all meters now and publish their exact values to MQTT. Updates the
  // shared readout job so both the web UI (polling GET /api/readout) and the
  // HTTP trigger reflect the same run.
  private async runReadout(trigger: 'web' | 'http'): Promise<ReadoutJob> {
    const log = getLogger();
    this.readout = { status: 'running', started_at: new Date().toISOString(), trigger, results: [] };
    try {
      this.readout.results = await this.scheduler.readAllNow();
      this.readout.status = 'done';
    } catch (err) {
      log.error(`Readout error: ${err}`);
      this.readout.status = 'error';
      this.readout.error = String(err);
    }
    this.readout.finished_at = new Date().toISOString();
    return this.readout;
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
