// Real production assets, native browser fetch/WebSocket, and a synthetic loopback hub. No network interception.
// node web/e2e/handoff-cache-recheck.mjs --dist web/dist --shots <directory> --chromium <executable> [--base SHA --head SHA]
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { appendFileSync, createReadStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, extname, resolve, sep } from "node:path";
import { chromium } from "playwright-core";
import { WebSocketServer } from "ws";

const args = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];
const dist = resolve(flag("--dist") || "web/dist");
const shots = resolve(flag("--shots") || "");
const executablePath = resolve(flag("--chromium") || "");
const base = flag("--base") || "unspecified";
const head = flag("--head") || "unspecified";
assert(existsSync(resolve(dist, "index.html")), "build the real web dist first");
assert(shots && !shots.startsWith(`${dirname(dist)}${sep}`), "screenshots stay outside the repository");
assert(existsSync(executablePath), "Chromium executable is required");
mkdirSync(shots, { recursive: true });

const require = createRequire(import.meta.url);
const playwrightVersion = require("playwright-core/package.json").version;
const at = "2026-11-27T08:00:00Z";
const main = "example-main";
const taskId = "example-cache-task";
const computer = { id: "example-computer", name: "Example computer", online: true, os: "linux" };
const persona = { machine_id: computer.id, session_id: main, title: "Persona", state: "idle", status: "idle", cwd: "/example", updated_at: at, started_by_persona: true, capabilities: { send: true, interrupt: true } };
const worker = { machine_id: computer.id, session_id: "example-agent", title: "Example Agent", state: "working", status: "working", cwd: "/example/project", updated_at: at, todo: { id: taskId, title: "Review the release" } };
const task = (withAgent) => ({
  id: taskId, title: "Review the release", origin: main, created_at: at, updated_at: at,
  agents: withAgent ? [{ machine_id: computer.id, session_id: worker.session_id, title: worker.title, linked_at: at }] : [],
});
const plan = { id: "example-plan", conversation: main, created_at: at, state: "started", tasks: [{ title: "Review the release", prompt: "Synthetic task", machine: computer.id, cwd: "/example/project", todo_id: taskId }] };
const feedItem = { id: "example-task-event", conversation: main, at: "2026-11-27T08:00:01Z", kind: "task", ref: taskId };
const planFeedItem = { id: "example-plan-event", conversation: main, at: "2026-11-27T08:00:00Z", kind: "plan", ref: plan.id };
const initialItems = [
  { id: "example-user", seq: 1, role: "user", kind: "text", text: "Please review the release.", ts: at },
  { id: "example-answer", seq: 2, role: "assistant", kind: "text", text: "I handed the review to an Agent.", ts: at },
];

const requests = [];
const socketEvents = [];
const assertions = [];
const screenshots = [];
const pageErrors = [];
const externalRequests = [];
const consoleErrors = [];
let requestSequence = 0;
let socketSequence = 0;
let revision = 1;
let stage = "initial";
let currentTodos = [];
let held = null;
let socket = null;
let transientControlledRequests = 0;
let deletionControlledRequests = 0;

function recordRequest(req, action, extra = {}) {
  const record = { sequence: requestSequence++, action, method: req.method, path: new URL(req.url, "http://127.0.0.1").pathname, stage, ...extra };
  requests.push(record);
  return record;
}

function finishJson(res, value, status = 200, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(value));
}

function answerTodos(res, record) {
  const etag = `W/"t1-${revision}"`;
  finishJson(res, { todos: currentTodos, closed_cursors: {} }, 200, { ETag: etag, "X-Persona-Todos-Revision": String(revision) });
  requests.push({ ...record, action: "respond", todo_ids: currentTodos.map((row) => row.id), revision });
  fixture.emit("todos-complete", record);
}

function holdTodos(res, record) {
  assert(!held, "only one controlled response is held at a time");
  held = { res, record };
  requests.push({ ...record, action: "hold" });
  fixture.emit("held", record);
}

function releaseHeld() {
  assert(held, "a controlled response is held");
  const current = held;
  held = null;
  requests.push({ ...current.record, action: "release", todo_ids: currentTodos.map((row) => row.id), revision });
  answerTodos(current.res, current.record);
}

