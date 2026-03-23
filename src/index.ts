#!/usr/bin/env node

import { Command } from 'commander';
import { loadConfig } from './config';
import { initLogger } from './util/logger';
import { cmdScan } from './commands/scan';
import { cmdList } from './commands/list';
import { cmdRead } from './commands/read';
import { cmdRun } from './commands/run';
import { cmdUpdate } from './commands/update';
import { cmdSetup } from './commands/setup';

const program = new Command();

program
  .name('mbus2mqtt')
  .description('M-Bus meter reader with MQTT publishing')
  .version('1.0.0')
  .option('-c, --config <path>', 'path to config file');

program
  .command('scan')
  .description('Scan all configured ports for M-Bus devices')
  .option('-e, --extended', 'Alle Baudraten testen (300–921600)')
  .option('-p, --port <alias>', 'Nur diesen Port scannen (z.B. usb0, usb1)')
  .option('-a, --add', 'Gefundene Geräte automatisch in Config aufnehmen')
  .action(async (opts) => {
    const configPath = program.opts().config;
    const config = loadConfig(configPath);
    initLogger(config.logging.level, config.logging.file);
    await cmdScan(config, opts.extended || false, opts.port, opts.add || false, configPath);
  });

program
  .command('list')
  .description('Show configured devices and last readings')
  .action(async () => {
    const config = loadConfig(program.opts().config);
    initLogger(config.logging.level, config.logging.file);
    await cmdList(config);
  });

program
  .command('read <device-id>')
  .description('Read a single device by secondary address')
  .action(async (deviceId: string) => {
    const config = loadConfig(program.opts().config);
    initLogger(config.logging.level, config.logging.file);
    await cmdRead(config, deviceId);
  });

program
  .command('run')
  .description('Start daemon: read meters and publish to MQTT')
  .action(async () => {
    const config = loadConfig(program.opts().config);
    initLogger(config.logging.level, config.logging.file);
    await cmdRun(config);
  });

program
  .command('update')
  .description('Update mbus2mqtt from GitHub and restart service')
  .action(async () => {
    await cmdUpdate();
  });

program
  .command('setup')
  .description('USB-Adapter erkennen und Ports konfigurieren')
  .action(async () => {
    const configPath = program.opts().config || '/opt/mbus2mqtt/config/config.yaml';
    await cmdSetup(configPath);
  });

program.parse();
