import {questionProxy} from '../../../../../lib/question-proxy';

export const dynamic = 'force-dynamic';

// Check the room session before forwarding this request
export async function GET(
  request: Request,
  context: {params: Promise<{id: string}>},
) {
  const params = await context.params;
  return questionProxy(request, params.id);
}

// Check the room session before forwarding this request
export async function POST(
  request: Request,
  context: {params: Promise<{id: string}>},
) {
  const params = await context.params;
  return questionProxy(request, params.id);
}
