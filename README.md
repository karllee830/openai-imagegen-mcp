# openai-imagegen-mcp

An [MCP](https://modelcontextprotocol.io) server that generates and edits images with GPT Image 2.6 through the OpenAI Images API or a compatible endpoint. Images are saved to local files, and tools return a downscaled preview plus the path of each original.

> [!NOTE]
> This server is built and tuned for the Claude desktop app. Other MCP clients can use it, but the experience may not be as polished: for example, a client may display the preview as well as the original, may not collapse the preview, or may only show a file path.

## Models

Each call can choose a model with the `model` option. No other model names are accepted. Results report the model that made the image.

| Model | Best for |
| --- | --- |
| `gpt-image-2.6-flare` (default) | Fast iteration |
| `gpt-image-2.6-sunburst` | Demanding requirements for detail, layout or edit accuracy |

This server follows the latest GPT Image generation, and older models are dropped when a new one arrives.

## Requirements

- Node.js 22 or later
- An API key for OpenAI or a compatible service. OpenAI may require [organization verification](https://help.openai.com/en/articles/10910291-api-organization-verification) for GPT Image models.

## Setup

Add the server to your MCP client's configuration:

```json
{
  "mcpServers": {
    "imagegen": {
      "command": "npx",
      "args": ["-y", "openai-imagegen-mcp"],
      "env": {
        "OPENAI_API_KEY": "sk-...",
        "OPENAI_BASE_URL": "https://api.openai.com/v1"
      }
    }
  }
}
```

The base URL and API key are configured here, not passed as tool arguments, so the key stays out of conversations and a prompt cannot redirect it to another host.

`npx` may keep using a cached version. To always run the newest release, use `openai-imagegen-mcp@latest` in `args`.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `OPENAI_API_KEY` | required | API key sent to the endpoint. |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | API root. `/v1` is added if the URL has no path. |
| `IMAGEGEN_HOME` | `~/.openai-imagegen-mcp` | Folder that holds saved images. Must be an absolute path or start with `~/`. |
| `IMAGEGEN_WAIT_SECONDS` | `50` | How long one tool call waits before returning a job. Must be shorter than your client's tool timeout. |
| `IMAGEGEN_REQUEST_TIMEOUT_SECONDS` | `300` | Timeout for each request to the API. |
| `IMAGEGEN_MAX_N` | `4` | Most images allowed in one call, from 1 to 10. |

## Tools

### `generate_image`

Creates images from a prompt. Options: `model`, `size`, `quality`, `complexity`, `background`, `output_format` (`png`, `jpeg`, `webp`, `gif`), `output_compression`, `n`, `frame_count`, `frame_duration_ms`, `moderation` and `workspace`.

### `edit_image`

Edits local images or uses them as references. `images` takes up to 16 local PNG, JPEG or WebP paths, and the first one is the image being edited. To target part of it, add either `mask` or `markup`, a transparent PNG with annotations showing where to edit. With a mask, describe the complete final image in the prompt, not only the change. The other options match `generate_image`, except that `output_format` is limited to `png`, `jpeg` and `webp`, and the GIF frame options are not available.

### `get_image_result`

Collects the result of a job by `job_id`.

## Saved images and previews

Images are saved as `<IMAGEGEN_HOME>/<workspace>/<job_id>.<ext>`, with a number added when one call returns several images. The calling model cannot choose the location or the file name. If an image belongs somewhere else, the model copies it there and keeps the original, as the tool instructions ask.

`workspace` is the caller's current working directory, and only its last segment is used. An MCP server usually cannot see that directory itself. Without `workspace`, the server falls back to `CLAUDE_PROJECT_DIR`, then to its own working directory, then to a folder named `default`. Images are not cleaned up automatically.

Each result also includes a downscaled JPEG preview for the model to look at. A call's previews stay within 75 KB in total, because clients limit tool results and rarely document how. Long edges go up to 1024 pixels when the size allows. If no preview fits, the result has the path only. A GIF preview shows the first frame.

Previews are for the model only. The tool instructions require the model to show users the original file, and results mark the preview with the `assistant` audience and the link to the original with the `user` audience. How far this is honored depends on the client: some ignore audience annotations and may display the preview, and some cannot display local files at all. If a client only displays images from certain folders and gives the model a session scratchpad, the instructions ask the model to copy the original there before sharing it. The instructions also ask the model to write no text until the original is shared, because some clients collapse a preview into a small thumbnail only while tool calls run back to back.

## Prompts

Prompts must be written in English. Text that should appear in the image stays in its original language, in quotes. The tool descriptions ask the calling model to follow this rule; the server does not check it, because quoted text can be in any language.

## Long-running images

Complex images can take a couple of minutes, while some MCP clients give up on a tool call after about 60 seconds. To work in every client, each call waits for a limited time:

1. If the image finishes within `IMAGEGEN_WAIT_SECONDS`, the call returns it directly.
2. Otherwise the call returns `status: "running"` and a `job_id`, and the job keeps running.
3. `get_image_result` waits again and returns the result, or `running` if it needs another call.

```json
{
  "status": "completed",
  "job_id": "img_a1b2c3d4e5f6",
  "elapsed_seconds": 18,
  "model": "gpt-image-2.6-flare",
  "images": [
    {
      "path": "/Users/me/.openai-imagegen-mcp/my-site/img_a1b2c3d4e5f6.png",
      "uri": "file:///Users/me/.openai-imagegen-mcp/my-site/img_a1b2c3d4e5f6.png",
      "mime_type": "image/png",
      "bytes": 1482133,
      "preview": { "width": 768, "height": 768, "bytes": 61240 }
    }
  ],
  "usage": { "total_tokens": 1234 }
}
```

Cancelling the call that started a job also cancels the job. After that call has returned a `job_id`, a job cannot be cancelled and runs to the end.

Jobs live in the server's memory. Results stay available for an hour, and a job in progress is lost if the server is killed. If the client just disconnects, the server finishes the jobs in progress, saves their images and then exits.

## Compatible endpoints

`OPENAI_BASE_URL` can point at any service that implements the Images API and offers these models under their official names. Responses may use `b64_json`, a data URL or a `url` to download. Limits such as allowed sizes and quality levels are left for the service to enforce, so its own error is returned to the caller.

Some gateways drop fields they do not recognize without reporting an error, and the server cannot detect that. If `markup`, `complexity` or the GIF frame options do not behave as expected, check whether the gateway forwards these fields. On a gateway with a pass-through setting, enabling it for the image models usually solves this.

## Local file safety

- Input files are checked by content, and only real PNG, JPEG or WebP images up to 50 MB are uploaded.
- `workspace` only names a folder, so files cannot be written outside `IMAGEGEN_HOME`.
- Existing files are never overwritten.

## Development

```bash
npm install
```

```bash
npm test
```

Tests run the built server over stdio against a local fake of the Images API, so they make no paid requests.

## License

[MIT](LICENSE)
