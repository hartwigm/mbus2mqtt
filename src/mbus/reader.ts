import { MbusConnection, MbusData, MbusDataRecord } from './connection';
import { DeviceConfig, MeterReading } from '../types';
import { getLogger } from '../util/logger';

const UNIT_MAP: Record<string, string> = {
  'Volume (my m^3)': 'm³',
  'Volume (m m^3)': 'm³',
  'Volume (m^3)': 'm³',
  'Volume (10 m^3)': 'm³',
  'Volume (100 m^3)': 'm³',
  'Volume (k m^3)': 'm³',
  'Energy (Wh)': 'Wh',
  'Energy (10 Wh)': 'Wh',
  'Energy (100 Wh)': 'Wh',
  'Energy (kWh)': 'kWh',
  'Energy (10 kWh)': 'kWh',
  'Energy (100 kWh)': 'kWh',
  'Energy (MWh)': 'MWh',
  'Energy (J)': 'J',
  'Energy (kJ)': 'kJ',
  'Energy (10 kJ)': 'kJ',
  'Energy (100 kJ)': 'kJ',
  'Power (W)': 'W',
  'Power (kW)': 'kW',
  'Flow (m m^3/h)': 'm³/h',
  'Volume flow (m^3/h)': 'm³/h',
};

function normalizeUnit(raw: string): string {
  return UNIT_MAP[raw] || raw;
}

function unitMatchesMedium(unit: string, medium: string): boolean {
  if (medium === 'heat' || medium === 'electricity') {
    return unit.startsWith('Energy ');
  }
  if (medium === 'water' || medium === 'warm_water' || medium === 'gas') {
    return unit.startsWith('Volume ') && !unit.startsWith('Volume flow');
  }
  return false;
}

function findPrimaryValue(records: MbusDataRecord[], medium: string): { value: number; unit: string } | null {
  // Current total: Instantaneous value, StorageNumber 0, Unit matching the medium.
  // Filter is required because some meters emit the Fabrication number as the
  // first Instantaneous/StorageNumber-0 record — it would otherwise win.
  const primary = records.find(r =>
    r.Function === 'Instantaneous value' &&
    r.StorageNumber === 0 &&
    typeof r.Value === 'number' &&
    unitMatchesMedium(r.Unit, medium)
  );

  if (primary && typeof primary.Value === 'number') {
    return { value: primary.Value, unit: normalizeUnit(primary.Unit) };
  }

  return null;
}

function round(n: number, precision = 10): number {
  return parseFloat(n.toPrecision(precision));
}

function volumeFactorToM3(unit: string): number | null {
  if (unit.startsWith('Volume flow')) return null;
  if (!unit.startsWith('Volume ')) return null;
  if (unit.includes('my m^3')) return 1e-6;
  if (unit.includes('m m^3')) return 1e-3;
  if (unit.includes('10 m^3')) return 10;
  if (unit.includes('100 m^3')) return 100;
  if (unit.includes('k m^3')) return 1000;
  if (unit.includes('m^3')) return 1;
  return null;
}

function volumeFlowFactorToM3h(unit: string): number | null {
  if (!unit.startsWith('Volume flow')) return null;
  if (unit.includes('m m^3/h')) return 1e-3;
  if (unit.includes('my m^3/h')) return 1e-6;
  if (unit.includes('m^3/h')) return 1;
  return null;
}

function energyFactorToKwh(unit: string): number | null {
  if (!unit.startsWith('Energy')) return null;
  if (unit.includes('MWh')) return 1000;
  if (unit.includes('100 kWh')) return 100;
  if (unit.includes('10 kWh')) return 10;
  if (unit.includes('kWh')) return 1;
  if (unit.includes('100 Wh')) return 0.1;
  if (unit.includes('10 Wh')) return 0.01;
  if (unit.includes('Wh')) return 1e-3;
  if (unit.includes('kJ')) return 1 / 3600;
  if (unit.includes('J')) return 1 / 3_600_000;
  return null;
}

