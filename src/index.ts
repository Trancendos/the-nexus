/**
 * The Nexus — Main Entry Point
 * Integration hub and event routing for the Trancendos mesh.
 * Architecture: Trancendos Industry 6.0 / 2060 Standard
 */
import { logger } from './utils/logger';
import { createServer } from './api/server';
import { integrationHub } from './integration/integration-hub';

const PORT = parseInt(process.env.PORT || '3014', 10);
const HOST = process.env.HOST || '0.0.0.0';

async function bootstrap(): Promise<void> {
  logger.info({ service: 'the-nexus', port: PORT }, 'The Nexus bootstrapping — connecting the mesh...');
  const stats = integrationHub.getStats();
  logger.info({ integrations: stats.totalIntegrations, active: stats.activeIntegrations }, 'Integration hub verified');
  const app = createServer();
  const server = app.listen(PORT, HOST, () => logger.info({ host: HOST, port: PORT }, 'The Nexus listening — all connections active'));
  const shutdown = (signal: string) => { logger.info({ signal }, 'Shutdown'); server.close(() => { logger.info('The Nexus shutdown complete'); process.exit(0); }); setTimeout(() => process.exit(1), 10_000); };
  process.on('SIGTERM', () => shutdown('SIGTERM')); process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('uncaughtException', (err) => { logger.error({ err }, 'Uncaught exception'); shutdown('uncaughtException'); });
  process.on('unhandledRejection', (reason) => { logger.error({ reason }, 'Unhandled rejection'); });
}
bootstrap().catch((err) => { logger.error({ err }, 'Bootstrap failed'); process.exit(1); });