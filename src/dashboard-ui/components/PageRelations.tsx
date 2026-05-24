import { Link } from "@tanstack/react-router";
import { type PageInbound, type PageRelation } from "../hooks/usePageDetail.js";
import { wikiPathToRouterParams } from "../lib/wikilinks.js";
import { Card } from "./Card.js";

export function PageRelations({ relations, inbound }: { relations: PageRelation[]; inbound: PageInbound[] }) {
  const grouped = new Map<string, PageRelation[]>();
  for (const relation of relations) {
    const group = grouped.get(relation.key) ?? [];
    group.push(relation);
    grouped.set(relation.key, group);
  }

  return (
    <section className="mt-8 space-y-4">
      {grouped.size > 0 ? (
        <Card>
          <h2 className="mb-3 text-sm font-semibold">Relations</h2>
          <div className="space-y-3">
            {[...grouped.entries()].sort().map(([key, items]) => (
              <div key={key}>
                <p className="mb-1 text-xs uppercase tracking-wider text-text-muted">{key}</p>
                <ul className="space-y-1">
                  {items.map((relation, index) => (
                    <li className="text-sm" key={`${relation.key}-${relation.target}-${index}`}>
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
                <li className="flex items-baseline justify-between gap-2 text-sm" key={`${reference.fromPath}-${index}`}>
                  {params ? (
                    <Link className="truncate text-primary hover:underline" params={params} to="/wiki/$category/$slug">
                      {reference.fromTitle ?? reference.fromPath}
                    </Link>
                  ) : (
                    <span className="truncate">{reference.fromTitle ?? reference.fromPath}</span>
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
