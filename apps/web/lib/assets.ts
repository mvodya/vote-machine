import {roomIdPattern} from './rooms';
import {isRecord} from './voting-links';

export const maxUploadBytes = 10 * 1024 * 1024;
export const maxMediaPixels = 25000000;
export const acceptedMedia =
  'image/png,image/jpeg,image/webp,image/gif,image/jxl,image/avif,video/mp4,video/webm,.jxl';
export interface Asset {
  // Generated file ID
  id: string;
  // Image or video display mode
  kind: 'image' | 'video';
  // Safe stored media type
  mime: string;
  // Width of the image or video frame
  width: number;
  // Height of the image or video frame
  height: number;
  // Size after processing
  bytes: number;
}
export interface MediaViewer {
  // Room that owns the content
  roomId: string;
  // Participant link, missing for an admin viewer
  linkId?: string;
}
// Never accept a remote URL as an uploaded media reference
export function assetId(url: unknown): string | null {
  if (typeof url !== 'string' || !url.startsWith('asset:')) return null;
  const id = url.slice(6);
  return roomIdPattern.test(id) ? id : null;
}
// Keep display data small and independent of storage credentials
export function isAsset(value: unknown): value is Asset {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    roomIdPattern.test(value.id) &&
    (value.kind === 'image' || value.kind === 'video') &&
    typeof value.mime === 'string' &&
    [
      'image/png',
      'image/jpeg',
      'image/webp',
      'image/gif',
      'video/mp4',
      'video/webm',
    ].includes(value.mime) &&
    value.mime.startsWith(`${value.kind}/`) &&
    Number.isInteger(value.width) &&
    Number(value.width) > 0 &&
    Number.isInteger(value.height) &&
    Number(value.height) > 0 &&
    Number(value.width) * Number(value.height) <= maxMediaPixels &&
    Number.isInteger(value.bytes) &&
    Number(value.bytes) > 0 &&
    Number(value.bytes) <= maxUploadBytes
  );
}
// Use a scoped cookie path for each viewer role
export function assetPath(viewer: MediaViewer, id: string) {
  return viewer.linkId
    ? `/api/vote/${viewer.linkId}/assets/${id}`
    : `/api/rooms/${viewer.roomId}/assets/${id}`;
}
// Copy only public media metadata
export function publicAsset(value: Asset): Asset {
  return {
    id: value.id,
    kind: value.kind,
    mime: value.mime,
    width: value.width,
    height: value.height,
    bytes: value.bytes,
  };
}
