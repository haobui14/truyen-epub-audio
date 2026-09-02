import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

const root = resolve("out");
const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

async function resolveFile(pathname) {
  const decoded = decodeURIComponent(pathname).replace(/^\/+/, "");
  const candidate = resolve(root, normalize(decoded));
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return null;

  const choices = [candidate];
  if (!extname(candidate)) choices.push(`${candidate}.html`);
  choices.push(join(candidate, "index.html"));

  for (const choice of choices) {
    try {
      if ((await stat(choice)).isFile()) return choice;
    } catch {
      // Try the next static-export shape.
    }
  }
  return null;
}

const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const file = await resolveFile(pathname);
    if (!file) {
      response.writeHead(404).end("Not found");
      return;
    }
    response.setHeader(
      "Content-Type",
      mimeTypes[extname(file).toLowerCase()] ?? "application/octet-stream",
    );
    if (request.method === "HEAD") {
      response.writeHead(200).end();
      return;
    }
    createReadStream(file)
      .on("error", () => response.destroy())
      .pipe(response);
  } catch {
    response.writeHead(400).end("Bad request");
  }
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1_000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
server.listen(3100, "127.0.0.1");
