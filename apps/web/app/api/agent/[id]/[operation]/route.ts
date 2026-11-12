import {serveAgentApi} from '../../../../../lib/server/mcp-tools';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

// Use the room ID from the path and the bearer token from the request
export async function POST(
  request: Request,
  context: {params: Promise<{id: string; operation: string}>},
) {
  const {id, operation} = await context.params;
  return serveAgentApi(request, id, operation);
}
