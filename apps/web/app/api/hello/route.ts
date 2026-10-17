import {isHello} from '../../../lib/hello';

export const dynamic = 'force-dynamic';

// Read the hello reply from the API
export async function GET() {
  const origin = process.env.API_ORIGIN ?? 'http://api:8080';
  const headers = {'Cache-Control': 'no-store'};
  try {
    const upstream = await fetch(new URL('/api/hello', origin), {
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    // Hide API and database errors
    if (!upstream.ok) {
      return Response.json(
        {error: 'Service is unavailable'},
        {status: 503, headers},
      );
    }
    const body: unknown = await upstream.json();
    // Do not pass bad reply data to the page
    if (!isHello(body)) {
      return Response.json(
        {error: 'Invalid service response'},
        {status: 502, headers},
      );
    }
    return Response.json(
      {message: body.message, database: body.database},
      {headers},
    );
  } catch {
    return Response.json(
      {error: 'Service is unavailable'},
      {status: 503, headers},
    );
  }
}
