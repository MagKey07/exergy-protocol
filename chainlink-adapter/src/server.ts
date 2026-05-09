/**
 * @file server.ts
 * @description Express HTTP server exposing the Chainlink External Adapter.
 *
 * Routes:
 *   POST /submit     — accept a dual-signed packet, run the pipeline.
 *   GET  /health     — adapter status + (best-effort) role check.
 *   GET  /version    — dialect tag + adapter version.
 *
 * Pipeline per /submit request (also documented in PROTOCOL_SPEC.md §V1):
 *
 *   1. Parse + validate the JSON shape.
 *   2. Off-chain dual-signature verification (verifier.ts).
 *      → on failure: 422, { stage: 'verify' }
 *   3. 3-of-5 simulated Chainlink-node consensus + DSO cross-check (consensus.ts).
 *      → on failure: 422, { stage: 'consensus' }
 *   4. Relay on chain via CHAINLINK_RELAYER_ROLE (relayer.ts).
 *      → on failure: 502, { stage: 'relay' }
 *   5. 200 with txHash + blockNumber + consensus summary on success.
 *
 * Defence-in-depth:
 *   The on-chain OracleRouter ALSO verifies the dual signatures and the
 *   registry binding, regardless of which relayer called it. The adapter's
 *   verifier is a fail-fast off-chain mirror so we don't burn gas on packets
 *   the contract would revert.
 *
 * No admin overrides. No allow-list. No "trusted VPP skip-DSO" mode. The
 * pipeline is deterministic per CORE_THESIS §5.5.
 */
import express, { type Request, type Response, type NextFunction } from 'express';
import { runConsensus } from './consensus';
import { Relayer } from './relayer';
import { verifyDualSignature } from './verifier';
import {
  ADAPTER_DIALECT,
  CONSENSUS_NODE_COUNT,
  CONSENSUS_THRESHOLD,
  DSO_DISCREPANCY_THRESHOLD_BPS,
  type AdapterConfig,
  type ConsensusResult,
  type ConsensusSummary,
  type MeasurementPacket,
  type SubmitRequest,
  type SubmitResponse,
} from './types';
import { child } from './logger';

const log = child('server');

export function buildApp(cfg: AdapterConfig, relayer: Relayer): express.Express {
  const app = express();
  app.use(express.json({ limit: '64kb' }));

  app.get('/version', (_req, res) => {
    res.json({
      dialect: ADAPTER_DIALECT,
      consensus: { threshold: CONSENSUS_THRESHOLD, nodeCount: CONSENSUS_NODE_COUNT },
      dsoThresholdBps: DSO_DISCREPANCY_THRESHOLD_BPS,
    });
  });

  app.get('/health', async (_req, res) => {
    const role = await relayer.hasRelayerRole();
    res.json({
      ok: role !== 'no',
      relayerAddress: relayer.address,
      hasRelayerRole: role,
      oracleRouter: cfg.oracleRouterAddress,
      chainId: cfg.chainId,
      dialect: ADAPTER_DIALECT,
    });
  });

  app.post('/submit', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = parseSubmitRequest(req.body as unknown);
      if ('reason' in parsed) {
        respond(res, 400, {
          ok: false,
          stage: 'verify',
          reason: parsed.reason,
          requestId: undefined,
        });
        return;
      }
      const { packet, deviceSignature, vppSignature, requestId } = parsed;

      // Stage 1 — off-chain dual-signature verification.
      const verify = verifyDualSignature(packet, deviceSignature, vppSignature);
      if (!verify.ok) {
        respond(res, 422, {
          ok: false,
          stage: 'verify',
          reason: verify.reason,
          requestId,
        });
        return;
      }

      // Stage 2 — 3-of-5 consensus + DSO cross-check.
      const consensus = runConsensus(packet, cfg.dsoNoiseRange);
      if (!consensus.accepted) {
        respond(res, 422, {
          ok: false,
          stage: 'consensus',
          reason: consensus.reason,
          consensus: summarize(consensus),
          requestId,
        });
        return;
      }

      // Stage 3 — relay on chain.
      const relay = await relayer.relay(packet, deviceSignature, vppSignature);
      if (!relay.ok) {
        respond(res, 502, {
          ok: false,
          stage: 'relay',
          reason: relay.error,
          consensus: summarize(consensus),
          requestId,
        });
        return;
      }

      respond(res, 200, {
        ok: true,
        txHash: relay.txHash,
        blockNumber: relay.blockNumber,
        consensus: summarize(consensus),
        requestId,
      });
    } catch (err) {
      next(err);
    }
  });

  // 4xx fallthrough.
  app.use((req, res) => {
    res.status(404).json({ ok: false, reason: `unknown route ${req.method} ${req.path}` });
  });

  // 5xx handler.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    log.error('uncaught', { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    });
  });

  return app;
}

