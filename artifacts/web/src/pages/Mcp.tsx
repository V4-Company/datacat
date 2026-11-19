import { useId, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { Bot, KeyRound, Plus, Trash2, TriangleAlert } from "lucide-react";
import { PageHeader } from "@/components/Layout";
import { CodeBlock, CopyButton } from "@/components/CopyButton";
import { fmtAgo } from "@/lib/format";
import {
  MCP_TOKEN_NAME_MAX,
  TOKEN_PLACEHOLDER,
  defaultTokenName,
  mcpSnippets,
  useCreateMcpToken,
  useMcpInfo,
  useMcpTokens,
  useRevokeMcpToken,
  type CreatedMcpToken,
} from "@/lib/mcp";

const errMsg = (e: unknown) => (e instanceof Error && e.message ? e.message : "Something went wrong. Try again.");

const EXAMPLE_PROMPTS = [
  "Which services had the most errors in the last hour?",
  "Show the trace for the slowest request of <service> in the last 15 minutes.",
  "Compare the request rate of <service> today vs. yesterday.",
  "Which monitors are alerting right now, and what do their logs say?",
];

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="space-y-2">
      <h2 id={id} className="section-title">
        {title}
      </h2>
      {children}
    </section>
  );
}

function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="card bg-red-50 border-alert/30 text-alert p-2 text-xs">
      {children}
    </div>
  );
}

