import {registrationProxy} from '../../../../../lib/registration-proxy';
export const dynamic = 'force-dynamic';
// Keep group registration separate from question access
export async function GET(
  request: Request,
  context: {params: Promise<{id: string}>},
) {
  return registrationProxy(request, (await context.params).id);
}
export const POST = GET;
