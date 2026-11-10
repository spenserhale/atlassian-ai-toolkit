import { buildRouteMap } from "@stricli/core";
import { authDeleteCommand } from "./delete.js";
import { authListCommand } from "./list.js";
import { authMigrateCommand } from "./migrate.js";
import { authSetCommand } from "./set.js";

export const authRoutes = buildRouteMap({
  routes: {
    set: authSetCommand,
    list: authListCommand,
    delete: authDeleteCommand,
    migrate: authMigrateCommand,
  },
  docs: {
    brief: "Store, list, and remove credentials in the OS keychain",
  },
});
