import { Check, Pencil, X } from "lucide-react";
import { useState } from "react";
import { useConfig, type ConfigObject } from "../hooks/useConfig.js";
import { type ProviderCatalogEntry, useProvidersCatalog } from "../hooks/useProvidersCatalog.js";
import { useUpdateConfig } from "../hooks/useUpdateConfig.js";
import { ApiKeyField } from "./ApiKeyField.js";
import { Button } from "./Button.js";
import { Card } from "./Card.js";
import { ConfigStatusPill } from "./ConfigStatusPill.js";
import { Input } from "./Input.js";

type EmbedderProvider = "lexical" | "voyage" | "openai" | "ollama" | "openai-compat";

interface EmbedderDraft {
  provider: EmbedderProvider;
  model: string;
  baseURL?: string;
  dim?: string;
  apiKey?: string;
}

export function EmbedderConfigCard({ disabledReason = null }: { disabledReason?: string | null }) {
  const config = useConfig();
  const providers = useProvidersCatalog();
  const mutation = useUpdateConfig();
  const active = readActiveEmbedder(config.data);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<EmbedderDraft>(active);
  const [message, setMessage] = useState<string | null>(null);
  const providerEntries = providers.data?.embedders ?? [];
  const selectedProvider = providerEntries.find((entry) => entry.provider === draft.provider);
  const activeProviderEntry = providerEntries.find((entry) => entry.provider === active.provider);

  const selectedModels = selectedProvider?.models ?? [];
  const activeDim = activeProviderEntry?.models.find((model) => model.id === active.model)?.dim;

  function startEditing() {
    if (disabledReason) return;
    setDraft(active);
    setMessage(null);
    setEditing(true);
  }

  function changeProvider(provider: string) {
    if (!isEmbedderProvider(provider)) return;
    const entry = providerEntries.find((item) => item.provider === provider);
    const next: EmbedderDraft = {
      provider,
      model: defaultModel(entry) ?? (provider === "lexical" ? "lexical" : provider === "ollama" || provider === "openai-compat" ? "nomic-embed-text" : ""),
    };
    if (provider === "openai-compat") {
      next.baseURL = "";
      next.dim = "768";
      next.apiKey = "";
    }
    setDraft(next);
  }

  function save() {
    const providerChanged = draft.provider !== active.provider;
    const patch: Record<string, unknown> = { provider: draft.provider, model: draft.model };
    if (draft.provider === "openai-compat") {
      const options: Record<string, unknown> = {};
      if (draft.baseURL?.trim()) options["baseURL"] = draft.baseURL.trim();
      const dimNum = Number(draft.dim);
      if (Number.isInteger(dimNum) && dimNum > 0) options["dim"] = dimNum;
      if (draft.apiKey?.trim()) options["apiKey"] = draft.apiKey.trim();
      patch["options"] = options;
      patch["allow_internal_hosts"] = true;
    }
    mutation.mutate(
      { embedder: patch },
      {
        onSuccess: () => {
          setEditing(false);
          setMessage(providerChanged
            ? "Config saved. Dashboard will pick up changes on next request. Note: switching embedder provider requires memory provider reindex-embeddings --apply to migrate existing vectors."
            : "Config saved. Dashboard will pick up changes on next request.");
        },
      },
    );
  }

  return (
    <Card hasBrackets className="border-border-emphasis">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Embedder</h2>
          <p className="text-xs text-text-muted">Vector provider for search embeddings.</p>
        </div>
        {!editing && (
          <Button
            type="button"
            onClick={startEditing}
            disabled={disabledReason !== null}
            title={disabledReason ?? undefined}
            aria-label="Edit embedder"
            className="disabled:cursor-not-allowed disabled:opacity-45"
          >
            <Pencil size={15} strokeWidth={1.5} />
            Edit
          </Button>
        )}
      </div>

      {editing ? (
        <div className="space-y-3">
          <label className="block text-sm">
            <span className="mb-1 block text-xs uppercase tracking-wide text-text-muted">Provider</span>
            <select
              aria-label="Embedder provider"
              className="min-h-11 w-full rounded-md border border-border-subtle bg-surface px-3 py-1.5 text-sm md:min-h-8"
              value={draft.provider}
              onChange={(event) => changeProvider(event.target.value)}
            >
              {providerEntries.map((entry) => (
                <option key={entry.provider} value={entry.provider}>{entry.provider}</option>
              ))}
            </select>
          </label>

          <ModelControl
            label="Embedder model"
            provider={draft.provider}
            value={draft.model}
            placeholder="nomic-embed-text"
            providers={selectedModels}
            onChange={(model) => setDraft((current) => ({ ...current, model }))}
          />

          <KeyStatus provider={selectedProvider} loading={providers.isLoading} />

          {draft.provider === "voyage" ? (
            <ApiKeyField provider="voyage" envVar="VOYAGE_API_KEY" label="Voyage API key" />
          ) : null}
          {draft.provider === "openai" ? (
            <ApiKeyField provider="openai" envVar="OPENAI_API_KEY" label="OpenAI API key" />
          ) : null}

          {draft.provider === "openai-compat" && (
            <>
              <label className="block text-sm">
                <span className="mb-1 block text-xs uppercase tracking-wide text-text-muted">Base URL</span>
                <Input
                  aria-label="OpenAI-compat base URL"
                  value={draft.baseURL ?? ""}
                  placeholder="http://localhost:11434/v1"
                  onChange={(event) => setDraft((current) => ({ ...current, baseURL: event.target.value }))}
                  className="w-full"
                />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block text-xs uppercase tracking-wide text-text-muted">Dimension</span>
                <Input
                  aria-label="Embedding dimension"
                  type="number"
                  value={draft.dim ?? ""}
                  placeholder="768"
                  onChange={(event) => setDraft((current) => ({ ...current, dim: event.target.value }))}
                  className="w-full"
                />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block text-xs uppercase tracking-wide text-text-muted">API Key (optional)</span>
                <Input
                  aria-label="OpenAI-compat API key"
                  value={draft.apiKey ?? ""}
                  placeholder="Leave blank if not required"
                  onChange={(event) => setDraft((current) => ({ ...current, apiKey: event.target.value }))}
                  className="w-full"
                />
              </label>
            </>
          )}

          {draft.provider !== active.provider && (
            <p className="rounded-md border border-status-amber/30 bg-status-amber/10 p-2 text-xs text-status-amber" role="alert">
              Switching from <strong>{active.provider}</strong> to <strong>{draft.provider}</strong> requires re-indexing existing vectors after saving. Run{" "}
              <code className="font-mono">memory provider reindex-embeddings --apply</code>.
            </p>
          )}

          <div className="flex flex-wrap justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
              <X size={15} strokeWidth={1.5} />
              Cancel
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={save}
              disabled={mutation.isPending || draft.model.trim().length === 0 || disabledReason !== null}
              title={disabledReason ?? undefined}
              aria-label="Save embedder changes"
            >
              <Check size={15} strokeWidth={1.5} />
              Save Changes
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-2 text-sm">
          <p className="sr-only">Provider: {active.provider}</p>
          <p className="sr-only">Model: {active.model}{activeDim ? ` (${activeDim}-dim)` : ""}</p>
          <label className="block text-sm">
            <span className="mb-1 block text-xs uppercase tracking-wide text-text-muted">Provider</span>
            <select
              aria-label="Embedder provider"
              disabled
              className="min-h-11 w-full rounded-md border border-border-subtle bg-surface px-3 py-1.5 text-sm opacity-80 md:min-h-8"
              value={active.provider}
            >
              {providerEntries.some((entry) => entry.provider === active.provider) ? null : (
                <option value={active.provider}>{active.provider}</option>
              )}
              {providerEntries.map((entry) => (
                <option key={entry.provider} value={entry.provider}>{entry.provider}</option>
              ))}
            </select>
          </label>
          <ReadonlyModelControl
            provider={active.provider}
            value={active.model}
            displayValue={activeDim ? `${active.model} (${activeDim}-dim)` : active.model}
            providers={activeProviderEntry?.models ?? []}
          />
          <KeyStatus provider={activeProviderEntry} loading={providers.isLoading} />
          {active.provider === "voyage" ? (
            <ApiKeyField provider="voyage" envVar="VOYAGE_API_KEY" label="Voyage API key" />
          ) : null}
          {active.provider === "openai" ? (
            <ApiKeyField provider="openai" envVar="OPENAI_API_KEY" label="OpenAI API key" />
          ) : null}
          {message && <p className="rounded-md border border-status-green/30 bg-status-green/10 p-2 text-xs text-status-green">{message}</p>}
        </div>
      )}

      {mutation.error && (
        <p className="mt-3 rounded-md border border-status-red/30 bg-status-red/10 p-2 text-xs text-status-red">
          {mutation.error instanceof Error ? mutation.error.message : "Failed to save config."}
        </p>
      )}
    </Card>
  );
}

