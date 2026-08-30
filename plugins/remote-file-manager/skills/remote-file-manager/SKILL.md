---
name: remote-file-manager
description: Open and use the visual SSH/SFTP file manager inside Codex. Use when the user wants to browse, search, preview, download, upload, edit, move, rename, create, or delete files on a server configured through OpenSSH.
---

# Remote File Manager

Open the visual workspace by calling `remote_file_manager_open`. Do not ask the user for a private key or password. The plugin uses hosts from the user's OpenSSH configuration and authenticates with existing keys or SSH Agent credentials.

The user chooses a server alias and a remote root in the visual workspace. Treat that root as the complete authorization boundary for the session. Use the visual workspace for navigation and file operations. Every remote mutation is previewed by the plugin and must be confirmed in the workspace before execution; never bypass this confirmation flow with shell commands.

If connection fails, explain the concise error shown by the plugin and suggest verifying that the alias works with key-based SSH authentication. Do not weaken host-key checking or request plaintext credentials.
