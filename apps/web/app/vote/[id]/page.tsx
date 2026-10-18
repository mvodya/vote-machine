import VotingEntry from './voting-entry';
export const dynamic = 'force-dynamic';
// Open only the participant link, not the room admin page
export default async function VotePage({
  params,
}: {
  params: Promise<{id: string}>;
}) {
  const {id} = await params;
  return <VotingEntry key={id} id={id} />;
}
