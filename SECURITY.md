# Security Policy

## Supported versions

Only the latest published version of `opencode-token-norm` receives security fixes.

## Reporting a vulnerability

Please do not report security vulnerabilities through public GitHub issues.

Use GitHub's private vulnerability reporting: open the repository's **Security** tab and click **Report a vulnerability**, or go directly to:

https://github.com/salitaba/token-norm/security/advisories/new

Include as much of the following as you can:

- affected version(s)
- a description of the issue and its impact
- reproduction steps or a proof of concept
- any suggested fix

You can expect an acknowledgement within a few days. Fixes are released as soon as practical, and reporters are credited unless they prefer otherwise.

## Scope

This project is an OpenCode plugin that runs locally and invokes the bundled audit script (`scripts/usage-audit.py`). In scope:

- command or code injection in the plugin or audit script
- unsafe file handling or path traversal
- supply-chain concerns about the published npm package

Issues in the OpenCode host itself should be reported to the OpenCode project.
