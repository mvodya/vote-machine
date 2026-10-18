import {keepAssets} from '../../../../../../lib/server/asset-proxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Check the current viewer before reading or changing media
export async function POST(
  request: Request,
  context: {params: Promise<{id: string}>},
) {
  const params = await context.params;
  return keepAssets(request, params.id);
}
