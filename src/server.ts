import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { McpServer, type ServerContext } from '@modelcontextprotocol/server';
import type OpenAI from 'openai';
import * as z from 'zod/v4';
import { DEFAULT_IMAGE_MODEL, IMAGE_MODELS, type Config } from './config.js';
import { toToolError, type ToolError } from './errors.js';
import {
  createClient,
  editImages,
  generateImages,
  type EditRequest,
  type GenerateRequest,
  type ImageResult,
} from './images.js';
import { loadInputImage } from './inputs.js';
import { JobStore, type Job } from './jobs.js';
import { parseFilename, saveImages, type SavedImage } from './storage.js';
import { checkEditRequest, checkGenerateRequest } from './validation.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

const PNG_ONLY = ['png'] as const;

interface JobOutput {
  images: SavedImage[];
  usage?: Record<string, unknown>;
  revised_prompts?: string[];
}

const commonInputs = {
  prompt: z
    .string()
    .min(1)
    .max(32000)
    .describe('Description of the desired image or edit. Must be written in English. Keep text that should appear in the image in its original language, in quotes.'),
  model: z
    .enum(IMAGE_MODELS)
    .optional()
    .describe(
      'gpt-image-2.6-flare is the default and suits fast iteration. ' +
        'gpt-image-2.6-sunburst suits work with demanding requirements for detail, layout or edit accuracy.',
    ),
  size: z
    .string()
    .regex(/^(auto|\d+x\d+)$/)
    .optional()
    .describe('"auto" or WIDTHxHEIGHT, such as 1024x1024, 1536x1024 or 1024x1536. Custom sizes use multiples of 16 and an aspect ratio from 1:3 to 3:1.'),
  quality: z
    .enum(['low', 'medium', 'high', 'xhigh', 'max', 'auto'])
    .optional()
    .describe('Rendering quality. Use low for drafts. Compare medium and high for small text or dense information.'),
  complexity: z
    .enum(['low', 'medium', 'high'])
    .optional()
    .describe('How much the model plans before rendering. Defaults to high, which suits dense text and layouts but takes longer. Start with low for targeted edits.'),
  background: z
    .enum(['transparent', 'opaque', 'auto'])
    .optional()
    .describe('Transparent cannot be used with output_format jpeg.'),
  output_compression: z.number().int().min(0).max(100).optional().describe('Compression level for jpeg or webp output.'),
  moderation: z.enum(['auto', 'low']).optional(),
  filename: z
    .string()
    .optional()
    .describe('Base name for the saved file, without directories. Existing files are never overwritten.'),
};

const resultSchema = z.object({
  status: z.enum(['completed', 'running', 'failed']),
  job_id: z.string().optional(),
  elapsed_seconds: z.number().optional(),
  next: z.string().optional(),
  images: z
    .array(
      z.object({
        path: z.string(),
        uri: z.string(),
        mime_type: z.string(),
        bytes: z.number(),
      }),
    )
    .optional(),
  usage: z.record(z.string(), z.unknown()).optional(),
  revised_prompts: z.array(z.string()).optional(),
  error: z
    .object({
      message: z.string(),
      code: z.string().optional(),
      type: z.string().optional(),
      status: z.number().optional(),
      request_id: z.string().optional(),
      moderation_details: z.unknown().optional(),
    })
    .optional(),
});

type ToolOutput = z.infer<typeof resultSchema>;

function asToolResult(output: ToolOutput) {
  const links = (output.images ?? []).map((image) => ({
    type: 'resource_link' as const,
    uri: image.uri,
    name: image.path,
    mimeType: image.mime_type,
    size: image.bytes,
  }));
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(output) }, ...links],
    structuredContent: output,
    isError: output.status === 'failed',
  };
}

function failure(error: ToolError, job?: Job<JobOutput>): ToolOutput {
  return { status: 'failed', ...(job ? describeTiming(job) : {}), error };
}

