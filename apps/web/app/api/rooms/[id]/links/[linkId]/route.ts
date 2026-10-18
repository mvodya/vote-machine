import {adminLinkProxy} from '../../../../../../lib/link-proxy';

export const dynamic = 'force-dynamic';

// Forward this admin link action after checking its session
export async function PATCH(
  request: Request,
  context: {params: Promise<{id: string; linkId: string}>},
) {
  const params = await context.params;
  return adminLinkProxy(request, params.id, params.linkId);
}
