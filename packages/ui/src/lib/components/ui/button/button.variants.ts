import type { Button as ButtonPrimitive } from 'bits-ui'
import type { Snippet } from 'svelte'
import type { HTMLButtonAttributes } from 'svelte/elements'
import { tv, type VariantProps } from 'tailwind-variants'

type PrimitiveProps = ButtonPrimitive.RootProps

export const buttonVariants = tv({
  base: 'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
  variants: {
    variant: {
      default: 'bg-primary text-primary-foreground hover:bg-primary/90',
      destructive:
        'bg-destructive text-destructive-foreground hover:bg-destructive/90',
      outline:
        'border border-input bg-background hover:bg-accent hover:text-accent-foreground',
      secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
      ghost: 'hover:bg-accent hover:text-accent-foreground',
      link: 'text-primary underline-offset-4 hover:underline',
    },
    size: {
      default: 'h-9 px-4 py-2',
      sm: 'h-8 px-3 text-xs',
      lg: 'h-10 px-8',
      icon: 'size-9',
    },
  },
  defaultVariants: {
    variant: 'default',
    size: 'default',
  },
})

type Variant = VariantProps<typeof buttonVariants>

export type ButtonProps = PrimitiveProps & {
  variant?: Variant['variant']
  size?: Variant['size']
  class?: HTMLButtonAttributes['class']
  children?: Snippet
}
