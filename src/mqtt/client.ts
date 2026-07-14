import * as mqtt from 'mqtt';
import * as os from 'os';
import { MqttConfig } from '../types';
import { getLogger } from '../util/logger';

export interface MqttPublisherOptions {
  enableLWT?: boolean;
  publishStatus?: boolean;
}

export class MqttPublisher {
  private client: mqtt.MqttClient | null = null;
  private config: MqttConfig;
  private options: Required<MqttPublisherOptions>;
  private statusRevertTimer: ReturnType<typeof setTimeout> | null = null;

  // For the first hour after a (re)start the status topic carries the service
  // IP behind "online" (e.g. "online 192.168.133.42"), then settles to a plain
  // "online". Lets you find the box via MQTT after a DHCP-driven restart.
  private static readonly IP_WINDOW_MS = 60 * 60 * 1000;

  // Upper bound for a single QoS-1 publish. A publish resolves only when the
  // broker returns PUBACK; if the route/broker drops *after* the socket still
  // reports `connected` (e.g. EHOSTUNREACH), that ACK never arrives and the
  // callback never fires. The scheduler awaits publish() while holding a
  // single-flight read lock, so an unbounded publish would wedge the whole read
  // loop indefinitely. Time it out to turn a hang into a recoverable error.
  private static readonly PUBLISH_TIMEOUT_MS = 15000;

  constructor(config: MqttConfig, options: MqttPublisherOptions = {}) {
    this.config = config;
    this.options = {
      enableLWT: options.enableLWT ?? true,
      publishStatus: options.publishStatus ?? true,
    };
  }

  async connect(): Promise<void> {
    const log = getLogger();

    // Normalize broker URL: accept bare "host:port" and prepend mqtt:// scheme
    // so mqtt.js doesn't mis-parse (URL module would treat "host:port" like
    // protocol=host, pathname=port).
    const brokerUrl = /^(mqtt|mqtts|ws|wss):\/\//.test(this.config.broker)
      ? this.config.broker
      : `mqtt://${this.config.broker}`;

    return new Promise((resolve, reject) => {
      const connOpts: mqtt.IClientOptions = {
        username: this.config.username || undefined,
        password: this.config.password || undefined,
        clientId: this.config.client_id,
        keepalive: 60,
        reconnectPeriod: 5000,
        connectTimeout: 10000,
        protocolVersion: 4, // MQTT 3.1.1 — matches mosquitto_sub default, broadest compat
      };
      if (this.options.enableLWT) {
        connOpts.will = {
          topic: `mbus2mqtt/status`,
          payload: Buffer.from('offline'),
          qos: 1,
          retain: true,
        };
      }
      log.debug(`MQTT connecting to ${brokerUrl} as user=${this.config.username || '(anon)'} clientId=${this.config.client_id}`);
      this.client = mqtt.connect(brokerUrl, connOpts);

      let connected = false;
      let settled = false;
      let closeCount = 0;

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      const timer = setTimeout(() => {
        settle(() => reject(new Error(`MQTT connect timeout after 10s (${this.config.broker})`)));
      }, 10000);

      this.client.on('connect', () => {
        if (!connected) {
          connected = true;
          log.info(`MQTT connected to ${this.config.broker}`);
          if (this.options.publishStatus) {
            this.publishOnlineStatus();
          }
          settle(resolve);
        } else {
          log.info(`MQTT reconnected to ${this.config.broker}`);
        }
      });

      this.client.on('error', (err) => {
        log.error(`MQTT error: ${err.message}`);
        if (!connected) settle(() => reject(err));
      });

      this.client.on('close', () => {
        if (connected) return;
        closeCount++;
        if (closeCount >= 2) {
          settle(() => reject(new Error(
            `MQTT broker closed connection without CONNACK (${this.config.broker}) — ` +
            `check auth, ACL or protocol version`
          )));
        }
      });

      this.client.on('reconnect', () => {
        log.debug('MQTT reconnecting...');
      });
    });
  }

  async publish(topic: string, payload: string | Record<string, unknown>, retain = false): Promise<void> {
    if (!this.client?.connected) {
      getLogger().warn(`MQTT not connected, skipping publish to ${topic}`);
      return;
    }

    const msg = typeof payload === 'string' ? payload : JSON.stringify(payload);

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };
      const timer = setTimeout(
        () => finish(new Error(`MQTT publish timeout after ${MqttPublisher.PUBLISH_TIMEOUT_MS}ms to ${topic}`)),
        MqttPublisher.PUBLISH_TIMEOUT_MS,
      );
      this.client!.publish(topic, msg, { qos: 1, retain }, (err) => finish(err ?? undefined));
    });
  }

  // Publish "online <ip>" retained, then revert to a plain "online" after the
  // first hour. Downstream availability checks must look at the first token
  // only — HA discovery uses an availability_template for exactly that.
  private publishOnlineStatus(): void {
    const ip = this.getLocalIp();
    this.publish('mbus2mqtt/status', `online ${ip}`, true);
    if (this.statusRevertTimer) clearTimeout(this.statusRevertTimer);
    this.statusRevertTimer = setTimeout(() => {
      this.statusRevertTimer = null;
      if (this.client?.connected) {
        this.publish('mbus2mqtt/status', 'online', true);
      }
    }, MqttPublisher.IP_WINDOW_MS);
    this.statusRevertTimer.unref();
  }

  async disconnect(): Promise<void> {
    if (!this.client) return;
    if (this.statusRevertTimer) {
      clearTimeout(this.statusRevertTimer);
      this.statusRevertTimer = null;
    }
    if (this.client.connected && this.options.publishStatus) {
      await this.publish('mbus2mqtt/status', 'offline', true);
    }
    return new Promise((resolve) => {
      this.client!.end(true, {}, () => {
        this.client = null;
        resolve();
      });
    });
  }

  async publishHeartbeat(): Promise<void> {
    const topic = `property/${this.config.client_id}/online`;
    const ip = this.getLocalIp();
    const payload = {
      ip,
      timestamp: new Date().toISOString(),
    };
    await this.publish(topic, payload, true);
  }

  private getLocalIp(): string {
    const interfaces = os.networkInterfaces();
    for (const iface of Object.values(interfaces)) {
      if (!iface) continue;
      for (const addr of iface) {
        if (addr.family === 'IPv4' && !addr.internal) {
          return addr.address;
        }
      }
    }
    return '127.0.0.1';
  }

  isConnected(): boolean {
    return this.client?.connected ?? false;
  }
}
