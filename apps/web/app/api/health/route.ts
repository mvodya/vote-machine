// Check that the web server is alive
export function GET() {
  return Response.json(
    {status: 'alive'},
    {headers: {'Cache-Control': 'no-store'}},
  );
}
