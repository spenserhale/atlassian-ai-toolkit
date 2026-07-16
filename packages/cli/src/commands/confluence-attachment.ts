import { basename } from "node:path";
import { buildCommand, buildRouteMap } from "@stricli/core";
import { AtlassianClient, resolveConfig } from "@atlassian-ai-toolkit/sdk";

interface UploadFlags {
  readonly comment?: string;
  readonly "create-only": boolean;
  readonly file: string;
  readonly filename?: string;
  readonly json: boolean;
  readonly "media-type"?: string;
  readonly notify: boolean;
  readonly page: string;
}

function summarizeUpload(result: { results: Array<{ id: string; title?: string; status?: string; _links?: Record<string, unknown> }> }) {
  return {
    attachments: result.results.map((attachment) => ({
      id: attachment.id,
      title: attachment.title,
      status: attachment.status,
      links: attachment._links,
    })),
  };
}

function requireNonEmpty(value: string, label: string): string {
  if (value.trim().length === 0) throw new Error(`${label} is required`);
  return value;
}

export const uploadCommand = buildCommand({
  docs: {
    brief: "Upload an attachment to a Confluence page",
  },
  parameters: {
    flags: {
      page: {
        kind: "parsed",
        parse: String,
        brief: "Confluence page ID",
      },
      file: {
        kind: "parsed",
        parse: String,
        brief: "Local file path to upload",
      },
      filename: {
        kind: "parsed",
        parse: String,
        brief: "Attachment filename; defaults to the local basename",
        optional: true,
      },
      comment: {
        kind: "parsed",
        parse: String,
        brief: "Attachment version comment",
        optional: true,
      },
      "media-type": {
        kind: "parsed",
        parse: String,
        brief: "Media type for the uploaded file",
        optional: true,
      },
      notify: {
        kind: "boolean",
        brief: "Notify watchers by not marking the upload as a minor edit",
        default: false,
      },
      "create-only": {
        kind: "boolean",
        brief: "Fail if an attachment with the same filename already exists",
        default: false,
      },
      json: {
        kind: "boolean",
        brief: "Output as JSON",
        default: false,
      },
    },
  },
  async func(this: void, flags: UploadFlags) {
    try {
      const filePath = requireNonEmpty(flags.file, "--file");
      const pageId = requireNonEmpty(flags.page, "--page");
      const filename = requireNonEmpty(flags.filename ?? basename(filePath), "--filename");
      const file = Bun.file(filePath, flags["media-type"] === undefined ? undefined : { type: flags["media-type"] });
      if (!(await file.exists())) {
        console.error(`error: --file does not exist or is not readable: ${filePath}`);
        process.exit(1);
      }
      const bytes = await file.bytes().catch(() => null);
      if (bytes === null) {
        console.error(`error: --file does not exist or is not readable: ${filePath}`);
        process.exit(1);
      }

      const uploadFile = new Blob([bytes], { type: flags["media-type"] ?? file.type });
      const client = new AtlassianClient(resolveConfig());
      const result = await client.uploadConfluenceAttachment(pageId, {
        file: uploadFile,
        filename,
        comment: flags.comment,
        minorEdit: !flags.notify,
        createOnly: flags["create-only"],
      });
      const summary = { status: "uploaded", pageId, ...summarizeUpload(result) };

      if (flags.json) {
        console.log(JSON.stringify(summary, null, 2));
        return;
      }

      console.log("status: uploaded");
      console.log(`page: ${pageId}`);
      for (const attachment of summary.attachments) {
        console.log(`attachment: ${attachment.id}${attachment.title ? ` ${attachment.title}` : ""}`);
        if (attachment.status) console.log(`attachment_status: ${attachment.status}`);
        if (attachment.links) console.log(`attachment_links: ${JSON.stringify(attachment.links)}`);
      }
    } catch (err) {
      console.error(`error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  },
});

export const confluenceAttachmentRoutes = buildRouteMap({
  routes: {
    upload: uploadCommand,
  },
  docs: {
    brief: "Manage Confluence attachments",
  },
});
