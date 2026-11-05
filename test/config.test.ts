import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectWorkspace, loadConfig } from '../src/config.js';

const KEY = { OPENAI_API_KEY: 'sk-test' };

describe('loadConfig', () => {
  it('requires an API key', () => {
    expect(() => loadConfig({})).toThrow('OPENAI_API_KEY');
  });

  it('applies defaults', () => {
    expect(loadConfig(KEY)).toEqual({
      apiKey: 'sk-test',
      baseURL: undefined,
      home: join(homedir(), '.openai-imagegen-mcp'),
      defaultWorkspace: detectWorkspace({}, process.cwd()),
      waitMs: 50_000,
      requestTimeoutMs: 300_000,
      maxImagesPerRequest: 4,
    });
  });

  it('removes trailing slashes from the base URL', () => {
    expect(loadConfig({ ...KEY, OPENAI_BASE_URL: 'https://relay.example/v1/' }).baseURL).toBe('https://relay.example/v1');
  });

  it.each([
    ['https://relay.example', 'https://relay.example/v1'],
    ['https://relay.example/', 'https://relay.example/v1'],
    ['https://relay.example/custom/path', 'https://relay.example/custom/path'],
  ])('adds the version path only to a bare host: %s', (input, expected) => {
    expect(loadConfig({ ...KEY, OPENAI_BASE_URL: input }).baseURL).toBe(expected);
  });

  it('treats an empty base URL as unset', () => {
    expect(loadConfig({ ...KEY, OPENAI_BASE_URL: '  ' }).baseURL).toBeUndefined();
  });

  it('expands a home-relative images folder', () => {
    expect(loadConfig({ ...KEY, IMAGEGEN_HOME: '~/images' }).home).toBe(join(homedir(), 'images'));
  });

  it.each([
    [{ CLAUDE_PROJECT_DIR: '/work/from-env' }, '/work/other', 'from-env'],
    [{}, '/work/my-site', 'my-site'],
    [{}, '/', 'default'],
    [{}, homedir(), 'default'],
  ])('detects the default workspace from %j and %s', (env, cwd, expected) => {
    expect(detectWorkspace(env, cwd)).toBe(expected);
  });

  it.each([
    ['OPENAI_BASE_URL', 'not a url'],
    ['OPENAI_BASE_URL', 'ftp://relay.example'],
    ['IMAGEGEN_HOME', 'relative/images'],
    ['IMAGEGEN_HOME', './images'],
    ['IMAGEGEN_WAIT_SECONDS', '0'],
    ['IMAGEGEN_WAIT_SECONDS', 'soon'],
    ['IMAGEGEN_REQUEST_TIMEOUT_SECONDS', '-1'],
    ['IMAGEGEN_MAX_N', '11'],
    ['IMAGEGEN_MAX_N', '1.5'],
  ])('rejects %s=%s', (name, value) => {
    expect(() => loadConfig({ ...KEY, [name]: value })).toThrow(name);
  });
});
