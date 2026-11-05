import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { detectImageFormat, FILE_EXTENSIONS, MIME_TYPES, type ImageFormat } from './formats.js';

export interface SavedImage {
  path: string;
  uri: string;
  mime_type: string;
  bytes: number;
}

export const FALLBACK_WORKSPACE = 'default';

const MAX_FOLDER_NAME_LENGTH = 120;

/**
 * Turns a working directory path or name into one folder name. Only the last
 * segment is kept, so the value can never move a save out of the images folder.
 */
export function workspaceFolderName(workspace: string | undefined): string {
  const lastSegment = workspace?.split(/[/\\]/).filter(Boolean).at(-1) ?? '';
  const safe = lastSegment
    .replace(/[^\p{L}\p{N} ._-]/gu, '-')
    .replace(/^[ .-]+/, '')
    .slice(0, MAX_FOLDER_NAME_LENGTH)
    .trimEnd();
  return safe || FALLBACK_WORKSPACE;
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
  const formats = images.map((data) => {
    const format = detectImageFormat(data);
    if (!format) throw new Error('The API returned data that is not a recognized image format');
    return format;
  });
  await mkdir(dir, { recursive: true });

  const saved: SavedImage[] = [];
  for (const [index, data] of images.entries()) {
    const format = formats[index] as ImageFormat;
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
