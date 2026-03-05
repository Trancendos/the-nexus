/**
 * The Nexus — REST API Server
 * Integration hub, webhook receiver, event routing, subscriptions
 */

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors'; import helmet from 'helmet'; import morgan from 'morgan';
import { logger } from '../utils/logger';
import { integrationHub } from '../integration/integration-hub';
import type { IntegrationType } from '../integration/integration-hub';

export function createServer(): express.Application {
  const app = express();
  app.use(helmet()); app.use(cors()); app.use(express.json({ limit: '2mb' }));
  app.use(morgan('combined', { stream: { write: (m: string) => logger.info({ http: m.trim() }, 'HTTP') } }));

  app.get('/health', (_req, res) => res.json({ status: 'healthy', service: 'the-nexus', uptime: process.uptime(), timestamp: new Date().toISOString(), ...integrationHub.getStats() }));
  app.get('/metrics', (_req, res) => { const mem = process.memoryUsage(); res.json({ service: 'the-nexus', uptime: process.uptime(), memory: { heapUsedMb: Math.round(mem.heapUsed/1024/1024) }, stats: integrationHub.getStats() }); });

  // Integrations
  app.get('/api/v1/integrations', (req, res) => res.json({ integrations: integrationHub.getIntegrations(req.query.type as IntegrationType) }));
  app.post('/api/v1/integrations', (req, res) => { try { res.status(201).json(integrationHub.addIntegration(req.body)); } catch (err) { res.status(500).json({ error: String(err) }); } });
  app.get('/api/v1/integrations/:id', (req, res) => { const i = integrationHub.getIntegration(req.params.id); if (!i) return res.status(404).json({ error: 'Not found' }); return res.json(i); });
  app.patch('/api/v1/integrations/:id/status', (req, res) => { const ok = integrationHub.updateIntegrationStatus(req.params.id, req.body.status); res.json({ updated: ok }); });
  app.delete('/api/v1/integrations/:id', (req, res) => res.json({ deleted: integrationHub.removeIntegration(req.params.id) }));

  // Webhook receiver
  app.post('/api/v1/webhooks/:integrationId', async (req, res) => {
    try {
      const event = await integrationHub.receiveEvent({ integrationId: req.params.integrationId, eventType: req.headers['x-event-type'] as string || 'webhook', payload: req.body, headers: req.headers as Record<string, string> });
      res.status(202).json({ eventId: event.id, status: event.status });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // Events
  app.get('/api/v1/events', (req, res) => res.json({ events: integrationHub.getEvents({ integrationId: req.query.integrationId as string, eventType: req.query.eventType as string, status: req.query.status as 'received' | undefined, limit: req.query.limit ? parseInt(req.query.limit as string) : 100 }) }));

  // Subscriptions
  app.get('/api/v1/subscriptions', (req, res) => res.json({ subscriptions: integrationHub.getSubscriptions(req.query.eventType as string) }));
  app.post('/api/v1/subscriptions', (req, res) => { try { res.status(201).json(integrationHub.subscribe(req.body)); } catch (err) { res.status(500).json({ error: String(err) }); } });
  app.delete('/api/v1/subscriptions/:id', (req, res) => res.json({ deleted: integrationHub.unsubscribe(req.params.id) }));

  // Routing rules
  app.get('/api/v1/routing-rules', (_req, res) => res.json({ rules: integrationHub.getRoutingRules() }));
  app.post('/api/v1/routing-rules', (req, res) => { try { res.status(201).json(integrationHub.addRoutingRule(req.body)); } catch (err) { res.status(500).json({ error: String(err) }); } });
  app.delete('/api/v1/routing-rules/:id', (req, res) => res.json({ deleted: integrationHub.deleteRoutingRule(req.params.id) }));

  app.get('/api/v1/stats', (_req, res) => res.json(integrationHub.getStats()));

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => { logger.error({ err }, 'Unhandled error'); res.status(500).json({ error: err.message }); });
  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  return app;
}