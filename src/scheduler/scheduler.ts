import { Config, MeterReading } from '../types';
import { PortManager } from '../mbus/port-manager';
import { MqttPublisher } from '../mqtt/client';
import { ReadingsStore } from '../store/readings-store';
import { buildDiscovery } from '../mqtt/ha-discovery';
import { haStateTopic, houseAiTopic } from '../mqtt/topics';
import { shouldPublishHA, shouldPublishHouseAiHourly, isDailyWindow } from './strategies';
import { getLogger } from '../util/logger';

export class Scheduler {
  private config: Config;
  private portManager: PortManager;
  private mqttClient: MqttPublisher;
  private store: ReadingsStore;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

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

  async readAndPublish(): Promise<void> {
    const log = getLogger();
    log.info('Starting read cycle...');

    const readings = await this.portManager.readAllDevices();
    const now = new Date().toISOString();

    for (const reading of readings) {
      const state = this.store.get(reading.device_id);
      const valueChanged = this.store.hasValueChanged(reading.device_id, reading.value);

      // Update store with new reading
      this.store.update(reading.device_id, {
        last_value: reading.value,
        last_unit: reading.unit,
        last_read: now,
        read_errors: 0,
      });

      const payload = {
        value: reading.value,
        unit: reading.unit,
        medium: reading.medium,
        name: reading.name,
        timestamp: now,
      };

      // HA publishing: daily + on change
      if (shouldPublishHA(state, valueChanged)) {
        const topic = haStateTopic(this.config.property, reading.device_id);
        await this.mqttClient.publish(topic, payload, true);
        this.store.update(reading.device_id, { last_ha_publish: now });
        log.debug(`Published to HA: ${reading.name} = ${reading.value} ${reading.unit}`);
      }

      // house.ai publishing: hourly
      if (shouldPublishHouseAiHourly(state)) {
        const topic = houseAiTopic(this.config.property, reading.device_id);
        await this.mqttClient.publish(topic, payload);
        this.store.update(reading.device_id, { last_houseai_hourly: now });
        log.debug(`Published to house.ai (hourly): ${reading.name}`);
      }

      // house.ai publishing: daily at 23:59
      if (isDailyWindow() && !state.last_houseai_daily?.startsWith(now.slice(0, 10))) {
        const topic = houseAiTopic(this.config.property, reading.device_id);
        const dailyPayload = { ...payload, type: 'daily_snapshot' };
        await this.mqttClient.publish(topic, dailyPayload);
        this.store.update(reading.device_id, { last_houseai_daily: now });
        log.info(`Published daily snapshot to house.ai: ${reading.name} = ${reading.value} ${reading.unit}`);
      }
    }

    // Track errors for devices that were not read
    for (const device of this.config.devices) {
      if (!readings.find(r => r.device_id === device.secondary_address)) {
        const state = this.store.get(device.secondary_address);
        this.store.update(device.secondary_address, { read_errors: state.read_errors + 1 });
      }
    }

    this.store.save();
    log.info(`Read cycle complete: ${readings.length}/${this.config.devices.length} devices OK`);
  }

  start(): void {
    const log = getLogger();
    this.running = true;
    const intervalMs = this.config.read_interval_minutes * 60 * 1000;

    log.info(`Scheduler started: reading every ${this.config.read_interval_minutes} min`);

    // Initial read
    this.readAndPublish().catch(err => log.error(`Read cycle error: ${err}`));

    this.timer = setInterval(() => {
      if (this.running) {
        this.readAndPublish().catch(err => log.error(`Read cycle error: ${err}`));
      }
    }, intervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
