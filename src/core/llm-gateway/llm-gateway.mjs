import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import fs from 'node:fs';
import path from 'node:path';
import { URL, fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const DEFAULT_BIND_HOST = '127.0.0.1';
const DEFAULT_BODY_LIMIT_BYTES = 30 * 1024 * 1024;
const DEFAULT_ANTHROPIC_FALLBACK_MODEL = 'claude-sonnet-4-5-20250929';

const UPSTREAMS = {
  anthropic: {
    origin: 'https://api.anthropic.com',
    basePath: '',
  },
  minimax: {
    origin: 'https://api.minimax.io',
    basePath: '/anthropic',
  },
};

const ALLOWED_BLOCK_TYPES = new Set(['text', 'tool_use', 'tool_result', 'image', 'document']);
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
]);

const normalizePrefix = (value) =>
  String(value || '')
    .trim()
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');

const randomPrefix = () => crypto.randomBytes(12).toString('hex');

const readJsonFile = (filePath) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
};

const normalizeSecret = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed === '<API_KEY>' || trimmed === '<MINIMAX_API_KEY>') return null;
  return trimmed;
};

const stripThinkingBlocksFromContent = (content) => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content;

  const next = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') {
      next.push(block);
      continue;
    }
    const type = typeof block.type === 'string' ? block.type : '';
    if (type === 'thinking' || type === 'redacted_thinking') {
      continue;
    }
    if (type === 'tool_result' && Array.isArray(block.content)) {
      next.push({ ...block, content: stripThinkingBlocksFromContent(block.content) });
      continue;
    }
    next.push(block);
  }
  return next;
};

const stripThinkingFromRequest = (body) => {
  if (!body || typeof body !== 'object') return body;
  const next = { ...body };

  if (Object.hasOwn(next, 'thinking')) {
    delete next.thinking;
  }

  if (Object.hasOwn(next, 'messages') && Array.isArray(next.messages)) {
    next.messages = next.messages
      .map((message) => {
        if (!message || typeof message !== 'object') return message;
        if (!Object.hasOwn(message, 'content')) return message;
        const stripped = stripThinkingBlocksFromContent(message.content);
        if (Array.isArray(stripped) && stripped.length === 0) {
          return { ...message, content: '' };
        }
        return { ...message, content: stripped };
      })
      .filter(Boolean);
  }

  if (Object.hasOwn(next, 'system')) {
    next.system = stripThinkingBlocksFromContent(next.system);
  }

  return next;
};

