import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { InvalidRequestError } from './errors.js';
import { detectImageFormat, FILE_EXTENSIONS, MIME_TYPES } from './formats.js';

export interface SavedImage {
  path: string;
  uri: string;
  mime_type: string;
  bytes: number;
}

const SAFE_FILENAME = /^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u;
const KNOWN_EXTENSION = /\.(png|jpe?g|webp|gif)$/i;
const MAX_FILENAME_LENGTH = 120;

/** Accepts a bare file name only, so a save can never leave the output directory. */
export function parseFilename(filename: string): string {
  if (filename.length > MAX_FILENAME_LENGTH || !SAFE_FILENAME.test(filename)) {
    throw new InvalidRequestError(
      `filename must be a plain name of at most ${MAX_FILENAME_LENGTH} characters, with no path separators`,
    );
  }
  return filename.replace(KNOWN_EXTENSION, '');
}

async function writeWithoutOverwriting(dir: string, name: string, extension: string, data: Buffer): Promise<string> {
  for (let attempt = 1; ; attempt += 1) {
    const candidate = join(dir, attempt === 1 ? `${name}.${extension}` : `${name}-${attempt}.${extension}`);
    try {
      await writeFile(candidate, data, { flag: 'wx' });
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
}

export async function saveImages(images: Buffer[], dir: string, name: string): Promise<SavedImage[]> {
  await mkdir(dir, { recursive: true });

  const saved: SavedImage[] = [];
  for (const [index, data] of images.entries()) {
    const format = detectImageFormat(data);
    if (!format) throw new Error('The API returned data that is not a recognized image format');

    const imageName = images.length > 1 ? `${name}-${index + 1}` : name;
    const path = await writeWithoutOverwriting(dir, imageName, FILE_EXTENSIONS[format], data);
    saved.push({
      path,
      uri: pathToFileURL(path).href,
      mime_type: MIME_TYPES[format],
      bytes: data.length,
    });
  }
  return saved;
}
