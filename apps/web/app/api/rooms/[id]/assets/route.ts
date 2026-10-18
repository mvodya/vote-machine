import {uploadAsset} from '../../../../../lib/server/asset-proxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

// Check the current viewer before reading or changing media
export async function POST(
  request: Request,
  context: {params: Promise<{id: string}>},
) {
  const params = await context.params;
  return uploadAsset(request, params.id);
}
