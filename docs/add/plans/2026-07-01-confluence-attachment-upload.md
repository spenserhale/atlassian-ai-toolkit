# Confluence Attachment Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use add-subagent-driven-development (recommended) or add-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Confluence page attachment upload support across the SDK, CLI, and MCP server.

**Architecture:** The SDK owns multipart upload construction and Atlassian REST calls. CLI and MCP wrappers read local file paths, pass bytes to the SDK, and print bounded attachment metadata. Upload defaults to create-or-update for safe retries, with create-only available as an explicit option.

**Tech Stack:** Bun, TypeScript, Zod, Stricli, FastMCP, Confluence Cloud REST v1 attachment API, `FormData`, `Blob`.

---

## Files

- Modify `packages/sdk/src/types.ts` with Confluence attachment schemas and upload input type.
- Modify `packages/sdk/src/index.ts` to export attachment types and schemas.
- Modify `packages/sdk/src/client.ts` to support multipart requests and add `uploadConfluenceAttachment`.
- Modify `packages/sdk/tests/client.test.ts` with multipart upload request tests.
- Create `packages/cli/src/commands/confluence-attachment.ts` for attachment upload CLI routing.
- Modify `packages/cli/src/app.ts` to mount `confluence attachment`.
- Modify `packages/mcp/src/tools/resources.ts` to add `confluence_upload_attachment`.

## Task 1: SDK Multipart Upload

**Files:**
- Modify: `packages/sdk/tests/client.test.ts`
- Modify: `packages/sdk/src/types.ts`
- Modify: `packages/sdk/src/index.ts`
- Modify: `packages/sdk/src/client.ts`

- [ ] **Step 1: Write failing SDK tests**

Add tests for `uploadConfluenceAttachment` that stub `globalThis.fetch` and assert:

- default upload uses `PUT /wiki/rest/api/content/{pageId}/child/attachment`
- `createOnly: true` uses `POST /wiki/rest/api/content/{pageId}/child/attachment`
- headers include `X-Atlassian-Token: nocheck`
- headers do not include explicit `Content-Type`
- body is `FormData` with `file`, `minorEdit`, and optional `comment`

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/sdk/tests/client.test.ts`

Expected: FAIL because `uploadConfluenceAttachment` does not exist.

- [ ] **Step 3: Add attachment types**

Add `ConfluenceAttachmentSchema`, `ConfluenceAttachmentUploadResultSchema`, `ConfluenceAttachmentUploadInput`, and export them.

- [ ] **Step 4: Add multipart request support**

Extend SDK request handling so JSON requests keep `Content-Type: application/json`, while `FormData` requests do not set `Content-Type` and can add `X-Atlassian-Token: nocheck`.

- [ ] **Step 5: Add `uploadConfluenceAttachment`**

Implement `uploadConfluenceAttachment(pageId, input)` with `FormData`, `file`, `minorEdit`, and optional `comment` fields. Use `PUT` unless `input.createOnly` is true, in which case use `POST`.

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test packages/sdk/tests/client.test.ts`

Expected: PASS.

## Task 2: CLI Upload Command

**Files:**
- Create: `packages/cli/src/commands/confluence-attachment.ts`
- Modify: `packages/cli/src/app.ts`

- [ ] **Step 1: Add upload command**

Create `confluenceAttachmentRoutes` with `upload`. Flags: `--page`, `--file`, `--filename`, `--comment`, `--media-type`, `--notify`, `--create-only`, and `--json`.

- [ ] **Step 2: Read local file safely**

Use `Bun.file(path)` and `await file.exists()` before reading. If missing, print `error: --file does not exist or is not readable: <path>` and exit `1`.

- [ ] **Step 3: Mount route**

Add `attachment: confluenceAttachmentRoutes` under `confluence` in `packages/cli/src/app.ts`.

- [ ] **Step 4: Type-check CLI**

Run: `bun run --filter '@atlassian-ai-toolkit/cli' lint`

Expected: PASS.

## Task 3: MCP Upload Tool

**Files:**
- Modify: `packages/mcp/src/tools/resources.ts`

- [ ] **Step 1: Add `confluence_upload_attachment`**

Add a tool accepting local `filePath`, `pageId`, optional `filename`, `comment`, `mediaType`, `notify`, and `createOnly`.

- [ ] **Step 2: Read local file safely**

Use `Bun.file(filePath)` and `await file.exists()` before reading. Throw a clear error if missing.

- [ ] **Step 3: Return metadata only**

Return JSON with `status`, `pageId`, and attachment summary fields, not file bytes.

- [ ] **Step 4: Type-check MCP**

Run: `bun run --filter '@atlassian-ai-toolkit/mcp' lint`

Expected: PASS.

## Task 4: Verification

**Files:**
- No code files unless verification exposes issues.

- [ ] **Step 1: Run full lint**

Run: `bun run lint`

Expected: PASS.

- [ ] **Step 2: Run full tests**

Run: `bun test`

Expected: PASS.

- [ ] **Step 3: Run CLI help smoke test**

Run: `bun run dev:cli -- confluence attachment --help`

Expected: help lists `upload`.

## Assumptions & Decisions

- Use Confluence REST v1 for upload because REST v2 does not expose upload.
- Default to create-or-update `PUT` for retry-safe agent behavior.
- Add create-only `POST` mode for users who want existing filename conflicts to fail.
- Default to `minorEdit=true`; `--notify` flips it to `false`.
- Keep response output to attachment metadata, not binary content.
- Verify CLI and MCP through TypeScript until this repo has an execution test harness.
