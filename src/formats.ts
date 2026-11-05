export type ImageFormat = 'png' | 'jpeg' | 'webp' | 'gif';

export const MIME_TYPES: Record<ImageFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

export const FILE_EXTENSIONS: Record<ImageFormat, string> = {
  png: 'png',
  jpeg: 'jpg',
  webp: 'webp',
  gif: 'gif',
};

function hasBytes(data: Buffer, offset: number, bytes: number[]): boolean {
  return bytes.every((byte, index) => data[offset + index] === byte);
}

/** Identifies an image from its content, so a misnamed file is never trusted. */
export function detectImageFormat(data: Buffer): ImageFormat | undefined {
  if (hasBytes(data, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (hasBytes(data, 0, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (hasBytes(data, 0, [0x52, 0x49, 0x46, 0x46]) && hasBytes(data, 8, [0x57, 0x45, 0x42, 0x50])) return 'webp';
  if (hasBytes(data, 0, [0x47, 0x49, 0x46, 0x38])) return 'gif';
  return undefined;
}
