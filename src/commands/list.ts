import { Config } from '../types';
import { ReadingsStore } from '../store/readings-store';
import { PortManager } from '../mbus/port-manager';
import { MqttPublisher } from '../mqtt/client';
import { buildDiscovery, normalizeToHAUnit } from '../mqtt/ha-discovery';
import { haStateTopic, houseAiTopic } from '../mqtt/topics';

export async function cmdList(config: Config, readFirst = false, publishMqtt = false): Promise<void> {
  const store = new ReadingsStore(config.state_file);

  if (readFirst) {
    console.log(`\n  Lese alle ${config.devices.length} Gerät(e)...`);
    const pm = new PortManager(config);
    const mqttClient = publishMqtt ? new MqttPublisher(config.mqtt) : null;
    try {
      await pm.connectAll();
      if (mqttClient) {
        console.log(`  MQTT: verbinde mit ${config.mqtt.broker}...`);
        await mqttClient.connect();
        for (const dev of config.devices) {
          const disc = buildDiscovery(config.property, dev);
          await mqttClient.publish(disc.topic, disc.payload, true);
        }
        console.log(`  MQTT: Discovery für ${config.devices.length} Gerät(e) gesendet`);
      }

      const readings = await pm.readDevices(config.devices);
      const now = new Date().toISOString();
      let published = 0;
      for (const r of readings) {
        store.update(r.device_id, {
          last_value: r.value,
          last_unit: r.unit,
          last_read: now,
          read_errors: 0,
        });

        if (mqttClient) {
          const ha = normalizeToHAUnit(r.value, r.unit, r.medium);
          const payload = {
            value: ha.value,
            unit: ha.unit,
            medium: r.medium,
            name: r.name,
            timestamp: now,
          };
          await mqttClient.publish(haStateTopic(config.property, r.device_id), payload, true);
          await mqttClient.publish(houseAiTopic(config.property, r.device_id), { value: r.value, timestamp: now });
          store.update(r.device_id, { last_ha_publish: now });
          published++;
        }
      }
      for (const dev of config.devices) {
        if (!readings.find(r => r.device_id === dev.secondary_address)) {
          const state = store.get(dev.secondary_address);
          store.update(dev.secondary_address, { read_errors: state.read_errors + 1 });
        }
      }
      store.save();
      console.log(`  ${readings.length}/${config.devices.length} erfolgreich gelesen${mqttClient ? `, ${published} per MQTT gesendet` : ''}.`);
    } finally {
      await pm.disconnectAll();
      if (mqttClient) await mqttClient.disconnect();
    }
  }

  const allState = store.getAll();

  console.log(`\n  Property: ${config.property}`);
  console.log(`  Devices:  ${config.devices.length}`);
  console.log(`  ${'─'.repeat(80)}`);
  console.log(
    `  ${'Name'.padEnd(30)} ${'Medium'.padEnd(12)} ${'Value'.padEnd(14)} ${'Last Read'.padEnd(20)} Errors`
  );
  console.log(`  ${'─'.repeat(80)}`);

  for (const dev of config.devices) {
    const state = allState[dev.secondary_address];
    const name = dev.name.slice(0, 28).padEnd(30);
    const medium = dev.medium.padEnd(12);
    let value = '—'.padEnd(14);
    let lastRead = '—'.padEnd(20);
    let errors = '0';

    if (state) {
      if (state.last_value !== null) {
        const v = parseFloat(state.last_value.toPrecision(10));
        value = `${v} ${state.last_unit}`.padEnd(14);
      }
      if (state.last_read) {
        lastRead = state.last_read.slice(0, 19).replace('T', ' ').padEnd(20);
      }
      errors = String(state.read_errors);
    }

    console.log(`  ${name} ${medium} ${value} ${lastRead} ${errors}`);
  }
  console.log();
}
