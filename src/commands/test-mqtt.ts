import { Config } from '../types';
import { PortManager } from '../mbus/port-manager';
import { MqttPublisher } from '../mqtt/client';
import { buildDiscovery } from '../mqtt/ha-discovery';
import { haStateTopic, houseAiTopic } from '../mqtt/topics';
import { getLogger } from '../util/logger';

export async function cmdTestMqtt(config: Config): Promise<void> {
  const log = getLogger();
  const pm = new PortManager(config);
  const mqttClient = new MqttPublisher(config.mqtt);

  try {
    // 1. MQTT verbinden
    console.log(`\n  MQTT Broker: ${config.mqtt.broker}`);
    console.log(`  Client-ID:  ${config.mqtt.client_id}`);
    console.log(`  Verbinde...`);

    await mqttClient.connect();
    console.log(`  ✅ MQTT verbunden\n`);

    // 2. Discovery senden
    console.log(`  Discovery für ${config.devices.length} Gerät(e) senden...`);
    for (const device of config.devices) {
      const disc = buildDiscovery(config.property, device);
      await mqttClient.publish(disc.topic, disc.payload, true);
      console.log(`  ✅ ${device.name} → ${disc.topic}`);
    }
    console.log();

    // 3. Zähler auslesen
    console.log(`  M-Bus Ports verbinden...`);
    await pm.connectAll();
    console.log(`  ✅ Ports verbunden\n`);

    console.log(`  Alle Geräte auslesen und sofort senden...`);
    const readings = await pm.readDevices(config.devices);
    const now = new Date().toISOString();

    if (readings.length === 0) {
      console.log(`  ⚠️  Keine Geräte konnten gelesen werden\n`);
    }

    for (const reading of readings) {
      const payload = {
        value: reading.value,
        unit: reading.unit,
        medium: reading.medium,
        name: reading.name,
        timestamp: now,
      };

      const haTopic = haStateTopic(config.property, reading.device_id);
      await mqttClient.publish(haTopic, payload, true);

      const aiTopic = houseAiTopic(config.property, reading.device_id);
      await mqttClient.publish(aiTopic, { value: reading.value, timestamp: now });

      console.log(`  ✅ ${reading.name}: ${reading.value} ${reading.unit}`);
      console.log(`     HA:       ${haTopic}`);
      console.log(`     house.ai: ${aiTopic}`);
    }

    // Fehler melden
    const failed = config.devices.filter(
      d => !readings.find(r => r.device_id === d.secondary_address)
    );
    for (const dev of failed) {
      console.log(`  ❌ ${dev.name} (${dev.secondary_address}) — Lesen fehlgeschlagen`);
    }

    console.log(`\n  Ergebnis: ${readings.length}/${config.devices.length} gelesen und gesendet`);
    console.log();
  } catch (err) {
    console.error(`  ❌ Fehler: ${err}`);
    process.exit(1);
  } finally {
    await pm.disconnectAll();
    await mqttClient.disconnect();
  }
}
