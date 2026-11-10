import { UsageError } from "../errors.js";

export function stdinIsInteractive(): boolean {
  return Boolean(process.stdin.isTTY && typeof process.stdin.setRawMode === "function");
}

/**
 * Read one line from the terminal in raw mode. With `echo: false` nothing is shown, so a pasted
 * token never lands in the scrollback. The label goes to stderr so stdout stays clean for output.
 */
export function promptLine(label: string, options: { echo: boolean }): Promise<string> {
  const stdin = process.stdin;
  process.stderr.write(label);
  stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  stdin.resume();

  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (error?: Error) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    // Pasted text arrives as one multi-character chunk, so walk every character.
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n" || char === "\u0004") return finish();
        if (char === "\u0003") return finish(new UsageError("Cancelled; nothing was stored"));
        if (char === "\u007f" || char === "\b") {
          if (value.length > 0 && options.echo) process.stderr.write("\b \b");
          value = value.slice(0, -1);
          continue;
        }
        value += char;
        if (options.echo) process.stderr.write(char);
      }
    };
    stdin.on("data", onData);
  });
}

/** Read one line without echoing it. */
export function promptHidden(label: string): Promise<string> {
  return promptLine(label, { echo: false });
}

/** Read all of stdin, for piped secrets (`... | atlassian auth set atlassian --key ATLASSIAN_API_TOKEN --stdin`). */
export async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
