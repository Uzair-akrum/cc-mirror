import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

test('llm-gateway hook redirects minimax /v1/messages to local gateway', async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };

  try {
    process.env.CC_MIRROR_GATEWAY_MODE = 'fetch-hook';
    process.env.CC_MIRROR_GATEWAY_PORT = '4567';
    process.env.CC_MIRROR_GATEWAY_PREFIX = 'abc123';

    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return {} as Response;
    };

    const require = createRequire(import.meta.url);
    const hookPath = '../src/core/llm-gateway/llm-gateway-hook.cjs';
    const resolvedHookPath = require.resolve(hookPath);
    delete require.cache[resolvedHookPath];
    require(resolvedHookPath);

    await globalThis.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'minimax:MiniMax-M2.1', stream: true }),
    });

    await globalThis.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-3-5-sonnet-latest' }),
    });

    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.url, 'http://127.0.0.1:4567/abc123/v1/messages');
    assert.equal(calls[1]?.url, 'https://api.anthropic.com/v1/messages');
  } finally {
    globalThis.fetch = originalFetch;

    for (const key of Object.keys(process.env)) {
      if (!Object.hasOwn(originalEnv, key)) {
        delete process.env[key];
      }
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      if (typeof value === 'string') {
        process.env[key] = value;
      }
    }
  }
});