/** The token is kept only in this page's state: it is never written to storage and is gone once the user leaves. */
export function McpSetup() {
  const info = useMcpInfo();
  const [created, setCreated] = useState<CreatedMcpToken | null>(null);
  const endpoint = info.data?.endpoint ?? `${location.origin}/api/mcp`;
  const server = info.data?.server_name ?? "datacat";
  return (
    <div>
      <PageHeader title="Connect an AI assistant (MCP)" icon={Bot} />
      <div className="p-6 max-w-4xl space-y-7">
        <div className="space-y-3">
          <p className="text-ink-2">
            The DataCat MCP server lets an AI assistant such as Claude Code, Claude Desktop or Cursor answer questions about this organization's services,
            traces, metrics, logs, monitors and dashboards. It is read-only: the assistant can look things up but never changes anything. It signs in with a
            personal token tied to your account, so it sees what you see, and the token is revoked automatically if you leave the organization.
          </p>
          <div className="card bg-panel p-3">
            <div className="label mb-1">MCP endpoint</div>
            <div className="flex items-center gap-2">
              <span className="mono text-xs break-all" data-testid="mcp-endpoint">
                {endpoint}
              </span>
              <CopyButton text={endpoint} label="Copy endpoint URL" />
            </div>
            <p className="text-xs text-ink-3 mt-1">The machine running the assistant must be able to reach this URL.</p>
          </div>
          {info.isError && <ErrorNote>Couldn't load the MCP server details: {errMsg(info.error)}</ErrorNote>}
        </div>
        <CreateToken created={created} onCreated={setCreated} />
        <InstallSnippets endpoint={endpoint} server={server} token={created?.token ?? TOKEN_PLACEHOLDER} />
        <Section title="Things to ask">
          <ul className="card divide-y divide-line">
            {EXAMPLE_PROMPTS.map((p) => (
              <li key={p} className="flex items-center gap-3 px-4 py-2">
                <span className="flex-1">{p}</span>
                <CopyButton text={p} label={`Copy prompt: ${p}`} />
              </li>
            ))}
          </ul>
        </Section>
        <Section title="Available tools">
          {info.isLoading ? (
            <p className="text-ink-3 text-xs">Loading tools…</p>
          ) : info.isError ? (
            <p className="text-ink-3 text-xs">Tools are unavailable until the server details load.</p>
          ) : (
            <ul className="card divide-y divide-line" data-testid="mcp-tools">
              {(info.data?.tools ?? []).map((t) => (
                <li key={t.name} className="px-4 py-2">
                  <div className="mono text-xs font-semibold">{t.name}</div>
                  <div className="text-xs text-ink-2 mt-0.5">{t.description}</div>
                </li>
              ))}
              {info.data?.tools.length === 0 && <li className="px-4 py-3 text-ink-3 text-xs">No tools are available.</li>}
            </ul>
          )}
        </Section>
        <TokenList onRevoked={(id) => created?.id === id && setCreated(null)} />
      </div>
    </div>
  );
}

function CreateToken({ created, onCreated }: { created: CreatedMcpToken | null; onCreated: (t: CreatedMcpToken) => void }) {
  const [name, setName] = useState(defaultTokenName);
  const create = useCreateMcpToken();
  const inputId = useId();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate(name.trim(), { onSuccess: (t) => onCreated(t) });
  };
  return (
    <Section title="1. Create a token">
      <p className="text-xs text-ink-2">Create one token per assistant or machine, so you can revoke it on its own later.</p>
      <form className="flex flex-wrap items-end gap-2" onSubmit={submit}>
        <div>
          <label htmlFor={inputId} className="label block mb-1">
            Token name
          </label>
          <input
            id={inputId}
            className="input w-72"
            value={name}
            maxLength={MCP_TOKEN_NAME_MAX}
            onChange={(e) => setName(e.target.value)}
            placeholder="Claude Code"
            data-testid="mcp-token-name"
          />
        </div>
        <button className="btn-primary" disabled={create.isPending} data-testid="mcp-create-token">
          <Plus size={14} /> {create.isPending ? "Creating…" : "Create token"}
        </button>
      </form>
      {create.isError && <ErrorNote>{errMsg(create.error)}</ErrorNote>}
      {created && (
        <div className="card border-warn/60 bg-[#fff8e6] p-3 space-y-2" role="status" data-testid="mcp-new-token">
          <div className="flex items-center gap-2 font-semibold">
            <TriangleAlert size={15} className="text-warn" aria-hidden="true" />
            Copy this token now. It won't be shown again.
          </div>
          <div className="flex items-center gap-2 bg-white border border-line rounded-[3px] px-2.5 py-1.5">
            <KeyRound size={14} className="text-ink-3 shrink-0" aria-hidden="true" />
            <span className="mono text-xs break-all flex-1">{created.token}</span>
            <CopyButton text={created.token} label="Copy token" />
          </div>
          <p className="text-xs text-ink-2">
            "{created.name}" is filled into the commands below. If you lose it, revoke it and create a new one.
          </p>
        </div>
      )}
    </Section>
  );
}

const SNIPPET_TABS = [
  ["claude", "Claude Code (CLI)"],
  ["json", "JSON config"],
  ["curl", "Test with curl"],
] as const;
type SnippetTab = (typeof SNIPPET_TABS)[number][0];

