import {presenceProxy} from '../../../../../lib/presence-proxy';
export const dynamic = 'force-dynamic';
// Record only the current view, never an answer choice
export async function POST(
  request: Request,
  context: {params: Promise<{id: string}>},
) {
  const {id} = await context.params;
  return presenceProxy(request, id);
}
