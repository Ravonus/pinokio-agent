import { chromium } from "playwright";

async function readInput() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    throw new Error("no input payload provided to playwright service");
  }
  return JSON.parse(raw);
}

async function main() {
  const payload = await readInput();
  if (payload.action !== "read_title") {
    throw new Error(`unsupported action: ${payload.action}`);
  }
  if (typeof payload.url !== "string" || payload.url.length === 0) {
    throw new Error("payload.url must be a non-empty string");
  }
  const timeoutMs = typeof payload.timeout_ms === "number" ? payload.timeout_ms : 30_000;

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const response = await page.goto(payload.url, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs
    });
    const title = await page.title();
    const url = page.url();
    const status = response ? response.status() : null;
    process.stdout.write(JSON.stringify({ ok: true, title, url, status }));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
