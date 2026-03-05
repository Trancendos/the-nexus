/**
 * The Nexus — Integration Hub
 *
 * Central connection point for all external integrations, webhooks,
 * event routing, and service-to-service communication in the Trancendos mesh.
 *
 * Architecture: Trancendos Industry 6.0 / 2060 Standard
 */

import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger';

export type IntegrationType = 'webhook' | 'api' | 'event_bus' | 'message_queue' | 'stream' | 'database' | 'file_sync';
export type IntegrationStatus = 'active' | 'inactive' | 'error' | 'rate_limited' | 'configuring';
export type EventType = string;

export interface Integration {
  id: string;
  name: string;
  type: IntegrationType;
  description: string;
  endpoint?: string;
  status: IntegrationStatus;
  config: Record<string, unknown>;
  tags: string[];
  lastActivity?: Date;
  errorCount: number;
  successCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WebhookEvent {
  id: string;
  integrationId: string;
  eventType: EventType;
  payload: Record<string, unknown>;
  headers: Record<string, string>;
  status: 'received' | 'processing' | 'processed' | 'failed' | 'retrying';
  retryCount: number;
  receivedAt: Date;
  processedAt?: Date;
  error?: string;
}

export interface EventSubscription {
  id: string;
  eventType: EventType;
  subscriberId: string;
  callbackUrl?: string;
  filter?: Record<string, unknown>;
  active: boolean;
  createdAt: Date;
}

export interface RoutingRule {
  id: string;
  name: string;
  eventType: EventType;
  sourceIntegrationId?: string;
  targetIntegrationIds: string[];
  transform?: string;
  filter?: Record<string, unknown>;
  priority: number;
  enabled: boolean;
}

export interface NexusStats {
  totalIntegrations: number;
  activeIntegrations: number;
  totalEvents: number;
  processedEvents: number;
  failedEvents: number;
  totalSubscriptions: number;
  activeSubscriptions: number;
  routingRules: number;
}

export class IntegrationHub {
  private integrations: Map<string, Integration> = new Map();
  private events: Map<string, WebhookEvent> = new Map();
  private subscriptions: Map<string, EventSubscription> = new Map();
  private routingRules: Map<string, RoutingRule> = new Map();
  private eventHandlers: Map<EventType, Array<(event: WebhookEvent) => Promise<void>>> = new Map();

  constructor() {
    this.seedDefaultIntegrations();
    logger.info({ integrations: this.integrations.size }, 'IntegrationHub initialised');
  }

  // Integrations
  addIntegration(params: Omit<Integration, 'id' | 'errorCount' | 'successCount' | 'createdAt' | 'updatedAt'>): Integration {
    const integration: Integration = { ...params, id: uuidv4(), errorCount: 0, successCount: 0, createdAt: new Date(), updatedAt: new Date() };
    this.integrations.set(integration.id, integration);
    logger.info({ integrationId: integration.id, name: integration.name, type: integration.type }, 'Integration added');
    return integration;
  }

  getIntegration(id: string): Integration | undefined { return this.integrations.get(id); }
  getIntegrations(type?: IntegrationType): Integration[] {
    const all = Array.from(this.integrations.values());
    return type ? all.filter(i => i.type === type) : all;
  }

  updateIntegrationStatus(id: string, status: IntegrationStatus): boolean {
    const integration = this.integrations.get(id);
    if (!integration) return false;
    integration.status = status; integration.updatedAt = new Date();
    return true;
  }

  removeIntegration(id: string): boolean { return this.integrations.delete(id); }

  // Events
  async receiveEvent(params: { integrationId: string; eventType: EventType; payload: Record<string, unknown>; headers?: Record<string, string> }): Promise<WebhookEvent> {
    const event: WebhookEvent = {
      id: uuidv4(), integrationId: params.integrationId, eventType: params.eventType,
      payload: params.payload, headers: params.headers || {}, status: 'received',
      retryCount: 0, receivedAt: new Date(),
    };
    this.events.set(event.id, event);
    logger.info({ eventId: event.id, eventType: event.eventType, integrationId: event.integrationId }, 'Event received');

    // Route event
    await this.routeEvent(event);
    return event;
  }

