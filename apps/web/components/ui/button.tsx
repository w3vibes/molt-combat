import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva('inline-flex items-center justify-center rounded-lg px-4 py-2 text-sm font-medium transition', {
  variants: {
    variant: {
      default: 'bg-primary text-white hover:opacity-90',
      outline: 'border border-border bg-transparent text-foreground hover:bg-white/5',
    },
  },
  defaultVariants: { variant: 'default' },
});

export function Button({ className, variant, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>) {
  return <button className={cn(buttonVariants({ variant }), className)} {...props} />;
}
