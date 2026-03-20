import { DeviceConfig } from '../types';
import { haStateTopic, haDiscoveryTopic } from './topics';

interface DiscoveryPayload {
  topic: string;
  payload: Record<string, unknown>;
}

const MEDIUM_CONFIG: Record<string, { device_class: string; unit: string; icon: string }> = {
  water:       { device_class: 'water',  unit: 'm³',  icon: 'mdi:water-pump' },
  warm_water:  { device_class: 'water',  unit: 'm³',  icon: 'mdi:water-boiler' },
  heat:        { device_class: 'energy', unit: 'kWh', icon: 'mdi:radiator' },
  gas:         { device_class: 'gas',    unit: 'm³',  icon: 'mdi:gas-cylinder' },
  electricity: { device_class: 'energy', unit: 'kWh', icon: 'mdi:flash' },
};

export function buildDiscovery(property: string, device: DeviceConfig): DiscoveryPayload {
  const mc = MEDIUM_CONFIG[device.medium] || MEDIUM_CONFIG.water;
  const uniqueId = `mbus2mqtt_${property}_${device.secondary_address}`;

  return {
    topic: haDiscoveryTopic(property, device.secondary_address),
    payload: {
      name: device.name,
      unique_id: uniqueId,
      state_topic: haStateTopic(property, device.secondary_address),
      value_template: '{{ value_json.value }}',
      unit_of_measurement: mc.unit,
      device_class: mc.device_class,
      state_class: 'total_increasing',
      icon: mc.icon,
      device: {
        identifiers: [uniqueId],
        name: `${device.name} (${property})`,
        manufacturer: 'NZR',
        model: `M-Bus ${device.medium}`,
        via_device: `mbus2mqtt_${property}`,
      },
    },
  };
}

export function buildBridgeDiscovery(property: string): Record<string, unknown> {
  return {
    name: `mbus2mqtt ${property}`,
    unique_id: `mbus2mqtt_${property}`,
    state_topic: `mbus2mqtt/${property}/status`,
    device: {
      identifiers: [`mbus2mqtt_${property}`],
      name: `mbus2mqtt ${property}`,
      manufacturer: 'mbus2mqtt',
      model: 'M-Bus Gateway',
    },
  };
}
