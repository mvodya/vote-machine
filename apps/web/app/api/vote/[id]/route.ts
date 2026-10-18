import {participantProxy} from '../../../../lib/link-proxy';

export const dynamic = 'force-dynamic';

// Check participant access without granting admin rights
export async function GET(
  request: Request,
  context: {params: Promise<{id: string}>},
) {
  return participantProxy(request, (await context.params).id, false);
}
