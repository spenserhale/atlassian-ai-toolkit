import { UserError } from "fastmcp";
import type { FastMCP } from "fastmcp";
import { AtlassianError } from "@atlassian-ai-toolkit/sdk";

/**
 * Rethrows an SDK error as a FastMCP UserError. FastMCP returns a UserError's extras as
 * `structuredContent`, so the client gets the error code and details (valid transitions, settable
 * fields, a page's current version) as data, not only as prose in the message.
 */
export function toToolError(err: unknown): unknown {
  if (!(err instanceof AtlassianError)) return err;
  const extras: Record<string, unknown> = { status: "error", code: err.code };
  if (err.details !== undefined) extras.details = err.details;
  return new UserError(err.message, extras);
}

/** Makes every tool registered on `server` report SDK errors with their code and details. */
export function withStructuredErrors(server: FastMCP): FastMCP {
  const addTool = server.addTool.bind(server);
  server.addTool = ((tool) =>
    addTool({
      ...tool,
      execute: async (args, context) => {
        try {
          return await tool.execute(args, context);
        } catch (err) {
          throw toToolError(err);
        }
      },
    })) as FastMCP["addTool"];
  return server;
}
