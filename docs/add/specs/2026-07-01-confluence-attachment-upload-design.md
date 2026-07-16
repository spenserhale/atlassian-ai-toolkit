# Confluence Attachment Upload Design

## Goal

Add a way for users and agents to upload local files as attachments to Confluence pages through the SDK, CLI, and MCP server.

## Scope

This change covers uploading one local file to one Confluence page. It does not add attachment listing, download, deletion, page body editing, remote URL ingestion, or bulk upload.

## API Surface

SDK method:

- `uploadConfluenceAttachment(pageId, input)` uploads a file to a Confluence page and returns the Confluence attachment response.

CLI command:

- `atlassian confluence attachment upload --page <page-id> --file <path> [--filename <name>] [--comment <text>] [--media-type <type>] [--notify] [--create-only] [--json]`

MCP tool:

- `confluence_upload_attachment` accepts `pageId`, `filePath`, optional `filename`, `comment`, `mediaType`, `notify`, and `createOnly`.

## Data Flow

The SDK uses Confluence Cloud REST v1 attachment endpoints because Confluence REST v2 exposes attachment reads/deletes but not attachment upload. Uploads use `multipart/form-data` with these parts:

- `file`: binary file content with the selected filename.
- `minorEdit`: string boolean. Defaults to `true`, which avoids watcher notifications.
- `comment`: optional upload/version comment.

The SDK sends `X-Atlassian-Token: nocheck`, as required by Atlassian for multipart attachment endpoints, and does not set `Content-Type` manually so the runtime can add the multipart boundary.

The default method is `PUT /wiki/rest/api/content/{pageId}/child/attachment`, which creates the attachment or creates a new version if a same-named attachment already exists. `createOnly` switches to `POST /wiki/rest/api/content/{pageId}/child/attachment` when the caller wants duplicate-name protection from Confluence.

## Safety

Attachment upload is a mutation but not a destructive operation. It does not require `--force`. The default create-or-update behavior is chosen for agent-safe retries: retrying an upload with the same filename creates a new version of that attachment instead of creating duplicate attachment records. Users can pass `--create-only` to fail if the attachment already exists.

The CLI and MCP server read a local file path and pass file bytes to the SDK. They return attachment ids, titles, status, and links, not the uploaded file content.

## Errors

The CLI validates that the file exists and is readable before calling the SDK. The SDK reuses existing Atlassian HTTP error handling for auth, not found, rate limits, and validation failures. Missing page permissions surface as Atlassian 403 errors.

## Testing

SDK tests should verify that upload uses the correct endpoint, method, multipart body, `X-Atlassian-Token: nocheck`, and no explicit `Content-Type` header. CLI and MCP are verified by TypeScript and CLI help smoke tests.

## Assumptions & Decisions

- Use Confluence REST v1 for upload because REST v2 does not expose an upload operation.
- Default to create-or-update `PUT` because it is safer for agent retries and matches the common "upload this file to the page" intent.
- Add `--create-only` / `createOnly` for callers that want Confluence to reject existing attachment names.
- Default to `minorEdit=true` and expose `--notify` / `notify` to opt into watcher notifications.
- Accept local file paths in CLI and MCP because this toolkit runs locally with access to the same workspace as the user and agent.
- Do not add bulk upload yet because one-file upload satisfies the requested capability and keeps failure handling simple.
