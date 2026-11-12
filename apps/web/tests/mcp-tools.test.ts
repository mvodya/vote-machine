// @vitest-environment node
import {expect, test} from 'vitest';
import {serveMcp} from '../lib/server/mcp-tools';

// Keep discovery public and deny cross-site browser requests
test('MCP discovery does not require any room credential', async () => {
  const response = await serveMcp(request('tools/list', {}));
  expect(response.ok).toBe(true);
  const discovery = await rpcResult(response);
  expect(discovery.tools.map((tool: {name: string}) => tool.name)).toEqual(
    expect.arrayContaining([
      'questions_list',
      'results_summary',
      'registration_results',
      'registration_member_rename',
    ]),
  );
  expect(discovery.tools[0].inputSchema.properties.apiToken.type).toBe(
    'string',
  );
  expect(response.headers.get('cache-control')).toBe('private, no-store');

  const denied = await serveMcp(
    request('tools/list', {}, {Origin: 'https://other.example'}),
  );
  expect(denied.status).toBe(403);
});

// Keep tool errors free of secret values
test('MCP rejects missing or conflicting room credentials without echoing them', async () => {
  const headerToken = 'a'.repeat(64);
  const apiToken = 'b'.repeat(64);
  const missing = await serveMcp(
    request('tools/call', {name: 'questions_list', arguments: {}}),
  );
  expect(await rpcResult(missing)).toMatchObject({
    isError: true,
    structuredContent: {error: 'invalid_token'},
  });
  const conflict = await serveMcp(
    request(
      'tools/call',
      {name: 'questions_list', arguments: {apiToken}},
      {Authorization: `Bearer ${headerToken}`},
    ),
  );
  const result = await rpcResult(conflict);
  expect(result).toMatchObject({
    isError: true,
    structuredContent: {error: 'invalid_token'},
  });
  expect(JSON.stringify(result)).not.toContain(apiToken);
  expect(JSON.stringify(result)).not.toContain(headerToken);
});

// Use Streamable HTTP without a browser or database
function request(method: string, params: object, headers = {}) {
  return new Request('http://localhost:3000/api/mcp', {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      'Mcp-Protocol-Version': '2025-11-25',
      ...headers,
    },
    body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params}),
  });
}

// Read either JSON or the first SSE event
async function rpcResult(response: Response) {
  const body = await response.text();
  const line = body.split('\n').find((item) => item.startsWith('data: '));
  return JSON.parse(line?.slice(6) ?? body).result;
}
