import assert from "node:assert/strict";
import { chmod, copyFile, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

function createClient(child) {
  let id = 0;
  let buffer = "";
  const pending = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index < 0) break;
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (message.id === undefined) continue;
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result);
    }
  });
  return {
    request(method, params = {}) {
      return new Promise((resolve, reject) => {
        const requestId = ++id;
        pending.set(requestId, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`);
      });
    },
    notify(method, params = {}) { child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`); },
  };
}

test("MCP app serves its UI and enforces the preview/commit write flow", { timeout: 20_000 }, async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "rfm-test-"));
  const bin = join(sandbox, "bin");
  const remote = join(sandbox, "remote");
  await mkdir(bin);
  await mkdir(remote);
  await writeFile(join(remote, "hello.txt"), "before", "utf8");
  const largeText = "0123456789abcdef\n".repeat(100_000);
  await writeFile(join(remote, "large.log"), largeText, "utf8");
  const pixelPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  await writeFile(join(remote, "pixel.png"), pixelPng);
  await writeFile(join(remote, "clip.mp4"), Buffer.alloc(4096, 7));
  const fakeSsh = join(bin, "ssh");
  await copyFile(new URL("./fixtures/fake-ssh.sh", import.meta.url), fakeSsh);
  await chmod(fakeSsh, 0o755);
  const child = spawn(process.execPath, [new URL("../server.mjs", import.meta.url).pathname], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, RFM_SIDEBAR_DISABLED: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGTERM"));
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const client = createClient(child);
  const initialized = await client.request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "remote-file-manager-test", version: "0.1.0" },
  });
  assert.equal(initialized.serverInfo.name, "remote-file-manager");
  client.notify("notifications/initialized");

  const tools = await client.request("tools/list");
  const names = tools.tools.map((tool) => tool.name);
  assert.ok(names.includes("remote_file_manager_open"));
  assert.ok(names.includes("rfm_prepare_mutation"));
  assert.ok(names.includes("rfm_commit_mutation"));
  const openTool = tools.tools.find((tool) => tool.name === "remote_file_manager_open");
  assert.equal(openTool._meta.ui.resourceUri, "ui://remote-file-manager/workspace-v1.html");

  const resource = await client.request("resources/read", { uri: "ui://remote-file-manager/workspace-v1.html" });
  assert.equal(resource.contents[0].mimeType, "text/html;profile=mcp-app");
  assert.match(resource.contents[0].text, /Remote Files/u);
  assert.match(resource.contents[0].text, /ui\/initialize/u);
  assert.match(resource.contents[0].text, /id="treeView"/u);
  assert.match(resource.contents[0].text, /id="newFileBtn"/u);
  assert.match(resource.contents[0].text, /id="backBtn"/u);
  assert.match(resource.contents[0].text, /function fileVisual/u);
  assert.match(resource.contents[0].text, /addEventListener\("dblclick"/u);
  assert.doesNotMatch(resource.contents[0].text, /\b(?:prompt|confirm)\s*\(/u);

  const connected = await client.request("tools/call", { name: "rfm_connect", arguments: { host: "fake", root: remote } });
  assert.equal(connected.structuredContent.ok, true, stderr);
  const sessionId = connected.structuredContent.sessionId;
  assert.ok(connected.structuredContent.entries.some((entry) => entry.name === "hello.txt"));
  const helloEntry = connected.structuredContent.entries.find((entry) => entry.name === "hello.txt");
  assert.equal(helloEntry.size, Buffer.byteLength("before"));
  assert.ok(helloEntry.modified > 0);

  const read = await client.request("tools/call", { name: "rfm_read", arguments: { sessionId, path: "hello.txt" } });
  assert.equal(Buffer.from(read.structuredContent.dataBase64, "base64").toString("utf8"), "before");
  assert.equal(read.structuredContent.hasMore, false);
  const firstChunk = await client.request("tools/call", { name: "rfm_read", arguments: { sessionId, path: "large.log", offset: 0 } });
  assert.equal(firstChunk.structuredContent.bytesRead, 1024 * 1024);
  assert.equal(firstChunk.structuredContent.hasMore, true);
  const secondChunk = await client.request("tools/call", { name: "rfm_read", arguments: { sessionId, path: "large.log", offset: firstChunk.structuredContent.bytesRead } });
  const combinedPreview = Buffer.concat([
    Buffer.from(firstChunk.structuredContent.dataBase64, "base64"),
    Buffer.from(secondChunk.structuredContent.dataBase64, "base64"),
  ]).toString("utf8");
  assert.equal(combinedPreview, largeText);
  assert.equal(secondChunk.structuredContent.hasMore, false);
  const imagePreview = await client.request("tools/call", { name: "rfm_preview_image", arguments: { sessionId, path: "pixel.png" } });
  assert.equal(imagePreview.structuredContent.mimeType, "image/png");
  assert.deepEqual(Buffer.from(imagePreview.structuredContent.dataBase64, "base64"), pixelPng);
  const mediaPreview = await client.request("tools/call", { name: "rfm_prepare_media", arguments: { sessionId, path: "clip.mp4" } });
  assert.equal(mediaPreview.structuredContent.mimeType, "video/mp4");
  assert.equal(mediaPreview.structuredContent.size, 4096);
  assert.match(mediaPreview.structuredContent.url, /^\/api\/media\/[0-9a-f-]+$/u);
  const preview = await client.request("tools/call", {
    name: "rfm_prepare_mutation",
    arguments: { sessionId, operation: { kind: "write", path: "hello.txt", text: "after", expectedVersion: read.structuredContent.version } },
  });
  assert.equal(await readFile(join(remote, "hello.txt"), "utf8"), "before", "preview must not write");
  const committed = await client.request("tools/call", {
    name: "rfm_commit_mutation",
    arguments: { proposalId: preview.structuredContent.proposalId, confirmation: "" },
  });
  assert.equal(committed.structuredContent.ok, true, stderr);
  assert.equal(await readFile(join(remote, "hello.txt"), "utf8"), "after");

  const mkdirPreview = await client.request("tools/call", { name: "rfm_prepare_mutation", arguments: { sessionId, operation: { kind: "mkdir", path: "docs" } } });
  await client.request("tools/call", { name: "rfm_commit_mutation", arguments: { proposalId: mkdirPreview.structuredContent.proposalId } });
  const newFilePreview = await client.request("tools/call", { name: "rfm_prepare_mutation", arguments: { sessionId, operation: { kind: "write", path: "draft.txt", text: "draft" } } });
  await client.request("tools/call", { name: "rfm_commit_mutation", arguments: { proposalId: newFilePreview.structuredContent.proposalId } });
  const renamePreview = await client.request("tools/call", { name: "rfm_prepare_mutation", arguments: { sessionId, operation: { kind: "rename", path: "draft.txt", destination: "docs/moved.txt" } } });
  await client.request("tools/call", { name: "rfm_commit_mutation", arguments: { proposalId: renamePreview.structuredContent.proposalId } });
  assert.equal(await readFile(join(remote, "docs", "moved.txt"), "utf8"), "draft");

  const binary = Buffer.from([0, 1, 2, 250, 255]);
  const uploadPreview = await client.request("tools/call", { name: "rfm_prepare_mutation", arguments: { sessionId, operation: { kind: "upload", path: "docs/blob.bin", dataBase64: binary.toString("base64") } } });
  await client.request("tools/call", { name: "rfm_commit_mutation", arguments: { proposalId: uploadPreview.structuredContent.proposalId } });
  const downloaded = await client.request("tools/call", { name: "rfm_download", arguments: { sessionId, path: "docs/blob.bin" } });
  assert.deepEqual(Buffer.from(downloaded.structuredContent.dataBase64, "base64"), binary);

  const searched = await client.request("tools/call", { name: "rfm_search", arguments: { sessionId, path: "", query: "moved" } });
  assert.deepEqual(searched.structuredContent.results.map((item) => item.path), ["docs/moved.txt"]);

  const recursiveDelete = await client.request("tools/call", { name: "rfm_prepare_mutation", arguments: { sessionId, operation: { kind: "delete", path: "docs", recursive: true } } });
  assert.equal(recursiveDelete.structuredContent.confirmationPhrase, "docs");
  const rejectedDelete = await client.request("tools/call", { name: "rfm_commit_mutation", arguments: { proposalId: recursiveDelete.structuredContent.proposalId, confirmation: "wrong" } });
  assert.equal(rejectedDelete.structuredContent.ok, false);
  assert.equal(await readFile(join(remote, "docs", "moved.txt"), "utf8"), "draft");
  const acceptedDelete = await client.request("tools/call", { name: "rfm_commit_mutation", arguments: { proposalId: recursiveDelete.structuredContent.proposalId, confirmation: "docs" } });
  assert.equal(acceptedDelete.structuredContent.ok, true, stderr);
  await assert.rejects(readFile(join(remote, "docs", "moved.txt")));
});
