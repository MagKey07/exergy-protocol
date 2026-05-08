import { cn } from "@/lib/utils";

interface EmptyStateProps {
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({
  title,
  description,
  action,
  className,
}: EmptyStateProps): JSX.Element {
  return (
    <div
      className={cn(
        "panel flex flex-col items-center justify-center gap-3 px-6 py-12 text-center",
        className,
      )}
    >
      <div className="text-sm font-medium text-fg">{title}</div>
      {description && (
        <p className="max-w-md text-sm text-fg-muted leading-relaxed">{description}</p>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
