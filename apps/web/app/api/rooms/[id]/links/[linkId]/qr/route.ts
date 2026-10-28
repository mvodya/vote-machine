import {linkQr} from '../../../../../../../lib/server/link-qr';
export const dynamic = 'force-dynamic';
// A direct PNG page keeps the secret out of its address
export async function GET(
  request: Request,
  context: {params: Promise<{id: string; linkId: string}>},
) {
  const {id, linkId} = await context.params;
  return linkQr(request, id, linkId);
}
