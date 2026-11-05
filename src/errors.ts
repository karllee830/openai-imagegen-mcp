import OpenAI from 'openai';
import { IMAGE_MODELS } from './config.js';

export interface ToolError {
  message: string;
  code?: string;
  type?: string;
  status?: number;
  request_id?: string;
  moderation_details?: unknown;
}

/** A problem with the request itself, reported before anything is sent upstream. */
export class InvalidRequestError extends Error {}

function readModerationDetails(error: InstanceType<typeof OpenAI.APIError>): unknown {
  const body = error.error;
  if (body && typeof body === 'object' && 'moderation_details' in body) {
    return (body as { moderation_details?: unknown }).moderation_details;
  }
  return undefined;
}

function describeUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withoutUndefined(error: ToolError): ToolError {
  return Object.fromEntries(Object.entries(error).filter(([, value]) => value !== undefined)) as unknown as ToolError;
}

export function toToolError(error: unknown, apiKey: string): ToolError {
  let result: ToolError;
  if (error instanceof InvalidRequestError) {
    result = { message: error.message, code: 'invalid_request' };
  } else if (error instanceof OpenAI.APIUserAbortError) {
    result = { message: 'The request was cancelled.', code: 'cancelled' };
  } else if (error instanceof OpenAI.APIError) {
    let hint = '';
    if (error.code === 'model_not_found') {
      hint = ` This server supports only ${IMAGE_MODELS.join(' and ')}, so the endpoint and account must offer the requested model.`;
    } else if (error.status === 404) {
      hint = ' Check that OPENAI_BASE_URL includes the version path, such as /v1.';
    }
    result = {
      message: `${error.message}${hint}`,
      code: error.code ?? undefined,
      type: error.type,
      status: error.status,
      request_id: error.requestID ?? undefined,
      moderation_details: readModerationDetails(error),
    };
  } else {
    result = { message: describeUnknownError(error) };
  }
  // A compatible endpoint may echo the credential back in its error text.
  result.message = result.message.replaceAll(apiKey, '[redacted]');
  return withoutUndefined(result);
}
