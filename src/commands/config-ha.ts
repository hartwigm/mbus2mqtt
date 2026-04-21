import { Config } from '../types';
import { MqttPublisher } from '../mqtt/client';
import { buildDiscovery, buildSubDiscoveries, getSubSensors } from '../mqtt/ha-discovery';
import { haStateTopic, haDiscoveryTopic, haSubDiscoveryTopic } from '../mqtt/topics';
import { getLogger } from '../util/logger';

export async function cmdConfigHA(config: Config, opts: { clean?: boolean; reset?: boolean }): Promise<void> {
  const log = getLogger();

  if (!opts.clean && !opts.reset) {
    // Show current HA configuration
    showConfig(config);
    return;
  }

  const mqttConfig = {
    ...config.mqtt,
    client_id: `${config.mqtt.client_id || 'mbus2mqtt'}-config-${Date.now()}`,
  };
  const mqttClient = new MqttPublisher(mqttConfig);

  try {
    console.log(`\n  MQTT Broker: ${config.mqtt.broker}`);
    console.log(`  Verbinde...`);
    await mqttClient.connect();
    console.log(`  ✅ MQTT verbunden\n`);

    if (opts.reset) {
      // Remove all discovery + state messages, then republish
      await cleanDiscovery(mqttClient, config);
      await publishDiscovery(mqttClient, config);
    } else if (opts.clean) {
      // Only remove old retained messages
      await cleanDiscovery(mqttClient, config);
    }

    console.log();
  } catch (err) {
    console.error(`  ❌ Fehler: ${err}`);
    process.exit(1);
  } finally {
    await mqttClient.disconnect();
  }
}

function showConfig(config: Config): void {
  console.log(`\n  Home Assistant MQTT Auto-Discovery`);
  console.log(`  ${'─'.repeat(70)}`);
  console.log(`  Property:         ${config.property}`);
  console.log(`  Discovery-Prefix: homeassistant/sensor/`);
  console.log(`  State-Prefix:     mbus2mqtt/${config.property}/`);
  console.log(`  ${'─'.repeat(70)}`);

  for (const device of config.devices) {
    const disc = buildDiscovery(config.property, device);
    const payload = disc.payload as Record<string, unknown>;
    console.log();
    console.log(`  ${device.name}`);
    console.log(`    Discovery: ${disc.topic}`);
    console.log(`    State:     ${payload.state_topic}`);
    console.log(`    unique_id: ${payload.unique_id}`);
    console.log(`    Einheit:   ${payload.unit_of_measurement}  (device_class: ${payload.device_class})`);
    console.log(`    Icon:      ${payload.icon}`);
  }

  console.log(`\n  Optionen:`);
  console.log(`    m2q config-ha --clean   Alte retained Discovery-Messages löschen`);
  console.log(`    m2q config-ha --reset   Löschen + neu senden`);
  console.log();
}

async function cleanDiscovery(mqttClient: MqttPublisher, config: Config): Promise<void> {
  console.log(`  Alte Discovery-Messages löschen...`);

  // Clean current property topics (main + sub-sensors)
  for (const device of config.devices) {
    const topic = haDiscoveryTopic(config.property, device.secondary_address);
    await mqttClient.publish(topic, '', true);
    console.log(`    ✅ ${topic}`);
    for (const sub of getSubSensors(device.medium)) {
      const subTopic = haSubDiscoveryTopic(config.property, device.secondary_address, sub.key);
      await mqttClient.publish(subTopic, '', true);
    }
  }

  // Clean common case-variants (BT6 vs bt6, M47 vs m47, etc.)
  const variants = getCaseVariants(config.property);
  for (const variant of variants) {
    if (variant === config.property) continue;
    for (const device of config.devices) {
      const topic = haDiscoveryTopic(variant, device.secondary_address);
      await mqttClient.publish(topic, '', true);
      console.log(`    ✅ ${topic} (alte Variante)`);
      for (const sub of getSubSensors(device.medium)) {
        const subTopic = haSubDiscoveryTopic(variant, device.secondary_address, sub.key);
        await mqttClient.publish(subTopic, '', true);
      }

      // Also clean old state topics
      const stateTopic = haStateTopic(variant, device.secondary_address);
      await mqttClient.publish(stateTopic, '', true);
    }
  }

  console.log(`  ✅ Cleanup abgeschlossen`);
}

async function publishDiscovery(mqttClient: MqttPublisher, config: Config): Promise<void> {
  console.log(`\n  Discovery neu senden...`);
  for (const device of config.devices) {
    const disc = buildDiscovery(config.property, device);
    await mqttClient.publish(disc.topic, disc.payload, true);
    const subs = buildSubDiscoveries(config.property, device);
    for (const sub of subs) {
      await mqttClient.publish(sub.topic, sub.payload, true);
    }
    const suffix = subs.length ? ` (+${subs.length} Sub-Sensoren)` : '';
    console.log(`    ✅ ${device.name} → ${disc.topic}${suffix}`);
  }
  console.log(`  ✅ Discovery gesendet`);
}

function getCaseVariants(property: string): string[] {
  const variants = new Set<string>();
  variants.add(property);
  variants.add(property.toLowerCase());
  variants.add(property.toUpperCase());
  // Mixed case: first letter upper
  if (property.length > 0) {
    variants.add(property[0].toUpperCase() + property.slice(1).toLowerCase());
  }
  return Array.from(variants);
}