export const decideUpstream = (body, opts = {}) => {
  const fallbackModel = opts.anthropicFallbackModel || DEFAULT_ANTHROPIC_FALLBACK_MODEL;
  const model = typeof body?.model === 'string' ? body.model.trim() : '';

  const wantsMiniMax = model.startsWith('minimax:');
  if (!wantsMiniMax) {
    return {
      upstream: 'anthropic',
      rewrittenBody: body,
      reasons: [],
    };
  }

  const sanitizedBody = stripThinkingFromRequest(body);

  const reasons = [];
  const scan = { hasMedia: false, hasUnknownType: false, hasFileId: false };

  // Scan only *content blocks* for unsupported types/media. Do not scan arbitrary JSON schema "type" fields
  // (e.g. tools[*].input_schema.type === "object"), which would incorrectly force Anthropic fallback.
  const scanContentBlocks = (content) => {
    if (!content) return;
    if (typeof content === 'string') return;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!block || typeof block !== 'object') {
        scan.hasUnknownType = true;
        continue;
      }
      const type = typeof block.type === 'string' ? block.type : '';
      if (!type) {
        scan.hasUnknownType = true;
        continue;
      }
      if (!ALLOWED_BLOCK_TYPES.has(type)) {
        scan.hasUnknownType = true;
        continue;
      }
      if (type === 'image' || type === 'document') {
        scan.hasMedia = true;
      }
      if (type === 'tool_result') {
        scanContentBlocks(block.content);
      }
      // NOTE: tool_use.input is arbitrary and may contain "type" keys; do not scan it.
    }
  };

  // system can be an array of blocks (Anthropic API supports both string and blocks)
  scanContentBlocks(sanitizedBody?.system);

  const messages = Array.isArray(sanitizedBody?.messages) ? sanitizedBody.messages : [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    scanContentBlocks(message.content);
  }

  // file_id: keep broad scan (matches existing docs/test behavior)
  const fileIdStack = [sanitizedBody];
  while (fileIdStack.length > 0) {
    const current = fileIdStack.pop();
    if (!current) continue;
    if (Array.isArray(current)) {
      for (const item of current) fileIdStack.push(item);
      continue;
    }
    if (typeof current !== 'object') continue;
    for (const [key, value] of Object.entries(current)) {
      if (key === 'file_id') scan.hasFileId = true;
      fileIdStack.push(value);
    }
  }

  if (scan.hasMedia) reasons.push('fallback:media');
  if (scan.hasUnknownType) reasons.push('fallback:unknown_block_type');
  if (scan.hasFileId) reasons.push('fallback:file_id');

  const hasTemp = Object.prototype.hasOwnProperty.call(body, 'temperature');
  if (hasTemp) {
    const t = body.temperature;
    if (typeof t !== 'number' || t <= 0 || t > 1) {
      reasons.push('fallback:minimax_temperature_invalid');
    }
  }

  const shouldFallback = reasons.length > 0;
  if (shouldFallback) {
    return {
      upstream: 'anthropic',
      rewrittenBody: { ...sanitizedBody, model: fallbackModel },
      reasons,
    };
  }

  const strippedModel = model.slice('minimax:'.length).trim();
  return {
    upstream: 'minimax',
    rewrittenBody: { ...sanitizedBody, model: strippedModel },
    reasons: [],
  };
};

const filterHopByHop = (headers) => {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const lower = key.toLowerCase();
    if (lower === 'host') continue;
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    if (value === undefined) continue;
    out[lower] = value;
  }
  return out;
};

export const buildMessageUpstreamHeaders = (incoming, upstream, opts = {}) => {
  const headers = {};
  const setIfPresent = (key) => {
    const value = incoming?.[key];
    if (value !== undefined) headers[key] = value;
  };

  setIfPresent('content-type');
  setIfPresent('accept');
  setIfPresent('user-agent');
  setIfPresent('anthropic-version');
  setIfPresent('x-request-id');

  if (!headers['content-type']) {
    headers['content-type'] = 'application/json';
  }

  if (upstream === 'anthropic') {
    setIfPresent('authorization');
    setIfPresent('x-api-key');
    setIfPresent('anthropic-beta');
  } else if (upstream === 'minimax') {
    const key = normalizeSecret(opts.minimaxApiKey);
    if (!key) {
      throw new Error('MINIMAX_API_KEY missing (settings.json.proxyEnv.MINIMAX_API_KEY)');
    }
    headers.authorization = `Bearer ${key}`;
  }

  if (typeof opts.contentLength === 'number' && Number.isFinite(opts.contentLength)) {
    headers['content-length'] = String(opts.contentLength);
  }

  return headers;
};

const readJsonBody = async (req, limitBytes) => {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > limitBytes) {
      const err = new Error('Request body too large');
      err.code = 'PAYLOAD_TOO_LARGE';
      throw err;
    }
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    const err = new Error('Invalid JSON');
    err.code = 'INVALID_JSON';
    throw err;
  }
};

const writeJsonResponse = (res, statusCode, payload) => {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body)),
  });
  res.end(body);
};

const buildUpstreamRequestOptions = ({ origin, basePath, method, pathWithQuery, headers }) => {
  const url = new URL(origin);
  const requestPath = `${String(basePath || '').replace(/\/+$/, '')}${pathWithQuery}`;

  return {
    lib: url.protocol === 'https:' ? https : http,
    options: {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      method,
      path: requestPath,
      headers,
    },
  };
};