function InstallSnippets({ endpoint, server, token }: { endpoint: string; server: string; token: string }) {
  const [tab, setTab] = useState<SnippetTab>("claude");
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const baseId = useId();
  const s = mcpSnippets(endpoint, server, token);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = SNIPPET_TABS.findIndex(([k]) => k === tab);
    const next = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? SNIPPET_TABS.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    const j = (next + SNIPPET_TABS.length) % SNIPPET_TABS.length;
    setTab(SNIPPET_TABS[j][0]);
    tabRefs.current[j]?.focus();
  };
  return (
    <Section title="2. Add DataCat to your assistant">
      {token === TOKEN_PLACEHOLDER && (
        <p className="text-xs text-ink-2">
          Create a token first, or replace <span className="mono">{TOKEN_PLACEHOLDER}</span> with one you already have.
        </p>
      )}
      <div role="tablist" aria-label="Install method" className="flex gap-1" onKeyDown={onKeyDown}>
        {SNIPPET_TABS.map(([k, l], i) => (
          <button
            key={k}
            ref={(el) => {
              tabRefs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`${baseId}-tab-${k}`}
            aria-selected={tab === k}
            aria-controls={`${baseId}-panel-${k}`}
            tabIndex={tab === k ? 0 : -1}
            onClick={() => setTab(k)}
            className={`px-3 h-8 rounded text-[13px] ${tab === k ? "bg-primary text-white" : "bg-panel hover:bg-[#eef2fc]"}`}
          >
            {l}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${baseId}-panel-${tab}`} aria-labelledby={`${baseId}-tab-${tab}`} className="space-y-2">
        {tab === "claude" && (
          <>
            <CodeBlock code={s.claude} label="Copy Claude Code command" />
            <p className="text-xs text-ink-2">
              This adds DataCat to the current project only. To use it in every project, add <span className="mono">--scope user</span>:
            </p>
            <CodeBlock code={s.claudeUser} label="Copy Claude Code command for all projects" />
            <p className="text-xs text-ink-2">
              Then start a new Claude Code session and run <span className="mono">/mcp</span> to check that <span className="mono">{server}</span> is connected.
            </p>
          </>
        )}
        {tab === "json" && (
          <>
            <CodeBlock code={s.json} label="Copy JSON config" />
            <p className="text-xs text-ink-2">
              For Claude Desktop, Cursor and other clients that support remote HTTP MCP servers. Merge it into the client's MCP config: for example{" "}
              <span className="mono">.mcp.json</span> at the root of a project (Claude Code, project scope) or <span className="mono">~/.cursor/mcp.json</span>{" "}
              (Cursor). Keep files that contain your token out of version control.
            </p>
          </>
        )}
        {tab === "curl" && (
          <>
            <CodeBlock code={s.curl} label="Copy curl command" />
            <p className="text-xs text-ink-2">
              Run this from the assistant's machine to check that it can reach DataCat and that the token works. It should return the list of tools.
            </p>
          </>
        )}
      </div>
    </Section>
  );
}

function TokenList({ onRevoked }: { onRevoked: (id: number) => void }) {
  const tokens = useMcpTokens();
  const revoke = useRevokeMcpToken();
  const list = tokens.data?.tokens ?? [];
  return (
    <Section title="Your tokens">
      {revoke.isError && <ErrorNote>Couldn't revoke the token: {errMsg(revoke.error)}</ErrorNote>}
      {tokens.isError ? (
        <ErrorNote>Couldn't load your tokens: {errMsg(tokens.error)}</ErrorNote>
      ) : tokens.isLoading ? (
        <p className="text-ink-3 text-xs">Loading tokens…</p>
      ) : list.length === 0 ? (
        <div className="card px-4 py-4 text-ink-3 text-xs" data-testid="mcp-tokens-empty">
          You have no MCP tokens yet. Create one above to connect an assistant.
        </div>
      ) : (
        <table className="tbl card" data-testid="mcp-tokens">
          <thead>
            <tr>
              <th>Name</th>
              <th>Created</th>
              <th>Last used</th>
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {list.map((t) => (
              <tr key={t.id}>
                <td>{t.name}</td>
                <td className="text-ink-2" title={new Date(t.created_at).toLocaleString()}>
                  {fmtAgo(new Date(t.created_at).getTime())}
                </td>
                <td className="text-ink-2">{t.last_used_at ? fmtAgo(new Date(t.last_used_at).getTime()) : "never"}</td>
                <td className="text-right">
                  <button
                    type="button"
                    className="text-ink-3 hover:text-alert disabled:opacity-50"
                    aria-label={`Revoke token ${t.name}`}
                    title="Revoke"
                    disabled={revoke.isPending && revoke.variables === t.id}
                    onClick={() =>
                      confirm(`Revoke "${t.name}"? Assistants using it will lose access to DataCat.`) && revoke.mutate(t.id, { onSuccess: () => onRevoked(t.id) })
                    }
                  >
                    <Trash2 size={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}
