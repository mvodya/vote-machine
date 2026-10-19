import {adminVotingProxy} from '../../../../../lib/admin-voting-proxy';
export const dynamic = 'force-dynamic';
// Read the room's repeat rule
export async function GET(
  request: Request,
  context: {params: Promise<{id: string}>},
) {
  const {id} = await context.params;
  return adminVotingProxy(request, id);
}
// Save the repeat rule under its current room version
export async function PATCH(
  request: Request,
  context: {params: Promise<{id: string}>},
) {
  const {id} = await context.params;
  return adminVotingProxy(request, id);
}
