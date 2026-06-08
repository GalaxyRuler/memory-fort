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

type LLMProvider = "openrouter" | "ollama";

interface LLMDraft {
  provider: LLMProvider;
  model: string;
  max_tokens: number;
  temperature: number;
}

export function LLMConfigCard({ disabledReason = null }: { disabledReason?: string | null }) {
  const config = useConfig();
  const providers = useProvidersCatalog();
  const mutation = useUpdateConfig();
  const active = readActiveLLM(config.data);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<LLMDraft>(active);
  const [message, setMessage] = useState<string | null>(null);
  const providerEntries = providers.data?.llms ?? [];
  const selectedProvider = providerEntries.find((entry) => entry.provider === draft.provider);
  const activeProviderEntry = providerEntries.find((entry) => entry.provider === active.provider);

  function startEditing() {
    if (disabledReason) return;
    setDraft(active);
    setMessage(null);
    setEditing(true);
  }

  function changeProvider(provider: string) {
    if (!isLLMProvider(provider)) return;
    const entry = providerEntries.find((item) => item.provider === provider);
    setDraft((current) => ({
      ...current,
      provider,
      model: defaultModel(entry) ?? (provider === "ollama" ? "llama3.2" : ""),
    }));
  }

  function save() {
    mutation.mutate(
      {
        llm: {
          provider: draft.provider,
          model: draft.model,
          max_tokens: draft.max_tokens,
          temperature: draft.temperature,
        },
      },
      {
        onSuccess: () => {
          setEditing(false);
          setMessage("Config saved. Dashboard will pick up changes on next request.");
        },
      },
    );
  }

  return (
    <Card hasBrackets className="border-border-emphasis">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">LLM</h2>
          <p className="text-xs text-text-muted">Chat model provider for audited LLM consumers.</p>
        </div>
        {!editing && (
          <Button
            type="button"
            onClick={startEditing}
            disabled={disabledReason !== null}
            title={disabledReason ?? undefined}
            aria-label="Edit LLM"
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
              aria-label="LLM provider"
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
            provider={draft.provider}
            value={draft.model}
            providers={selectedProvider?.models ?? []}
            onChange={(model) => setDraft((current) => ({ ...current, model }))}
          />

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="mb-1 block text-xs uppercase tracking-wide text-text-muted">Max tokens</span>
              <Input
                aria-label="LLM max tokens"
                type="number"
                min={1}
                max={32000}
                value={draft.max_tokens}
                onChange={(event) => setDraft((current) => ({ ...current, max_tokens: Number(event.target.value) }))}
                className="w-full"
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-xs uppercase tracking-wide text-text-muted">Temperature</span>
              <Input
                aria-label="LLM temperature"
                type="number"
                min={0}
                max={2}
                step={0.1}
                value={draft.temperature}
                onChange={(event) => setDraft((current) => ({ ...current, temperature: Number(event.target.value) }))}
                className="w-full"
              />
            </label>
          </div>

          <KeyStatus provider={selectedProvider} loading={providers.isLoading} />

          {draft.provider === "openrouter" ? (
            <ApiKeyField provider="openrouter" envVar="OPENROUTER_API_KEY" label="OpenRouter API key" />
          ) : null}

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
              aria-label="Save LLM changes"
            >
              <Check size={15} strokeWidth={1.5} />
              Save Changes
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-2 text-sm">
          <p className="sr-only">Provider: {active.provider}</p>
          <p className="sr-only">Model: {active.model}</p>
          <p className="sr-only">Max tokens: {active.max_tokens}</p>
          <p className="sr-only">Temperature: {active.temperature}</p>
          <label className="block text-sm">
            <span className="mb-1 block text-xs uppercase tracking-wide text-text-muted">Provider</span>
            <select
              aria-label="LLM provider"
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
            providers={activeProviderEntry?.models ?? []}
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="mb-1 block text-xs uppercase tracking-wide text-text-muted">Max tokens</span>
              <Input aria-label="LLM max tokens" disabled type="number" value={active.max_tokens} className="w-full opacity-80" />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-xs uppercase tracking-wide text-text-muted">Temperature</span>
              <Input aria-label="LLM temperature" disabled type="number" value={active.temperature} className="w-full opacity-80" />
            </label>
          </div>
          <KeyStatus provider={activeProviderEntry} loading={providers.isLoading} />
          {active.provider === "openrouter" ? (
            <ApiKeyField provider="openrouter" envVar="OPENROUTER_API_KEY" label="OpenRouter API key" />
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
  providers: Array<{ id: string }>;
}) {
  if (props.provider === "ollama") {
    return (
      <label className="block text-sm">
        <span className="mb-1 block text-xs uppercase tracking-wide text-text-muted">Model</span>
        <Input aria-label="LLM model" disabled value={props.value} className="w-full opacity-80" />
      </label>
    );
  }
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-xs uppercase tracking-wide text-text-muted">Model</span>
      <select
        aria-label="LLM model"
        disabled
        className="min-h-11 w-full rounded-md border border-border-subtle bg-surface px-3 py-1.5 text-sm opacity-80 md:min-h-8"
        value={props.value}
      >
        {props.providers.some((model) => model.id === props.value) ? null : (
          <option value={props.value}>{props.value}</option>
        )}
        {props.providers.map((model) => (
          <option key={model.id} value={model.id}>{model.id}</option>
        ))}
      </select>
    </label>
  );
}

function ModelControl(props: {
  provider: string;
  value: string;
  providers: Array<{ id: string }>;
  onChange: (model: string) => void;
}) {
  if (props.provider === "ollama") {
    return (
      <label className="block text-sm">
        <span className="mb-1 block text-xs uppercase tracking-wide text-text-muted">Model</span>
        <Input
          aria-label="LLM model"
          value={props.value}
          placeholder="llama3.2"
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
        aria-label="LLM model"
        className="min-h-11 w-full rounded-md border border-border-subtle bg-surface px-3 py-1.5 text-sm md:min-h-8"
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      >
        {props.providers.map((model) => (
          <option key={model.id} value={model.id}>{model.id}</option>
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

function readActiveLLM(config: ConfigObject | undefined): LLMDraft {
  const llm = asRecord(config?.llm);
  return {
    provider: readLLMProvider(llm?.provider) ?? "openrouter",
    model: readString(llm?.model) ?? "openai/gpt-4o-mini",
    max_tokens: readNumber(llm?.max_tokens) ?? 4096,
    temperature: readNumber(llm?.temperature) ?? 0.2,
  };
}

function defaultModel(provider: ProviderCatalogEntry | undefined): string | undefined {
  return provider?.models.find((model) => model.default)?.id ?? provider?.models[0]?.id;
}

function readLLMProvider(value: unknown): LLMProvider | null {
  return isLLMProvider(value) ? value : null;
}

function isLLMProvider(value: unknown): value is LLMProvider {
  return value === "openrouter" || value === "ollama";
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
