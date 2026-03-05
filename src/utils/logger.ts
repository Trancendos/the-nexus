import pino from 'pino';
export const logger = pino({ name: 'the-nexus', level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV !== 'production' ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } } : undefined,
  base: { service: 'the-nexus' }, timestamp: pino.stdTimeFunctions.isoTime });
export default logger;