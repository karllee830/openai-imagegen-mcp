import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

// The smallest valid PNG: one transparent pixel.
export const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

export interface RecordedRequest {
  path: string;
  authorization: string | undefined;
  json?: Record<string, unknown>;
  form?: FormData;
}

export type Responder = (request: RecordedRequest, response: ServerResponse) => void | Promise<void>;

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

export function sendImage(response: ServerResponse): void {
  sendJson(response, 200, {
    created: 1,
    data: [{ b64_json: PNG_BYTES.toString('base64') }],
    usage: { total_tokens: 42 },
  });
}

async function readRequest(request: IncomingMessage): Promise<RecordedRequest> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks);
  const contentType = request.headers['content-type'] ?? '';

  const recorded: RecordedRequest = { path: request.url ?? '', authorization: request.headers.authorization };
  if (contentType.includes('multipart/form-data')) {
    recorded.form = await new Response(body, { headers: { 'content-type': contentType } }).formData();
  } else if (body.length > 0) {
    recorded.json = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
  }
  return recorded;
}

/** A local stand-in for the Images API, so tests exercise real HTTP without spending money. */
export class FakeImagesApi {
  readonly requests: RecordedRequest[] = [];
  disconnects = 0;
  origin = '';
  respond: Responder = (_request, response) => sendImage(response);
  private server: Server | undefined;

  async start(): Promise<string> {
    this.server = createServer((request, response) => {
      response.on('close', () => {
        if (!response.writableFinished) this.disconnects += 1;
      });
      void readRequest(request).then(async (recorded) => {
        this.requests.push(recorded);
        await this.respond(recorded, response);
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.origin;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise((resolve) => this.server?.close(resolve));
  }
}
