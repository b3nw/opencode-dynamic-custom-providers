# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
