import { DeviceState } from '../types';

export function shouldPublishHA(state: DeviceState, valueChanged: boolean): boolean {
  // Publish to HA on value change
  if (valueChanged) return true;

  // Publish daily even without change
  if (!state.last_ha_publish) return true;
  const last = new Date(state.last_ha_publish);
  const now = new Date();
  return now.getTime() - last.getTime() > 24 * 60 * 60 * 1000;
}

export function shouldPublishHouseAiHourly(state: DeviceState): boolean {
  if (!state.last_houseai_hourly) return true;
  const last = new Date(state.last_houseai_hourly);
  const now = new Date();
  return now.getHours() !== last.getHours() || now.getTime() - last.getTime() > 60 * 60 * 1000;
}

export function shouldPublishHouseAiDaily(): boolean {
  const now = new Date();
  return now.getHours() === 23 && now.getMinutes() >= 55;
}

export function isDailyWindow(): boolean {
  const now = new Date();
  return now.getHours() === 23 && now.getMinutes() >= 55;
}
