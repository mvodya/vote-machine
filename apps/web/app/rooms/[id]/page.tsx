import AdminRoom from './room';

export const dynamic = 'force-dynamic';

// Read the room ID and show its admin page
export default async function RoomPage({
  params,
}: {
  params: Promise<{id: string}>;
}) {
  const {id} = await params;
  return <AdminRoom key={id} id={id} />;
}
