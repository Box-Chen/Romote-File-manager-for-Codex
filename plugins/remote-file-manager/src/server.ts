import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const PLUGIN_ROOT = dirname(fileURLToPath(import.meta.url));
const WIDGET_URI = "ui://remote-file-manager/workspace-v1.html";
const PREVIEW_CHUNK_BYTES = 1024 * 1024;
const MAX_EDIT_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_PREVIEW_BYTES = 20 * 1024 * 1024;
const MAX_TRANSFER_BYTES = 8 * 1024 * 1024;
const MAX_LIST_ENTRIES = 500;
const PROPOSAL_TTL_MS = 2 * 60 * 1000;
const MEDIA_TICKET_TTL_MS = 30 * 60 * 1000;
const MEDIA_CHUNK_BYTES = 2 * 1024 * 1024;
const DEFAULT_SIDEBAR_PORT = 17_654;
const MAX_HTTP_BODY_BYTES = Math.ceil(MAX_TRANSFER_BYTES * 1.5);
const HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/u;
let sshControlDirPromise: Promise<string> | null = null;

type Session = { id: string; host: string; root: string; createdAt: number };
type Operation =
  | { kind: "mkdir"; path: string }
  | { kind: "write"; path: string; text: string; expectedVersion?: string }
  | { kind: "upload"; path: string; dataBase64: string; expectedVersion?: string }
  | { kind: "rename"; path: string; destination: string }
  | { kind: "delete"; path: string; recursive: boolean };
type Proposal = {
  id: string;
  sessionId: string;
  operation: Operation;
  summary: string;
  expiresAt: number;
  sourceVersion: string | null;
  confirmationPhrase: string | null;
};
type MediaTicket = { id: string; sessionId: string; canonicalPath: string; name: string; mimeType: string; size: number; expiresAt: number };

const sessions = new Map<string, Session>();
const proposals = new Map<string, Proposal>();
const mediaTickets = new Map<string, MediaTicket>();

class RfmError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function safeRelativePath(value: string): string {
  if (typeof value !== "string" || value.length > 4096 || value.includes("\0")) throw new RfmError("INVALID_PATH", "路径无效。");
  const normalizedInput = value.replaceAll("\\", "/").replace(/^\/+/, "");
  if (normalizedInput.split("/").some((part) => part === "..")) throw new RfmError("PATH_OUTSIDE_ROOT", "路径不能离开已授权的远程根目录。");
  const normalized = posix.normalize(`/${normalizedInput}`).slice(1);
  return normalized === "." ? "" : normalized;
}

function isInsideRoot(root: string, target: string): boolean {
  return target === root || target.startsWith(root.endsWith("/") ? root : `${root}/`);
}

function targetPath(session: Session, relative: string): string {
  return posix.join(session.root, safeRelativePath(relative));
}

async function runProcess(command: string, args: string[], options: { input?: Buffer; timeoutMs?: number; maxBytes?: number } = {}): Promise<Buffer> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const maxBytes = options.maxBytes ?? MAX_TRANSFER_BYTES + 256 * 1024;
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env: process.env });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const finish = (error?: Error, value?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(value ?? Buffer.alloc(0));
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new RfmError("SSH_TIMEOUT", "SSH 操作超时。"));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > maxBytes) {
        child.kill("SIGKILL");
        finish(new RfmError("OUTPUT_TOO_LARGE", "远程响应超过安全上限。"));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (Buffer.concat(stderr).length < 64 * 1024) stderr.push(chunk);
    });
    child.on("error", (error) => finish(new RfmError("SSH_UNAVAILABLE", `无法启动 OpenSSH：${error.message}`)));
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString("utf8").trim().slice(0, 800);
        finish(new RfmError("SSH_FAILED", detail || `SSH 操作失败（退出码 ${code ?? "unknown"}）。`));
        return;
      }
      finish(undefined, Buffer.concat(stdout));
    });
    if (options.input) child.stdin.end(options.input); else child.stdin.end();
  });
}

async function runSsh(host: string, command: string, options: { input?: Buffer; timeoutMs?: number; maxBytes?: number } = {}): Promise<Buffer> {
  if (!HOST_PATTERN.test(host)) throw new RfmError("INVALID_HOST", "SSH 主机别名格式无效。");
  // macOS limits Unix-domain socket paths to 104 bytes. Its resolved TMPDIR is
  // often already very long, so keep our private control socket under /tmp.
  // This path is only for SSH connection multiplexing; key/config paths remain untouched.
  sshControlDirPromise ??= mkdtemp("/tmp/rfm-");
  const sshControlDir = await sshControlDirPromise;
  return runProcess("ssh", [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ControlMaster=auto",
    "-o", "ControlPersist=120",
    "-o", `ControlPath=${sshControlPath(sshControlDir)}`,
    "--", host, command,
  ], options);
}

function sshControlPath(directory: string): string {
  return join(directory, "%C");
}

