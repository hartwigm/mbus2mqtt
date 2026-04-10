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
import { cmdTestMqtt } from './commands/test-mqtt';

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

program
  .command('test-mqtt')
  .description('Alle Zähler lesen und sofort per MQTT senden (Diagnose)')
  .action(async () => {
    const config = loadConfig(program.opts().config);
    initLogger(config.logging.level, config.logging.file);
    await cmdTestMqtt(config);
  });

program
  .command('config')
  .description('Config-Datei im Editor öffnen')
  .action(async () => {
    const fs = require('fs');
    const { execSync } = require('child_process');
    const configPath = program.opts().config;
    const paths = configPath ? [configPath] : ['/etc/mbus2mqtt/config.yaml', './config.yaml'];
    const found = paths.find((p: string) => fs.existsSync(p));
    if (!found) {
      console.log(`  ❌ Config nicht gefunden. Gesucht: ${paths.join(', ')}`);
      return;
    }
    const editor = process.env.EDITOR || process.env.VISUAL || 'nano';
    try {
      execSync(`${editor} ${found}`, { stdio: 'inherit' });
    } catch {
      console.log(`  ❌ Editor "${editor}" konnte nicht gestartet werden`);
    }
  });

program
  .command('restart')
  .description('Dienst neu starten')
  .action(async () => {
    const { execSync } = require('child_process');
    const fs = require('fs');
    try {
      if (fs.existsSync('/run/systemd/system')) {
        execSync('sudo systemctl restart mbus2mqtt', { stdio: 'inherit' });
      } else {
        execSync('rc-service mbus2mqtt restart', { stdio: 'inherit' });
      }
      console.log('  ✅ mbus2mqtt neu gestartet');
    } catch {
      console.log('  ❌ Neustart fehlgeschlagen — evtl. sudo nötig?');
    }
  });

program.parse();
