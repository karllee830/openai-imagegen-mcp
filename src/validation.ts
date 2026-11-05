import { InvalidRequestError } from './errors.js';
import type { EditRequest, GenerateRequest } from './images.js';

type OutputOptions = Pick<GenerateRequest, 'background' | 'n' | 'output_compression' | 'output_format'>;

function checkOutputOptions(options: OutputOptions, maxImages: number): void {
  const format = options.output_format ?? 'png';

  if ((options.n ?? 1) > maxImages) {
    throw new InvalidRequestError(`n must not exceed ${maxImages}, the limit set by IMAGEGEN_MAX_N`);
  }
  if (options.output_compression !== undefined && format !== 'jpeg' && format !== 'webp') {
    throw new InvalidRequestError('output_compression requires output_format jpeg or webp');
  }
  if (options.background === 'transparent' && format === 'jpeg') {
    throw new InvalidRequestError('background transparent cannot be used with output_format jpeg');
  }
}

export function checkGenerateRequest(request: GenerateRequest, maxImages: number): void {
  checkOutputOptions(request, maxImages);

  const usesFrameOptions = request.frame_count !== undefined || request.frame_duration_ms !== undefined;
  if (usesFrameOptions && request.output_format !== 'gif') {
    throw new InvalidRequestError('frame_count and frame_duration_ms require output_format gif');
  }
}

export function checkEditRequest(
  request: Omit<EditRequest, 'image' | 'mask' | 'markup'> & { mask?: string; markup?: string },
  maxImages: number,
): void {
  checkOutputOptions(request, maxImages);

  if (request.mask !== undefined && request.markup !== undefined) {
    throw new InvalidRequestError('mask and markup cannot be combined');
  }
}
