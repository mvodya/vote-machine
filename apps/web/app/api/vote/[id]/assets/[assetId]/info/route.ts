import {assetInfo} from '../../../../../../../lib/server/asset-proxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Check the current viewer before reading or changing media
export async function GET(
  request: Request,
  context: {params: Promise<{id: string; assetId: string}>},
) {
  const params = await context.params;
  return assetInfo(request, params.id, params.assetId, true);
}
