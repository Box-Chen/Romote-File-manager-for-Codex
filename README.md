# Remote File Manager for Codex

Remote File Manager is a local-first Codex plugin for browsing and managing files over SSH with a familiar visual interface. It uses the user's existing OpenSSH configuration and SSH Agent, keeps credentials on the user's computer, and requires confirmation before remote writes or deletion.

The interface supports fast directory navigation, file-type icons, text preview and editing, chunked previews for large files, image preview, video range streaming, search, upload, download, rename, move, and deletion.

## Install

```sh
codex plugin marketplace add Box-Chen/Romote-File-manager-for-Codex --ref main
codex plugin add remote-file-manager@remote-files
```

Node.js 22 or newer and a working OpenSSH host alias are required. Restart Codex or open a new task after installation, then ask Codex to open the remote file manager.

See the [plugin documentation](plugins/remote-file-manager/README.md) for usage, development, privacy, and security details.

This repository does not include SSH configuration, private keys, passwords, host addresses, or user-specific paths.

## License

Released under the [MIT License](LICENSE).
