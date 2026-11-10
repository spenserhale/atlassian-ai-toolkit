import { CREDENTIAL_RESOURCES } from "@atlassian-ai-toolkit/sdk";

export const resourcePositional = {
  kind: "tuple",
  parameters: [{ brief: `Resource: ${CREDENTIAL_RESOURCES.join(", ")}`, parse: String, placeholder: "resource" }],
} as const;

export const keyFlag = {
  key: {
    kind: "parsed",
    parse: String,
    brief: "Only this credential (e.g. ATLASSIAN_API_TOKEN); default: every key the resource uses",
    optional: true,
  },
} as const;

export const dryRunFlag = {
  "dry-run": {
    kind: "boolean",
    brief: "Validate and report what would change without touching the keychain",
    default: false,
  },
} as const;

export const jsonFlag = {
  json: { kind: "boolean", brief: "Output as JSON", default: false },
} as const;

export function emit(result: unknown, json: boolean, text: () => string): void {
  console.log(json ? JSON.stringify(result, null, 2) : text());
}
