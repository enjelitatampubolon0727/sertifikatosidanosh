import type { HTMLAttributes } from 'react';

import { cn } from '@/lib/utils';

const badgeVariants: Record<string, string> = {
  default: 'bg-slate-800 text-slate-100',
  success: 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/50',
  warning: 'bg-amber-500/10 text-amber-300 border border-amber-500/50',
  danger: 'bg-red-500/10 text-red-300 border border-red-500/50',
  info: 'bg-blue-500/10 text-blue-300 border border-blue-500/50',
};

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: keyof typeof badgeVariants;
}

export function Badge({ className, variant = 'default', ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-3 py-1 text-xs font-medium',
        badgeVariants[variant],
        className
      )}
      {...props}
    />
  );
}