async function listSshHosts(): Promise<string[]> {
  try {
    const config = await readFile(join(homedir(), ".ssh", "config"), "utf8");
    const hosts = new Set<string>();
    for (const rawLine of config.split(/\r?\n/u)) {
      const line = rawLine.replace(/\s+#.*$/u, "").trim();
      const match = /^Host\s+(.+)$/iu.exec(line);
      if (!match) continue;
      for (const candidate of match[1].trim().split(/\s+/u)) {
        if (HOST_PATTERN.test(candidate) && !candidate.includes("*") && !candidate.includes("?") && !candidate.startsWith("!")) hosts.add(candidate);
      }
    }
    return [...hosts].sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

async function validateSshHost(host: string): Promise<{ hostname: string; user: string; port: number }> {
  if (!HOST_PATTERN.test(host)) throw new RfmError("INVALID_HOST", "请输入 SSH 配置中的安全主机别名。");
  const output = (await runProcess("ssh", ["-G", "--", host], { timeoutMs: 5_000, maxBytes: 256 * 1024 })).toString("utf8");
  const values = new Map<string, string>();
  for (const line of output.split(/\r?\n/u)) {
    const space = line.indexOf(" ");
    if (space > 0) values.set(line.slice(0, space), line.slice(space + 1).trim());
  }
  return { hostname: values.get("hostname") ?? host, user: values.get("user") ?? "", port: Number(values.get("port") ?? 22) };
}

function getSession(sessionId: string): Session {
  const session = sessions.get(sessionId);
  if (!session) throw new RfmError("SESSION_EXPIRED", "远程会话不存在或已过期，请重新连接。");
  return session;
}

async function canonicalRemotePath(session: Session, relative: string, allowMissing = false): Promise<string> {
  const requested = targetPath(session, relative);
  const script = `target=${shellQuote(requested)}\nallow_missing=${allowMissing ? "1" : "0"}\nif [ -e "$target" ] || [ -L "$target" ]; then\n  if command -v realpath >/dev/null 2>&1; then realpath -- "$target"\n  elif command -v readlink >/dev/null 2>&1 && readlink -f -- "$target" >/dev/null 2>&1; then readlink -f -- "$target"\n  else\n    [ ! -L "$target" ] || { echo SYMLINK_UNSUPPORTED >&2; exit 42; }\n    d=\${target%/*}; b=\${target##*/}; CDPATH= cd -- "$d" && printf '%s/%s\\n' "$PWD" "$b"\n  fi\nelif [ "$allow_missing" = 1 ]; then\n  d=\${target%/*}; b=\${target##*/}; CDPATH= cd -- "$d" && printf '%s/%s\\n' "$PWD" "$b"\nelse\n  echo NOT_FOUND >&2; exit 44\nfi`;
  const canonical = (await runSsh(session.host, `sh -c ${shellQuote(script)}`, { maxBytes: 16 * 1024 })).toString("utf8").trim();
  if (!canonical.startsWith("/")) throw new RfmError("CANONICAL_PATH_FAILED", "无法验证远程路径。");
  if (!isInsideRoot(session.root, canonical)) throw new RfmError("PATH_OUTSIDE_ROOT", "目标经过符号链接后离开了授权根目录。");
  return canonical;
}

async function statVersion(session: Session, relative: string): Promise<string | null> {
  const target = targetPath(session, relative);
  const script = `p=${shellQuote(target)}\nif [ ! -e "$p" ] && [ ! -L "$p" ]; then printf 'MISSING'; exit 0; fi\nif stat -c '%s:%Y:%f' -- "$p" >/dev/null 2>&1; then stat -c '%s:%Y:%f' -- "$p"; else stat -f '%z:%m:%p' -- "$p"; fi`;
  const value = (await runSsh(session.host, `sh -c ${shellQuote(script)}`, { maxBytes: 4096 })).toString("utf8").trim();
  return value === "MISSING" ? null : value;
}

function decodeBase64Name(value: string): string {
  try { return Buffer.from(value, "base64").toString("utf8"); } catch { throw new RfmError("INVALID_REMOTE_OUTPUT", "远程目录响应格式无效。"); }
}

async function listDirectory(session: Session, relative: string): Promise<{ path: string; entries: unknown[] }> {
  const requested = targetPath(session, relative);
  const rootGuard = session.root === "/" ? ":" : `case "$d" in ${shellQuote(session.root)}|${shellQuote(`${session.root}/`)}*) ;; *) echo PATH_OUTSIDE_ROOT >&2; exit 43 ;; esac`;
  const resolve = `target=${shellQuote(requested)}\nif command -v realpath >/dev/null 2>&1; then d=$(realpath -- "$target")\nelif command -v readlink >/dev/null 2>&1 && readlink -f -- "$target" >/dev/null 2>&1; then d=$(readlink -f -- "$target")\nelse\n  [ ! -L "$target" ] || { echo SYMLINK_UNSUPPORTED >&2; exit 42; }\n  CDPATH= cd -- "$target" && d=$PWD\nfi`;
  const script = `${resolve}\n${rootGuard}\n[ -d "$d" ] || { echo NOT_DIRECTORY >&2; exit 45; }\nprintf 'RFM_PATH\\t'; printf '%s' "$d" | base64 | tr -d '\\n'; printf '\\n'\nfor p in "$d"/.[!.]* "$d"/..?* "$d"/*; do\n  { [ -e "$p" ] || [ -L "$p" ]; } || continue\n  n=\${p##*/}; enc=$(printf '%s' "$n" | base64 | tr -d '\\n')\n  if [ -L "$p" ]; then t=link; elif [ -d "$p" ]; then t=directory; elif [ -f "$p" ]; then t=file; else t=other; fi\n  if stat -c '%s' -- "$p" >/dev/null 2>&1; then\n    size=$(stat -c '%s' -- "$p"); modified=$(stat -c '%Y' -- "$p"); mode=$(stat -c '%a' -- "$p")\n  else\n    size=$(stat -f '%z' -- "$p"); modified=$(stat -f '%m' -- "$p"); mode=$(stat -f '%Lp' -- "$p")\n  fi\n  printf '%s\\t%s\\t%s\\t%s\\t%s\\n' "$enc" "$t" "$size" "$modified" "$mode"\ndone`;
  const output = (await runSsh(session.host, `sh -c ${shellQuote(script)}`, { maxBytes: 2 * 1024 * 1024 })).toString("utf8");
  const lines = output.split(/\r?\n/u).filter(Boolean);
  const [marker, encodedPath] = (lines.shift() ?? "").split("\t");
  if (marker !== "RFM_PATH" || !encodedPath) throw new RfmError("INVALID_REMOTE_OUTPUT", "远程目录响应格式无效。");
  const canonical = decodeBase64Name(encodedPath);
  if (!isInsideRoot(session.root, canonical)) throw new RfmError("PATH_OUTSIDE_ROOT", "目标经过符号链接后离开了授权根目录。");
  const path = posix.relative(session.root, canonical);
  const entries = lines.slice(0, MAX_LIST_ENTRIES).map((line) => {
    const [encoded, type, size, modified, mode] = line.split("\t");
    const name = decodeBase64Name(encoded);
    return { name, path: posix.join(path, name), type, size: Number(size) || 0, modified: Number(modified) || 0, mode: mode ?? "" };
  }).sort((a, b) => (a.type === "directory" ? -1 : 1) - (b.type === "directory" ? -1 : 1) || a.name.localeCompare(b.name));
  return { path, entries };
}

async function readRemoteFile(session: Session, relative: string, offsetInput = 0): Promise<{ path: string; name: string; dataBase64: string; version: string; size: number; offset: number; bytesRead: number; hasMore: boolean; editable: boolean }> {
  const relativePath = safeRelativePath(relative);
  const requested = targetPath(session, relativePath);
  const offset = Number(offsetInput);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new RfmError("INVALID_OFFSET", "预览位置无效。");
  const rootGuard = session.root === "/" ? ":" : `case "$p" in ${shellQuote(session.root)}|${shellQuote(`${session.root}/`)}*) ;; *) echo PATH_OUTSIDE_ROOT >&2; exit 43 ;; esac`;
  const resolve = `target=${shellQuote(requested)}\nif command -v realpath >/dev/null 2>&1; then p=$(realpath -- "$target")\nelif command -v readlink >/dev/null 2>&1 && readlink -f -- "$target" >/dev/null 2>&1; then p=$(readlink -f -- "$target")\nelse\n  [ ! -L "$target" ] || { echo SYMLINK_UNSUPPORTED >&2; exit 42; }\n  d=\${target%/*}; b=\${target##*/}; CDPATH= cd -- "$d" && p="$PWD/$b"\nfi`;
  const script = `${resolve}\n${rootGuard}\n[ -f "$p" ] && [ ! -L "$p" ] || { echo NOT_REGULAR_FILE >&2; exit 46; }\nsize=$(wc -c < "$p" | tr -d ' ')\nif stat -c '%s:%Y:%f' -- "$p" >/dev/null 2>&1; then version=$(stat -c '%s:%Y:%f' -- "$p"); else version=$(stat -f '%z:%m:%p' -- "$p"); fi\nprintf 'RFM_FILE\\t%s\\t' "$size"; printf '%s' "$version" | base64 | tr -d '\\n'; printf '\\n'\nif [ ${offset} -lt "$size" ]; then tail -c +${offset + 1} -- "$p" | head -c ${PREVIEW_CHUNK_BYTES} | base64 | tr -d '\\n'; fi`;
  const output = (await runSsh(session.host, `sh -c ${shellQuote(script)}`, { maxBytes: Math.ceil(PREVIEW_CHUNK_BYTES * 1.4) + 4096 })).toString("utf8");
  const newline = output.indexOf("\n");
  if (newline < 0) throw new RfmError("INVALID_REMOTE_OUTPUT", "远程文件响应格式无效。");
  const [marker, sizeText, encodedVersion] = output.slice(0, newline).split("\t");
  if (marker !== "RFM_FILE") throw new RfmError("INVALID_REMOTE_OUTPUT", "远程文件响应格式无效。");
  const size = Number(sizeText);
  const buffer = Buffer.from(output.slice(newline + 1).trim(), "base64");
  if (buffer.includes(0)) throw new RfmError("BINARY_FILE", "这是二进制文件，请使用下载功能。");
  return { path: relativePath, name: basename(relativePath), dataBase64: buffer.toString("base64"), version: decodeBase64Name(encodedVersion ?? ""), size, offset, bytesRead: buffer.length, hasMore: offset + buffer.length < size, editable: size <= MAX_EDIT_BYTES };
}

async function searchRemote(session: Session, relative: string, query: string): Promise<{ path: string; results: unknown[] }> {
  if (!query.trim() || query.length > 100 || query.includes("\0")) throw new RfmError("INVALID_QUERY", "请输入 1–100 个字符的文件名关键词。");
  const canonical = await canonicalRemotePath(session, relative);
  const pattern = `*${query.trim()}*`;
  const inner = `for p do printf '%s' "$p" | base64 | tr -d '\\n'; printf '\\n'; done`;
  const script = `d=${shellQuote(canonical)}\n[ -d "$d" ] || exit 45\nfind "$d" -type f -iname ${shellQuote(pattern)} -exec sh -c ${shellQuote(inner)} sh {} +`;
  const output = (await runSsh(session.host, `sh -c ${shellQuote(script)}`, { timeoutMs: 30_000, maxBytes: 2 * 1024 * 1024 })).toString("utf8");
  const results = output.split(/\r?\n/u).filter(Boolean).slice(0, 200).map((encoded) => {
    const absolute = decodeBase64Name(encoded);
    if (!isInsideRoot(session.root, absolute)) throw new RfmError("PATH_OUTSIDE_ROOT", "搜索结果离开了授权根目录。");
    return { name: posix.basename(absolute), path: posix.relative(session.root, absolute) };
  });
  return { path: posix.relative(session.root, canonical), results };
}

function mutationSummary(operation: Operation): { summary: string; phrase: string | null } {
  switch (operation.kind) {
    case "mkdir": return { summary: `新建文件夹：${operation.path}`, phrase: null };
    case "write": return { summary: `保存文本文件：${operation.path}（${Buffer.byteLength(operation.text)} 字节）`, phrase: null };
    case "upload": return { summary: `上传文件：${operation.path}（${Buffer.from(operation.dataBase64, "base64").length} 字节）`, phrase: null };
    case "rename": return { summary: `移动或重命名：${operation.path} → ${operation.destination}`, phrase: null };
    case "delete": return { summary: `${operation.recursive ? "递归" : ""}删除：${operation.path}`, phrase: operation.recursive ? posix.basename(operation.path) : null };
  }
}

async function prepareMutation(session: Session, operation: Operation): Promise<Proposal> {
  operation.path = safeRelativePath(operation.path);
  if (!operation.path) throw new RfmError("ROOT_MUTATION_DENIED", "不能修改或删除会话根目录。");
  let sourceVersion: string | null = null;
  if (operation.kind === "write") {
    if (Buffer.byteLength(operation.text) > MAX_EDIT_BYTES) throw new RfmError("PAYLOAD_TOO_LARGE", "可编辑文本不能超过 8 MiB。较大的文件仍可分段预览和下载。");
    await canonicalRemotePath(session, operation.path, true);
    sourceVersion = await statVersion(session, operation.path);
    if (operation.expectedVersion !== undefined && operation.expectedVersion !== sourceVersion) throw new RfmError("FILE_CHANGED", "远程文件已被其他程序修改，请刷新后再保存。");
  } else if (operation.kind === "upload") {
    const bytes = Buffer.from(operation.dataBase64, "base64");
    if (bytes.length > MAX_TRANSFER_BYTES) throw new RfmError("PAYLOAD_TOO_LARGE", "上传文件超过 8 MiB 上限。");
    await canonicalRemotePath(session, operation.path, true);
    sourceVersion = await statVersion(session, operation.path);
    if (operation.expectedVersion !== undefined && operation.expectedVersion !== sourceVersion) throw new RfmError("FILE_CHANGED", "远程目标已改变，请刷新后重试。");
  } else if (operation.kind === "mkdir") {
    await canonicalRemotePath(session, operation.path, true);
    sourceVersion = await statVersion(session, operation.path);
    if (sourceVersion !== null) throw new RfmError("ALREADY_EXISTS", "目标已经存在。");
  } else if (operation.kind === "rename") {
    operation.destination = safeRelativePath(operation.destination);
    if (!operation.destination) throw new RfmError("ROOT_MUTATION_DENIED", "目标不能是会话根目录。");
    await canonicalRemotePath(session, operation.path);
    await canonicalRemotePath(session, operation.destination, true);
    sourceVersion = await statVersion(session, operation.path);
    if (await statVersion(session, operation.destination) !== null) throw new RfmError("ALREADY_EXISTS", "目标路径已经存在。");
  } else {
    await canonicalRemotePath(session, operation.path);
    sourceVersion = await statVersion(session, operation.path);
  }
  const { summary, phrase } = mutationSummary(operation);
  const proposal: Proposal = { id: randomUUID(), sessionId: session.id, operation, summary, expiresAt: Date.now() + PROPOSAL_TTL_MS, sourceVersion, confirmationPhrase: phrase };
  proposals.set(proposal.id, proposal);
  return proposal;
}

async function writeBuffer(session: Session, relative: string, data: Buffer): Promise<void> {
  const target = await canonicalRemotePath(session, relative, true);
  const script = `p=${shellQuote(target)}\ntmp="\${p}.rfm.$$"\numask 077\ntrap 'rm -f -- "$tmp"' EXIT HUP INT TERM\ncat > "$tmp"\nif [ -e "$p" ]; then chmod --reference="$p" "$tmp" 2>/dev/null || true; fi\nmv -- "$tmp" "$p"\ntrap - EXIT`;
  await runSsh(session.host, `sh -c ${shellQuote(script)}`, { input: data, timeoutMs: 60_000, maxBytes: 64 * 1024 });
}

async function commitProposal(proposal: Proposal, confirmation: string): Promise<{ message: string }> {
  if (proposal.expiresAt < Date.now()) throw new RfmError("PROPOSAL_EXPIRED", "操作确认已过期，请重新发起。");
  if (proposal.confirmationPhrase && confirmation !== proposal.confirmationPhrase) throw new RfmError("CONFIRMATION_MISMATCH", "确认名称不匹配。");
  const session = getSession(proposal.sessionId);
  const currentVersion = await statVersion(session, proposal.operation.path);
  if (currentVersion !== proposal.sourceVersion) throw new RfmError("REMOTE_CHANGED", "目标在确认期间发生变化，操作已取消。");
  const operation = proposal.operation;
  if (operation.kind === "mkdir") {
    const target = await canonicalRemotePath(session, operation.path, true);
    await runSsh(session.host, `mkdir -- ${shellQuote(target)}`);
  } else if (operation.kind === "write") {
    await writeBuffer(session, operation.path, Buffer.from(operation.text, "utf8"));
  } else if (operation.kind === "upload") {
    await writeBuffer(session, operation.path, Buffer.from(operation.dataBase64, "base64"));
  } else if (operation.kind === "rename") {
    const source = await canonicalRemotePath(session, operation.path);
    const destination = await canonicalRemotePath(session, operation.destination, true);
    await runSsh(session.host, `mv -- ${shellQuote(source)} ${shellQuote(destination)}`);
  } else {
    const target = await canonicalRemotePath(session, operation.path);
    if (operation.recursive) await runSsh(session.host, `rm -rf -- ${shellQuote(target)}`);
    else {
      const script = `p=${shellQuote(target)}\nif [ -d "$p" ]; then rmdir -- "$p"; else rm -- "$p"; fi`;
      await runSsh(session.host, `sh -c ${shellQuote(script)}`);
    }
  }
  proposals.delete(proposal.id);
  return { message: `已完成：${proposal.summary}` };
}

function ok(data: Record<string, unknown>, text = "Remote File Manager operation completed.") {
  return { content: [{ type: "text" as const, text }], structuredContent: { ok: true, ...data } };
}

function failed(error: unknown) {
  const known = error instanceof RfmError ? error : new RfmError("INTERNAL_ERROR", error instanceof Error ? error.message : "未知错误");
  return { content: [{ type: "text" as const, text: `Remote File Manager failed: ${known.code}.` }], structuredContent: { ok: false, code: known.code, message: known.message }, isError: true };
}

function appTool(server: McpServer, name: string, title: string, description: string, inputSchema: Record<string, z.ZodTypeAny>, handler: (input: any) => Promise<unknown>) {
  registerAppTool(server, name, {
    title,
    description,
    inputSchema,
    _meta: { ui: { visibility: ["app"] } },
  }, async (input) => { try { return await handler(input); } catch (error) { return failed(error); } });
}

async function connectRemote(host: string, root: string) {
  if (typeof host !== "string" || typeof root !== "string" || !root.startsWith("/") || root.length > 4096 || root.includes("\0")) throw new RfmError("INVALID_ROOT", "远程根目录必须是绝对路径。");
  const resolved = await validateSshHost(host);
  const script = `CDPATH= cd -- ${shellQuote(root)} && pwd -P`;
  const canonicalRoot = (await runSsh(host, `sh -c ${shellQuote(script)}`, { maxBytes: 16 * 1024 })).toString("utf8").trim();
  if (!canonicalRoot.startsWith("/")) throw new RfmError("INVALID_ROOT", "无法解析远程根目录。");
  const session: Session = { id: randomUUID(), host, root: canonicalRoot.replace(/\/$/u, "") || "/", createdAt: Date.now() };
  sessions.set(session.id, session);
  return { sessionId: session.id, host, root: session.root, connection: resolved, ...(await listDirectory(session, "")) };
}

async function downloadRemote(sessionId: string, path: string) {
  const session = getSession(sessionId);
  const canonical = await canonicalRemotePath(session, path);
  const script = `p=${shellQuote(canonical)}\n[ -f "$p" ] && [ ! -L "$p" ] || exit 46\nsize=$(wc -c < "$p" | tr -d ' ')\n[ "$size" -le ${MAX_TRANSFER_BYTES} ] || exit 47\ncat -- "$p"`;
  const data = await runSsh(session.host, `sh -c ${shellQuote(script)}`, { maxBytes: MAX_TRANSFER_BYTES });
  return { name: basename(path), path: safeRelativePath(path), dataBase64: data.toString("base64"), size: data.length, mimeType: "application/octet-stream" };
}

function imageMimeType(path: string): string | null {
  const extension = posix.extname(path).toLowerCase();
  return ({
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".avif": "image/avif",
  } as Record<string, string>)[extension] ?? null;
}

async function previewRemoteImage(sessionId: string, path: string) {
  const session = getSession(sessionId);
  const relativePath = safeRelativePath(path);
  const mimeType = imageMimeType(relativePath);
  if (!mimeType) throw new RfmError("UNSUPPORTED_IMAGE", "暂不支持这种图片格式，请下载后查看。");
  const canonical = await canonicalRemotePath(session, relativePath);
  const script = `p=${shellQuote(canonical)}\n[ -f "$p" ] && [ ! -L "$p" ] || exit 46\nsize=$(wc -c < "$p" | tr -d ' ')\n[ "$size" -le ${MAX_IMAGE_PREVIEW_BYTES} ] || { echo IMAGE_TOO_LARGE >&2; exit 47; }\ncat -- "$p"`;
  const data = await runSsh(session.host, `sh -c ${shellQuote(script)}`, { timeoutMs: 30_000, maxBytes: MAX_IMAGE_PREVIEW_BYTES });
  return { name: basename(relativePath), path: relativePath, dataBase64: data.toString("base64"), size: data.length, mimeType };
}

function mediaMimeType(path: string): string | null {
  const extension = posix.extname(path).toLowerCase();
  return ({
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".mkv": "video/x-matroska",
    ".avi": "video/x-msvideo",
  } as Record<string, string>)[extension] ?? null;
}

function parseMediaRange(header: string | undefined, size: number): { start: number; end: number } {
  if (!Number.isSafeInteger(size) || size <= 0) throw new RfmError("EMPTY_MEDIA", "视频文件为空。");
  let start = 0;
  let end = Math.min(size - 1, MEDIA_CHUNK_BYTES - 1);
  if (header) {
    const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
    if (!match || (!match[1] && !match[2])) throw new RfmError("INVALID_RANGE", "视频分段请求无效。");
    if (!match[1]) {
      const suffix = Math.min(Number(match[2]), MEDIA_CHUNK_BYTES, size);
      start = size - suffix;
      end = size - 1;
    } else {
      start = Number(match[1]);
      const requestedEnd = match[2] ? Number(match[2]) : size - 1;
      end = Math.min(requestedEnd, start + MEDIA_CHUNK_BYTES - 1, size - 1);
    }
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) throw new RfmError("RANGE_NOT_SATISFIABLE", "视频分段超出文件范围。");
  return { start, end };
}

async function prepareRemoteMedia(sessionId: string, path: string) {
  const session = getSession(sessionId);
  const relativePath = safeRelativePath(path);
  const mimeType = mediaMimeType(relativePath);
  if (!mimeType) throw new RfmError("UNSUPPORTED_MEDIA", "暂不支持这种视频格式，请下载后查看。");
  const canonicalPath = await canonicalRemotePath(session, relativePath);
  const script = `p=${shellQuote(canonicalPath)}\n[ -f "$p" ] && [ ! -L "$p" ] || exit 46\nwc -c < "$p" | tr -d ' '`;
  const size = Number((await runSsh(session.host, `sh -c ${shellQuote(script)}`, { maxBytes: 4096 })).toString("utf8").trim());
  if (!Number.isSafeInteger(size) || size <= 0) throw new RfmError("EMPTY_MEDIA", "视频文件为空或无法读取。");
  const ticket: MediaTicket = { id: randomUUID(), sessionId, canonicalPath, name: basename(relativePath), mimeType, size, expiresAt: Date.now() + MEDIA_TICKET_TTL_MS };
  mediaTickets.set(ticket.id, ticket);
  return { name: ticket.name, path: relativePath, mimeType, size, url: `/api/media/${ticket.id}` };
}

async function readRemoteMediaRange(ticket: MediaTicket, start: number, end: number): Promise<Buffer> {
  const session = getSession(ticket.sessionId);
  const length = end - start + 1;
  const script = `p=${shellQuote(ticket.canonicalPath)}\ntail -c +${start + 1} -- "$p" | head -c ${length}`;
  return await runSsh(session.host, `sh -c ${shellQuote(script)}`, { timeoutMs: 30_000, maxBytes: length + 4096 });
}

async function executeUiCall(name: string, input: any): Promise<Record<string, unknown>> {
  switch (name) {
    case "rfm_list_hosts": return { hosts: await listSshHosts() };
    case "rfm_connect": return await connectRemote(input?.host, input?.root);
    case "rfm_list": return await listDirectory(getSession(input?.sessionId), input?.path);
    case "rfm_read": return await readRemoteFile(getSession(input?.sessionId), input?.path, input?.offset ?? 0);
    case "rfm_search": return await searchRemote(getSession(input?.sessionId), input?.path, input?.query);
    case "rfm_preview_image": return await previewRemoteImage(input?.sessionId, input?.path);
    case "rfm_prepare_media": return await prepareRemoteMedia(input?.sessionId, input?.path);
    case "rfm_download": return await downloadRemote(input?.sessionId, input?.path);
    case "rfm_prepare_mutation": {
      const proposal = await prepareMutation(getSession(input?.sessionId), input?.operation);
      return { proposalId: proposal.id, summary: proposal.summary, expiresAt: proposal.expiresAt, confirmationPhrase: proposal.confirmationPhrase };
    }
    case "rfm_commit_mutation": {
      const proposal = proposals.get(input?.proposalId);
      if (!proposal) throw new RfmError("PROPOSAL_NOT_FOUND", "操作确认不存在或已使用。");
      return await commitProposal(proposal, input?.confirmation ?? "");
    }
    case "rfm_discard_mutation": proposals.delete(input?.proposalId); return { message: "操作已取消。" };
    default: throw new RfmError("UNKNOWN_OPERATION", "不支持的文件管理操作。");
  }
}

async function readJsonBody(request: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_HTTP_BODY_BYTES) throw new RfmError("PAYLOAD_TOO_LARGE", "请求超过安全上限。");
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new RfmError("INVALID_REQUEST", "请求格式无效。"); }
}

function sidebarPort(): number {
  const value = Number(process.env.RFM_SIDEBAR_PORT ?? DEFAULT_SIDEBAR_PORT);
  return Number.isInteger(value) && value >= 0 && value <= 65_535 ? value : DEFAULT_SIDEBAR_PORT;
}

async function startSidebarServer(widgetHtml: string): Promise<{ server: HttpServer | null; port: number }> {
  const requestedPort = sidebarPort();
  const server = createHttpServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `127.0.0.1:${requestedPort}`}`);
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    if (request.method === "GET" && url.pathname === "/") {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob: data:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'self'");
      response.end(widgetHtml);
      return;
    }
    if (request.method === "GET" && url.pathname === "/health") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ ok: true, name: "Remote File Manager" }));
      return;
    }
    if (request.method === "GET" && url.pathname === "/favicon.ico") { response.statusCode = 204; response.end(); return; }
    if ((request.method === "GET" || request.method === "HEAD") && url.pathname.startsWith("/api/media/")) {
      const ticketId = url.pathname.slice("/api/media/".length);
      const ticket = mediaTickets.get(ticketId);
      if (!ticket || ticket.expiresAt < Date.now()) { mediaTickets.delete(ticketId); response.statusCode = 404; response.end("Media preview expired"); return; }
      try {
        const { start, end } = parseMediaRange(request.headers.range, ticket.size);
        response.statusCode = 206;
        response.setHeader("Accept-Ranges", "bytes");
        response.setHeader("Content-Type", ticket.mimeType);
        response.setHeader("Content-Range", `bytes ${start}-${end}/${ticket.size}`);
        response.setHeader("Content-Length", String(end - start + 1));
        if (request.method === "HEAD") { response.end(); return; }
        response.end(await readRemoteMediaRange(ticket, start, end));
      } catch (error) {
        response.statusCode = error instanceof RfmError && error.code === "RANGE_NOT_SATISFIABLE" ? 416 : 400;
        response.setHeader("Content-Range", `bytes */${ticket.size}`);
        response.end(error instanceof Error ? error.message : "Media preview failed");
      }
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/call") {
      const expectedOrigin = `http://127.0.0.1:${(server.address() as { port?: number } | null)?.port ?? requestedPort}`;
      const origin = request.headers.origin;
      if (origin !== expectedOrigin && origin !== expectedOrigin.replace("127.0.0.1", "localhost")) {
        response.statusCode = 403;
        response.end(JSON.stringify({ ok: false, code: "ORIGIN_DENIED", message: "请求来源不受信任。" }));
        return;
      }
      try {
        const body = await readJsonBody(request);
        const data = await executeUiCall(body?.name, body?.arguments ?? {});
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ ok: true, ...data }));
      } catch (error) {
        const result = failed(error).structuredContent;
        response.statusCode = 400;
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(result));
      }
      return;
    }
    response.statusCode = 404;
    response.end("Not found");
  });
  return await new Promise((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") resolve({ server: null, port: requestedPort }); else reject(error);
    });
    server.listen(requestedPort, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, port: typeof address === "object" && address ? address.port : requestedPort });
    });
  });
}

