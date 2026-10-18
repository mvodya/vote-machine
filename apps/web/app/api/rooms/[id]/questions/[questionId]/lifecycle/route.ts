import {questionProxy} from '../../../../../../../lib/question-proxy';

export const dynamic = 'force-dynamic';
// Change state through the same scoped admin session
export async function POST(
  request: Request,
  context: {params: Promise<{id: string; questionId: string}>},
) {
  const params = await context.params;
  return questionProxy(request, params.id, params.questionId, false, true);
}
