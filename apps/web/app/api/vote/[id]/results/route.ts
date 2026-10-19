import {resultsProxy} from '../../../../../lib/results-proxy';
export const dynamic = 'force-dynamic';
// Read results with the access role fixed by this route
export async function GET(
  request: Request,
  context: {params: Promise<{id: string}>},
) {
  const {id} = await context.params;
  return resultsProxy(request, id, false);
}