async function createServer(widgetHtml?: string): Promise<McpServer> {
  widgetHtml ??= await readFile(join(PLUGIN_ROOT, "assets", "widget.html"), "utf8");
  const server = new McpServer({ name: "remote-file-manager", version: "0.1.1" });
  registerAppResource(server, "Remote File Manager workspace", WIDGET_URI, { description: "Visual SSH/SFTP file manager" }, async () => ({
    contents: [{
      uri: WIDGET_URI,
      mimeType: RESOURCE_MIME_TYPE,
      text: widgetHtml,
      _meta: {
        ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [] } },
        "openai/widgetDescription": "A visual SSH/SFTP file manager with a directory browser, preview editor, transfer controls, and confirmed mutations.",
      },
    }],
  }));
  registerAppTool(server, "remote_file_manager_open", {
    title: "Open Remote File Manager",
    description: "Open the visual SSH/SFTP file manager in Codex",
    inputSchema: { host: z.string().optional(), root: z.string().optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true, idempotentHint: true },
    _meta: {
      ui: { resourceUri: WIDGET_URI, visibility: ["model", "app"] },
      "openai/outputTemplate": WIDGET_URI,
      "openai/toolInvocation/invoking": "正在打开远程文件管理器",
      "openai/toolInvocation/invoked": "远程文件管理器已就绪",
    },
  }, async ({ host, root }) => {
    try {
      return { ...ok({ hosts: await listSshHosts(), requestedHost: host ?? "", requestedRoot: root ?? "" }, "Opened the visual Remote File Manager."), _meta: { "openai/outputTemplate": WIDGET_URI } };
    } catch (error) { return failed(error); }
  });
  appTool(server, "rfm_list_hosts", "List SSH hosts", "List safe aliases from the local OpenSSH config", {}, async (input) => ok(await executeUiCall("rfm_list_hosts", input)));
  appTool(server, "rfm_connect", "Connect to SSH root", "Connect with OpenSSH keys and restrict the session to one remote root", { host: z.string(), root: z.string() }, async (input) => ok(await executeUiCall("rfm_connect", input)));
  appTool(server, "rfm_list", "List remote directory", "List a directory inside the authorized remote root", { sessionId: z.string(), path: z.string() }, async (input) => ok(await executeUiCall("rfm_list", input)));
  appTool(server, "rfm_read", "Read remote text file chunk", "Read a text-file preview chunk inside the authorized root", { sessionId: z.string(), path: z.string(), offset: z.number().int().nonnegative().optional() }, async (input) => ok(await executeUiCall("rfm_read", input)));
  appTool(server, "rfm_search", "Search remote filenames", "Search filenames below a directory inside the authorized root", { sessionId: z.string(), path: z.string(), query: z.string() }, async (input) => ok(await executeUiCall("rfm_search", input)));
  appTool(server, "rfm_preview_image", "Preview remote image", "Read a supported remote image for visual preview", { sessionId: z.string(), path: z.string() }, async (input) => ok(await executeUiCall("rfm_preview_image", input)));
  appTool(server, "rfm_prepare_media", "Stream remote video", "Create an expiring read-only stream for a supported remote video", { sessionId: z.string(), path: z.string() }, async (input) => ok(await executeUiCall("rfm_prepare_media", input)));
  appTool(server, "rfm_download", "Download remote file", "Read a bounded remote file for download", { sessionId: z.string(), path: z.string() }, async (input) => ok(await executeUiCall("rfm_download", input)));
  const operationSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("mkdir"), path: z.string() }).strict(),
    z.object({ kind: z.literal("write"), path: z.string(), text: z.string(), expectedVersion: z.string().optional() }).strict(),
    z.object({ kind: z.literal("upload"), path: z.string(), dataBase64: z.string(), expectedVersion: z.string().optional() }).strict(),
    z.object({ kind: z.literal("rename"), path: z.string(), destination: z.string() }).strict(),
    z.object({ kind: z.literal("delete"), path: z.string(), recursive: z.boolean() }).strict(),
  ]);
  appTool(server, "rfm_prepare_mutation", "Preview remote change", "Prepare an expiring remote mutation without changing files", { sessionId: z.string(), operation: operationSchema }, async (input) => ok(await executeUiCall("rfm_prepare_mutation", input)));
  appTool(server, "rfm_commit_mutation", "Confirm remote change", "Execute exactly one previously reviewed remote mutation", { proposalId: z.string(), confirmation: z.string().optional() }, async (input) => ok(await executeUiCall("rfm_commit_mutation", input)));
  appTool(server, "rfm_discard_mutation", "Cancel remote change", "Discard one uncommitted remote mutation", { proposalId: z.string() }, async (input) => ok(await executeUiCall("rfm_discard_mutation", input)));
  return server;
}

export const __test = { shellQuote, safeRelativePath, isInsideRoot, mutationSummary, decodeBase64Name, sshControlPath, parseMediaRange, startSidebarServer };

async function main() {
  const widgetHtml = await readFile(join(PLUGIN_ROOT, "assets", "widget.html"), "utf8");
  const sidebar = process.env.RFM_SIDEBAR_DISABLED === "1" ? { server: null, port: sidebarPort() } : await startSidebarServer(widgetHtml);
  if (process.argv.includes("--sidebar")) {
    if (!sidebar.server) return;
    const closeSidebar = () => sidebar.server?.close();
    process.once("SIGTERM", closeSidebar);
    process.once("SIGINT", closeSidebar);
    return;
  }
  const server = await createServer(widgetHtml);
  const close = () => { sidebar.server?.close(); void server.close(); };
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main().catch((error) => {
    process.stderr.write(`Remote File Manager failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
}