function describeTiming(job: Job<JobOutput>): Pick<ToolOutput, 'job_id' | 'elapsed_seconds'> {
  const elapsedMs = (job.finishedAt ?? Date.now()) - job.startedAt;
  return { job_id: job.id, elapsed_seconds: Math.round(elapsedMs / 1000) };
}

function defaultFileName(): string {
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  return `image-${timestamp}-${randomBytes(3).toString('hex')}`;
}

export function createServer(config: Config): McpServer {
  const client: OpenAI = createClient(config);
  const jobs = new JobStore<JobOutput>();

  const server = new McpServer(
    { name: 'openai-imagegen-mcp', version },
    {
      instructions:
        'Images are saved to local files and returned as paths. If a tool returns status "running", the image is still being made: ' +
        'call get_image_result with the job_id. Do not start the request again, because that would create and bill a new image.\n\n' +
        'Writing prompts: always write the prompt in English, translating the request if needed. Keep text that should appear in the image in its original language. ' +
        'State the subject and intended use, then composition, style, lighting and materials. ' +
        'For complex requests, use labeled sections for scene, subject, details and constraints. ' +
        'Put required text in quotes, say where it goes and how many times it appears, and ask for no extra text. ' +
        'For edits, say what to change and list what must stay unchanged. ' +
        'With several input images, refer to each by number and give its role. ' +
        'Refine by passing the previous output as the next input and changing one thing at a time. ' +
        'Check text, labels and numbers in the result, because the model can get them wrong.',
    },
  );

  function describeJob(job: Job<JobOutput>): ToolOutput {
    if (job.state === 'failed') return failure(toToolError(job.error, config.apiKey), job);
    if (job.state === 'completed' && job.result) return { status: 'completed', ...describeTiming(job), ...job.result };
    return {
      status: 'running',
      ...describeTiming(job),
      next: `Call get_image_result with job_id "${job.id}". Do not start the request again, because that would create and bill a new image.`,
    };
  }

  // Progress keeps clients that track idle time from giving up during the wait.
  async function waitWithProgress(job: Job<JobOutput>, ctx: ServerContext): Promise<void> {
    const progressToken = ctx.mcpReq._meta?.progressToken;
    const reporter =
      progressToken === undefined
        ? undefined
        : setInterval(() => {
            const elapsedMs = Date.now() - job.startedAt;
            void ctx.mcpReq
              .notify({
                method: 'notifications/progress',
                params: { progressToken, progress: elapsedMs, message: `Generating image (${Math.round(elapsedMs / 1000)}s)` },
              })
              .catch(() => {});
          }, config.waitMs / 5);
    reporter?.unref();

    try {
      await jobs.wait(job, config.waitMs, ctx.mcpReq.signal);
    } finally {
      clearInterval(reporter);
    }
  }

  async function runJob(
    filename: string | undefined,
    produce: (signal: AbortSignal) => Promise<ImageResult>,
    ctx: ServerContext,
  ): Promise<ToolOutput> {
    const chosenName = filename === undefined ? undefined : parseFilename(filename);

    const job = jobs.start(async (signal) => {
      const result = await produce(signal);
      const images = await saveImages(result.images, config.outputDir, chosenName ?? defaultFileName());
      return {
        images,
        ...(result.usage ? { usage: result.usage } : {}),
        ...(result.revisedPrompts.length > 0 ? { revised_prompts: result.revisedPrompts } : {}),
      };
    });

    // Cancelling the call that started a job also stops the job. Once the call has
    // returned a job_id, the job is on its own and no longer follows any request.
    const abortJob = () => job.abort();
    ctx.mcpReq.signal.addEventListener('abort', abortJob, { once: true });
    try {
      await waitWithProgress(job, ctx);
    } finally {
      ctx.mcpReq.signal.removeEventListener('abort', abortJob);
    }
    return describeJob(job);
  }

  async function handle(action: () => Promise<ToolOutput>) {
    try {
      return asToolResult(await action());
    } catch (error) {
      return asToolResult(failure(toToolError(error, config.apiKey)));
    }
  }

  server.registerTool(
    'generate_image',
    {
      title: 'Generate image',
      description:
        'Generate images from a text prompt and save them to local files. Returns file paths. ' +
        'Supports raster output and animated GIF. If the result has status "running", call get_image_result with its job_id.',
      inputSchema: z.object({
        ...commonInputs,
        output_format: z.enum(['png', 'jpeg', 'webp', 'gif']).optional().describe('Defaults to png. Access to gif can depend on the account.'),
        n: z.number().int().min(1).max(10).optional().describe(`Number of images, at most ${config.maxImagesPerRequest}.`),
        frame_count: z.number().int().min(2).max(16).optional().describe('GIF only. Number of frames.'),
        frame_duration_ms: z.number().int().min(20).optional().describe('GIF only. Delay per frame in milliseconds.'),
      }),
      outputSchema: resultSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ filename, model, ...options }, ctx) =>
      handle(async () => {
        const request: GenerateRequest = { ...options, model: model ?? DEFAULT_IMAGE_MODEL };
        checkGenerateRequest(request, config.maxImagesPerRequest);
        return runJob(filename, (signal) => generateImages(client, request, signal), ctx);
      }),
  );

  server.registerTool(
    'edit_image',
    {
      title: 'Edit image',
      description:
        'Edit local images, or create a new image from local reference images, and save the result to local files. Returns file paths. ' +
        'The first image is the one edited; the others serve as references. ' +
        'If the result has status "running", call get_image_result with its job_id.',
      inputSchema: z.object({
        ...commonInputs,
        images: z.array(z.string()).min(1).max(16).describe('Local paths of PNG, JPEG or WebP input images.'),
        mask: z
          .string()
          .optional()
          .describe('Local path of a mask for the first image, with an alpha channel. Transparent areas mark what to replace. Describe the complete final image in the prompt, not only the change. Cannot be combined with markup.'),
        markup: z
          .string()
          .optional()
          .describe('Local path of a transparent PNG with annotations showing where to edit, the same dimensions as the first image. Cannot be combined with mask.'),
        output_format: z.enum(['png', 'jpeg', 'webp']).optional().describe('Defaults to png.'),
        n: z.number().int().min(1).max(10).optional().describe(`Number of images, at most ${config.maxImagesPerRequest}.`),
      }),
      outputSchema: resultSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ filename, model, images, mask, markup, ...options }, ctx) =>
      handle(async () => {
        const settings = { ...options, model: model ?? DEFAULT_IMAGE_MODEL };
        checkEditRequest({ ...settings, mask, markup }, config.maxImagesPerRequest);

        const request: EditRequest = {
          ...settings,
          image: await Promise.all(images.map((path, index) => loadInputImage(path, `images[${index}]`))),
          ...(mask === undefined ? {} : { mask: await loadInputImage(mask, 'mask') }),
          ...(markup === undefined ? {} : { markup: await loadInputImage(markup, 'markup', PNG_ONLY) }),
        };
        return runJob(filename, (signal) => editImages(client, request, signal), ctx);
      }),
  );

  server.registerTool(
    'get_image_result',
    {
      title: 'Get image result',
      description:
        'Wait for and return the result of a job that generate_image or edit_image reported as "running". ' +
        'Waits for a limited time; if the result still has status "running", call this tool again.',
      inputSchema: z.object({
        job_id: z.string().describe('The job_id returned by generate_image or edit_image.'),
      }),
      outputSchema: resultSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ job_id }, ctx) =>
      handle(async () => {
        const job = jobs.get(job_id);
        if (!job) {
          return failure({
            code: 'unknown_job',
            message: `No job "${job_id}". Results expire after an hour, and jobs do not survive a server restart.`,
          });
        }
        await waitWithProgress(job, ctx);
        return describeJob(job);
      }),
  );

  return server;
}
