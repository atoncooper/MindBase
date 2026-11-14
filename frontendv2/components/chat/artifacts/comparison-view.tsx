"use client";

// Declarative comparison renderer: 2-4 option cards with pros / cons /
// attribute rows plus an optional recommendation banner. Pure React + Tailwind
// theme tokens, no iframe and nothing executable — the model only ever emits
// the structured spec validated by isComparisonSpec().

import type { ComparisonItemSpec, ComparisonSpec } from "@/lib/artifacts/interactive-spec";

function ProsConsList({ items, tone }: { items: string[]; tone: "pros" | "cons" }) {
  if (items.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1">
      {items.map((item, index) => (
        <li key={`${tone}-${index}`} className="flex gap-1.5 text-[12px] leading-relaxed text-secondary">
          <span
            aria-hidden="true"
            className={`mt-px shrink-0 font-medium ${tone === "pros" ? "text-success" : "text-danger"}`}
          >
            {tone === "pros" ? "✓" : "✗"}
          </span>
          <span className="min-w-0 break-words">{item}</span>
        </li>
      ))}
    </ul>
  );
}

function ItemCard({ item }: { item: ComparisonItemSpec }) {
  const pros = item.pros ?? [];
  const cons = item.cons ?? [];
  const attrs = item.attrs ?? [];
  return (
    <article className="flex min-w-0 flex-col gap-2 rounded-xl border border-border-subtle bg-white p-3">
      <h4 className="text-[13px] font-semibold leading-snug text-foreground">{item.name}</h4>
      {item.summary && <p className="text-[12px] leading-relaxed text-secondary">{item.summary}</p>}
      {pros.length > 0 && <ProsConsList items={pros} tone="pros" />}
      {cons.length > 0 && <ProsConsList items={cons} tone="cons" />}
      {attrs.length > 0 && (
        <dl className="mt-0.5 grid grid-cols-[auto_1fr] gap-x-2.5 gap-y-1 border-t border-border-subtle pt-2 text-[11.5px] leading-relaxed">
          {attrs.map((attr, index) => (
            <div key={`attr-${index}`} className="contents">
              <dt className="whitespace-nowrap text-tertiary">{attr.label}</dt>
              <dd className="min-w-0 break-words text-foreground">{attr.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </article>
  );
}

export function ComparisonView({ spec }: { spec: ComparisonSpec }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {spec.items.map((item) => (
          <ItemCard key={item.name} item={item} />
        ))}
      </div>
      {spec.recommendation && (
        <div className="rounded-xl border border-accent/25 bg-accent-soft px-3 py-2.5">
          <p className="text-[11px] font-medium text-accent">推荐结论</p>
          <p className="mt-0.5 text-[12.5px] leading-relaxed text-foreground">{spec.recommendation}</p>
        </div>
      )}
    </div>
  );
}
