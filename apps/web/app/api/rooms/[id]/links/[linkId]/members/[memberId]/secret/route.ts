import {registrationAdminProxy} from '../../../../../../../../../lib/registration-proxy';
export const dynamic = 'force-dynamic';
// Return a recovery key only to the room admin
export async function GET(
  request: Request,
  context: {params: Promise<{id: string; linkId: string; memberId: string}>},
) {
  const {id, linkId, memberId} = await context.params;
  return registrationAdminProxy(request, id, linkId, memberId, true);
}
