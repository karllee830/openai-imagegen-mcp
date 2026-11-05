import OpenAI, { type Uploadable } from 'openai';
import type { Config } from './config.js';

export interface GenerateRequest {
  prompt: string;
  model: string;
  size?: string;
  quality?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'auto';
  complexity?: 'low' | 'medium' | 'high';
  background?: 'transparent' | 'opaque' | 'auto';
  output_format?: 'png' | 'jpeg' | 'webp' | 'gif';
  output_compression?: number;
  n?: number;
  frame_count?: number;
  frame_duration_ms?: number;
  moderation?: 'auto' | 'low';
}

export interface EditRequest extends Omit<GenerateRequest, 'output_format' | 'frame_count' | 'frame_duration_ms'> {
  output_format?: 'png' | 'jpeg' | 'webp';
  image: Uploadable[];
  mask?: Uploadable;
  markup?: Uploadable;
}

export interface ImageResult {
  images: Buffer[];
  revisedPrompts: string[];
  usage?: Record<string, unknown>;
}

type ImagesResponse = OpenAI.Images.ImagesResponse;

export function createClient(config: Config): OpenAI {
  return new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    timeout: config.requestTimeoutMs,
  });
}

// Compatible endpoints sometimes return a data URL where the API returns plain base64.
function decodeBase64(value: string): Buffer {
  return Buffer.from(value.replace(/^data:[^,]*;base64,/, ''), 'base64');
}

// The credential is deliberately not sent here: the URL may point at a separate file host.
async function download(url: string, signal: AbortSignal): Promise<Buffer> {
  if (!/^https?:\/\//i.test(url)) throw new Error('The API returned an image URL that is not http or https');
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Downloading the generated image failed with status ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function readResponse(response: ImagesResponse, signal: AbortSignal): Promise<ImageResult> {
  const items = response.data ?? [];
  if (items.length === 0) {
    throw new Error('The API response contained no images. Check that OPENAI_BASE_URL is the API root, including the version path, such as /v1.');
  }

  const images = await Promise.all(
    items.map(async (item) => {
      if (item.b64_json) return decodeBase64(item.b64_json);
      if (item.url) return download(item.url, signal);
      throw new Error('The API response contained an image with neither b64_json nor url');
    }),
  );

  return {
    images,
    revisedPrompts: items.flatMap((item) => (item.revised_prompt ? [item.revised_prompt] : [])),
    usage: response.usage as unknown as Record<string, unknown> | undefined,
  };
}

export async function generateImages(client: OpenAI, request: GenerateRequest, signal: AbortSignal): Promise<ImageResult> {
  return readResponse(await client.images.generate(request, { signal }), signal);
}

export async function editImages(client: OpenAI, request: EditRequest, signal: AbortSignal): Promise<ImageResult> {
  return readResponse(await client.images.edit(request, { signal }), signal);
}
