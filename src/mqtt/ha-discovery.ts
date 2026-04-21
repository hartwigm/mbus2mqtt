import { DeviceConfig } from '../types';
import { haStateTopic, haDiscoveryTopic, haSubDiscoveryTopic } from './topics';

export interface DiscoveryPayload {
  topic: string;
  payload: Record<string, unknown>;
}

interface SubSensor {
  key: string;
  name: string;
  unit?: string;
  device_class?: string;
  state_class?: string;
  icon?: string;
  suggested_display_precision?: number;
}

// Sub-sensors per medium. Each produces its own HA discovery entry but shares
// the parent device's state topic; value_template picks the attribute out.
const SUB_SENSORS: Record<string, SubSensor[]> = {
  heat: [
    { key: 'power_w',             name: 'Leistung',         unit: 'W',     device_class: 'power',            state_class: 'measurement',       icon: 'mdi:gauge' },
    { key: 'power_max_w',         name: 'Leistung Max',     unit: 'W',     device_class: 'power',            state_class: 'measurement',       icon: 'mdi:gauge-full' },
    { key: 'volume_m3',           name: 'Volumen',          unit: 'm³',    device_class: 'water',            state_class: 'total_increasing',  icon: 'mdi:water', suggested_display_precision: 3 },
    { key: 'flow_m3h',            name: 'Durchfluss',       unit: 'm³/h',  device_class: 'volume_flow_rate', state_class: 'measurement',       icon: 'mdi:water-pump', suggested_display_precision: 3 },
    { key: 'flow_max_m3h',        name: 'Durchfluss Max',   unit: 'm³/h',  device_class: 'volume_flow_rate', state_class: 'measurement',       icon: 'mdi:water-pump', suggested_display_precision: 3 },
    { key: 'flow_temp_c',         name: 'Vorlauf',          unit: '°C',    device_class: 'temperature',      state_class: 'measurement',       icon: 'mdi:thermometer-high' },
    { key: 'return_temp_c',       name: 'Rücklauf',         unit: '°C',    device_class: 'temperature',      state_class: 'measurement',       icon: 'mdi:thermometer-low' },
    { key: 'temp_diff_k',         name: 'Spreizung',        unit: 'K',                                        state_class: 'measurement',       icon: 'mdi:thermometer', suggested_display_precision: 2 },
    { key: 'on_time_days',        name: 'Betriebstage',     unit: 'd',                                        state_class: 'total_increasing',  icon: 'mdi:clock-outline' },
    { key: 'energy_previous_kwh', name: 'Energie Stichtag', unit: 'kWh',   device_class: 'energy',            state_class: 'total_increasing',  icon: 'mdi:radiator' },
    { key: 'volume_previous_m3',  name: 'Volumen Stichtag', unit: 'm³',    device_class: 'water',             state_class: 'total_increasing',  icon: 'mdi:water', suggested_display_precision: 3 },
    { key: 'error_flags',         name: 'Fehlerflags',                                                         state_class: 'measurement',       icon: 'mdi:alert-circle' },
  ],
};

export function getSubSensors(medium: string): SubSensor[] {
  return SUB_SENSORS[medium] || [];
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
  const deviceBlock = {
    identifiers: [uniqueId],
    name: `${device.name} (${property})`,
    manufacturer: 'NZR',
    model: `M-Bus ${device.medium}`,
    via_device: `mbus2mqtt_${property}`,
  };

  return {
    topic: haDiscoveryTopic(property, device.secondary_address),
    payload: {
      name: device.name,
      unique_id: uniqueId,
      state_topic: haStateTopic(property, device.secondary_address),
      value_template: '{{ value_json.value }}',
      json_attributes_topic: haStateTopic(property, device.secondary_address),
      json_attributes_template: '{{ value_json.attributes | tojson }}',
      unit_of_measurement: mc.unit,
      device_class: mc.device_class,
      state_class: 'total_increasing',
      icon: mc.icon,
      device: deviceBlock,
    },
  };
}

export function buildSubDiscoveries(property: string, device: DeviceConfig): DiscoveryPayload[] {
  const subs = getSubSensors(device.medium);
  if (subs.length === 0) return [];

  const parentUid = `mbus2mqtt_${property}_${device.secondary_address}`;
  const deviceBlock = {
    identifiers: [parentUid],
    name: `${device.name} (${property})`,
    manufacturer: 'NZR',
    model: `M-Bus ${device.medium}`,
    via_device: `mbus2mqtt_${property}`,
  };
  const stateTopic = haStateTopic(property, device.secondary_address);

  return subs.map(sub => {
    const uid = `${parentUid}_${sub.key}`;
    const payload: Record<string, unknown> = {
      name: sub.name,
      unique_id: uid,
      state_topic: stateTopic,
      value_template: `{{ value_json.attributes.${sub.key} | default(None) }}`,
      availability_topic: 'mbus2mqtt/status',
      device: deviceBlock,
    };
    if (sub.unit) payload.unit_of_measurement = sub.unit;
    if (sub.device_class) payload.device_class = sub.device_class;
    if (sub.state_class) payload.state_class = sub.state_class;
    if (sub.icon) payload.icon = sub.icon;
    if (sub.suggested_display_precision !== undefined) {
      payload.suggested_display_precision = sub.suggested_display_precision;
    }
    return {
      topic: haSubDiscoveryTopic(property, device.secondary_address, sub.key),
      payload,
    };
  });
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
