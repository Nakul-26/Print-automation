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
  /** Starts accepting connections on an existing HTTP server. Until then `emit` does nothing. */
  attach(server: HttpServer): void;
  /**
   * For a process that serves no browsers (the job worker): `emit` is relayed through
   * PostgreSQL to the web processes that hold the connections.
   */
  attachEmitterOnly(): void;
  close(): Promise<void>;
}

export function createRealtime(deps: {
  logger: Logger;
  /** Browsers may connect only from this origin. */
  allowedOrigin: string;
  /** Turns the handshake's Cookie header into a user id, or null. */
  authenticate: (cookieHeader: string | undefined) => Promise<string | null>;
  /** Shares events between processes (web and worker) through PostgreSQL. */
  pool?: Pool;
}): Realtime {
  const handlers = new Map<string, RealtimeHandler>();
  let io: Server | null = null;
  let emitterOnly = false;

  return {
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
        maxHttpBufferSize: 10_000,
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
