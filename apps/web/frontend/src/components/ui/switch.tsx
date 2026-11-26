import { Switch as SwitchPrimitive } from '@base-ui/react/switch';

import { cn } from '@/lib/cn';

function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      nativeButton
      render={<button type="button" />}
      data-slot="switch"
      className={cn(
        'inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-input bg-muted p-0.5',
        'transition-colors duration-150 ease-in-out data-checked:bg-primary',
        'focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring',
        'disabled:pointer-events-none disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          'pointer-events-none block size-3.5 rounded-full bg-foreground transition-transform',
          'duration-150 ease-in-out data-checked:translate-x-4 data-checked:bg-primary-foreground',
        )}
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
