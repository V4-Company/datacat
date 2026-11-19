import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

/** Copies text, falling back to a hidden textarea where the async Clipboard API is unavailable (plain-HTTP self-hosted installs). */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.className = "fixed -left-[9999px] top-0 opacity-0";
  document.body.appendChild(ta);
  ta.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(ta);
  }
}

/** Icon button that copies `text` and announces the result to screen readers. */
export function CopyButton({ text, label = "Copy", className = "text-ink-3 hover:text-ink" }: { text: string; label?: string; className?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const onCopy = async () => {
    setState((await copyText(text)) ? "copied" : "failed");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 1800);
  };
  return (
    <>
      <button type="button" onClick={onCopy} className={`inline-flex items-center gap-1 ${className}`} aria-label={label} title={label}>
        {state === "copied" ? <Check size={14} /> : <Copy size={14} />}
        {state === "failed" && <span className="text-[11px]">Select and copy manually</span>}
      </button>
      <span className="sr-only" aria-live="polite">
        {state === "copied" ? "Copied to clipboard" : state === "failed" ? "Copy failed. Select the text and copy it manually." : ""}
      </span>
    </>
  );
}

/** Dark code block with a copy button, matching the agent install page. */
export function CodeBlock({ code, label = "Copy code" }: { code: string; label?: string }) {
  return (
    <div className="relative">
      <pre className="mono text-xs bg-[#23222c] text-white rounded p-4 pr-10 overflow-auto whitespace-pre">{code}</pre>
      <CopyButton text={code} label={label} className="absolute top-2 right-2 text-white/60 hover:text-white" />
    </div>
  );
}