const proxyToUpstream = (req, res, target, bodyBuffer, context = null) => {
  const { lib, options } = buildUpstreamRequestOptions(target);
  const upstreamReq = lib.request(options, (upstreamRes) => {
    const statusCode = upstreamRes.statusCode || 502;
    if (
      context &&
      typeof context === 'object' &&
      context.decidedUpstream === 'anthropic' &&
      Array.isArray(context.reasons) &&
      context.reasons.length > 0
    ) {
      console.error(
        'llm-gateway: upstream response',
        JSON.stringify({
          statusCode,
          upstream: {
            origin: target?.origin,
            basePath: target?.basePath,
            method: target?.method,
          },
          context,
        })
      );
    }
    const responseHeaders = filterHopByHop(upstreamRes.headers || {});
    res.writeHead(statusCode, responseHeaders);
    upstreamRes.pipe(res);
  });

  upstreamReq.on('error', (err) => {
    if (res.headersSent) {
      res.destroy(err);
      return;
    }
    const payload = {
      error: 'bad_gateway',
      message: String(err?.message || err),
      upstream: {
        origin: target?.origin,
        basePath: target?.basePath,
        method: target?.method,
      },
      request: {
        hostname: options?.hostname,
        port: options?.port,
      },
      ...(context && typeof context === 'object' ? { context } : {}),
    };
    try {
      const hostname = options?.hostname;
      if (typeof hostname === 'string' && hostname) {
        dns.lookup(hostname, { all: true }, (lookupErr, addresses) => {
          if (!lookupErr && Array.isArray(addresses) && addresses.length > 0) {
            payload.request.resolved = addresses.map((item) => item?.address).filter(Boolean);
          }
          // Log even if lookup fails; stderr is redirected to llm-gateway.log by wrapper
          console.error('llm-gateway: upstream error', JSON.stringify(payload));
          writeJsonResponse(res, 502, payload);
        });
        return;
      }
    } catch {
      // ignore
    }
    console.error('llm-gateway: upstream error', JSON.stringify(payload));
    writeJsonResponse(res, 502, payload);
  });

  req.on('aborted', () => upstreamReq.destroy());
  res.on('close', () => upstreamReq.destroy());

  if (bodyBuffer) {
    upstreamReq.end(bodyBuffer);
  } else {
    req.pipe(upstreamReq);
  }
};

