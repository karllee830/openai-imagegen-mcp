import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

// The models this server offers. Moving to a new GPT Image generation means
// replacing these and removing whatever only the old one needed.
export const IMAGE_MODELS = ['gpt-image-2.6-flare', 'gpt-image-2.6-sunburst'] as const;
export const DEFAULT_IMAGE_MODEL = IMAGE_MODELS[0];

export interface Config {
  apiKey: string;
  baseURL: string | undefined;
  outputDir: string;
  waitMs: number;
  requestTimeoutMs: number;
  maxImagesPerRequest: number;
}

const API_IMAGE_LIMIT = 10;

export function expandPath(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return resolve(path);
}

function positiveNumber(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number, got "${raw}"`);
  }
  return value;
}

function parseBaseURL(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`OPENAI_BASE_URL is not a valid URL: "${value}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('OPENAI_BASE_URL must use http or https');
  }
  const trimmed = value.replace(/\/+$/, '');
  // A bare host is the easiest mistake to make, and without the version path
  // gateways tend to answer with a web page instead of an error.
  return url.pathname === '/' ? `${trimmed}/v1` : trimmed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiKey = env['OPENAI_API_KEY']?.trim();
  if (!apiKey) throw new Error('OPENAI_API_KEY is required');

  const maxImages = positiveNumber(env, 'IMAGEGEN_MAX_N', 4);
  if (!Number.isInteger(maxImages) || maxImages > API_IMAGE_LIMIT) {
    throw new Error(`IMAGEGEN_MAX_N must be an integer from 1 to ${API_IMAGE_LIMIT}`);
  }

  return {
    apiKey,
    baseURL: parseBaseURL(env['OPENAI_BASE_URL']),
    outputDir: expandPath(env['IMAGEGEN_OUTPUT_DIR']?.trim() || join(homedir(), 'Pictures', 'imagegen')),
    waitMs: positiveNumber(env, 'IMAGEGEN_WAIT_SECONDS', 50) * 1000,
    requestTimeoutMs: positiveNumber(env, 'IMAGEGEN_REQUEST_TIMEOUT_SECONDS', 300) * 1000,
    maxImagesPerRequest: maxImages,
  };
}
