import type { CompileOperation } from "./execute.js";
import type { Block, PageIR } from "./parse-pageir.js";

export type SectionPatch =
  | { op: "test"; path: `/sections/${string}/body_hash`; value: string }
  | { op: "replace"; path: `/sections/${string}/body_blocks`; value: Block[] };

export interface CompileSectionPatchOptions {
  path: string;
  page: PageIR;
  sectionId: string;
  bodyHash: string;
  replacementParagraphs: string[];
}

export function compileSectionPatch(opts: CompileSectionPatchOptions): Extract<CompileOperation, { kind: "section_patch" }> {
  const section = opts.page.sections.find((candidate) => candidate.section_id === opts.sectionId);
  const expectedHash = section?.body_hash ?? opts.bodyHash;
  return {
    kind: "section_patch",
    path: opts.path,
    section_id: opts.sectionId,
    patch: [
      {
        op: "test",
        path: `/sections/${opts.sectionId}/body_hash`,
        value: opts.bodyHash || expectedHash,
      },
      {
        op: "replace",
        path: `/sections/${opts.sectionId}/body_blocks`,
        value: opts.replacementParagraphs.map((paragraph) => ({
          type: "paragraph" as const,
          text: paragraph.trim(),
        })).filter((block) => block.text.length > 0),
      },
    ],
  };
}
