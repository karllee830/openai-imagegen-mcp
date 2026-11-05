import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_IMAGE_MODEL, IMAGE_MODELS } from '../src/config.js';
import { FakeImagesApi, PNG_BYTES, sendImage, sendJson } from './helpers.js';

const API_KEY = 'sk-test-secret-value';
const SERVER_ENTRY = fileURLToPath(new URL('../dist/index.js', import.meta.url));

interface Output {
  status: 'completed' | 'running' | 'failed';
  job_id?: string;
  next?: string;
  images?: { path: string; uri: string; mime_type: string; bytes: number }[];
  usage?: Record<string, unknown>;
  error?: { message: string; code?: string; status?: number };
}

interface CallResult {
  isError?: boolean;
  structuredContent?: unknown;
  content: { type: string; text?: string }[];
}

describe('MCP server over stdio', () => {
  let api: FakeImagesApi;
  let workDir: string;
  let outputDir: string;
  let client: Client | undefined;

  async function connect(env: Record<string, string> = {}): Promise<Client> {
    const baseUrl = await api.start();
    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [SERVER_ENTRY],
        env: {
          OPENAI_API_KEY: API_KEY,
          OPENAI_BASE_URL: `${baseUrl}/v1`,
          IMAGEGEN_OUTPUT_DIR: outputDir,
          IMAGEGEN_WAIT_SECONDS: '5',
          ...env,
        },
      }),
    );
    return client;
  }

  async function call(mcp: Client, name: string, args: Record<string, unknown>) {
    const result = (await mcp.callTool({ name, arguments: args })) as CallResult;
    return { result, output: result.structuredContent as Output };
  }

  beforeEach(async () => {
    api = new FakeImagesApi();
    workDir = await mkdtemp(join(tmpdir(), 'imagegen-test-'));
    outputDir = join(workDir, 'out');
  });

  afterEach(async () => {
    await client?.close();
    client = undefined;
    await api.stop();
    await rm(workDir, { recursive: true, force: true });
  });

  it('lists the three tools', async () => {
    const mcp = await connect();
    const { tools } = await mcp.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(['edit_image', 'generate_image', 'get_image_result']);
  });

  it('generates an image, saves it and returns the path', async () => {
    const mcp = await connect();
    const { result, output } = await call(mcp, 'generate_image', { prompt: 'a cat', complexity: 'low', filename: 'cat' });

    expect(result.isError).toBeFalsy();
    expect(output.status).toBe('completed');
    expect(output.usage).toEqual({ total_tokens: 42 });
    const image = output.images![0]!;
    expect(image.path).toBe(join(outputDir, 'cat.png'));
    expect(image.mime_type).toBe('image/png');
    expect(await readFile(image.path)).toEqual(PNG_BYTES);
    expect(result.content.map((block) => block.type)).toEqual(['text', 'resource_link']);

    expect(api.requests).toHaveLength(1);
    const request = api.requests[0]!;
    expect(request.path).toBe('/v1/images/generations');
    expect(request.authorization).toBe(`Bearer ${API_KEY}`);
    expect(request.json).toEqual({ prompt: 'a cat', complexity: 'low', model: DEFAULT_IMAGE_MODEL });
  });

  it('describes both models in the image tools', async () => {
    const mcp = await connect();
    const { tools } = await mcp.listTools();

    for (const name of ['generate_image', 'edit_image']) {
      const tool = tools.find((candidate) => candidate.name === name)!;
      const model = tool.inputSchema.properties!['model'] as { enum: string[]; description: string };
      expect(model.enum).toEqual([...IMAGE_MODELS]);
      for (const id of IMAGE_MODELS) expect(model.description).toContain(id);
    }
  });

  it('tells callers to write prompts in English', async () => {
    const mcp = await connect();
    const { tools } = await mcp.listTools();

    for (const name of ['generate_image', 'edit_image']) {
      const tool = tools.find((candidate) => candidate.name === name)!;
      const prompt = tool.inputSchema.properties!['prompt'] as { description: string };
      expect(prompt.description).toContain('Must be written in English');
    }
    expect(mcp.getInstructions()).toContain('always write the prompt in English');
  });

  it('uses the chosen model', async () => {
    const mcp = await connect();
    await call(mcp, 'generate_image', { prompt: 'x', model: 'gpt-image-2.6-sunburst' });
    expect(api.requests[0]!.json).toMatchObject({ model: 'gpt-image-2.6-sunburst' });
  });

  it('rejects a model outside the supported list before calling the API', async () => {
    const mcp = await connect();
    const result = (await mcp.callTool({
      name: 'generate_image',
      arguments: { prompt: 'x', model: 'gpt-image-2.5-flare' },
    })) as CallResult;

    expect(result.isError).toBe(true);
    expect(api.requests).toHaveLength(0);
  });

  it('ignores the removed IMAGEGEN_MODEL variable', async () => {
    const mcp = await connect({ IMAGEGEN_MODEL: 'gpt-image-2.6-sunburst' });
    await call(mcp, 'generate_image', { prompt: 'x' });
    expect(api.requests[0]!.json).toMatchObject({ model: DEFAULT_IMAGE_MODEL });
  });

  it('does not offer svg output', async () => {
    const mcp = await connect();
    const result = (await mcp.callTool({
      name: 'generate_image',
      arguments: { prompt: 'x', output_format: 'svg' },
    })) as CallResult;

    expect(result.isError).toBe(true);
    expect(api.requests).toHaveLength(0);
  });

  it('allows a transparent background with gif', async () => {
    const mcp = await connect();
    await call(mcp, 'generate_image', { prompt: 'x', output_format: 'gif', background: 'transparent' });
    expect(api.requests[0]!.json).toMatchObject({ output_format: 'gif', background: 'transparent' });
  });

  it('points at the base URL when a gateway answers with a web page', async () => {
    const mcp = await connect();
    api.respond = (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><html></html>');
    };

    const { output } = await call(mcp, 'generate_image', { prompt: 'x' });
    expect(output.status).toBe('failed');
    expect(output.error?.message).toContain('OPENAI_BASE_URL');
  });

  it('never overwrites an existing file', async () => {
    const mcp = await connect();
    const first = await call(mcp, 'generate_image', { prompt: 'a', filename: 'same' });
    const second = await call(mcp, 'generate_image', { prompt: 'b', filename: 'same' });

    expect(first.output.images![0]!.path).toBe(join(outputDir, 'same.png'));
    expect(second.output.images![0]!.path).toBe(join(outputDir, 'same-2.png'));
  });

  it('returns a job after the wait and delivers the result without a second generation', async () => {
    const mcp = await connect({ IMAGEGEN_WAIT_SECONDS: '0.3' });
    api.respond = async (_request, response) => {
      await new Promise((resolve) => setTimeout(resolve, 700));
      sendImage(response);
    };

    const first = await call(mcp, 'generate_image', { prompt: 'slow' });
    expect(first.result.isError).toBeFalsy();
    expect(first.output.status).toBe('running');
    expect(first.output.next).toContain(first.output.job_id);

    let current = first.output;
    for (let attempt = 0; attempt < 10 && current.status === 'running'; attempt += 1) {
      current = (await call(mcp, 'get_image_result', { job_id: first.output.job_id })).output;
    }
    expect(current.status).toBe('completed');
    expect(await readFile(current.images![0]!.path)).toEqual(PNG_BYTES);
    expect(api.requests).toHaveLength(1);
  });

  it('reports progress while waiting', async () => {
    const mcp = await connect({ IMAGEGEN_WAIT_SECONDS: '1' });
    api.respond = async (_request, response) => {
      await new Promise((resolve) => setTimeout(resolve, 700));
      sendImage(response);
    };

    const updates: number[] = [];
    await mcp.callTool(
      { name: 'generate_image', arguments: { prompt: 'slow' } },
      { onprogress: (update) => updates.push(update.progress) },
    );
    expect(updates.length).toBeGreaterThan(0);
    expect([...updates].sort((a, b) => a - b)).toEqual(updates);
  });

  it('stops the upstream request when the initial call is cancelled', async () => {
    const mcp = await connect({ IMAGEGEN_WAIT_SECONDS: '30' });
    api.respond = () => {};

    const controller = new AbortController();
    const pending = mcp.callTool({ name: 'generate_image', arguments: { prompt: 'never' } }, { signal: controller.signal });
    await expect.poll(() => api.requests.length).toBe(1);
    controller.abort();
    await expect(pending).rejects.toThrow();

    await expect.poll(() => api.disconnects).toBe(1);
  });

  it('keeps a running job alive when a get_image_result call is cancelled', async () => {
    const mcp = await connect({ IMAGEGEN_WAIT_SECONDS: '0.2' });
    let release = () => {};
    api.respond = async (_request, response) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      sendImage(response);
    };

    const { output } = await call(mcp, 'generate_image', { prompt: 'slow' });
    expect(output.status).toBe('running');

    const controller = new AbortController();
    const pending = mcp.callTool({ name: 'get_image_result', arguments: { job_id: output.job_id } }, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(api.disconnects).toBe(0);

    release();
    await expect
      .poll(async () => (await call(mcp, 'get_image_result', { job_id: output.job_id })).output.status)
      .toBe('completed');
  });

  it('reports moderation failures without retrying', async () => {
    const mcp = await connect();
    api.respond = (_request, response) =>
      sendJson(response, 400, {
        error: {
          type: 'image_generation_user_error',
          code: 'moderation_blocked',
          message: 'Blocked',
          moderation_details: { categories: ['example'] },
        },
      });

    const { result, output } = await call(mcp, 'generate_image', { prompt: 'blocked' });
    expect(result.isError).toBe(true);
    expect(output.status).toBe('failed');
    expect(output.error).toMatchObject({
      code: 'moderation_blocked',
      status: 400,
      moderation_details: { categories: ['example'] },
    });
    expect(api.requests).toHaveLength(1);
  });

  it('removes the API key from upstream error text', async () => {
    const mcp = await connect();
    api.respond = (_request, response) =>
      sendJson(response, 401, { error: { message: `Bad key ${API_KEY}`, code: 'invalid_api_key' } });

    const { result, output } = await call(mcp, 'generate_image', { prompt: 'x' });
    expect(output.error?.message).toContain('[redacted]');
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });

  it('points at the base URL on a 404', async () => {
    const mcp = await connect();
    api.respond = (_request, response) => sendJson(response, 404, { error: { message: 'Not found' } });

    const { output } = await call(mcp, 'generate_image', { prompt: 'x' });
    expect(output.error?.message).toContain('OPENAI_BASE_URL');
  });

  it('explains when the endpoint does not offer the model', async () => {
    const mcp = await connect();
    api.respond = (_request, response) =>
      sendJson(response, 404, { error: { message: 'No such model', code: 'model_not_found' } });

    const { output } = await call(mcp, 'generate_image', { prompt: 'x' });
    expect(output.error?.code).toBe('model_not_found');
    for (const id of IMAGE_MODELS) expect(output.error?.message).toContain(id);
    expect(output.error?.message).not.toContain('OPENAI_BASE_URL');
  });

  it('accepts the url and data URL responses some compatible endpoints return', async () => {
    const mcp = await connect();
    api.respond = (request, response) => {
      if (request.path === '/files/result.png') {
        response.writeHead(200, { 'content-type': 'image/png' });
        response.end(PNG_BYTES);
        return;
      }
      sendJson(response, 200, { data: [{ url: `${api.origin}/files/result.png` }] });
    };

    const viaUrl = await call(mcp, 'generate_image', { prompt: 'url' });
    expect(await readFile(viaUrl.output.images![0]!.path)).toEqual(PNG_BYTES);
    expect(api.requests.at(-1)?.authorization).toBeUndefined();

    api.respond = (_request, response) =>
      sendJson(response, 200, { data: [{ b64_json: `data:image/png;base64,${PNG_BYTES.toString('base64')}` }] });
    const viaDataUrl = await call(mcp, 'generate_image', { prompt: 'data' });
    expect(await readFile(viaDataUrl.output.images![0]!.path)).toEqual(PNG_BYTES);
  });

  it('refuses upstream data that is not an image', async () => {
    const mcp = await connect();
    api.respond = (_request, response) =>
      sendJson(response, 200, { data: [{ b64_json: Buffer.from('<html>nope</html>').toString('base64') }] });

    const { output } = await call(mcp, 'generate_image', { prompt: 'x' });
    expect(output.status).toBe('failed');
    await expect(readdir(outputDir)).resolves.toEqual([]);
  });

  it.each([
    ['gif with compression', { output_format: 'gif', output_compression: 50 }],
    ['frames without gif', { frame_count: 4 }],
    ['transparent jpeg', { background: 'transparent', output_format: 'jpeg' }],
    ['more images than the limit', { n: 5 }],
    ['a path in filename', { filename: '../escape' }],
    ['a hidden filename', { filename: '.bashrc' }],
  ])('rejects %s before calling the API', async (_label, args) => {
    const mcp = await connect();
    const { result, output } = await call(mcp, 'generate_image', { prompt: 'x', ...args });
    expect(result.isError).toBe(true);
    expect(output.error?.code).toBe('invalid_request');
    expect(api.requests).toHaveLength(0);
  });

  it('reports an unknown job', async () => {
    const mcp = await connect();
    const { result, output } = await call(mcp, 'get_image_result', { job_id: 'img_missing' });
    expect(result.isError).toBe(true);
    expect(output.error?.code).toBe('unknown_job');
  });

  describe('edit_image', () => {
    let imagePath: string;

    beforeEach(async () => {
      imagePath = join(workDir, 'input.png');
      await writeFile(imagePath, PNG_BYTES);
    });

    it('uploads images and markup as multipart', async () => {
      const mcp = await connect();
      const markupPath = join(workDir, 'markup.png');
      await writeFile(markupPath, PNG_BYTES);

      const { output } = await call(mcp, 'edit_image', {
        prompt: 'recolor',
        images: [imagePath, imagePath],
        markup: markupPath,
        quality: 'medium',
        model: 'gpt-image-2.6-sunburst',
      });

      expect(output.status).toBe('completed');
      const request = api.requests[0]!;
      expect(request.path).toBe('/v1/images/edits');
      expect(request.form?.get('prompt')).toBe('recolor');
      expect(request.form?.get('quality')).toBe('medium');
      expect(request.form?.get('model')).toBe('gpt-image-2.6-sunburst');
      expect(request.form?.get('stream')).toBeNull();
      expect(request.form?.getAll('image[]')).toHaveLength(2);
      expect((request.form?.get('markup') as File).type).toBe('image/png');
    });

    it('refuses a non-image file whatever its name', async () => {
      const mcp = await connect();
      const secret = join(workDir, 'secret.png');
      await writeFile(secret, 'PRIVATE KEY MATERIAL');

      const { output } = await call(mcp, 'edit_image', { prompt: 'x', images: [secret] });
      expect(output.error?.code).toBe('invalid_request');
      expect(output.error?.message).not.toContain('PRIVATE KEY');
      expect(api.requests).toHaveLength(0);
    });

    it('refuses a missing file', async () => {
      const mcp = await connect();
      const { output } = await call(mcp, 'edit_image', { prompt: 'x', images: [join(workDir, 'absent.png')] });
      expect(output.error?.code).toBe('invalid_request');
    });

    it('refuses mask and markup together', async () => {
      const mcp = await connect();
      const { output } = await call(mcp, 'edit_image', { prompt: 'x', images: [imagePath], mask: imagePath, markup: imagePath });
      expect(output.error?.code).toBe('invalid_request');
      expect(api.requests).toHaveLength(0);
    });

    it('requires markup to be a PNG', async () => {
      const mcp = await connect();
      const jpeg = join(workDir, 'markup.jpg');
      await writeFile(jpeg, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]));

      const { output } = await call(mcp, 'edit_image', { prompt: 'x', images: [imagePath], markup: jpeg });
      expect(output.error?.code).toBe('invalid_request');
    });
  });
});
