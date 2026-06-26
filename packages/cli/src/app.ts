import { buildApplication, buildRouteMap } from "@stricli/core";
import { confluenceDeleteCommand } from "./commands/confluence-delete.js";
import { confluenceGetCommand } from "./commands/confluence-get.js";
import { jiraDeleteCommand } from "./commands/jira-delete.js";
import { jiraGetCommand } from "./commands/jira-get.js";

const jiraRoutes = buildRouteMap({
  routes: {
    get: jiraGetCommand,
    delete: jiraDeleteCommand,
  },
  docs: {
    brief: "Manage Jira issues",
  },
});

const confluenceRoutes = buildRouteMap({
  routes: {
    get: confluenceGetCommand,
    delete: confluenceDeleteCommand,
  },
  docs: {
    brief: "Manage Confluence pages",
  },
});

const routes = buildRouteMap({
  routes: {
    jira: jiraRoutes,
    confluence: confluenceRoutes,
  },
  docs: {
    brief: "AI-first SDK, CLI, and MCP server for Atlassian Jira and Confluence",
  },
});

export const app = buildApplication(routes, {
  name: "atlassian",
  versionInfo: {
    currentVersion: "0.1.1",
  },
});
