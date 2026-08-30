# Security policy

Remote File Manager has access to files reachable through the user's existing OpenSSH configuration. Treat every release as security-sensitive software.

## Reporting a vulnerability

Please do not publish exploitable details in a public issue. Use GitHub's private vulnerability reporting feature for this repository. Include affected versions, reproduction steps, and the expected security boundary.

## Security boundaries

The plugin never asks for or stores SSH passwords or private keys. It delegates authentication and host-key verification to the user's system OpenSSH client. The sidebar HTTP server binds only to `127.0.0.1`, and remote operations are restricted to the canonical root selected for the session. Mutating operations use a two-step proposal and confirmation flow; recursive deletion additionally requires typing the target directory name.

Users should review SSH aliases before connecting, keep OpenSSH and Node.js patched, and install releases only from a repository they trust.
