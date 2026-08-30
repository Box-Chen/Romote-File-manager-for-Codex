import assert from "node:assert/strict";
import test from "node:test";
import { __test } from "../server.mjs";

test("safeRelativePath normalizes paths inside the root", () => {
  assert.equal(__test.safeRelativePath("/var/www/app.txt"), "var/www/app.txt");
  assert.equal(__test.safeRelativePath("a/./b"), "a/b");
  assert.equal(__test.safeRelativePath(""), "");
});

test("safeRelativePath rejects traversal and NUL", () => {
  assert.throws(() => __test.safeRelativePath("../etc/passwd"), /授权|离开/u);
  assert.throws(() => __test.safeRelativePath("a/../../b"), /授权|离开/u);
  assert.throws(() => __test.safeRelativePath("a\0b"), /无效/u);
});

test("root containment is boundary aware", () => {
  assert.equal(__test.isInsideRoot("/srv/app", "/srv/app"), true);
  assert.equal(__test.isInsideRoot("/srv/app", "/srv/app/public/a"), true);
  assert.equal(__test.isInsideRoot("/srv/app", "/srv/application"), false);
});

test("shell quoting does not expose single quotes", () => {
  assert.equal(__test.shellQuote("a'b"), `'a'"'"'b'`);
});

test("recursive delete requires the basename as a confirmation phrase", () => {
  const result = __test.mutationSummary({ kind: "delete", path: "logs/archive", recursive: true });
  assert.equal(result.phrase, "archive");
  assert.match(result.summary, /递归删除/u);
});

test("base64 remote names round trip Unicode and newlines", () => {
  const name = "配置\n文件.txt";
  assert.equal(__test.decodeBase64Name(Buffer.from(name).toString("base64")), name);
});

test("SSH multiplex socket path stays below the macOS limit", () => {
  const path = __test.sshControlPath("/tmp/rfm-ABC123").replace("%C", "f".repeat(40));
  assert.ok(Buffer.byteLength(path) < 104, `ControlPath is ${Buffer.byteLength(path)} bytes`);
});

test("video ranges are bounded to streaming chunks", () => {
  assert.deepEqual(__test.parseMediaRange("bytes=0-9999999", 10_000_000), { start: 0, end: 2 * 1024 * 1024 - 1 });
  assert.deepEqual(__test.parseMediaRange("bytes=500-999", 10_000), { start: 500, end: 999 });
  assert.deepEqual(__test.parseMediaRange("bytes=-100", 10_000), { start: 9900, end: 9999 });
  assert.throws(() => __test.parseMediaRange("bytes=10000-", 10_000), /范围/u);
});
