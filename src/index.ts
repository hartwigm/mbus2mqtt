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
import { cmdConfigHA } from './commands/config-ha';

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
  .option('-r, --read', 'Vor der Anzeige alle Zähler lesen und Werte speichern')
  .option('-m, --mqtt', 'Gelesene Werte zusätzlich per MQTT senden (nur mit --read)')
  .action(async (opts) => {
    const config = loadConfig(program.opts().config);
    initLogger(config.logging.level, config.logging.file);
    if (opts.mqtt && !opts.read) {
      console.error('  ❌ --mqtt erfordert --read');
      process.exit(1);
    }
    await cmdList(config, opts.read || false, opts.mqtt || false);
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
  .command('config-ha')
  .description('Home Assistant Discovery anzeigen, bereinigen oder neu senden')
  .option('--clean', 'Alte retained Discovery-Messages vom Broker löschen')
  .option('--reset', 'Löschen + Discovery neu senden')
  .action(async (opts) => {
    const config = loadConfig(program.opts().config);
    initLogger(config.logging.level, config.logging.file);
    await cmdConfigHA(config, opts);
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

function serviceAction(action: 'start' | 'stop' | 'restart' | 'status'): void {
  const { execSync } = require('child_process');
  const fs = require('fs');
  const isSystemd = fs.existsSync('/run/systemd/system');
  const cmd = isSystemd
    ? `sudo systemctl ${action} mbus2mqtt`
    : `rc-service mbus2mqtt ${action}`;
  try {
    execSync(cmd, { stdio: 'inherit' });
    if (action !== 'status') {
      const msg = { start: 'gestartet', stop: 'gestoppt', restart: 'neu gestartet' }[action];
      console.log(`  ✅ mbus2mqtt ${msg}`);
    }
  } catch {
    console.log(`  ❌ ${action} fehlgeschlagen — evtl. sudo nötig?`);
  }
}

program
  .command('start')
  .description('Dienst starten')
  .action(() => serviceAction('start'));

program
  .command('stop')
  .description('Dienst stoppen')
  .action(() => serviceAction('stop'));

program
  .command('restart')
  .description('Dienst neu starten')
  .action(() => serviceAction('restart'));

program
  .command('status')
  .description('Dienst-Status anzeigen')
  .action(() => serviceAction('status'));

program.parse();
