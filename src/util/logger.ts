import pino from 'pino';

let logger: pino.Logger;

export function initLogger(level: string, file?: string): pino.Logger {
  const targets: pino.TransportTargetOptions[] = [
    { target: 'pino-pretty', options: { colorize: true }, level },
  ];

  if (file) {
    targets.push({ target: 'pino/file', options: { destination: file, mkdir: true }, level });
  }

  logger = pino({ level }, pino.transport({ targets }));
  return logger;
}

export function getLogger(): pino.Logger {
  if (!logger) {
    logger = pino({ level: 'info' }, pino.transport({
      target: 'pino-pretty',
      options: { colorize: true },
    }));
  }
  return logger;
}