// Only fill a slot once — first matching record wins. Meters often repeat
// records (e.g. trailing zero-filled placeholders); we want the real value.
function setOnce(obj: Record<string, number>, key: string, value: number): void {
  if (obj[key] === undefined) obj[key] = value;
}

function extractAttributes(records: MbusDataRecord[], medium: string): Record<string, number> {
  const attrs: Record<string, number> = {};
  if (medium !== 'heat') return attrs;

  for (const r of records) {
    if (typeof r.Value !== 'number') continue;
    const unit = r.Unit || '';
    const sn = r.StorageNumber ?? 0;
    const fn = r.Function;
    const isInst = fn === 'Instantaneous value';
    const isMax = fn === 'Maximum value';
    if (!isInst && !isMax) continue;

    const volF = volumeFactorToM3(unit);
    if (volF !== null && isInst) {
      const v = round(r.Value * volF);
      if (sn === 0) setOnce(attrs, 'volume_m3', v);
      else if (sn === 1) setOnce(attrs, 'volume_previous_m3', v);
      continue;
    }

    const flowF = volumeFlowFactorToM3h(unit);
    if (flowF !== null) {
      const v = round(r.Value * flowF);
      if (isMax) setOnce(attrs, 'flow_max_m3h', v);
      else setOnce(attrs, 'flow_m3h', v);
      continue;
    }

    const enF = energyFactorToKwh(unit);
    if (enF !== null && isInst && sn === 1) {
      setOnce(attrs, 'energy_previous_kwh', round(r.Value * enF));
      continue;
    }

    if (unit.startsWith('Power (kW)')) {
      const v = round(r.Value * 1000);
      if (isMax) setOnce(attrs, 'power_max_w', v);
      else setOnce(attrs, 'power_w', v);
    } else if (unit.startsWith('Power (W)')) {
      if (isMax) setOnce(attrs, 'power_max_w', r.Value);
      else setOnce(attrs, 'power_w', r.Value);
    } else if (unit.startsWith('Flow temperature')) {
      setOnce(attrs, 'flow_temp_c', r.Value);
    } else if (unit.startsWith('Return temperature')) {
      setOnce(attrs, 'return_temp_c', r.Value);
    } else if (unit.startsWith('Temperature Difference')) {
      const factor = unit.includes('1e-2') ? 0.01 : unit.includes('1e-3') ? 0.001 : 1;
      setOnce(attrs, 'temp_diff_k', round(r.Value * factor));
    } else if (unit.startsWith('On time')) {
      setOnce(attrs, 'on_time_days', r.Value);
    } else if (unit === 'Error flags') {
      setOnce(attrs, 'error_flags', r.Value);
    }
  }
  return attrs;
}

export async function readDevice(
  connection: MbusConnection,
  device: DeviceConfig
): Promise<MeterReading> {
  const log = getLogger();
  const data: MbusData = await connection.getData(device.secondary_address);
  const info = data.SlaveInformation;
  const records = data.DataRecord || [];

  const primary = findPrimaryValue(records, device.medium);
  if (!primary) {
    throw new Error(`No numeric value found for ${device.secondary_address}`);
  }

  const defaultFactor = device.medium === 'water' || device.medium === 'warm_water' ? 0.001 : 1;
  const factor = device.value_factor ?? defaultFactor;
  const raw = primary.value * factor;
  const value = factor !== 1 ? parseFloat(raw.toPrecision(10)) : raw;

  // Force canonical unit per medium: energy → kWh, water → m³.
  // Upstream value_factor is expected to scale raw into that unit.
  const unit = (device.medium === 'electricity' || device.medium === 'heat') ? 'kWh'
    : (device.medium === 'water' || device.medium === 'warm_water') ? 'm³'
    : primary.unit;

  log.debug(`Read ${device.name}: ${primary.value} ${primary.unit} (factor ${factor} → ${value} ${unit})`);

  const attributes = extractAttributes(records, device.medium);

  return {
    device_id: device.secondary_address,
    name: device.name,
    medium: device.medium,
    value,
    unit,
    timestamp: new Date().toISOString(),
    attributes,
    raw_records: records as unknown as Record<string, unknown>[],
  };
}
