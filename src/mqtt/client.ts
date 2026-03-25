import * as mqtt from 'mqtt';
import { MqttConfig } from '../types';
import { getLogger } from '../util/logger';

export class MqttPublisher {
  private client: mqtt.MqttClient | null = null;
  private config: MqttConfig;

  constructor(config: MqttConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    const log = getLogger();

    return new Promise((resolve, reject) => {
      this.client = mqtt.connect(this.config.broker, {
        username: this.config.username || undefined,
        password: this.config.password || undefined,
        clientId: this.config.client_id,
        keepalive: 60,
        reconnectPeriod: 5000,
        will: {
          topic: `mbus2mqtt/status`,
          payload: Buffer.from('offline'),
          qos: 1,
          retain: true,
        },
      });

      let connected = false;

      this.client.on('connect', () => {
        if (!connected) {
          connected = true;
          log.info(`MQTT connected to ${this.config.broker}`);
          this.publish('mbus2mqtt/status', 'online', true);
          resolve();
        } else {
          log.info(`MQTT reconnected to ${this.config.broker}`);
        }
      });

      this.client.on('error', (err) => {
        log.error(`MQTT error: ${err.message}`);
        if (!connected) reject(err);
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
    await this.publish('mbus2mqtt/status', 'offline', true);
    return new Promise((resolve) => {
      this.client!.end(false, {}, () => {
        this.client = null;
        resolve();
      });
    });
  }

  isConnected(): boolean {
    return this.client?.connected ?? false;
  }
}
