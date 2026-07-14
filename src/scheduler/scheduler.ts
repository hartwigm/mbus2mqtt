import { Config, DeviceConfig, ImmediateReadResult, MeterReading } from '../types';
import { PortManager } from '../mbus/port-manager';
import { MqttPublisher } from '../mqtt/client';
import { ReadingsStore } from '../store/readings-store';
import { buildDiscovery, buildSubDiscoveries, normalizeToHAUnit } from '../mqtt/ha-discovery';
import { haStateTopic, houseAiTopic } from '../mqtt/topics';
import { shouldPublishHA, shouldPublishHouseAiHourly, isDailyWindow } from './strategies';
import { getLogger } from '../util/logger';

const TICK_MS = 60 * 1000; // check every minute

// Hard ceiling on how long the single-flight read lock may stay held. A normal
// cycle is bounded (getData times out at 30s/device, scanSecondary at 600s), so
// a lock older than this means a tick hung on some await and would otherwise
// disable the scheduler forever (this exact wedge took BT6 offline for ~21h on
// 2026-07-13 when a QoS-1 publish never got its PUBACK). Force-release so the
// loop self-heals.
const READ_LOCK_MAX_AGE_MS = 30 * 60 * 1000;

export class Scheduler {
  private config: Config;
  private portManager: PortManager;
  private mqttClient: MqttPublisher;
  private store: ReadingsStore;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private reading = false;
  private readingSince = 0;
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
      const subs = buildSubDiscoveries(this.config.property, device);
      for (const sub of subs) {
        await this.mqttClient.publish(sub.topic, sub.payload, true);
      }
      log.info(`Published HA discovery for ${device.name}${subs.length ? ` (+${subs.length} sub-sensors)` : ''}`);
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
    const log = getLogger();

    if (this.reading) {
      // Previous cycle still running — normally we skip. But if the lock has
      // been held past the ceiling, a prior tick hung on an await; reclaim it
      // so the scheduler can't stay wedged indefinitely.
      const heldMs = Date.now() - this.readingSince;
      if (heldMs < READ_LOCK_MAX_AGE_MS) return;
      log.error(`Read lock stuck for ${Math.round(heldMs / 1000)}s — force-releasing and retrying`);
    }

    const due = this.getDevicesDue();
    if (due.length === 0) return;

    this.reading = true;
    this.readingSince = Date.now();
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

        // HA payload — normalize unit to match discovery declaration
        const ha = normalizeToHAUnit(reading.value, reading.unit, reading.medium);
        const payload = {
          value: ha.value,
          unit: ha.unit,
          medium: reading.medium,
          name: reading.name,
          timestamp: now,
          attributes: reading.attributes || {},
        };

        if (shouldPublishHA(state, valueChanged)) {
          const topic = haStateTopic(this.config.property, reading.device_id);
          await this.mqttClient.publish(topic, payload, true);
          this.store.update(reading.device_id, { last_ha_publish: now });
          log.debug(`HA: ${reading.name} = ${ha.value} ${ha.unit}`);
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

  /**
   * Read every configured device right now and publish the exact values to
   * MQTT immediately — both the Home Assistant state topic and the house.ai
   * meters topic — bypassing the usual change/throttle gating. Used for
   * apartment handover ("Rücknahme"), where the precise current meter reading
   * of all meters must be captured on demand from the web UI or an HTTP trigger.
   */
  async readAllNow(): Promise<ImmediateReadResult[]> {
    const log = getLogger();

    // Don't collide with a scheduled tick; wait for it to release the lock.
    const deadline = Date.now() + 60 * 1000;
    while (this.reading && Date.now() < deadline) {
      await new Promise(res => setTimeout(res, 200));
    }
    if (this.reading) throw new Error('Lesung läuft bereits — bitte erneut versuchen');

    this.reading = true;
    this.readingSince = Date.now();
    try {
      const devices = this.config.devices;
      log.info(`Sofort-Lesung: ${devices.length} Gerät(e)...`);
      const readings = await this.portManager.readDevices(devices);
      const now = new Date().toISOString();
      const results: ImmediateReadResult[] = [];

      for (const device of devices) {
        const reading = readings.find(r => r.device_id === device.secondary_address);
        if (!reading) {
          const state = this.store.get(device.secondary_address);
          this.store.update(device.secondary_address, { read_errors: state.read_errors + 1 });
          results.push({
            secondary_address: device.secondary_address,
            name: device.name,
            medium: device.medium,
            value: null,
            unit: null,
            ok: false,
          });
          continue;
        }

        this.store.update(reading.device_id, {
          last_value: reading.value,
          last_unit: reading.unit,
          last_read: now,
          read_errors: 0,
        });

        // HA state — force publish the exact current value
        const ha = normalizeToHAUnit(reading.value, reading.unit, reading.medium);
        await this.mqttClient.publish(
          haStateTopic(this.config.property, reading.device_id),
          {
            value: ha.value,
            unit: ha.unit,
            medium: reading.medium,
            name: reading.name,
            timestamp: now,
            attributes: reading.attributes || {},
          },
          true,
        );
        this.store.update(reading.device_id, { last_ha_publish: now });

        // house.ai — force publish the exact reading for the handover
        await this.mqttClient.publish(
          houseAiTopic(this.config.property, reading.device_id),
          { value: reading.value, timestamp: now },
        );

        results.push({
          secondary_address: device.secondary_address,
          name: device.name,
          medium: device.medium,
          value: reading.value,
          unit: reading.unit,
          ok: true,
        });
      }

      this.store.save();
      await this.mqttClient.publishHeartbeat();
      const okCount = results.filter(r => r.ok).length;
      log.info(`Sofort-Lesung fertig: ${okCount}/${devices.length} OK`);
      return results;
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