function respond(res: Response, status: number, body: SubmitResponse): void {
  log.info('respond', { status, ok: body.ok, stage: body.stage, requestId: body.requestId });
  res.status(status).json(body);
}

function summarize(c: ConsensusResult): ConsensusSummary {
  return {
    accepted: c.accepted,
    acceptCount: c.acceptCount,
    rejectCount: c.rejectCount,
    threshold: CONSENSUS_THRESHOLD,
    maxDiscrepancyBps: c.nodes.reduce((m, n) => Math.max(m, n.discrepancyBps), 0),
  };
}

/**
 * Validate and coerce the JSON body into the typed adapter shape. Returns
 * either the parsed payload OR `{ reason: string }` for client-side debugging.
 *
 * We keep the validator hand-written rather than pulling in zod / yup — the
 * surface area is tiny and adding a dep just for this is overkill. The parser
 * mirrors the documented JSON schema in PROTOCOL_SPEC.md §V1.
 */
function parseSubmitRequest(raw: unknown): { reason: string } | {
  packet: MeasurementPacket;
  deviceSignature: string;
  vppSignature: string;
  requestId: string | undefined;
} {
  if (!raw || typeof raw !== 'object') return { reason: 'body must be a JSON object' };
  const body = raw as Partial<SubmitRequest>;
  if (!body.packet || typeof body.packet !== 'object') return { reason: 'missing packet' };
  if (typeof body.deviceSignature !== 'string') return { reason: 'missing deviceSignature' };
  if (typeof body.vppSignature !== 'string') return { reason: 'missing vppSignature' };

  const p = body.packet;
  if (typeof p.deviceId !== 'string' || !p.deviceId.startsWith('0x')) {
    return { reason: 'packet.deviceId must be 0x-prefixed bytes32 hex' };
  }
  if (typeof p.kwhAmount !== 'string') return { reason: 'packet.kwhAmount must be a decimal string' };
  if (typeof p.timestamp !== 'string') return { reason: 'packet.timestamp must be a decimal string' };
  if (typeof p.storageCapacity !== 'string') return { reason: 'packet.storageCapacity must be a decimal string' };
  if (typeof p.chargeLevelPercent !== 'number') return { reason: 'packet.chargeLevelPercent must be a number' };
  if (typeof p.sourceType !== 'number') return { reason: 'packet.sourceType must be a number' };
  if (typeof p.cumulativeCycles !== 'number') return { reason: 'packet.cumulativeCycles must be a number' };

  let kwhAmount: bigint;
  let timestamp: bigint;
  let storageCapacity: bigint;
  try {
    kwhAmount = BigInt(p.kwhAmount);
    timestamp = BigInt(p.timestamp);
    storageCapacity = BigInt(p.storageCapacity);
  } catch (err) {
    return {
      reason: `bigint parse failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (kwhAmount < 0n) return { reason: 'packet.kwhAmount must be non-negative' };
  if (timestamp <= 0n) return { reason: 'packet.timestamp must be positive' };
  if (storageCapacity < 0n) return { reason: 'packet.storageCapacity must be non-negative' };
  if (p.chargeLevelPercent < 0 || p.chargeLevelPercent > 100) {
    return { reason: 'packet.chargeLevelPercent must be 0..100' };
  }
  if (p.sourceType < 0 || p.sourceType > 3) return { reason: 'packet.sourceType must be 0..3' };
  if (p.cumulativeCycles < 0) return { reason: 'packet.cumulativeCycles must be non-negative' };

  return {
    packet: {
      deviceId: p.deviceId,
      kwhAmount,
      timestamp,
      storageCapacity,
      chargeLevelPercent: p.chargeLevelPercent,
      sourceType: p.sourceType,
      cumulativeCycles: p.cumulativeCycles,
    },
    deviceSignature: body.deviceSignature,
    vppSignature: body.vppSignature,
    requestId: body.requestId,
  };
}
