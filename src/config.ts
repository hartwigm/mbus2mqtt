import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { Config } from './types';

const CONFIG_PATHS = [
  '/etc/mbus2mqtt/config.yaml',
  path.join(process.cwd(), 'config.yaml'),
];

export function loadConfig(configPath?: string): Config {
  const candidates = configPath ? [configPath] : CONFIG_PATHS;

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, 'utf-8');
      const cfg = yaml.load(raw) as Partial<Config>;
      return validate(cfg, p);
    }
  }

  throw new Error(`No config found. Searched: ${candidates.join(', ')}`);
}

function validate(cfg: Partial<Config>, filePath: string): Config {
  if (!cfg.property) throw new Error(`config: 'property' is required`);
  if (!cfg.mqtt?.broker) throw new Error(`config: 'mqtt.broker' is required`);
  if (!cfg.ports?.length) throw new Error(`config: at least one port is required`);
  if (!cfg.devices?.length) throw new Error(`config: at least one device is required`);

  for (const dev of cfg.devices!) {
    const port = cfg.ports!.find(p => p.alias === dev.port);
    if (!port) {
      throw new Error(`config: device ${dev.secondary_address} references unknown port '${dev.port}'`);
    }
  }

  return {
    property: cfg.property,
    mqtt: {
      broker: cfg.mqtt!.broker,
      username: cfg.mqtt!.username || '',
      password: cfg.mqtt!.password || '',
      client_id: cfg.mqtt!.client_id || `mbus2mqtt-${cfg.property}`,
    },
    ports: cfg.ports!,
    devices: cfg.devices!,
    read_interval_minutes: cfg.read_interval_minutes || 15,
    logging: {
      level: cfg.logging?.level || 'info',
      file: cfg.logging?.file,
    },
    state_file: cfg.state_file || '/var/lib/mbus2mqtt/state.json',
  };
}
