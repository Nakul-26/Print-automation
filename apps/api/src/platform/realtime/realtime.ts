import type { Server as HttpServer } from 'node:http';
import { createAdapter } from '@socket.io/postgres-adapter';
import type { Pool } from 'pg';
import { Server } from 'socket.io';
import type { Logger } from '../observability/logger.js';

/** The connected browser, as seen by an event handler. */
export interface RealtimeClient {
  /** The signed-in user, or null for an anonymous visitor such as a student. */
  userId: string | null;
  join(room: string): void;
  leave(room: string): void;
}

export type RealtimeHandler = (
  client: RealtimeClient,
  payload: unknown,
) => Promise<unknown> | unknown;

/** A print agent connected to the `/agent` namespace, already authenticated by its device token. */
export interface AgentClient {
  deviceId: string;
  shopId: string;
}

export type AgentHandler = (agent: AgentClient, payload: unknown) => Promise<unknown> | unknown;

/** The shop PCs' print agents: authenticated by device token, addressed by device id. */
export interface AgentGateway {
  /** Accept an agent event. Same acknowledgement rules as browser events. */
  handle(event: string, handler: AgentHandler): void;
  /** Called after an agent has connected (and any older connection of the same device was dropped). */
  onConnect(callback: (agent: AgentClient) => void | Promise<void>): void;
  onDisconnect(callback: (agent: AgentClient) => void | Promise<void>): void;
  /** Sends to a device if it is connected (to whichever web process holds the connection). */
  send(deviceId: string, event: string, payload: unknown): void;
  isOnline(deviceId: string): Promise<boolean>;
  /** Drops the device's connection (when it is removed from the shop). */
  disconnect(deviceId: string): void;
  /** Drops every device of a shop (when the shop is suspended). */
  disconnectShop(shopId: string): void;
}

/**
 * Live connections to browsers. The gateway knows nothing about orders or shops: feature modules
 * register the events they accept and publish to rooms they name. Events carry no personal data;
 * clients refetch over HTTP, where authorisation is enforced, so a missed event only costs a refresh.
 */
export interface Realtime {
  /** Accept a client event. The return value is sent back as the acknowledgement; a throw becomes `{ error }`. */
  handle(event: string, handler: RealtimeHandler): void;
  emit(room: string, event: string, payload?: unknown): void;
  /** Drops every connection of a user (on sign-out), so access ends with the session. */
  disconnectUser(userId: string): void;
  /** Drops every connection in a room, on any web process (when a shop is suspended). */
  disconnectRoom(room: string): void;
  /** Starts accepting connections on an existing HTTP server. Until then `emit` does nothing. */
  attach(server: HttpServer): void;
  /**
   * For a process that serves no browsers (the job worker): `emit` is relayed through
   * PostgreSQL to the web processes that hold the connections.
   */
  attachEmitterOnly(): void;
  readonly agents: AgentGateway;
  close(): Promise<void>;
}

