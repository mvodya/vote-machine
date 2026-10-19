import {questionProxy} from '../../../../../../../lib/question-proxy';
export const dynamic = 'force-dynamic';
// Reset only after the explicit admin confirmation
export async function POST(
  request: Request,
  context: {params: Promise<{id: string; questionId: string}>},
) {
  const {id, questionId} = await context.params;
  return questionProxy(request, id, questionId, false, false, true);
}