  private async routeEvent(event: WebhookEvent): Promise<void> {
    event.status = 'processing';
    try {
      // Apply routing rules
      const rules = Array.from(this.routingRules.values())
        .filter(r => r.enabled && (r.eventType === event.eventType || r.eventType === '*'))
        .sort((a, b) => b.priority - a.priority);

      for (const rule of rules) {
        for (const targetId of rule.targetIntegrationIds) {
          const target = this.integrations.get(targetId);
          if (target) { target.successCount++; target.lastActivity = new Date(); }
        }
      }

      // Notify subscribers
      const subs = Array.from(this.subscriptions.values()).filter(s => s.active && (s.eventType === event.eventType || s.eventType === '*'));
      for (const sub of subs) {
        const handlers = this.eventHandlers.get(event.eventType) || [];
        for (const handler of handlers) {
          try { await handler(event); } catch { /* non-fatal */ }
        }
      }

      // Update source integration
      const source = this.integrations.get(event.integrationId);
      if (source) { source.successCount++; source.lastActivity = new Date(); }

      event.status = 'processed'; event.processedAt = new Date();
    } catch (err) {
      event.status = 'failed'; event.error = err instanceof Error ? err.message : String(err);
      const source = this.integrations.get(event.integrationId);
      if (source) source.errorCount++;
      logger.error({ eventId: event.id, err }, 'Event routing failed');
    }
  }

  getEvents(filters?: { integrationId?: string; eventType?: string; status?: WebhookEvent['status']; limit?: number }): WebhookEvent[] {
    let events = Array.from(this.events.values());
    if (filters?.integrationId) events = events.filter(e => e.integrationId === filters.integrationId);
    if (filters?.eventType) events = events.filter(e => e.eventType === filters.eventType);
    if (filters?.status) events = events.filter(e => e.status === filters.status);
    events.sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());
    return filters?.limit ? events.slice(0, filters.limit) : events;
  }

  // Subscriptions
  subscribe(params: Omit<EventSubscription, 'id' | 'createdAt'>): EventSubscription {
    const sub: EventSubscription = { ...params, id: uuidv4(), createdAt: new Date() };
    this.subscriptions.set(sub.id, sub);
    return sub;
  }

  unsubscribe(id: string): boolean { return this.subscriptions.delete(id); }
  getSubscriptions(eventType?: string): EventSubscription[] {
    const all = Array.from(this.subscriptions.values());
    return eventType ? all.filter(s => s.eventType === eventType) : all;
  }

  // Routing rules
  addRoutingRule(rule: Omit<RoutingRule, 'id'>): RoutingRule {
    const full: RoutingRule = { ...rule, id: uuidv4() };
    this.routingRules.set(full.id, full);
    return full;
  }

  getRoutingRules(): RoutingRule[] { return Array.from(this.routingRules.values()); }
  deleteRoutingRule(id: string): boolean { return this.routingRules.delete(id); }

  // Event handlers (in-process)
  on(eventType: EventType, handler: (event: WebhookEvent) => Promise<void>): void {
    const handlers = this.eventHandlers.get(eventType) || [];
    handlers.push(handler);
    this.eventHandlers.set(eventType, handlers);
  }

  getStats(): NexusStats {
    const integrations = Array.from(this.integrations.values());
    const events = Array.from(this.events.values());
    const subs = Array.from(this.subscriptions.values());
    return {
      totalIntegrations: integrations.length, activeIntegrations: integrations.filter(i => i.status === 'active').length,
      totalEvents: events.length, processedEvents: events.filter(e => e.status === 'processed').length,
      failedEvents: events.filter(e => e.status === 'failed').length,
      totalSubscriptions: subs.length, activeSubscriptions: subs.filter(s => s.active).length,
      routingRules: this.routingRules.size,
    };
  }

  private seedDefaultIntegrations(): void {
    const defaults = [
      { name: 'cornelius-ai', type: 'api' as IntegrationType, description: 'Orchestrator agent', endpoint: 'http://cornelius-ai:3000', status: 'active' as IntegrationStatus, config: {}, tags: ['agent', 'core'] },
      { name: 'guardian-ai', type: 'api' as IntegrationType, description: 'IAM gateway', endpoint: 'http://guardian-ai:3004', status: 'active' as IntegrationStatus, config: {}, tags: ['agent', 'security'] },
      { name: 'the-observatory', type: 'api' as IntegrationType, description: 'Analytics engine', endpoint: 'http://the-observatory:3012', status: 'active' as IntegrationStatus, config: {}, tags: ['platform', 'analytics'] },
    ];
    for (const d of defaults) this.addIntegration(d);
  }
}

export const integrationHub = new IntegrationHub();