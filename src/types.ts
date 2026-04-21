export interface PortConfig {
  path: string;
  alias: string;
  baud_rate: number;
}

export interface DeviceConfig {
  secondary_address: string;
  port: string;
  name: string;
  medium: 'water' | 'warm_water' | 'heat' | 'gas' | 'electricity';
  value_factor?: number;
  read_interval_minutes?: number;
  baud_rate?: number;
}

export interface MqttConfig {
  broker: string;
  username: string;
  password: string;
  client_id?: string;
}

export interface WebConfig {
  enabled: boolean;
  port: number;
  bind: string;
  password: string;
  auth_log: string;
}

export interface Config {
  property: string;
  mqtt: MqttConfig;
  ports: PortConfig[];
  devices: DeviceConfig[];
  read_interval_minutes: number;
  logging: {
    level: string;
    file?: string;
  };
  state_file: string;
  web: WebConfig;
}

export interface MeterReading {
  device_id: string;
  name: string;
  medium: string;
  value: number;
  unit: string;
  timestamp: string;
  attributes?: Record<string, number>;
  raw_records?: Record<string, unknown>[];
}

export interface DeviceState {
  last_value: number | null;
  last_unit: string;
  last_read: string | null;
  last_ha_publish: string | null;
  last_houseai_hourly: string | null;
  last_houseai_daily: string | null;
  read_errors: number;
}

export type StateStore = Record<string, DeviceState>;