export const createGatewayServer = (opts) => {
  const prefix = normalizePrefix(opts?.prefix) || randomPrefix();
  const prefixPath = `/${prefix}`;
  const bindHost = opts?.bindHost || DEFAULT_BIND_HOST;
  const bodyLimitBytes = Number.isFinite(opts?.bodyLimitBytes) ? opts.bodyLimitBytes : DEFAULT_BODY_LIMIT_BYTES;

  const upstreams = {
    anthropic: opts?.anthropicUpstream || UPSTREAMS.anthropic,
    minimax: opts?.minimaxUpstream || UPSTREAMS.minimax,
  };

  const getFallbackModel = () => opts?.anthropicFallbackModel || DEFAULT_ANTHROPIC_FALLBACK_MODEL;

  const server = http.createServer(async (req, res) => {
    const rawUrl = req.url || '/';
    const parsed = new URL(rawUrl, `http://${DEFAULT_BIND_HOST}`);

    if (parsed.pathname === prefixPath || parsed.pathname === `${prefixPath}/`) {
      writeJsonResponse(res, 404, { error: 'not_found' });
      return;
    }
    if (!parsed.pathname.startsWith(`${prefixPath}/`)) {
      writeJsonResponse(res, 404, { error: 'not_found' });
      return;
    }

    const subPath = parsed.pathname.slice(prefixPath.length);
    const pathWithQuery = `${subPath}${parsed.search || ''}`;

    if (subPath === '/healthz') {
      writeJsonResponse(res, 200, { ok: true });
      return;
    }

    const isMessages = subPath === '/v1/messages' && req.method === 'POST';
    if (!isMessages) {
      proxyToUpstream(req, res, {
        origin: upstreams.anthropic.origin,
        basePath: upstreams.anthropic.basePath,
        method: req.method || 'GET',
        pathWithQuery,
        headers: filterHopByHop(req.headers || {}),
      });
      return;
    }

    let body;
    try {
      body = await readJsonBody(req, bodyLimitBytes);
    } catch (err) {
      const code = err?.code;
      if (code === 'PAYLOAD_TOO_LARGE') {
        writeJsonResponse(res, 413, { error: 'payload_too_large' });
        return;
      }
      writeJsonResponse(res, 400, { error: 'invalid_request', message: String(err?.message || err) });
      return;
    }

    const decision = decideUpstream(body, { anthropicFallbackModel: getFallbackModel() });
    const serialized = Buffer.from(JSON.stringify(decision.rewrittenBody));
    const incoming = req.headers || {};
    try {
      const incomingModel = typeof body?.model === 'string' ? body.model.trim() : '';
      const rewrittenModel = typeof decision.rewrittenBody?.model === 'string' ? decision.rewrittenBody.model : null;
      if (incomingModel.startsWith('minimax:') && decision.upstream === 'anthropic') {
        console.error(
          'llm-gateway: route',
          JSON.stringify({
            incomingModel,
            rewrittenModel,
            reasons: decision.reasons,
            temperature: Object.prototype.hasOwnProperty.call(body, 'temperature') ? body.temperature : null,
          })
        );
      }
    } catch {
      // ignore
    }

    let headers;
    try {
      headers = buildMessageUpstreamHeaders(incoming, decision.upstream, {
        minimaxApiKey: opts?.minimaxApiKey,
        contentLength: serialized.length,
      });
    } catch (err) {
      writeJsonResponse(res, 500, { error: 'gateway_misconfigured', message: String(err?.message || err) });
      return;
    }

    const upstream = decision.upstream === 'minimax' ? upstreams.minimax : upstreams.anthropic;

    proxyToUpstream(
      req,
      res,
      {
        origin: upstream.origin,
        basePath: upstream.basePath,
        method: 'POST',
        pathWithQuery,
        headers,
      },
      serialized,
      {
        decidedUpstream: decision.upstream,
        reasons: decision.reasons,
        rewrittenModel:
          decision && typeof decision === 'object' && decision.rewrittenBody && typeof decision.rewrittenBody === 'object'
            ? decision.rewrittenBody.model
            : null,
      }
    );
  });

  const listen = (port) =>
    new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, bindHost, () => resolve());
    });

  const close = () =>
    new Promise((resolve) => {
      server.close(() => resolve());
    });

  return { server, prefix, bindHost, listen, close };
};

const parseArgv = (argv) => {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (!raw.startsWith('--')) continue;
    const eq = raw.indexOf('=');
    if (eq !== -1) {
      out[raw.slice(2, eq)] = raw.slice(eq + 1);
      continue;
    }
    const key = raw.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      out[key] = 'true';
      continue;
    }
    out[key] = next;
    i++;
  }
  return out;
};

const writeReadyFile = (filePath, info) => {
  if (!filePath) return;
  const content = [`CC_MIRROR_GATEWAY_PORT=${info.port}`, `CC_MIRROR_GATEWAY_PREFIX=${info.prefix}`, ''].join('\n');
  fs.writeFileSync(filePath, content, 'utf8');
};

