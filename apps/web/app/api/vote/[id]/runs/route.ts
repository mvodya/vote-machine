import {runProxy} from '../../../../../lib/run-proxy';
export const dynamic = 'force-dynamic';
// Create one idempotent additional run
export async function POST(
  request: Request,
  context: {params: Promise<{id: string}>},
) {
  const {id} = await context.params;
  return runProxy(request, id);
}
