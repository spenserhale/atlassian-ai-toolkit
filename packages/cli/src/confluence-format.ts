/**
 * Default text output for the Confluence commands: short `key: value` lines an agent can read
 * without parsing, one url per page, ISO dates, and never a page body after a write.
 */
import { formatLossy } from "@atlassian-ai-toolkit/sdk";
import type { ConfluencePageContent, ConfluencePageCreateResult, ConfluencePageEditResult, ConfluenceSearchResult } from "@atlassian-ai-toolkit/sdk";

const n = (value: number) => value.toLocaleString("en-US");

function pageHeader(page: ConfluencePageContent): string[] {
  return [
    `id: ${page.id}`,
    `title: ${page.title}`,
    `space: ${page.space.key ?? page.space.id}`,
    `status: ${page.status}`,
    `version: ${page.version}`,
    ...(page.parentId !== undefined ? [`parent: ${page.parentId}`] : []),
    ...(page.url !== undefined ? [`url: ${page.url}`] : []),
    ...(page.lossy.length > 0 ? [`lossy: ${formatLossy(page.lossy)}`] : []),
  ];
}

function bodyText(body: unknown): string {
  return typeof body === "string" ? body : JSON.stringify(body);
}

export function formatPage(page: ConfluencePageContent): string {
  const lines = pageHeader(page);
  if (page.guard !== undefined) lines.push(page.guard.hint);
  if (page.outline !== undefined) {
    lines.push("outline:");
    if (page.outline.intro > 0) lines.push(`  (intro) ${n(page.outline.intro)}`);
    for (const section of page.outline.sections) {
      const selector = section.selector === section.title ? "" : `  --section "${section.selector}"`;
      lines.push(`  ${"#".repeat(section.level)} ${section.title}  ${n(section.chars)}${selector}`);
    }
  }
  for (const section of page.sections ?? []) lines.push(`--- section: ${section.selector} (${n(section.chars)} chars)`, bodyText(section.body));
  if (page.body !== undefined) lines.push("---", bodyText(page.body));
  return lines.join("\n");
}

export function formatSearch(result: ConfluenceSearchResult): string {
  const spaces = new Set(result.results.map((hit) => hit.space));
  const types = new Set(result.results.map((hit) => hit.type));
  const sharedSpace = spaces.size === 1 ? [...spaces][0] : undefined;
  const sharedType = types.size === 1 ? [...types][0] : undefined;
  const shared = [sharedSpace !== undefined ? `space ${sharedSpace}` : "", sharedType !== undefined ? `type ${sharedType}` : ""].filter(Boolean).join(", ");

  const header = [
    `${result.count}${result.total !== undefined ? ` of ${result.total}` : ""}`,
    ...(shared.length > 0 && result.count > 0 ? [`(${shared})`] : []),
    ...(result.nextCursor !== undefined ? [`more: --cursor ${result.nextCursor}`] : []),
  ].join(" ");

  const lines = [header];
  for (const hit of result.results) {
    const tags = [
      hit.space !== undefined && sharedSpace === undefined ? hit.space : "",
      hit.type !== undefined && sharedType === undefined ? hit.type : "",
      hit.version !== undefined ? `v${hit.version}` : "",
      hit.status !== undefined && hit.status !== "current" ? hit.status : "",
    ].filter(Boolean);
    const first = [hit.id, hit.title, tags.length > 0 ? `[${tags.join(" ")}]` : "", hit.modified].filter((part) => part !== undefined && part.length > 0).join("  ");
    lines.push(first);
    if (hit.ancestors !== undefined && hit.ancestors.length > 0) lines.push(`  in: ${hit.ancestors.map((ancestor) => ancestor.title ?? ancestor.id).join(" > ")}`);
    if (hit.url !== undefined) lines.push(`  ${hit.url}`);
    if (hit.excerpt !== undefined) lines.push(`  ${hit.excerpt}`);
  }
  return lines.join("\n");
}

export function formatCreate(result: ConfluencePageCreateResult): string {
  const path = result.parent !== undefined ? [...result.parent.ancestors.map((ancestor) => ancestor.title ?? ancestor.id), result.parent.title ?? result.parent.id] : [];
  return [
    `status: ${result.status}`,
    ...(result.id !== undefined ? [`id: ${result.id}`] : []),
    `title: ${result.title}`,
    ...(result.version !== undefined ? [`version: ${result.version}`] : []),
    `page_status: ${result.pageStatus}`,
    ...(result.url !== undefined ? [`url: ${result.url}`] : []),
    ...(result.status === "dry_run"
      ? [
          `space: ${result.space.key ?? ""} (${result.space.id})`,
          ...(result.parent !== undefined ? [`parent: ${result.parent.id} ${result.parent.title ?? ""}`.trimEnd(), `path: ${[...path, result.title].join(" > ")}`] : []),
          `body: ${n(result.bodyChars)} chars ${result.format}`,
          ...(result.labels !== undefined ? [`labels: ${result.labels.join(", ")}`] : []),
        ]
      : []),
    ...(result.failedLabels !== undefined ? [`failed_labels: ${result.failedLabels.join(", ")}`, `label_error: ${result.labelError ?? ""}`] : []),
  ].join("\n");
}

export function formatEdit(result: ConfluencePageEditResult): string {
  return [
    `status: ${result.status}`,
    `id: ${result.id}`,
    `title: ${result.title}`,
    `version: ${result.version}${result.status === "dry_run" ? " (would write)" : ""}`,
    ...(result.url !== undefined ? [`url: ${result.url}`] : []),
    `operation: ${result.operation}`,
    ...(result.section !== undefined ? [`section: ${result.section}`] : []),
    ...(result.matches !== undefined ? [`matches: ${result.matches}`] : []),
    ...(result.chars !== undefined ? [`chars: ${n(result.chars.before)} -> ${n(result.chars.after)}`] : []),
    ...(result.lossy !== undefined ? [`lossy: ${result.lossy.map((item) => `${item.kind} x${item.count}`).join(", ")}`] : []),
    ...(result.draft !== undefined ? ["draft: exists (Confluence may overwrite it if it diverged)"] : []),
    ...(result.retried === true ? ["retried: true (the page changed during the first attempt)"] : []),
  ].join("\n");
}
