import { buildApplication, buildRouteMap } from "@stricli/core";
import { confluenceAttachmentRoutes } from "./commands/confluence-attachment.js";
import { jiraAttachCommand } from "./commands/jira-attach.js";
import { jiraCreateCommand } from "./commands/jira-create.js";
import { confluenceDeleteCommand } from "./commands/confluence-delete.js";
import { confluenceCreateCommand } from "./commands/confluence-create.js";
import { confluenceEditCommand } from "./commands/confluence-edit.js";
import { confluenceGetCommand } from "./commands/confluence-get.js";
import { confluenceSearchCommand } from "./commands/confluence-search.js";
import { jiraDeleteCommand } from "./commands/jira-delete.js";
import { jiraEditCommand } from "./commands/jira-edit.js";
import { jiraGetCommand } from "./commands/jira-get.js";
import { jiraSearchCommand } from "./commands/jira-search.js";
import { jiraSprintRoutes } from "./commands/jira-sprint.js";
import { jiraTransitionCommand } from "./commands/jira-transition.js";
import { authRoutes } from "./commands/auth/index.js";
import { configRoutes } from "./commands/config-show.js";
import { upgradeCommand } from "./commands/upgrade.js";
import { CLI_VERSION } from "./version.js";

const jiraRoutes = buildRouteMap({
  routes: {
    get: jiraGetCommand,
    attach: jiraAttachCommand,
    create: jiraCreateCommand,
    delete: jiraDeleteCommand,
    edit: jiraEditCommand,
    search: jiraSearchCommand,
    sprint: jiraSprintRoutes,
    transition: jiraTransitionCommand,
  },
  docs: {
    brief: "Manage Jira issues",
  },
});

const confluenceRoutes = buildRouteMap({
  routes: {
    get: confluenceGetCommand,
    search: confluenceSearchCommand,
    create: confluenceCreateCommand,
    edit: confluenceEditCommand,
    delete: confluenceDeleteCommand,
    attachment: confluenceAttachmentRoutes,
  },
  docs: {
    brief: "Manage Confluence pages",
  },
});

const routes = buildRouteMap({
  routes: {
    jira: jiraRoutes,
    confluence: confluenceRoutes,
    auth: authRoutes,
    config: configRoutes,
    upgrade: upgradeCommand,
  },
  docs: {
    brief: "AI-first SDK, CLI, and MCP server for Atlassian Jira and Confluence",
  },
});

export const app = buildApplication(routes, {
  name: "atlassian",
  versionInfo: {
    currentVersion: CLI_VERSION,
  },
});