export function createRealtime(deps: {
  logger: Logger;
  /** Browsers may connect only from this origin. */
  allowedOrigin: string;
  /** Turns the handshake's Cookie header into a user id, or null. */
  authenticate: (cookieHeader: string | undefined) => Promise<string | null>;
  /** Turns an agent's device token into the device, or null. */
  authenticateAgent?: (token: string) => Promise<AgentClient | null>;
  /** Shares events between processes (web and worker) through PostgreSQL. */
  pool?: Pool;
}): Realtime {
  const handlers = new Map<string, RealtimeHandler>();
  const agentHandlers = new Map<string, AgentHandler>();
  const agentConnectCallbacks: ((agent: AgentClient) => void | Promise<void>)[] = [];
  const agentDisconnectCallbacks: ((agent: AgentClient) => void | Promise<void>)[] = [];
  const agentRoom = (deviceId: string): string => `agent:${deviceId}`;
  const agentShopRoom = (shopId: string): string => `agent-shop:${shopId}`;
  const logSafely = (what: string) => (err: unknown) =>
    deps.logger.error({ err }, `agent ${what} callback failed`);
  const agents: AgentGateway = {
    handle: (event, handler) => void agentHandlers.set(event, handler),
    onConnect: (callback) => void agentConnectCallbacks.push(callback),
    onDisconnect: (callback) => void agentDisconnectCallbacks.push(callback),
    send: (deviceId, event, payload) =>
      void io?.of('/agent').to(agentRoom(deviceId)).emit(event, payload),
    isOnline: async (deviceId) =>
      io ? (await io.of('/agent').in(agentRoom(deviceId)).fetchSockets()).length > 0 : false,
    disconnect: (deviceId) => void io?.of('/agent').in(agentRoom(deviceId)).disconnectSockets(true),
    disconnectShop: (shopId) =>
      void io?.of('/agent').in(agentShopRoom(shopId)).disconnectSockets(true),
  };
  let io: Server | null = null;
  let emitterOnly = false;

  return {
    agents,
    handle(event, handler) {
      handlers.set(event, handler);
    },

    emit(room, event, payload) {
      io?.to(room).emit(event, payload);
    },

    disconnectUser(userId) {
      if (!io) return;
      for (const socket of io.sockets.sockets.values()) {
        if (socket.data['userId'] === userId) socket.disconnect(true);
      }
    },

    disconnectRoom(room) {
      io?.in(room).disconnectSockets(true);
    },

    attachEmitterOnly() {
      const emitter = new Server();
      if (deps.pool) emitter.adapter(createAdapter(deps.pool));
      io = emitter;
      emitterOnly = true;
    },

    attach(server) {
      io = new Server(server, {
        // The proxy serves the app and the API from one origin, so no wildcard CORS is needed.
        cors: { origin: deps.allowedOrigin, credentials: true },
        allowRequest: (req, callback) => {
          const origin = req.headers.origin;
          callback(null, origin === undefined || origin === deps.allowedOrigin);
        },
        maxHttpBufferSize: 100_000,
      });
      if (deps.pool) io.adapter(createAdapter(deps.pool));

      io.use((socket, next) => {
        deps
          .authenticate(socket.handshake.headers.cookie)
          .then((userId) => {
            socket.data['userId'] = userId;
            next();
          })
          .catch((err: unknown) => next(err instanceof Error ? err : new Error('auth failed')));
      });

      const agentNamespace = io.of('/agent');
      agentNamespace.use((socket, next) => {
        const token = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
        if (typeof token !== 'string' || !deps.authenticateAgent) {
          next(new Error('unauthorized'));
          return;
        }
        deps
          .authenticateAgent(token)
          .then((agent) => {
            if (!agent) return next(new Error('unauthorized'));
            socket.data['agent'] = agent;
            next();
          })
          .catch((err: unknown) => next(err instanceof Error ? err : new Error('auth failed')));
      });
      agentNamespace.on('connection', (socket) => {
        const agent = socket.data['agent'] as AgentClient;
        // One live connection per device: a reconnect replaces the stale one.
        void agentNamespace
          .in(agentRoom(agent.deviceId))
          .fetchSockets()
          .then((others) => {
            for (const other of others) if (other.id !== socket.id) other.disconnect(true);
          })
          .catch(logSafely('replace'))
          .then(() => socket.join([agentRoom(agent.deviceId), agentShopRoom(agent.shopId)]))
          .then(() => Promise.all(agentConnectCallbacks.map((cb) => cb(agent))))
          .catch(logSafely('connect'));
        for (const [event, handler] of agentHandlers) {
          socket.on(event, (payload: unknown, ack?: unknown) => {
            const reply = typeof ack === 'function' ? (ack as (r: unknown) => void) : () => {};
            Promise.resolve()
              .then(() => handler(agent, payload))
              .then((result) => reply({ ok: true, ...(result as object | undefined) }))
              .catch((err: unknown) => {
                reply({ ok: false, error: err instanceof Error ? err.message : 'failed' });
              });
          });
        }
        socket.on('disconnect', () => {
          void Promise.all(agentDisconnectCallbacks.map((cb) => cb(agent))).catch(
            logSafely('disconnect'),
          );
        });
      });

      io.on('connection', (socket) => {
        const client: RealtimeClient = {
          userId: (socket.data['userId'] as string | null) ?? null,
          join: (room) => void socket.join(room),
          leave: (room) => void socket.leave(room),
        };
        for (const [event, handler] of handlers) {
          socket.on(event, (payload: unknown, ack?: unknown) => {
            const reply = typeof ack === 'function' ? (ack as (r: unknown) => void) : () => {};
            Promise.resolve()
              .then(() => handler(client, payload))
              .then((result) => reply({ ok: true, ...(result as object | undefined) }))
              .catch((err: unknown) => {
                const message = err instanceof Error ? err.message : 'failed';
                reply({ ok: false, error: message });
              });
          });
        }
      });
    },

    async close() {
      if (!io) return;
      const server = io;
      io = null;
      if (emitterOnly) {
        // No HTTP server or engine to shut down: just stop listening to the database.
        await server.of('/').adapter.close?.();
        return;
      }
      await new Promise<void>((resolve) => void server.close(() => resolve()));
    },
  };
}
