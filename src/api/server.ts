/**
 * The Nexus — REST API Server
 * Integration hub, webhook receiver, event routing, subscriptions
 */

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors'; import helmet from 'helmet'; import morgan from 'morgan';
import { logger } from '../utils/logger';
import { integrationHub } from '../integration/integration-hub';
import type { IntegrationType } from '../integration/integration-hub';


// ============================================================================
// IAM MIDDLEWARE — Trancendos 2060 Standard (TRN-PROD-001)
// ============================================================================
import { createHash, createHmac } from 'crypto';

const IAM_JWT_SECRET = process.env.IAM_JWT_SECRET || process.env.JWT_SECRET || '';
const IAM_ALGORITHM = process.env.JWT_ALGORITHM || 'HS512';
const SERVICE_ID = 'nexus';
const MESH_ADDRESS = process.env.MESH_ADDRESS || 'nexus.agent.local';

function sha512Audit(data: string): string {
  return createHash('sha512').update(data).digest('hex');
}

function b64urlDecode(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(b64 + '='.repeat((4 - b64.length % 4) % 4), 'base64').toString('utf8');
}

interface JWTClaims {
  sub: string; email?: string; role?: string;
  active_role_level?: number; permissions?: string[];
  exp?: number; jti?: string;
}

function verifyIAMToken(token: string): JWTClaims | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [h, p, sig] = parts;
    const header = JSON.parse(b64urlDecode(h));
    const alg = header.alg === 'HS512' ? 'sha512' : 'sha256';
    const expected = createHmac(alg, IAM_JWT_SECRET)
      .update(`${h}.${p}`).digest('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    if (expected !== sig) return null;
    const claims = JSON.parse(b64urlDecode(p)) as JWTClaims;
    if (claims.exp && Date.now() / 1000 > claims.exp) return null;
    return claims;
  } catch { return null; }
}

function requireIAMLevel(maxLevel: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) { res.status(401).json({ error: 'Authentication required', service: SERVICE_ID }); return; }
    const claims = verifyIAMToken(token);
    if (!claims) { res.status(401).json({ error: 'Invalid or expired token', service: SERVICE_ID }); return; }
    const level = claims.active_role_level ?? 6;
    if (level > maxLevel) {
      console.log(JSON.stringify({ level: 'audit', decision: 'DENY', service: SERVICE_ID,
        principal: claims.sub, requiredLevel: maxLevel, actualLevel: level, path: req.path,
        integrityHash: sha512Audit(`DENY:${claims.sub}:${req.path}:${Date.now()}`),
        timestamp: new Date().toISOString() }));
      res.status(403).json({ error: 'Insufficient privilege level', required: maxLevel, actual: level });
      return;
    }
    (req as any).principal = claims;
    next();
  };
}

function iamRequestMiddleware(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Service-Id', SERVICE_ID);
  res.setHeader('X-Mesh-Address', MESH_ADDRESS);
  res.setHeader('X-IAM-Version', '1.0');
  next();
}

function iamHealthStatus() {
  return {
    iam: {
      version: '1.0', algorithm: IAM_ALGORITHM,
      status: IAM_JWT_SECRET ? 'configured' : 'unconfigured',
      meshAddress: MESH_ADDRESS,
      routingProtocol: process.env.MESH_ROUTING_PROTOCOL || 'static_port',
      cryptoMigrationPath: 'hmac_sha512 → ml_kem (2030) → hybrid_pqc (2040) → slh_dsa (2060)',
    },
  };
}
// ============================================================================
// END IAM MIDDLEWARE
// ============================================================================

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


// ═══════════════════════════════════════════════════════════════════════════════
// 2060 SMART RESILIENCE LAYER — Auto-wired by Trancendos Compliance Engine
// ═══════════════════════════════════════════════════════════════════════════════
import {
  SmartTelemetry,
  SmartEventBus,
  SmartCircuitBreaker,
  telemetryMiddleware,
  adaptiveRateLimitMiddleware,
  createHealthEndpoint,
  setupGracefulShutdown,
} from '../middleware/resilience-layer';

// Initialize 2060 singletons
const telemetry2060 = SmartTelemetry.getInstance();
const eventBus2060 = SmartEventBus.getInstance();
const circuitBreaker2060 = new SmartCircuitBreaker(`${SERVICE_ID}-primary`, {
  failureThreshold: 5,
  resetTimeoutMs: 30000,
  halfOpenMaxAttempts: 3,
});

// Wire telemetry middleware (request tracking + trace propagation)
app.use(telemetryMiddleware);

// Wire adaptive rate limiting (IAM-level aware)
app.use(adaptiveRateLimitMiddleware);

// 2060 Enhanced health endpoint with resilience status
app.get('/health/2060', createHealthEndpoint({
  serviceName: SERVICE_ID,
  meshAddress: MESH_ADDRESS,
  getCustomHealth: () => ({
    circuitBreaker: circuitBreaker2060.getState(),
    eventBusListeners: eventBus2060.listenerCount(),
    telemetryMetrics: telemetry2060.getMetricNames().length,
  }),
}));

// Prometheus text format metrics export
app.get('/metrics/prometheus', (_req: any, res: any) => {
  res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.send(telemetry2060.exportPrometheus());
});

// Emit service lifecycle events
eventBus2060.emit('service.2060.wired', {
  serviceId: SERVICE_ID,
  meshAddress: MESH_ADDRESS,
  timestamp: new Date().toISOString(),
  features: ['telemetry', 'rate-limiting', 'circuit-breaker', 'event-bus', 'prometheus-export'],
});

// ═══════════════════════════════════════════════════════════════════════════════
// END 2060 SMART RESILIENCE LAYER
// ═══════════════════════════════════════════════════════════════════════════════

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => { logger.error({ err }, 'Unhandled error'); res.status(500).json({ error: err.message }); });
  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  return app;
}