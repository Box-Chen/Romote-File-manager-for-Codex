# Remote File Manager

Remote File Manager is a local-first Codex plugin that renders an interactive SSH/SFTP-style file manager directly in Codex. It discovers aliases from `~/.ssh/config`, uses the system OpenSSH client with key or SSH Agent authentication, and never stores passwords or private keys.

Open the plugin with “Open my remote file manager.” Select or enter an SSH alias, choose an absolute remote root such as `/var/www/example`, and connect. The interface supports directory navigation, filename search, text preview and editing, upload/download, folder creation, rename/move, and deletion.

Directory browsing reuses the SSH transport, resolves and lists each new directory in one remote call, and keeps visited directories in a local session cache for instant backtracking. Text previews load in 1 MiB chunks, so large files open quickly instead of failing at a fixed preview limit. Files up to 8 MiB become editable after fully loading; larger files remain available for chunked preview and download. PNG, JPEG, GIF, WebP, BMP, and AVIF images up to 20 MiB open directly in the visual preview pane. MP4, WebM, MOV, MKV, AVI, and M4V videos use expiring read-only range streams in 2 MiB chunks, allowing playback and seeking without loading the entire remote file into memory.

The same interface is also available as a Codex sidebar browser page at `http://127.0.0.1:17654/`. The installed MCP server starts this loopback-only page automatically when Codex loads the plugin. For a standalone launch, run `node server.mjs --sidebar` from the plugin directory and open that URL in the Codex browser panel.

The selected root is a hard session boundary. Paths containing traversal are rejected, canonical paths are checked on the server, symbolic-link escapes are denied, payload and preview sizes are bounded, and writes use expiring two-step proposals. Recursive deletion additionally requires typing the target name.

The sidebar API binds only to `127.0.0.1`, accepts same-origin browser requests, applies a restrictive content security policy, and never enables cross-origin access.

Key-based, non-interactive SSH must already work for the selected alias. Host-key checking follows the user's normal OpenSSH configuration and is never disabled by the plugin.

## Requirements

- Codex with plugin support
- Node.js 22 or newer
- OpenSSH with a working host alias in `~/.ssh/config`

## Install from the repository marketplace

```sh
codex plugin marketplace add OWNER/remote-file-manager --ref main
codex plugin add remote-file-manager@remote-files
```

Restart Codex or open a new task after installation, then ask it to open the remote file manager. Replace `OWNER` with the GitHub account that publishes this repository.

## Development

```sh
cd plugins/remote-file-manager
npm install
npm test
npm run build
```

The committed `server.mjs` bundle lets Codex run the plugin without installing npm dependencies. Development dependencies are only needed when changing and rebuilding the server.

## Privacy and security

The plugin runs on the user's computer and invokes the user's system `ssh` executable. SSH configuration, agent sockets, private keys, remote file contents, and session state are not sent to a service operated by this project. The optional sidebar server listens only on loopback. See [SECURITY.md](../../SECURITY.md) for reporting and deployment guidance.
