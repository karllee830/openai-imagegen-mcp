import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { toFile, type Uploadable } from 'openai';
import { expandPath } from './config.js';
import { InvalidRequestError } from './errors.js';
import { detectImageFormat, MIME_TYPES, type ImageFormat } from './formats.js';

const MAX_INPUT_BYTES = 50 * 1024 * 1024;
const RASTER_INPUT_FORMATS: readonly ImageFormat[] = ['png', 'jpeg', 'webp'];

/**
 * Loads a local image for upload. Content is checked because the path comes from
 * the model: only real images may leave the machine, whatever the file is called.
 */
export async function loadInputImage(
  path: string,
  label: string,
  allowedFormats: readonly ImageFormat[] = RASTER_INPUT_FORMATS,
): Promise<Uploadable> {
  const resolved = expandPath(path);

  const info = await stat(resolved).catch(() => undefined);
  if (!info?.isFile()) throw new InvalidRequestError(`${label}: no file found at ${resolved}`);
  if (info.size > MAX_INPUT_BYTES) throw new InvalidRequestError(`${label}: file is larger than 50 MB`);

  const data = await readFile(resolved);
  const format = detectImageFormat(data);
  if (!format || !allowedFormats.includes(format)) {
    throw new InvalidRequestError(`${label}: file content must be one of ${allowedFormats.join(', ')}`);
  }
  return toFile(data, basename(resolved), { type: MIME_TYPES[format] });
}
