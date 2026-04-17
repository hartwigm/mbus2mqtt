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

  constructor(config: MqttConfig, options: MqttPublisherOptions = {}) {
    this.config = config;
    this.options = {
      enableLWT: options.enableLWT ?? true,
      publishStatus: options.publishStatus ?? true,
    };
  }

  async connect(): Promise<void> {
    const log = getLogger();

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
      this.client = mqtt.connect(this.config.broker, connOpts);

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
            this.publish('mbus2mqtt/status', 'online', true);
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
      this.client!.publish(topic, msg, { qos: 1, retain }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async disconnect(): Promise<void> {
    if (!this.client) return;
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
