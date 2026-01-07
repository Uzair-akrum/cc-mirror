'use strict';

const normalizePrefix = (value) => String(value || '').trim().replace(/^\/+/, '').replace(/\/+$/, '');

const readEnv = (key) => {
  const raw = process.env[key];
  if (typeof raw !== 'string') return '';
  return raw.trim();
};

const shouldEnableHook = () => readEnv('CC_MIRROR_GATEWAY_MODE') === 'fetch-hook';

const isMinimaxRequest = (bodyText) => {
  try {
    const body = JSON.parse(bodyText);
    const model = typeof body?.model === 'string' ? body.model.trim() : '';
    return model.startsWith('minimax:');
  } catch {
    return false;
  }
};

const extractBodyText = async (input, init) => {
  const candidate = init?.body;
  if (typeof candidate === 'string') return candidate;
  if (candidate instanceof Uint8Array) return Buffer.from(candidate).toString('utf8');
  if (candidate instanceof ArrayBuffer) return Buffer.from(candidate).toString('utf8');
  if (candidate && typeof candidate === 'object' && ArrayBuffer.isView(candidate)) {
    return Buffer.from(candidate.buffer, candidate.byteOffset, candidate.byteLength).toString('utf8');
  }

  if (input && typeof input === 'object' && typeof input.clone === 'function') {
    try {
      return await input.clone().text();
    } catch {
      return null;
    }
  }

  return null;
};

const extractRequestInfo = (input, init) => {
  const method =
    typeof init?.method === 'string'
      ? init.method
      : input && typeof input === 'object' && typeof input.method === 'string'
        ? input.method
        : 'GET';

  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input && typeof input === 'object' && typeof input.url === 'string'
          ? input.url
          : '';

  const signal = init?.signal ?? (input && typeof input === 'object' ? input.signal : undefined);

  const headers = init?.headers ?? (input && typeof input === 'object' ? input.headers : undefined);

  return { method, url, signal, headers };
};

const shouldIntercept = ({ url, method }, bodyText) => {
  if (!url) return false;
  if (String(method).toUpperCase() !== 'POST') return false;
  try {
    const parsed = new URL(url);
    if (parsed.pathname !== '/v1/messages') return false;
  } catch {
    return false;
  }
  if (!bodyText) return false;
  return isMinimaxRequest(bodyText);
};

const buildGatewayUrl = (originalUrl) => {
  const port = readEnv('CC_MIRROR_GATEWAY_PORT');
  const prefix = normalizePrefix(readEnv('CC_MIRROR_GATEWAY_PREFIX'));
  if (!port || !prefix) return null;

  const parsed = new URL(originalUrl);
  return `http://127.0.0.1:${port}/${prefix}${parsed.pathname}${parsed.search}`;
};

const install = () => {
  if (!shouldEnableHook()) return;
  if (typeof globalThis.fetch !== 'function') return;

  const originalFetch = globalThis.fetch.bind(globalThis);

  globalThis.fetch = async (input, init) => {
    try {
      const bodyText = await extractBodyText(input, init);
      const info = extractRequestInfo(input, init);
      if (!shouldIntercept(info, bodyText)) {
        return originalFetch(input, init);
      }

      const gatewayUrl = buildGatewayUrl(info.url);
      if (!gatewayUrl) return originalFetch(input, init);

      const nextInit = {
        ...init,
        method: info.method,
        headers: info.headers,
        signal: info.signal,
        body: bodyText,
      };

      return originalFetch(gatewayUrl, nextInit);
    } catch {
      return originalFetch(input, init);
    }
  };
};

install();

