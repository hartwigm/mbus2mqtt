import { DeviceConfig } from '../types';
import { haStateTopic, haDiscoveryTopic } from './topics';

interface DiscoveryPayload {
  topic: string;
  payload: Record<string, unknown>;
}

export const MEDIUM_CONFIG: Record<string, { device_class: string; unit: string; icon: string }> = {
  water:       { device_class: 'water',  unit: 'm³',  icon: 'mdi:water-pump' },
  warm_water:  { device_class: 'water',  unit: 'm³',  icon: 'mdi:water-boiler' },
  heat:        { device_class: 'energy', unit: 'kWh', icon: 'mdi:radiator' },
  gas:         { device_class: 'gas',    unit: 'm³',  icon: 'mdi:gas-cylinder' },
  electricity: { device_class: 'energy', unit: 'kWh', icon: 'mdi:flash' },
};

// Conversion factors to normalize meter values to the HA-declared unit
const UNIT_CONVERSIONS: Record<string, Record<string, number>> = {
  'kWh': { 'Wh': 0.001, 'MWh': 1000, 'J': 1 / 3600000, 'kJ': 1 / 3600 },
  'm³':  {},
};

/**
 * Convert a meter value to the unit declared in HA discovery.
 * Returns the converted value and the target unit.
 */
export function normalizeToHAUnit(value: number, actualUnit: string, medium: string): { value: number; unit: string } {
  const mc = MEDIUM_CONFIG[medium] || MEDIUM_CONFIG.water;
  const targetUnit = mc.unit;

  if (actualUnit === targetUnit) return { value, unit: targetUnit };

  const conversions = UNIT_CONVERSIONS[targetUnit];
  if (conversions && conversions[actualUnit] !== undefined) {
    const converted = value * conversions[actualUnit];
    return { value: parseFloat(converted.toPrecision(10)), unit: targetUnit };
  }

  // No conversion known — pass through as-is
  return { value, unit: actualUnit };
}

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
