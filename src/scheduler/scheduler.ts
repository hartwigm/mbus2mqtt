import { Config, DeviceConfig, MeterReading } from '../types';
import { PortManager } from '../mbus/port-manager';
import { MqttPublisher } from '../mqtt/client';
import { ReadingsStore } from '../store/readings-store';
import { buildDiscovery } from '../mqtt/ha-discovery';
import { haStateTopic, houseAiTopic } from '../mqtt/topics';
import { shouldPublishHA, shouldPublishHouseAiHourly, isDailyWindow } from './strategies';
import { getLogger } from '../util/logger';

const TICK_MS = 60 * 1000; // check every minute

export class Scheduler {
  private config: Config;
  private portManager: PortManager;
  private mqttClient: MqttPublisher;
  private store: ReadingsStore;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private reading = false;
  private firstTick = true;

  constructor(config: Config, portManager: PortManager, mqttClient: MqttPublisher, store: ReadingsStore) {
    this.config = config;
    this.portManager = portManager;
    this.mqttClient = mqttClient;
    this.store = store;
  }

  async publishDiscovery(): Promise<void> {
    const log = getLogger();
    for (const device of this.config.devices) {
      const disc = buildDiscovery(this.config.property, device);
      await this.mqttClient.publish(disc.topic, disc.payload, true);
      log.info(`Published HA discovery for ${device.name}`);
    }
  }

  private getDeviceInterval(device: DeviceConfig): number {
    return (device.read_interval_minutes || this.config.read_interval_minutes) * 60 * 1000;
  }

  private getDevicesDue(): DeviceConfig[] {
    if (this.firstTick) {
      this.firstTick = false;
      return [...this.config.devices];
    }
    const now = Date.now();
    return this.config.devices.filter(dev => {
      const state = this.store.get(dev.secondary_address);
      if (!state.last_read) return true;
      const elapsed = now - new Date(state.last_read).getTime();
      return elapsed >= this.getDeviceInterval(dev);
    });
  }

  async tick(): Promise<void> {
    if (this.reading) return; // skip if previous cycle still running
    const log = getLogger();

    const due = this.getDevicesDue();
    if (due.length === 0) return;

    this.reading = true;
    try {
      log.info(`Reading ${due.length} device(s)...`);
      const readings = await this.portManager.readDevices(due);
      const now = new Date().toISOString();

      for (const reading of readings) {
        const state = this.store.get(reading.device_id);
        const valueChanged = this.store.hasValueChanged(reading.device_id, reading.value);

        this.store.update(reading.device_id, {
          last_value: reading.value,
          last_unit: reading.unit,
          last_read: now,
          read_errors: 0,
        });

        // HA payload (full)
        const payload = {
          value: reading.value,
          unit: reading.unit,
          medium: reading.medium,
          name: reading.name,
          timestamp: now,
        };

        if (shouldPublishHA(state, valueChanged)) {
          const topic = haStateTopic(this.config.property, reading.device_id);
          await this.mqttClient.publish(topic, payload, true);
          this.store.update(reading.device_id, { last_ha_publish: now });
          log.debug(`HA: ${reading.name} = ${reading.value} ${reading.unit}`);
        }

        // house.ai payload (value + timestamp only)
        const houseAiPayload = { value: reading.value, timestamp: now };

        if (shouldPublishHouseAiHourly(state)) {
          const topic = houseAiTopic(this.config.property, reading.device_id);
          await this.mqttClient.publish(topic, houseAiPayload);
          this.store.update(reading.device_id, { last_houseai_hourly: now });
          log.debug(`house.ai (hourly): ${reading.name}`);
        }

        if (isDailyWindow() && !state.last_houseai_daily?.startsWith(now.slice(0, 10))) {
          const topic = houseAiTopic(this.config.property, reading.device_id);
          await this.mqttClient.publish(topic, houseAiPayload);
          this.store.update(reading.device_id, { last_houseai_daily: now });
          log.info(`house.ai (daily): ${reading.name} = ${reading.value} ${reading.unit}`);
        }
      }

      // Track errors for devices that were due but not read
      for (const dev of due) {
        if (!readings.find(r => r.device_id === dev.secondary_address)) {
          const state = this.store.get(dev.secondary_address);
          this.store.update(dev.secondary_address, { read_errors: state.read_errors + 1 });
        }
      }

      this.store.save();
      await this.mqttClient.publishHeartbeat();
      log.info(`Done: ${readings.length}/${due.length} OK`);
    } finally {
      this.reading = false;
    }
  }

  start(): void {
    const log = getLogger();
    this.running = true;

    const intervals = this.config.devices.map(d =>
      `${d.name}: ${d.read_interval_minutes || this.config.read_interval_minutes}min`
    );
    log.info(`Scheduler started. Intervals: ${intervals.join(', ')}`);

    // Initial read
    this.tick().catch(err => log.error(`Tick error: ${err}`));

    this.timer = setInterval(() => {
      if (this.running) {
        this.tick().catch(err => log.error(`Tick error: ${err}`));
      }
    }, TICK_MS);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
