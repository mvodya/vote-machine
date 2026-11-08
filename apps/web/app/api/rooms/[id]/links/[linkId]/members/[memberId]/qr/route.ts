import QRCode from 'qrcode';
import {registrationAdminProxy} from '../../../../../../../../../lib/registration-proxy';
import {registrationUrl} from '../../../../../../../../../lib/registrations';
export const dynamic = 'force-dynamic';
// Render a recovery QR without putting its key in the image address
export async function GET(
  request: Request,
  context: {params: Promise<{id: string; linkId: string; memberId: string}>},
) {
  const {id, linkId, memberId} = await context.params;
  const response = await registrationAdminProxy(
    request,
    id,
    linkId,
    memberId,
    true,
  );
  if (!response.ok) return response;
  const {token} = await response.json();
  const png = await QRCode.toBuffer(
    registrationUrl(
      process.env.PUBLIC_ORIGIN || new URL(request.url).origin,
      linkId,
      memberId,
      token,
    ),
    {type: 'png', width: 768, margin: 4, errorCorrectionLevel: 'M'},
  );
  return new Response(new Uint8Array(png), {
    headers: {
      'Content-Type': 'image/png',
      'Content-Disposition': 'inline; filename="registration-qr.png"',
      'Cache-Control': 'private, no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
