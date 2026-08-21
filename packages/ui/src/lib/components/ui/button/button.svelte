<script lang="ts">
  import { Button as ButtonPrimitive } from 'bits-ui'
  import type { Snippet } from 'svelte'
  import { cn } from '$lib/utils'
  import type { ButtonProps } from './button.variants.js'
  import { buttonVariants } from './button.variants.js'

  type Props = ButtonProps & {
    children: Snippet
  }

  let {
    class: className,
    variant = 'default',
    size = 'default',
    children,
    ...rest
  }: Props = $props()
</script>

<ButtonPrimitive.Root
  class={cn(buttonVariants({ variant, size }), className)}
  {...rest}
>
  {@render children()}
</ButtonPrimitive.Root>
