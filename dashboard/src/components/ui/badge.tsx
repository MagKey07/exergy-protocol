import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-medium uppercase tracking-[0.08em] transition-colors",
  {
    variants: {
      variant: {
        default:
          "border-border bg-surface-2 text-fg-muted",
        accent:
          "border-accent/40 bg-accent/10 text-accent",
        warn:
          "border-warn/40 bg-warn/10 text-warn",
        danger:
          "border-danger/40 bg-danger/10 text-danger",
        outline: "border-border text-fg-muted",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps): JSX.Element {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
