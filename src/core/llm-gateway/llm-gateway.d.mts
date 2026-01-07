import type { Server } from 'node:http';

export type GatewayUpstream = 'anthropic' | 'minimax';

export type DecideUpstreamResult = {
  upstream: GatewayUpstream;
  rewrittenBody: unknown;
  reasons: string[];
};

export function decideUpstream(
  body: unknown,
  opts?: {
    anthropicFallbackModel?: string;
  }
): DecideUpstreamResult;

export function buildMessageUpstreamHeaders(
  incoming:
    | Record<string, string | string[] | undefined>
    | Record<string, string | string[] | number | undefined>
    | undefined,
  upstream: GatewayUpstream,
  opts?: {
    minimaxApiKey?: string | null;
    contentLength?: number;
  }
): Record<string, string | string[]>;

export type GatewayUpstreamBase = {
  origin: string;
  basePath: string;
};

export type GatewayServerOptions = {
  prefix?: string;
  bindHost?: string;
  bodyLimitBytes?: number;
  anthropicUpstream?: GatewayUpstreamBase;
  minimaxUpstream?: GatewayUpstreamBase;
  minimaxApiKey?: string | null;
  anthropicFallbackModel?: string;
};

export function createGatewayServer(opts?: GatewayServerOptions): {
  server: Server;
  prefix: string;
  bindHost: string;
  listen: (port: number) => Promise<void>;
  close: () => Promise<void>;
};

