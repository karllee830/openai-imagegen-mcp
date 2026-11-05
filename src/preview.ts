import sharp from 'sharp';

export interface Preview {
  data: Buffer;
  width: number;
  height: number;
}

export const PREVIEW_MIME_TYPE = 'image/jpeg';

// Clients limit tool results in ways they rarely document, and some count base64
// as text. This keeps a whole result small enough for the strictest ones known.
export const MAX_PREVIEW_BYTES = 75 * 1024;

const DIMENSIONS = [1024, 768, 512, 384, 256];
const QUALITIES = [80, 60, 45];

/** Returns the sharpest preview that fits, or nothing if none fits or the image cannot be read. */
export async function createPreview(image: Buffer, maxBytes: number): Promise<Preview | undefined> {
  try {
    for (const dimension of DIMENSIONS) {
      for (const quality of QUALITIES) {
        const { data, info } = await sharp(image)
          .resize(dimension, dimension, { fit: 'inside', withoutEnlargement: true })
          .flatten({ background: '#ffffff' })
          .jpeg({ quality })
          .toBuffer({ resolveWithObject: true });
        if (data.length <= maxBytes) return { data, width: info.width, height: info.height };
      }
    }
  } catch {
    // The original is already saved, so a missing preview must not fail the request.
  }
  return undefined;
}

export async function createPreviews(images: Buffer[]): Promise<(Preview | undefined)[]> {
  const budget = Math.floor(MAX_PREVIEW_BYTES / images.length);
  return Promise.all(images.map((image) => createPreview(image, budget)));
}
