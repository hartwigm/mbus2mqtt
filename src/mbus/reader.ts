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

  return {
    device_id: device.secondary_address,
    name: device.name,
    medium: device.medium,
    value,
    unit,
    timestamp: new Date().toISOString(),
    raw_records: records as unknown as Record<string, unknown>[],
  };
}