function ReadonlyModelControl(props: {
  provider: string;
  value: string;
  displayValue: string;
  providers: Array<{ id: string; dim?: number }>;
}) {
  if (props.provider === "lexical" || props.provider === "ollama" || props.provider === "openai-compat") {
    return (
      <label className="block text-sm">
        <span className="mb-1 block text-xs uppercase tracking-wide text-text-muted">Model</span>
        <Input aria-label="Embedder model" disabled value={props.value} className="w-full opacity-80" />
      </label>
    );
  }
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-xs uppercase tracking-wide text-text-muted">Model</span>
      <select
        aria-label="Embedder model"
        disabled
        className="min-h-11 w-full rounded-md border border-border-subtle bg-surface px-3 py-1.5 text-sm opacity-80 md:min-h-8"
        value={props.value}
      >
        {props.providers.some((model) => model.id === props.value) ? null : (
          <option value={props.value}>{props.displayValue}</option>
        )}
        {props.providers.map((model) => (
          <option key={model.id} value={model.id}>
            {model.id}{model.dim ? ` (${model.dim}-dim)` : ""}
          </option>
        ))}
      </select>
    </label>
  );
}

function ModelControl(props: {
  label: string;
  provider: string;
  value: string;
  placeholder: string;
  providers: Array<{ id: string; dim?: number }>;
  onChange: (model: string) => void;
}) {
  if (props.provider === "lexical" || props.provider === "ollama" || props.provider === "openai-compat") {
    return (
      <label className="block text-sm">
        <span className="mb-1 block text-xs uppercase tracking-wide text-text-muted">Model</span>
        <Input
          aria-label={props.label}
          value={props.value}
          placeholder={props.placeholder}
          onChange={(event) => props.onChange(event.target.value)}
          className="w-full"
        />
      </label>
    );
  }
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-xs uppercase tracking-wide text-text-muted">Model</span>
      <select
        aria-label={props.label}
        className="min-h-11 w-full rounded-md border border-border-subtle bg-surface px-3 py-1.5 text-sm md:min-h-8"
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      >
        {props.providers.map((model) => (
          <option key={model.id} value={model.id}>
            {model.id}{model.dim ? ` (${model.dim}-dim)` : ""}
          </option>
        ))}
      </select>
    </label>
  );
}

function KeyStatus({ provider, loading }: { provider?: ProviderCatalogEntry; loading?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-text-muted">Key:</span>
      <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs">{provider?.envVar ?? "provider env"}</code>
      <ConfigStatusPill status={loading || !provider ? "checking" : provider.envVarStatus} />
    </div>
  );
}

function readActiveEmbedder(config: ConfigObject | undefined): EmbedderDraft {
  const embedder = asRecord(config?.embedder) ?? asRecord(config?.embedding);
  return {
    provider: readEmbedderProvider(embedder?.provider) ?? "lexical",
    model: readString(embedder?.model) ?? "lexical",
  };
}

function defaultModel(provider: ProviderCatalogEntry | undefined): string | undefined {
  return provider?.models.find((model) => model.default)?.id ?? provider?.models[0]?.id;
}

function readEmbedderProvider(value: unknown): EmbedderProvider | null {
  return isEmbedderProvider(value) ? value : null;
}

function isEmbedderProvider(value: unknown): value is EmbedderProvider {
  return value === "lexical" || value === "voyage" || value === "openai" || value === "ollama" || value === "openai-compat";
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
