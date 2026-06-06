import { Link } from "@tanstack/react-router";
import { GitBranch } from "lucide-react";
import { useListKeyNav } from "../hooks/useListKeyNav.js";
import { type PageInbound, type PageRelation } from "../hooks/usePageDetail.js";
import { cn } from "../lib/cn.js";
import { wikiPathToRouterParams } from "../lib/wikilinks.js";
import { Card } from "./Card.js";
import { EmptyState } from "./EmptyState.js";

type RelationNavItem =
  | { kind: "relation"; relation: PageRelation; key: string }
  | { kind: "inbound"; inbound: PageInbound; key: string };

export function PageRelations({
  className,
  relations,
  inbound,
}: {
  className?: string;
  relations: PageRelation[];
  inbound: PageInbound[];
}) {
  const grouped = new Map<string, PageRelation[]>();
  for (const relation of relations) {
    const group = grouped.get(relation.key) ?? [];
    group.push(relation);
    grouped.set(relation.key, group);
  }
  const relationItems: RelationNavItem[] = [
    ...relations.map((relation, index) => ({
      kind: "relation" as const,
      relation,
      key: `relation-${relation.key}-${relation.target}-${index}`,
    })),
    ...inbound.map((reference, index) => ({
      kind: "inbound" as const,
      inbound: reference,
      key: `inbound-${reference.fromPath}-${index}`,
    })),
  ];
  const relationIndexByKey = new Map(relationItems.map((item, index) => [item.key, index]));
  const listNav = useListKeyNav({
    items: relationItems,
    getKey: (item) => item.key,
    onActivate: () => {
      const activeElement = document.activeElement;
      if (!(activeElement instanceof HTMLElement)) return;
      activeElement.querySelector<HTMLAnchorElement>("a[href]")?.click();
    },
  });

  if (grouped.size === 0 && inbound.length === 0) {
    return (
      <section className={cn("mt-8", className)}>
        <EmptyState
          icon={GitBranch}
          title="No relations yet"
          description="This page has no resolved relations or inbound references."
        />
      </section>
    );
  }

  return (
    <section className={cn("mt-8 space-y-4", className)} {...listNav.listProps}>
      {grouped.size > 0 ? (
        <Card>
          <h2 className="mb-3 text-sm font-semibold">Relations</h2>
          <div className="space-y-3">
            {[...grouped.entries()].sort().map(([key, items]) => (
              <div key={key}>
                <p className="mb-1 text-xs uppercase tracking-wider text-text-muted">{key}</p>
                <ul className="space-y-1">
                  {items.map((relation, index) => (
                    <li
                      className="rounded-sm text-sm data-[focused=true]:bg-surface-2 data-[focused=true]:ring-1 data-[focused=true]:ring-primary/60"
                      key={`${relation.key}-${relation.target}-${index}`}
                      {...listNav.getItemProps(relationIndexByKey.get(`relation-${relation.key}-${relation.target}-${relations.indexOf(relation)}`) ?? 0)}
                    >
                      <RelationTarget relation={relation} />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      {inbound.length > 0 ? (
        <Card>
          <h2 className="mb-3 text-sm font-semibold">Inbound references ({inbound.length})</h2>
          <ul className="space-y-1.5">
            {inbound.map((reference, index) => {
              const params = wikiPathToRouterParams(reference.fromPath);
              return (
                <li
                  className="flex flex-col gap-1 rounded-sm text-sm data-[focused=true]:bg-surface-2 data-[focused=true]:ring-1 data-[focused=true]:ring-primary/60 sm:flex-row sm:items-baseline sm:justify-between sm:gap-2"
                  key={`${reference.fromPath}-${index}`}
                  {...listNav.getItemProps(relationIndexByKey.get(`inbound-${reference.fromPath}-${index}`) ?? 0)}
                >
                  {params ? (
                    <Link className="break-words text-primary hover:underline sm:truncate" params={params} to="/wiki/$category/$slug">
                      {reference.fromTitle ?? reference.fromPath}
                    </Link>
                  ) : (
                    <span className="break-words sm:truncate">{reference.fromTitle ?? reference.fromPath}</span>
                  )}
                  <span className="flex-shrink-0 font-mono text-xs text-text-muted">via {reference.via}</span>
                </li>
              );
            })}
          </ul>
        </Card>
      ) : null}
    </section>
  );
}

function RelationTarget({ relation }: { relation: PageRelation }) {
  if (!relation.resolvedPath) {
    return (
      <span className="text-text-muted">
        {relation.target} <em className="text-[10px]">[unresolved]</em>
      </span>
    );
  }
  const params = wikiPathToRouterParams(relation.resolvedPath);
  if (!params) {
    return <span>{relation.resolvedTitle ?? relation.target}</span>;
  }
  return (
    <Link className="text-primary hover:underline" params={params} to="/wiki/$category/$slug">
      {relation.resolvedTitle ?? relation.target}
    </Link>
  );
}
