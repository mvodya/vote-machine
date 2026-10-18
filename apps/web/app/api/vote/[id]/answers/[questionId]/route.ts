import {ballotProxy} from '../../../../../../lib/ballot-proxy';
export const dynamic = 'force-dynamic';
// Read only the current link's answer
export async function GET(
  request: Request,
  context: {params: Promise<{id: string; questionId: string}>},
) {
  const {id, questionId} = await context.params;
  return ballotProxy(request, id, questionId);
}
// Submit one idempotent personal answer
export async function POST(
  request: Request,
  context: {params: Promise<{id: string; questionId: string}>},
) {
  const {id, questionId} = await context.params;
  return ballotProxy(request, id, questionId);
}
