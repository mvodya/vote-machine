import {serveAgentApi} from '../../../../lib/server/mcp-tools';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

// The token selects the room when the path has only an operation
export async function POST(
  request: Request,
  context: {params: Promise<{id: string}>},
) {
  return serveAgentApi(request, '', (await context.params).id);
}
