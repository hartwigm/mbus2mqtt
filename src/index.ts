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
  .option('-e, --extended', 'Alle Baudraten testen (300–38400)')
  .action(async (opts) => {
    const config = loadConfig(program.opts().config);
    initLogger(config.logging.level, config.logging.file);
    await cmdScan(config, opts.extended || false);
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
