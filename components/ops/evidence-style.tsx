// Each evidence item has a colour of its own, used for its panel's marker and for every chip that
// cites it, so a claim's citations can be matched to the items at a glance. The colour only ever
// sits beside the item's title, so nothing rests on colour alone. None of them is a state colour.

type ItemStyle = { dot: string; chip: string; text: string };

const STYLES: Record<string, ItemStyle> = {
  mandate: { dot: 'bg-[#c9a7ff]', chip: 'border-[#c9a7ff]/45 bg-[#c9a7ff]/10', text: 'text-[#c9a7ff]' },
  readback: { dot: 'bg-[#9db4ff]', chip: 'border-[#9db4ff]/45 bg-[#9db4ff]/10', text: 'text-[#9db4ff]' },
  receipt: { dot: 'bg-[#6fd6d0]', chip: 'border-[#6fd6d0]/45 bg-[#6fd6d0]/10', text: 'text-[#6fd6d0]' },
  cart: { dot: 'bg-[#7fd3ff]', chip: 'border-[#7fd3ff]/45 bg-[#7fd3ff]/10', text: 'text-[#7fd3ff]' },
  purchase_log: { dot: 'bg-[#d49cf0]', chip: 'border-[#d49cf0]/45 bg-[#d49cf0]/10', text: 'text-[#d49cf0]' },
  approval: { dot: 'bg-[#f2a7c9]', chip: 'border-[#f2a7c9]/45 bg-[#f2a7c9]/10', text: 'text-[#f2a7c9]' },
  decision: { dot: 'bg-[#bfe08a]', chip: 'border-[#bfe08a]/45 bg-[#bfe08a]/10', text: 'text-[#bfe08a]' },
};
const OTHER: ItemStyle = { dot: 'bg-[#b8c4d9]', chip: 'border-[#b8c4d9]/45 bg-[#b8c4d9]/10', text: 'text-[#b8c4d9]' };

/** The colour classes of the evidence item with `id`. */
export const evidenceStyle = (id: string): ItemStyle => (Object.hasOwn(STYLES, id) ? STYLES[id] : OTHER);

/** The id of the element that holds the evidence item with `id`, for links to it. */
export const evidenceAnchor = (id: string) => `evidence-${id}`;

/** A citation of an evidence item: a chip in the item's colour that jumps to the item. */
export function CitationChip({ id, title }: { id: string; title: string }) {
  const style = evidenceStyle(id);
  return (
    <a
      href={`#${evidenceAnchor(id)}`}
      className={`inline-flex min-h-7 items-center gap-1.5 rounded-control border px-2 text-meta text-text transition-colors hover:bg-raised ${style.chip}`}
    >
      <span aria-hidden className={`size-2 rounded-[2px] ${style.dot}`} />
      {title}
    </a>
  );
}