const fixture = new EventEmitter();
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".wasm": "application/wasm" };

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }
    if (url.pathname.startsWith("/api/v1/")) {
      const path = url.pathname.slice("/api/v1".length);
      const record = recordRequest(req, "receive", { closed_limit: url.searchParams.get("closed_limit") || undefined });
      if (path === "/todos") {
        if (stage === "transient-list") { stage = "transient-hold"; answerTodos(res, record); return; }
        if (stage === "transient-hold" || stage === "transient-held") {
          transientControlledRequests++;
          stage = "transient-held";
          holdTodos(res, record);
          return;
        }
        if (stage === "delete-list") { stage = "delete-hold"; answerTodos(res, record); return; }
        if (stage === "delete-hold" || stage === "delete-held") {
          deletionControlledRequests++;
          stage = "delete-held";
          holdTodos(res, record);
          return;
        }
        if (stage === "plan-hold") { stage = "plan-held"; holdTodos(res, record); return; }
        if (stage === "prep-list") stage = "normal";
        answerTodos(res, record);
        return;
      }
      if (path === "/todos/revision") {
        const unchanged = req.headers["if-none-match"] === String(revision);
        requests.push({ ...record, action: unchanged ? "revision-304" : "revision-200", revision });
        if (unchanged) { res.writeHead(304, { "Cache-Control": "no-store" }); res.end(); }
        else finishJson(res, { revision: String(revision) });
        fixture.emit("revision-complete", record);
        return;
      }
      let value = {};
      if (path === "/machines") value = { machines: [computer] };
      else if (path === "/sessions") value = { sessions: [persona, worker] };
      else if (path === "/interactions") value = { interactions: [] };
      else if (path === "/assistant") value = { machine_id: computer.id, main, conversations: [persona], tasks: [], memory: [], name: "Assistant" };
      else if (path === `/assistant/conversations/${main}/feed`) value = { items: [], plans: {} };
      else if (path === `/sessions/${computer.id}/${main}/items`) value = { items: initialItems, has_more: false };
      else if (path === `/sessions/${computer.id}/${worker.session_id}/items`) value = { items: [], has_more: false };
      else if (path === "/managers") value = { default: "assistant", managers: [{ id: "assistant", name: "Assistant", online: true, builtin: true, default: true }] };
      else if (path === "/mutes") value = { spaces: [], sessions: [], allowed: [] };
      else if (path === "/pins") value = { spaces: [], sessions: [] };
      else if (path === "/assistant/directions/tree") value = { directions: [] };
      else if (path === "/inbox") value = { items: [], total: 0 };
      else if (path === "/devices" || path === "/launchers") value = { devices: [], launchers: [] };
      else if (path === "/extensions" || path === "/extensions/ui" || path === "/extensions/-/themes") value = { extensions: [], themes: [], slots: [] };
      else if (path.endsWith("/items")) value = { items: [], has_more: false };
      finishJson(res, value);
      return;
    }
    const requested = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
    let file = resolve(dist, requested);
    if (!file.startsWith(`${dist}${sep}`) && file !== resolve(dist, "index.html")) { res.writeHead(403); res.end(); return; }
    if (!existsSync(file) || !extname(file)) file = resolve(dist, "index.html");
    res.writeHead(200, { "Content-Type": mime[extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
    createReadStream(file).pipe(res);
  } catch (error) {
    finishJson(res, { error: String(error) }, 500);
    fixture.emit("server-error", error);
  }
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, raw, headBytes) => {
  if (new URL(req.url, "http://127.0.0.1").pathname !== "/api/v1/ws") { raw.destroy(); return; }
  wss.handleUpgrade(req, raw, headBytes, (client) => wss.emit("connection", client));
});
wss.on("connection", (client) => {
  socket = client;
  client.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    socketEvents.push({ sequence: socketSequence++, direction: "received", type: message.type });
    if (message.type === "client_hello") {
      const hello = { type: "hello", server_version: "synthetic-loopback", hub_name: "Example hub", features: ["todo_revision"], resumed: false };
      socketEvents.push({ sequence: socketSequence++, direction: "sent", type: "hello" });
      client.send(JSON.stringify(hello));
    } else if (message.type === "app_ping" || message.type === "ping") client.send(JSON.stringify({ type: "pong" }));
  });
  client.on("close", () => { if (socket === client) socket = null; });
});

