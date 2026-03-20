import { Config } from '../types';
import { PortManager } from '../mbus/port-manager';
import { MqttPublisher } from '../mqtt/client';
import { ReadingsStore } from '../store/readings-store';
import { Scheduler } from '../scheduler/scheduler';
import { getLogger } from '../util/logger';

export async function cmdRun(config: Config): Promise<void> {
  const log = getLogger();
  log.info(`mbus2mqtt starting for property: ${config.property}`);

  const portManager = new PortManager(config);
  const mqttClient = new MqttPublisher(config.mqtt);
  const store = new ReadingsStore(config.state_file);
  const scheduler = new Scheduler(config, portManager, mqttClient, store);

  // Graceful shutdown
  const shutdown = async () => {
    log.info('Shutting down...');
    scheduler.stop();
    await portManager.disconnectAll();
    await mqttClient.disconnect();
    store.save();
    log.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  try {
    await portManager.connectAll();
    await mqttClient.connect();
    await scheduler.publishDiscovery();
    scheduler.start();

    // Re-publish discovery every 6 hours
    setInterval(() => {
      scheduler.publishDiscovery().catch(err => log.error(`Discovery error: ${err}`));
    }, 6 * 60 * 60 * 1000);

  } catch (err) {
    log.error(`Startup failed: ${err}`);
    await shutdown();
  }
}
