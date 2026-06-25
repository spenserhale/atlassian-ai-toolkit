import { describe, expect, it } from "bun:test";
import { AtlassianClient } from "../src/client.js";

describe("AtlassianClient", () => {
  it("requires Atlassian Cloud auth config", () => {
    expect(
      () => new AtlassianClient({ siteUrl: "", email: "", apiToken: "" })
    ).toThrow();
  });

  it("accepts a valid config", () => {
    const client = new AtlassianClient({
      siteUrl: "https://example.atlassian.net",
      email: "user@example.com",
      apiToken: "test-token",
    });

    expect(client).toBeDefined();
  });
});