const loadGatewayConfigFromSettings = (configDir) => {
  const settingsPath = path.join(configDir, 'settings.json');
  const settings = readJsonFile(settingsPath) || {};
  const env =
    settings && typeof settings === 'object' && settings.env && typeof settings.env === 'object' ? settings.env : {};
  const proxyEnv =
    settings && typeof settings === 'object' && settings.proxyEnv && typeof settings.proxyEnv === 'object'
      ? settings.proxyEnv
      : {};

  const minimaxApiKey = normalizeSecret(proxyEnv.MINIMAX_API_KEY);
  const fallback =
    typeof env.CC_MIRROR_GATEWAY_ANTHROPIC_FALLBACK_MODEL === 'string'
      ? env.CC_MIRROR_GATEWAY_ANTHROPIC_FALLBACK_MODEL.trim()
      : '';

  const fallbackModel =
    fallback ||
    (typeof env.ANTHROPIC_DEFAULT_SONNET_MODEL === 'string' ? env.ANTHROPIC_DEFAULT_SONNET_MODEL.trim() : '') ||
    (typeof env.ANTHROPIC_MODEL === 'string' ? env.ANTHROPIC_MODEL.trim() : '') ||
    DEFAULT_ANTHROPIC_FALLBACK_MODEL;

  const minimaxBaseUrl =
    typeof proxyEnv.MINIMAX_BASE_URL === 'string' && proxyEnv.MINIMAX_BASE_URL.trim()
      ? proxyEnv.MINIMAX_BASE_URL.trim()
      : null;

  return { minimaxApiKey, fallbackModel, minimaxBaseUrl };
};

const parseBaseUrl = (value) => {
  const url = new URL(value);
  return {
    origin: `${url.protocol}//${url.host}`,
    basePath: url.pathname.replace(/\/+$/, ''),
  };
};

const runCli = async () => {
  const args = parseArgv(process.argv.slice(2));
  const configDir = args['config-dir'] || process.env.CLAUDE_CONFIG_DIR;
  if (!configDir) {
    console.error('llm-gateway: missing --config-dir (or CLAUDE_CONFIG_DIR)');
    process.exit(1);
  }

  const prefix = normalizePrefix(args.prefix) || randomPrefix();
  const port = args.port ? Number(args.port) : 0;
  const readyFile = args['ready-file'] || null;

  const loaded = loadGatewayConfigFromSettings(configDir);
  const minimaxUpstream = loaded.minimaxBaseUrl ? parseBaseUrl(loaded.minimaxBaseUrl) : UPSTREAMS.minimax;
  const proxySnapshot = {
    HTTP_PROXY: process.env.HTTP_PROXY || process.env.http_proxy || null,
    HTTPS_PROXY: process.env.HTTPS_PROXY || process.env.https_proxy || null,
    ALL_PROXY: process.env.ALL_PROXY || process.env.all_proxy || null,
    NO_PROXY: process.env.NO_PROXY || process.env.no_proxy || null,
    NODE_OPTIONS: process.env.NODE_OPTIONS || null,
    GLOBAL_AGENT_HTTP_PROXY: process.env.GLOBAL_AGENT_HTTP_PROXY || null,
    GLOBAL_AGENT_HTTPS_PROXY: process.env.GLOBAL_AGENT_HTTPS_PROXY || null,
  };
  console.error(
    'llm-gateway: config',
    JSON.stringify({
      bindHost: DEFAULT_BIND_HOST,
      prefix,
      anthropicUpstream: UPSTREAMS.anthropic,
      minimaxUpstream,
      hasMinimaxApiKey: Boolean(loaded.minimaxApiKey),
      hasMinimaxBaseUrlOverride: Boolean(loaded.minimaxBaseUrl),
      dnsServers: dns.getServers?.() ?? null,
      proxyEnv: proxySnapshot,
    })
  );

  const gateway = createGatewayServer({
    prefix,
    bindHost: DEFAULT_BIND_HOST,
    anthropicUpstream: UPSTREAMS.anthropic,
    minimaxUpstream,
    minimaxApiKey: loaded.minimaxApiKey,
    anthropicFallbackModel: loaded.fallbackModel,
  });

  await gateway.listen(Number.isFinite(port) ? port : 0);
  const address = gateway.server.address();
  const actualPort = address && typeof address === 'object' ? address.port : null;
  if (!actualPort) {
    throw new Error('Failed to determine listening port');
  }

  writeReadyFile(readyFile, { port: actualPort, prefix: gateway.prefix });

  const shutdown = async () => {
    try {
      await gateway.close();
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
};

const isDirectRun = (() => {
  try {
    const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
    return entry === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  runCli().catch((err) => {
    console.error('llm-gateway: fatal:', err);
    process.exit(1);
  });
}
