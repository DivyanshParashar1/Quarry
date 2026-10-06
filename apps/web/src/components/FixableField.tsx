import { useMutation } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import type { ChangeEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { send } from '@/lib/api';
import { cn } from '@/lib/utils';

interface Props {
  value: string;
  onChange: (next: string) => void;
  kind: string;
  instruction?: string;
  multiline?: boolean;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  rows?: number;
}

/**
 * Input/textarea with a sparkles button that asks the server to rewrite the
 * current value via /api/profile/fix. Non-destructive: the user sees the
 * rewrite replace the field but can still edit or undo (browser-level).
 */
export function FixableField({ value, onChange, kind, instruction, multiline, placeholder, className, disabled, rows }: Props) {
  const fix = useMutation({
    mutationFn: () =>
      send<{ rewrite: string; provider: string; model: string }>('/api/profile/fix', 'POST', {
        text: value,
        kind,
        ...(instruction ? { instruction } : {}),
      }),
    onSuccess: (r) => onChange(r.rewrite),
  });
  const Field = multiline ? Textarea : Input;
  const handle = (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(e.currentTarget.value);
  return (
    <div className={cn('flex items-start gap-2', className)}>
      <Field
        value={value}
        onChange={handle}
        placeholder={placeholder}
        disabled={disabled || fix.isPending}
        className="flex-1"
        {...(multiline && rows ? { rows } : {})}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => fix.mutate()}
        disabled={disabled || fix.isPending || !value.trim()}
        title={fix.error ? (fix.error as Error).message : 'Rewrite with the LLM'}
      >
        <Sparkles className={cn('h-3.5 w-3.5', fix.isPending && 'animate-pulse')} />
        {fix.isPending ? 'Fixing' : 'Fix'}
      </Button>
    </div>
  );
}
