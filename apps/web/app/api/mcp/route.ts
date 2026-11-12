import {serveMcp} from '../../../lib/server/mcp-tools';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

// Serve one public endpoint for every room
export const GET = serveMcp;
export const POST = serveMcp;
