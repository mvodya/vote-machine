import {onlineProxy} from '../../../../../lib/online-proxy';
export const dynamic = 'force-dynamic';
// Read only this room's online labels
export async function GET(
  request: Request,
  context: {params: Promise<{id: string}>},
) {
  const {id} = await context.params;
  return onlineProxy(request, id);
}
