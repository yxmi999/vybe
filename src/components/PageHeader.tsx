import { cn } from "@/lib/utils";

/**
 * The one header every page wears. A mono "cue" eyebrow (the app's signature
 * broadcast label), a Syne display title, an optional one-line description, and
 * a right-aligned slot for page actions. Drop it at the top of a page's content
 * container; it brings its own bottom spacing.
 */
export default function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  className,
}: {
  eyebrow?: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("mb-7", className)}>
      <div className="flex items-end justify-between gap-4">
        <div className="min-w-0">
          {eyebrow && (
            <p className="cue text-violet-400/90 mb-2.5">{eyebrow}</p>
          )}
          <h1 className="font-display text-[1.75rem] sm:text-[2rem] font-extrabold tracking-tight leading-none text-white">
            {title}
          </h1>
          {description && (
            <p className="mt-2.5 text-sm text-white/40 leading-relaxed max-w-2xl">{description}</p>
          )}
        </div>
        {actions && <div className="flex items-center gap-2 flex-shrink-0">{actions}</div>}
      </div>
      <div className="mt-5 h-px bg-gradient-to-r from-white/[0.1] via-white/[0.05] to-transparent" />
    </header>
  );
}
