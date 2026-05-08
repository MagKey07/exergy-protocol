import { cn } from "@/lib/utils";

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  eyebrow?: string;
  actions?: React.ReactNode;
  className?: string;
}

/**
 * Consistent page header. Eyebrow → title (serif) → subtitle.
 * Actions slot for primary CTAs (e.g., "New Settlement").
 */
export function PageHeader({
  title,
  subtitle,
  eyebrow,
  actions,
  className,
}: PageHeaderProps): JSX.Element {
  return (
    <div className={cn("flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between mb-8", className)}>
      <div>
        {eyebrow && (
          <div className="text-[11px] uppercase tracking-[0.18em] text-fg-subtle mb-2">
            {eyebrow}
          </div>
        )}
        <h1 className="font-serif text-3xl tracking-tight text-fg">{title}</h1>
        {subtitle && (
          <p className="text-sm text-fg-muted mt-2 max-w-2xl leading-relaxed">{subtitle}</p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
