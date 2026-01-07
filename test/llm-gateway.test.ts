import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  decideUpstream,
  buildMessageUpstreamHeaders,
  createGatewayServer,
} from '../src/core/llm-gateway/llm-gateway.mjs';

const listenServer = async (t: import('node:test').TestContext, server: http.Server): Promise<number> => {
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
  } catch (err) {
    if ((err as { code?: string }).code === 'EPERM') {
      t.skip('Socket listen not permitted in this environment');
      return -1;
    }
    throw err;
  }

  return (server.address() as { port: number }).port;
};

const closeServer = (server: http.Server) => new Promise<void>((resolve) => server.close(() => resolve()));

test('decideUpstream routes minimax: model to MiniMax and strips prefix', () => {
  const body = { model: 'minimax:MiniMax-M2.1', messages: [{ role: 'user', content: 'hi' }] };
  const result = decideUpstream(body, { anthropicFallbackModel: 'claude-3-5-sonnet-latest' });
  assert.equal(result.upstream, 'minimax');
  assert.deepEqual((result.rewrittenBody as { model?: string }).model, 'MiniMax-M2.1');
  assert.deepEqual(result.reasons, []);
});

test('decideUpstream routes non-tagged model to Anthropic', () => {
  const body = { model: 'claude-3-5-sonnet-latest', messages: [{ role: 'user', content: 'hi' }] };
  const result = decideUpstream(body, { anthropicFallbackModel: 'claude-3-5-sonnet-latest' });
  assert.equal(result.upstream, 'anthropic');
  assert.equal(result.rewrittenBody, body);
});

test('decideUpstream falls back to Anthropic on image blocks', () => {
  const body = {
    model: 'minimax:MiniMax-M2.1',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'AA==' },
          },
        ],
      },
    ],
  };
  const result = decideUpstream(body, { anthropicFallbackModel: 'claude-3-5-sonnet-latest' });
  assert.equal(result.upstream, 'anthropic');
  assert.equal((result.rewrittenBody as { model?: string }).model, 'claude-3-5-sonnet-latest');
  assert.ok(result.reasons.includes('fallback:media'));
});

test('decideUpstream falls back to Anthropic on unknown content types', () => {
  const body = {
    model: 'minimax:MiniMax-M2.1',
    messages: [
      {
        role: 'user',
        content: [{ type: 'audio', data: '...' }],
      },
    ],
  };
  const result = decideUpstream(body, { anthropicFallbackModel: 'claude-3-5-sonnet-latest' });
  assert.equal(result.upstream, 'anthropic');
  assert.ok(result.reasons.includes('fallback:unknown_block_type'));
});

test('decideUpstream falls back to Anthropic on file_id presence', () => {
  const body = {
    model: 'minimax:MiniMax-M2.1',
    file_id: 'file_123',
    messages: [{ role: 'user', content: 'hi' }],
  };
  const result = decideUpstream(body, { anthropicFallbackModel: 'claude-3-5-sonnet-latest' });
  assert.equal(result.upstream, 'anthropic');
  assert.ok(result.reasons.includes('fallback:file_id'));
});

test('decideUpstream falls back to Anthropic on invalid MiniMax temperature', () => {
  const body = {
    model: 'minimax:MiniMax-M2.1',
    temperature: 2,
    messages: [{ role: 'user', content: 'hi' }],
  };
  const result = decideUpstream(body, { anthropicFallbackModel: 'claude-3-5-sonnet-latest' });
  assert.equal(result.upstream, 'anthropic');
  assert.ok(result.reasons.includes('fallback:minimax_temperature_invalid'));
});

test('decideUpstream does not fall back on JSON schema "type" fields in tools', () => {
  const body = {
    model: 'minimax:MiniMax-M2.1',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [
      {
        name: 'dummy_tool',
        description: 'test',
        input_schema: {
          type: 'object',
          properties: {
            command: { type: 'string' },
          },
          required: ['command'],
        },
      },
    ],
  };
  const result = decideUpstream(body, { anthropicFallbackModel: 'claude-3-5-sonnet-latest' });
  assert.equal(result.upstream, 'minimax');
  assert.deepEqual(result.reasons, []);
});

test('decideUpstream strips thinking blocks for minimax requests', () => {
  const body = {
    model: 'minimax:MiniMax-M2.1',
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'secret' },
          { type: 'text', text: 'hello' },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'text', text: 'hi' }],
      },
    ],
  };
  const result = decideUpstream(body, { anthropicFallbackModel: 'claude-3-5-sonnet-latest' });
  assert.equal(result.upstream, 'minimax');
  assert.deepEqual(result.reasons, []);
  const rewritten = result.rewrittenBody as { messages?: Array<{ role?: string; content?: unknown }> };
  const assistant = rewritten.messages?.find((m) => m.role === 'assistant');
  assert.ok(Array.isArray(assistant?.content));
  assert.equal(
    (assistant?.content as Array<{ type?: string }>).some((b) => b.type === 'thinking'),
    false
  );
});

test('buildMessageUpstreamHeaders keeps incoming auth for Anthropic', () => {
  const incoming = {
    'content-type': 'application/json',
    accept: 'application/json',
    'user-agent': 'test-agent',
    'anthropic-version': '2023-06-01',
    authorization: 'Bearer oauth-token',
    'x-api-key': 'sk-test',
    'anthropic-beta': 'tools-2024-04-04',
    'x-request-id': 'req_1',
  };
  const headers = buildMessageUpstreamHeaders(incoming, 'anthropic', { contentLength: 10 });
  assert.equal(headers.authorization, 'Bearer oauth-token');
  assert.equal(headers['x-api-key'], 'sk-test');
  assert.equal(headers['anthropic-beta'], 'tools-2024-04-04');
  assert.equal(headers['content-length'], '10');
});

