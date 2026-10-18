import {questionProxy} from '../../../../../../lib/question-proxy';

export const dynamic = 'force-dynamic';

// Check the room session before forwarding this request
export async function GET(
  request: Request,
  context: {params: Promise<{id: string; questionId: string}>},
) {
  const params = await context.params;
  return questionProxy(request, params.id, params.questionId);
}

// Check the room session before forwarding this request
export async function PATCH(
  request: Request,
  context: {params: Promise<{id: string; questionId: string}>},
) {
  const params = await context.params;
  return questionProxy(request, params.id, params.questionId);
}

// Check the room session before forwarding this request
export async function DELETE(
  request: Request,
  context: {params: Promise<{id: string; questionId: string}>},
) {
  const params = await context.params;
  return questionProxy(request, params.id, params.questionId);
}
