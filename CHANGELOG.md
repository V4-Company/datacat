# Changelog

## 0.1.0 (unreleased)

First public release.

- Optional single sign-on with Google or another OpenID Connect provider (`DATACAT_OIDC_*`): "Continue with Google"
  on the login page, restricted to the email domains in `DATACAT_OIDC_ALLOWED_DOMAINS`; new users are created in the
  organization with a default role. Password login, invites and API keys are unchanged.
- Read-only MCP server at `/api/mcp` (Streamable HTTP, stateless JSON) for AI assistants such as Claude Code: tools
  for APM services, spans and traces, metrics, logs, monitors and dashboards. API key + application key only; cookie
  sessions and foreign origins are refused, and outputs are capped. See "MCP server for AI assistants" in
  docs/SELF_HOSTING.md.

- Server and web UI: metrics explorer, dashboards, logs with live tail, APM with trace waterfalls, infrastructure,
  monitors with webhook and Slack notifications, organizations, local accounts and invite links.
- Telemetry storage in PostgreSQL (default) or ClickHouse.
- Intake: OpenTelemetry (OTLP/HTTP), the Datadog Agent (tested with 7.56.2 and 7.85.4) and Datadog's open-source
  tracers.
- DataCat Agent (an OpenTelemetry Collector distribution) and the `@datacat/trace` (Node.js) and `datacat-trace`
  (Python) libraries.
