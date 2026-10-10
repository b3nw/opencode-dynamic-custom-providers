# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- OpenCode V2 support ships as a separate package, `opencode-dynamic-custom-providers-v2`, in `packages/v2` (see its README and CHANGELOG). This package remains the OpenCode V1 plugin.

### Security
- Model discovery now keeps the `/models` request on the base URL's origin. Before, a base URL path starting with `//` (for example `https://host//other.host/v1`) sent the request and API key to `other.host`.

## [2.2.0] - 2026-05-23

### Added
- `add-provider` server tool for web/desktop provider setup (no TUI required)
- `refresh-models` server tool now performs full live re-discovery and config update (previously only cleared cache)

### Changed
- Extracted shared command logic into `src/commands.ts` to deduplicate between TUI commands and server tools
- Refactored TUI `/add-provider` and `/reload-models` to use shared logic

## [2.0.0] - 2026-05-21

### Added
- Automatic model discovery from any provider with a `baseURL` at startup
- [models.dev](https://models.dev) metadata enrichment (context windows, costs, capabilities, modalities)
- `/add-provider` TUI slash command for interactive provider setup
- `/reload-models` TUI slash command for in-session model re-discovery
- `refresh-models` server tool to clear the models.dev metadata cache
- `displayStyle` option to control model display names (`slug` vs `name`)
- Security: URL validation, model ID sanitization, error message redaction
- Stale cache fallback when models.dev is unreachable
- Environment variable support for API keys (`OPENCODE_LOCAL_<ID>_API_KEY`)
