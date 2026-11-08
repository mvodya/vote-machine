import {registrationAdminProxy} from '../../../../../../../../lib/registration-proxy';
// Moderate one person without changing the group link
export async function PATCH(
  request: Request,
  context: {params: Promise<{id: string; linkId: string; memberId: string}>},
) {
  const {id, linkId, memberId} = await context.params;
  return registrationAdminProxy(request, id, linkId, memberId);
}
