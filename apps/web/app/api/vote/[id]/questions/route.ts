import {journeyProxy} from '../../../../../lib/journey-proxy';
export const dynamic = 'force-dynamic';
// Read current questions and the participant's own history
export async function GET(
  request: Request,
  context: {params: Promise<{id: string}>},
) {
  const {id} = await context.params;
  return journeyProxy(request, id);
}
