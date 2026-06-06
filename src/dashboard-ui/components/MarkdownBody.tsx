import { Link } from "@tanstack/react-router";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { wikiPathToRouterParams } from "../lib/wikilinks.js";

export interface MarkdownBodyProps {
  source: string;
}

export function MarkdownBody({ source }: MarkdownBodyProps) {
  return (
    <div className="prose prose-invert max-w-none prose-headings:break-words prose-headings:font-semibold prose-headings:tracking-tight prose-p:break-words prose-a:break-words prose-a:text-primary prose-blockquote:border-l-primary prose-code:break-words prose-code:rounded prose-code:bg-surface-2 prose-code:px-1 prose-code:font-mono prose-code:text-text-primary prose-code:before:content-none prose-code:after:content-none prose-pre:overflow-x-auto prose-pre:border prose-pre:border-border-subtle prose-pre:bg-surface-2">
      <ReactMarkdown
        components={{
          a: ({ children, href, ...rest }) => {
            if (href?.startsWith("wiki:")) {
              const params = wikiPathToRouterParams(href.slice("wiki:".length));
              if (params) {
                return (
                  <Link className="text-primary hover:underline" params={params} to="/wiki/$category/$slug">
                    {children}
                  </Link>
                );
              }
            }
            return (
              <a href={href} {...rest}>
                {children}
              </a>
            );
          },
        }}
        remarkPlugins={[remarkGfm]}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
