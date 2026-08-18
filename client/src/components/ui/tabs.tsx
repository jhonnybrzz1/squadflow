'use client';

import * as React from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';

import { cn } from '@/lib/utils';

const Tabs = TabsPrimitive.Root;

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      'safe-area-tabs flex gap-0 border-2 border-[var(--border)] bg-[var(--muted)] scrollbar-hide',
      className,
    )}
    {...props}
  />
));
TabsList.displayName = TabsPrimitive.List.displayName;

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      'flex-1 flex-shrink-0 min-h-[44px] px-4 py-3 text-center font-mono text-xs font-semibold uppercase tracking-wide',
      'border-r border-[var(--border)] bg-transparent text-[var(--foreground-muted)]',
      'transition-all duration-150 cursor-pointer select-none',
      'hover:bg-[var(--background)] hover:text-[var(--foreground)]',
      'active:scale-[0.97] active:bg-[var(--accent-cyan)] active:text-[var(--background)]',
      'focus-visible:outline-2 focus-visible:outline-[var(--accent-cyan)] focus-visible:outline-offset-[-2px] focus-visible:bg-[var(--background)] focus-visible:text-[var(--foreground)]',
      'data-[state=active]:bg-[var(--accent-cyan)] data-[state=active]:text-[var(--background)]',
      'data-[state=active]:focus-visible:outline-[var(--foreground)]',
      'last:border-r-0',
      // Mobile responsive
      'max-md:flex-shrink max-md:min-w-0 max-md:px-2 max-md:py-2.5 max-md:text-[10px] max-md:whitespace-nowrap max-md:overflow-hidden max-md:text-ellipsis',
      // Reduced motion
      'motion-reduce:transform-none motion-reduce:transition-none',
      className,
    )}
    {...props}
  />
));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      'mt-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-cyan)] focus-visible:ring-offset-2',
      className,
    )}
    {...props}
  />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsList, TabsTrigger, TabsContent };
