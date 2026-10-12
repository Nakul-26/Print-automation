import { z } from 'zod';
import { PaperSize } from './order.js';

/**
 * The print agent's protocol. The agent is a small program on the shop PC that holds a device
 * token, keeps an outbound Socket.IO connection to the `/agent` namespace, downloads each print
 * PDF over HTTPS, and prints it silently. Nothing here is reachable without that token.
 */
export const AGENT = {
  /** Socket.IO namespace the agent connects to (token in the handshake `auth`). */
  namespace: '/agent',
  /** Agent → server: who I am and which printers this PC has. Sent on every (re)connect. */
  hello: 'agent:hello',
  /** Agent → server: progress of a job. */
  jobStatus: 'job:status',
  /** Server → agent: a job to print. The agent also receives every unfinished job after `hello`. */
  jobNew: 'job:new',
  /** Server → agent: this device was removed; forget the token. */
  revoked: 'agent:revoked',
} as const;

export const PAIRING_CODE_PATTERN = /^\d{6}$/;
export const PAIRING_TTL_MINUTES = 15;

/** One printer installed on the shop PC, as the agent reports it. */
export const AgentPrinter = z.object({
  name: z.string().min(1).max(200),
  /** null when the driver does not say. */
  isColor: z.boolean().nullable(),
  supportsDuplex: z.boolean().nullable(),
  isDefault: z.boolean(),
  /** The printer is turned off or unreachable right now. */
  offline: z.boolean().default(false),
});
export type AgentPrinter = z.infer<typeof AgentPrinter>;

export const AgentHello = z.object({
  version: z.string().max(40),
  printers: z.array(AgentPrinter).max(100),
});
export type AgentHello = z.infer<typeof AgentHello>;

export const PairRequest = z.object({
  code: z.string().regex(PAIRING_CODE_PATTERN),
  deviceName: z.string().trim().min(1).max(80),
  version: z.string().max(40),
});
export type PairRequest = z.infer<typeof PairRequest>;

export const PairResponse = z.object({
  deviceId: z.uuid(),
  /** Shown to the agent once; only its hash is stored. */
  token: z.string(),
  shopName: z.string(),
});
export type PairResponse = z.infer<typeof PairResponse>;

export const Duplex = z.enum(['none', 'long', 'short']);
export type Duplex = z.infer<typeof Duplex>;

/** Everything the agent needs to print one document. */
export const PrintJobSpec = z.object({
  id: z.uuid(),
  kind: z.enum(['order', 'test']),
  /** Shown in the agent's window: "P014 · notes.pdf". */
  label: z.string(),
  printerName: z.string(),
  color: z.boolean(),
  duplex: Duplex,
  copies: z.number().int().min(1).max(500),
  paperSize: PaperSize,
  /** Path to download the PDF from (with the device token), e.g. /api/v1/agent/jobs/<id>/file. */
  filePath: z.string(),
  fileBytes: z.number().int().nullable(),
});
export type PrintJobSpec = z.infer<typeof PrintJobSpec>;

export const JobStatusUpdate = z.object({
  jobId: z.uuid(),
  status: z.enum(['printing', 'done', 'failed']),
  error: z.string().max(300).optional(),
});
export type JobStatusUpdate = z.infer<typeof JobStatusUpdate>;

// ---- What the shop owner's dashboard sees and does ----

export const MappedPrinter = z.object({
  printerName: z.string(),
  supportsDuplex: z.boolean(),
  /** The agent no longer lists a printer with this name (renamed or removed). */
  missing: z.boolean(),
});
export type MappedPrinter = z.infer<typeof MappedPrinter>;

export const PrintingStatus = z.object({
  agent: z
    .object({
      id: z.uuid(),
      name: z.string(),
      version: z.string().nullable(),
      connected: z.boolean(),
      lastSeenAt: z.string().nullable(),
    })
    .nullable(),
  printers: z.array(AgentPrinter),
  mapping: z.object({
    black_white: MappedPrinter.nullable(),
    color: MappedPrinter.nullable(),
  }),
  /** Connected, and a printer is assigned to every colour mode the shop sells. */
  ready: z.boolean(),
});
export type PrintingStatus = z.infer<typeof PrintingStatus>;

export const PairingCode = z.object({ code: z.string(), expiresAt: z.string() });
export type PairingCode = z.infer<typeof PairingCode>;

export const PrinterChoice = z.object({
  printerName: z.string().min(1).max(200),
  supportsDuplex: z.boolean(),
});
export type PrinterChoice = z.infer<typeof PrinterChoice>;

export const PrinterMappingBody = z.object({
  black_white: PrinterChoice.nullable(),
  color: PrinterChoice.nullable(),
});
export type PrinterMappingBody = z.infer<typeof PrinterMappingBody>;

/** How an order's printing is going, as shown on the order card. */
export const OrderPrintState = z.object({
  state: z.enum(['waiting', 'printing', 'done', 'failed']),
  error: z.string().nullable(),
  /** The shop's printing app is connected right now. */
  agentOnline: z.boolean(),
});
export type OrderPrintState = z.infer<typeof OrderPrintState>;