test('buildMessageUpstreamHeaders injects bearer token for MiniMax and drops incoming auth', () => {
  const incoming = {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
    authorization: 'Bearer oauth-token',
    'x-api-key': 'sk-test',
    'anthropic-beta': 'tools-2024-04-04',
  };
  const headers = buildMessageUpstreamHeaders(incoming, 'minimax', { minimaxApiKey: 'mm-key', contentLength: 12 });
  assert.equal(headers.authorization, 'Bearer mm-key');
  assert.equal(headers['x-api-key'], undefined);
  assert.equal(headers['anthropic-beta'], undefined);
});

test('gateway integration: routes /v1/messages and proxies unknown paths to Anthropic', async (t) => {
  const anthropicHits: Array<{ url: string; headers: http.IncomingHttpHeaders; body: string }> = [];
  const minimaxHits: Array<{ url: string; headers: http.IncomingHttpHeaders; body: string }> = [];

  const anthropicServer = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    anthropicHits.push({ url: req.url || '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ upstream: 'anthropic' }));
  });

  const minimaxServer = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    minimaxHits.push({ url: req.url || '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ upstream: 'minimax' }));
  });

  const anthropicPort = await listenServer(t, anthropicServer);
  const minimaxPort = await listenServer(t, minimaxServer);
  if (anthropicPort === -1 || minimaxPort === -1) {
    await closeServer(anthropicServer);
    await closeServer(minimaxServer);
    return;
  }

  const gateway = createGatewayServer({
    prefix: 'testprefix',
    anthropicUpstream: { origin: `http://127.0.0.1:${anthropicPort}`, basePath: '' },
    minimaxUpstream: { origin: `http://127.0.0.1:${minimaxPort}`, basePath: '/anthropic' },
    minimaxApiKey: 'mm-key',
    anthropicFallbackModel: 'claude-3-5-sonnet-latest',
  });

  await gateway.listen(0);
  const gwPort = (gateway.server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${gwPort}/testprefix`;

  try {
    // Unknown path -> Anthropic passthrough
    {
      const resp = await fetch(`${base}/v1/models?x=1`, {
        headers: { authorization: 'Bearer oauth-token' },
      });
      assert.equal(resp.status, 200);
      assert.equal((await resp.json()).upstream, 'anthropic');
      assert.equal(anthropicHits.length, 1);
      assert.equal(anthropicHits[0].url, '/v1/models?x=1');
      assert.equal(anthropicHits[0].headers.authorization, 'Bearer oauth-token');
    }

    // minimax:<model> -> MiniMax upstream, with auth injected and model stripped
    {
      const resp = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          authorization: 'Bearer oauth-token',
          'x-api-key': 'sk-test',
          'anthropic-beta': 'tools-2024-04-04',
        },
        body: JSON.stringify({
          model: 'minimax:MiniMax-M2.1',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      assert.equal(resp.status, 200);
      assert.equal((await resp.json()).upstream, 'minimax');
      assert.equal(minimaxHits.length, 1);
      assert.equal(minimaxHits[0].url, '/anthropic/v1/messages');
      const forwarded = JSON.parse(minimaxHits[0].body) as { model?: string };
      assert.equal(forwarded.model, 'MiniMax-M2.1');
      assert.equal(minimaxHits[0].headers.authorization, 'Bearer mm-key');
      assert.equal(minimaxHits[0].headers['x-api-key'], undefined);
      assert.equal(minimaxHits[0].headers['anthropic-beta'], undefined);
    }

    // Missing prefix -> 404
    {
      const resp = await fetch(`http://127.0.0.1:${gwPort}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-3-5-sonnet-latest', messages: [] }),
      });
      assert.equal(resp.status, 404);
    }
  } finally {
    await gateway.close();
    await closeServer(anthropicServer);
    await closeServer(minimaxServer);
  }
});

test('gateway integration: streams SSE byte-for-byte', async (t) => {
  const ssePayload = Buffer.from('event: ping\ndata: hello\n\n', 'utf8');

  const minimaxServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(ssePayload);
    res.end();
  });

  const anthropicServer = http.createServer((req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unexpected' }));
  });

  const minimaxPort = await listenServer(t, minimaxServer);
  const anthropicPort = await listenServer(t, anthropicServer);
  if (minimaxPort === -1 || anthropicPort === -1) {
    await closeServer(minimaxServer);
    await closeServer(anthropicServer);
    return;
  }

  const gateway = createGatewayServer({
    prefix: 'stream',
    anthropicUpstream: { origin: `http://127.0.0.1:${anthropicPort}`, basePath: '' },
    minimaxUpstream: { origin: `http://127.0.0.1:${minimaxPort}`, basePath: '/anthropic' },
    minimaxApiKey: 'mm-key',
    anthropicFallbackModel: 'claude-3-5-sonnet-latest',
  });

  await gateway.listen(0);
  const gwPort = (gateway.server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${gwPort}/stream/v1/messages`;

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'minimax:MiniMax-M2.1',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    assert.equal(resp.status, 200);
    assert.equal(resp.headers.get('content-type'), 'text/event-stream');
    const bytes = Buffer.from(await resp.arrayBuffer());
    assert.deepEqual(bytes, ssePayload);
  } finally {
    await gateway.close();
    await closeServer(minimaxServer);
    await closeServer(anthropicServer);
  }
});
