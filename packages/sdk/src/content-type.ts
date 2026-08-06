const CONTENT_TYPES: Record<string, string> = {
  csv: "text/csv",
  gif: "image/gif",
  gz: "application/gzip",
  har: "application/json",
  html: "text/html",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  log: "text/plain",
  md: "text/markdown",
  pdf: "application/pdf",
  png: "image/png",
  svg: "image/svg+xml",
  txt: "text/plain",
  webp: "image/webp",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
  zip: "application/zip",
};

/**
 * Best-effort MIME type for a filename. Jira stores whatever the upload declares, and
 * `application/octet-stream` blocks inline preview, so common types are worth naming.
 */
export function guessContentType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}
