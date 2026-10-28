import QRCode from 'qrcode';
import {adminLinkProxy} from '../link-proxy';
import {votingUrl} from '../voting-links';

// Render the current secret only after checking this room's admin session
export async function linkQr(request: Request, room: string, link: string) {
  const secret = await adminLinkProxy(request, room, link, true);
  if (!secret.ok) return secret;
  try {
    const {token} = await secret.json();
    const origin = process.env.PUBLIC_ORIGIN || new URL(request.url).origin;
    const png = await QRCode.toBuffer(votingUrl(origin, link, token), {
      type: 'png',
      width: 768,
      margin: 4,
      errorCorrectionLevel: 'M',
    });
    return new Response(new Uint8Array(png), {
      headers: {
        'Content-Type': 'image/png',
        'Content-Disposition': 'inline; filename="link-qr.png"',
        'Cache-Control': 'private, no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch {
    return Response.json(
      {error: 'QR unavailable'},
      {
        status: 503,
        headers: {
          'Cache-Control': 'private, no-store',
          'Referrer-Policy': 'no-referrer',
        },
      },
    );
  }
}