function sendSocket(message) {
  assert(socket, "the native browser WebSocket is connected");
  socketEvents.push({ sequence: socketSequence++, direction: "sent", type: message.type, plan: message.plan?.id, item: message.item?.id });
  socket.send(JSON.stringify(message));
}

await new Promise((done) => server.listen(0, "127.0.0.1", done));
const address = server.address();
assert(address && typeof address === "object");
const origin = `http://127.0.0.1:${address.port}`;
let browser;
let context;
let page;
let verdict = "FAIL";
let failure = null;
const watchdog = setTimeout(() => {
  console.error("TIMEOUT handoff cache recheck");
  process.exit(124);
}, 170_000);

try {
  browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
  context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: "light", reducedMotion: "reduce", locale: "en-US" });
  await context.addInitScript(() => {
    localStorage.setItem("persona.token", "synthetic-loopback-token");
    localStorage.setItem("persona.language", "en");
    localStorage.setItem("persona.theme", "system");
  });
  page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  page.on("console", (message) => {
    appendFileSync(resolve(shots, "browser-console.log"), `${message.type()}: ${message.text()}\n`);
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("request", (req) => {
    const url = new URL(req.url());
    if (url.hostname !== "127.0.0.1") externalRequests.push(req.url());
    requests.push({ sequence: requestSequence++, source: "browser", action: "request", method: req.method(), path: url.pathname });
  });

  await page.goto(`${origin}/`);
  await page.getByText("I handed the review to an Agent.", { exact: true }).waitFor();
  assert.equal(requests.some((row) => row.path.endsWith("/todos") && row.action === "respond"), true, "the initial list really loaded");

  // A: plan and feed arrive before the list. The miss-triggered response stays pending on the real TCP server.
  const planHeld = once(fixture, "held");
  const feedRevision = once(fixture, "revision-complete");
  stage = "plan-hold";
  sendSocket({ type: "task_plan", plan });
  sendSocket({ type: "assistant_feed", item: planFeedItem });
  sendSocket({ type: "assistant_feed", item: feedItem });
  await planHeld;
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  await page.locator('[data-handoff-presence="checking"]').first().waitFor();
  assert.equal(await page.locator('[data-handoff-presence="gone"]').count(), 0);
  await page.screenshot({ path: resolve(shots, "01-plan-before-list-checking.png") });
  screenshots.push("01-plan-before-list-checking.png");
  assertions.push("A: task_plan and assistant_feed rendered checking while the controlled list response was pending");

  currentTodos = [task(true)];
  stage = "normal";
  releaseHeld();
  await page.locator(`[data-handoff-card="${computer.id}/${worker.session_id}"]`).waitFor();
  await page.locator('[data-handoff-presence="present"]').first().waitFor();
  await page.screenshot({ path: resolve(shots, "02-plan-list-arrived-recovered.png") });
  screenshots.push("02-plan-list-arrived-recovered.png");
  assertions.push("A: the real list answer restored the task and its Agent");
  await feedRevision;

  // Prepare a task-backed Handoff so clicking the real card opens TaskPanel rather than the Agent panel.
  currentTodos = [task(false)];
  revision++;
  const prepList = once(fixture, "todos-complete");
  stage = "prep-list";
  sendSocket({ type: "todos" });
  await prepList;
  const taskCard = page.locator(`[data-handoff-card="todo:${taskId}"]`);
  await taskCard.waitFor();
  await taskCard.click();
  const panel = page.locator('aside[aria-label="Task"]');
  await panel.waitFor();
  await panel.getByText(/Starting the agent|No Agent is currently working on this task\./).waitFor();

  // B: an already-open panel and its Handoff share one transient-miss recheck.
  currentTodos = [];
  revision++;
  transientControlledRequests = 0;
  const transientList = once(fixture, "todos-complete");
  const transientHeld = once(fixture, "held");
  stage = "transient-list";
  sendSocket({ type: "todos" });
  await transientList;
  await transientHeld;
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  await page.locator('[data-handoff-presence="checking"]').first().waitFor();
  await panel.locator('[data-taskpanel-presence="checking"]').waitFor();
  assert.equal(transientControlledRequests, 1, "both components share one controlled request");
  assert.equal(await page.locator('[data-handoff-presence="gone"]').count(), 0);
  assert.equal(await panel.locator('[data-taskpanel-presence="gone"]').count(), 0);
  await page.screenshot({ path: resolve(shots, "03-open-panel-transient-miss-checking.png") });
  screenshots.push("03-open-panel-transient-miss-checking.png");
  assertions.push("B: the open TaskPanel and Handoff shared one pending recheck and neither showed gone");

  currentTodos = [task(false)];
  stage = "normal";
  releaseHeld();
  await page.locator('[data-handoff-presence="present"]').first().waitFor();
  await panel.getByText(/Starting the agent|No Agent is currently working on this task\./).waitFor();
  await page.screenshot({ path: resolve(shots, "04-open-panel-list-arrived-recovered.png") });
  screenshots.push("04-open-panel-list-arrived-recovered.png");
  assertions.push("B: the same controlled answer restored both the Handoff and the already-open TaskPanel");

  // A later present→miss segment is allowed one new check; only its healthy missing-id answer proves deletion.
  currentTodos = [];
  revision++;
  deletionControlledRequests = 0;
  const deletionList = once(fixture, "todos-complete");
  const deletionHeld = once(fixture, "held");
  stage = "delete-list";
  sendSocket({ type: "todos" });
  await deletionList;
  await deletionHeld;
  assert.equal(deletionControlledRequests, 1);
  stage = "normal";
  releaseHeld();
  await page.locator('[data-handoff-presence="gone"]').first().waitFor();
  await panel.locator('[data-taskpanel-presence="gone"]').waitFor();
  await page.screenshot({ path: resolve(shots, "05-healthy-refresh-confirmed-gone.png") });
  screenshots.push("05-healthy-refresh-confirmed-gone.png");
  assertions.push("Deletion: a new applied, current, online, healthy answer still lacking the id showed gone in both places");

  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: resolve(shots, "06-healthy-refresh-confirmed-gone-dark.png") });
  screenshots.push("06-healthy-refresh-confirmed-gone-dark.png");
  await page.evaluate(() => document.documentElement.style.setProperty("--text-scale", "2"));
  await page.screenshot({ path: resolve(shots, "07-healthy-refresh-confirmed-gone-dark-large-text.png") });
  screenshots.push("07-healthy-refresh-confirmed-gone-dark-large-text.png");

  assert.deepEqual(externalRequests, [], "every browser request stayed on loopback");
  assert.deepEqual(pageErrors, [], "the browser reported no page errors");
  assert.deepEqual(consoleErrors, [], "the browser console reported no errors");
  verdict = "PASS";
} catch (error) {
  failure = String(error?.stack || error);
  console.error(failure);
  if (page) {
    try {
      await page.screenshot({ path: resolve(shots, "failure.png") });
      writeFileSync(resolve(shots, "failure-body.txt"), await page.locator("body").innerText());
      writeFileSync(resolve(shots, "failure-url.txt"), page.url());
    } catch (captureError) {
      console.error(`failure capture: ${captureError}`);
    }
  }
} finally {
  clearTimeout(watchdog);
  if (held) {
    stage = "normal";
    releaseHeld();
  }
  writeFileSync(resolve(shots, "requests.jsonl"), `${requests.map((row) => JSON.stringify(row)).join("\n")}\n`);
  writeFileSync(resolve(shots, "websocket.jsonl"), `${socketEvents.map((row) => JSON.stringify(row)).join("\n")}\n`);
  writeFileSync(resolve(shots, "page-errors.json"), `${JSON.stringify(pageErrors, null, 2)}\n`);
  writeFileSync(resolve(shots, "result.json"), `${JSON.stringify({
    base, head, verdict, failure, chromium_version: browser?.version() || null, playwright_core_version: playwrightVersion,
    origin, assertions, screenshots, transient_controlled_requests: transientControlledRequests,
    deletion_controlled_requests: deletionControlledRequests, external_requests: externalRequests,
    console_errors: consoleErrors, page_errors: pageErrors,
  }, null, 2)}\n`);
  if (context) await context.close();
  if (browser) await browser.close();
  await new Promise((done) => server.close(done));
  console.log(`${verdict} handoff cache recheck`);
}

if (verdict !== "PASS") process.exitCode = 1;
