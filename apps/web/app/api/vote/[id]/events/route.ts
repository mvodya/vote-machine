import {liveProxy} from '../../../../../lib/live-proxy';
export const dynamic = 'force-dynamic';
// Open the stream with this route's scoped session
export async function GET(
  request: Request,
  context: {params: Promise<{id: string}>},
) {
  const {id} = await context.params;
  return liveProxy(request, id, false);
}
