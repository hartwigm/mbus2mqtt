import * as fs from 'fs';
import * as path from 'path';
import { DeviceState, StateStore } from '../types';

const DEFAULT_STATE: DeviceState = {
  last_value: null,
  last_unit: '',
  last_read: null,
  last_ha_publish: null,
  last_houseai_hourly: null,
  last_houseai_daily: null,
  read_errors: 0,
};

export class ReadingsStore {
  private state: StateStore = {};
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        this.state = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      }
    } catch {
      this.state = {};
    }
  }

  save(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }

  get(deviceId: string): DeviceState {
    return this.state[deviceId] || { ...DEFAULT_STATE };
  }

  update(deviceId: string, partial: Partial<DeviceState>): void {
    this.state[deviceId] = { ...this.get(deviceId), ...partial };
  }

  hasValueChanged(deviceId: string, newValue: number): boolean {
    const prev = this.state[deviceId]?.last_value;
    return prev === null || prev === undefined || prev !== newValue;
  }

  getAll(): StateStore {
    return { ...this.state };
  }
}
