import {adminVotingProxy} from '../../../../../../../lib/admin-voting-proxy';
export const dynamic = 'force-dynamic';
// Read versions without disclosing a prior respondent's selection
export async function GET(
  request: Request,
  context: {params: Promise<{id: string; questionId: string}>},
) {
  const {id, questionId} = await context.params;
  return adminVotingProxy(request, id, questionId);
}
// Submit a manual ballot with a stable request ID
export async function POST(
  request: Request,
  context: {params: Promise<{id: string; questionId: string}>},
) {
  const {id, questionId} = await context.params;
  return adminVotingProxy(request, id, questionId);
}
