import { describe, expect, it } from "bun:test";
import { FastMCP, UserError } from "fastmcp";
import { AtlassianFieldError } from "@atlassian-ai-toolkit/sdk";
import { toToolError, withStructuredErrors } from "../src/errors.js";

describe("toToolError", () => {
  it("keeps the SDK error code and details as UserError extras", () => {
    const err = toToolError(new AtlassianFieldError("No transition matches", "transition_not_available", { available: ["Done"] }));
    expect(err).toBeInstanceOf(UserError);
    expect((err as UserError).message).toBe("No transition matches");
    expect((err as UserError).extras).toEqual({ status: "error", code: "transition_not_available", details: { available: ["Done"] } });
  });

  it("passes other errors through unchanged", () => {
    const plain = new Error("boom");
    expect(toToolError(plain)).toBe(plain);
  });
});

describe("withStructuredErrors", () => {
  it("wraps each registered tool's execute", async () => {
    let registered: { execute: (args: unknown, context: unknown) => Promise<unknown> } | undefined;
    const spy = new FastMCP({ name: "s", version: "0.0.0" });
    spy.addTool = ((tool: typeof registered) => {
      registered = tool;
    }) as FastMCP["addTool"];
    withStructuredErrors(spy).addTool({
      name: "fails",
      description: "d",
      execute: async () => {
        throw new AtlassianFieldError("stale", "version_conflict", { expected: 5, current: 7 });
      },
    });
    const thrown = await registered?.execute({}, {}).catch((err: unknown) => err);
    expect(thrown).toBeInstanceOf(UserError);
    expect((thrown as UserError).extras).toMatchObject({ code: "version_conflict", details: { current: 7 } });
  });
});
