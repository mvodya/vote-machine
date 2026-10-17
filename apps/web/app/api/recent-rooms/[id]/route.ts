import {NextResponse} from 'next/server';
import {forgetRoom, sameOrigin} from '../../../../lib/recent-rooms';
import {roomIdPattern} from '../../../../lib/rooms';
// Remove one entry from this browser
export async function DELETE(
  request: Request,
  context: {params: Promise<{id: string}>},
) {
  // Only this site may remove a saved entry
  if (!sameOrigin(request))
    return NextResponse.json({error: 'Request failed'}, {status: 403});
  const {id} = await context.params;
  // Do not change unrelated cookies
  if (!roomIdPattern.test(id))
    return NextResponse.json({error: 'Request failed'}, {status: 400});
  const response = NextResponse.json(
    {removed: true},
    {headers: {'Cache-Control': 'no-store'}},
  );
  // The room and its other sessions stay in the database
  forgetRoom(response, request, id);
  return response;
}
