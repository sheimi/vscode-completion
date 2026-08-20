# Inline AI Suggestions

A small VS Code extension that provides inline code suggestions through one of three HTTP API formats:

- OpenAI Chat Completions (`POST /chat/completions`)
- OpenAI Responses (`POST /responses`)
- Anthropic Messages for Claude (`POST /messages`)

It has no runtime SDK dependency, so the OpenAI formats also work with compatible gateways and self-hosted endpoints.

## Install

Build and package the extension from the project directory:

```sh
npm install
npm run build
npx @vscode/vsce package
```

This creates `inline-ai-suggestions-0.1.0.vsix`. Install it from the terminal:

```sh
code --install-extension inline-ai-suggestions-0.1.0.vsix
```

Alternatively, open the **Extensions** view in VS Code, select the `…` menu, choose **Install from VSIX…**, and select the generated file. Reload VS Code when prompted.

## Set up

1. Install the packaged VSIX, or launch the project for development with `F5`.
2. Run **Inline AI Suggestions: Set Up Provider** from the Command Palette.
3. Select an API format.
4. Enter the versioned API base URL (for example, `https://api.openai.com/v1`), a model ID, and an API key.
5. Open a code file and type. VS Code displays the completion as ghost text; accept it with `Tab`.

The API key is entered in a masked prompt and saved in VS Code SecretStorage. It is never written to `settings.json`. Keys are scoped to the API family and normalized base URL, so changing a base URL cannot silently send an existing credential to another host.

You can later run **Inline AI Suggestions: Set API Key**, **Clear API Key**, or **Open Settings**.

## Configuration

This is a typical non-secret settings configuration:

```json
{
  "inlineAi.enabled": true,
  "inlineAi.apiFormat": "openai-responses",
  "inlineAi.baseUrl": "https://api.openai.com/v1",
  "inlineAi.model": "gpt-5.6-luna",
  "inlineAi.chatTokenField": "max_completion_tokens",
  "inlineAi.maxOutputTokens": 8000
}
```

`inlineAi.apiFormat` accepts:

| Value | Default base URL | Endpoint | Authentication |
| --- | --- | --- | --- |
| `openai-chat` | `https://api.openai.com/v1` | `/chat/completions` | `Authorization: Bearer …` |
| `openai-responses` | `https://api.openai.com/v1` | `/responses` | `Authorization: Bearer …` |
| `anthropic-messages` | `https://api.anthropic.com/v1` | `/messages` | `x-api-key: …` |

The base URL is the API root, not the full operation URL. A blank base URL selects the default in the table. HTTPS is required except for loopback development servers such as `http://localhost:11434/v1`. URLs containing credentials, query strings, or fragments are rejected.

For `openai-chat`, `inlineAi.chatTokenField` defaults to the modern `max_completion_tokens`. Set it to `max_tokens` for an older OpenAI-compatible gateway that only supports the legacy field.

Other settings control request debounce and timeout, output-token count, bounded prefix/suffix context, maximum accepted suggestion size, and excluded language IDs. See **Settings → Inline AI Suggestions** for the full list.

## Privacy, cost, and security

When the extension is enabled and configured, it sends the configured endpoint:

- a bounded portion of the active document before and after the cursor;
- the document's language ID and workspace-relative file name (or only its basename when outside the workspace); and
- instructions asking for an insert-only code completion.

The extension has no telemetry and does not log API keys, source prompts, or successful response bodies. Its output channel records only short, redacted provider error messages. Responses API requests set `store: false`. Redirects are disabled for authenticated requests and oversized responses are rejected. Duplicate provider invocations share an in-flight request; cancelling one invocation stops that caller from waiting without tearing down the shared request. The HTTP request is still bounded by its timeout and is aborted when a different completion supersedes it, configuration changes, or the extension shuts down. The extension is disabled in untrusted workspaces.

Requests use the VS Code extension host's built-in `fetch`. Environments that require a custom corporate proxy, proxy authentication, or a private certificate authority may need additional host-level network configuration.

Your chosen API provider may retain data and charge for requests. Review that provider's data policy, terms, quotas, and model availability before enabling completions for sensitive code.

This project is not affiliated with or endorsed by OpenAI or Anthropic.

## Development

Requirements: Node.js 20 or newer and VS Code 1.96 or newer.

```sh
npm install
npm run check
```

Press `F5` in VS Code to compile the extension and launch an Extension Development Host. Core protocol tests use mocked HTTP responses and never contact a live API.

Useful scripts:

- `npm run typecheck` — strict TypeScript checking
- `npm test` — unit tests
- `npm run build` — compile the extension into `dist/`
- `npm run watch` — recompile the extension while editing

Before publishing, replace the placeholder `publisher` value in `package.json` and add your Marketplace metadata and icon.
