import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { send, type ReviewItemAny } from '@/lib/api';

/** Phase 11: draft an application (Greenhouse/Lever/Ashby) into the review queue. */
export function ApplyPanel({ jobId, onOpenReview }: { jobId: string; onOpenReview: () => void }) {
  const qc = useQueryClient();
  const [msg, setMsg] = useState<string | null>(null);
  const draft = useMutation({
    mutationFn: () => send<ReviewItemAny>(`/api/jobs/${jobId}/apply`, 'POST', {}),
    onSuccess: (item) => {
      const missing = (item.draft as { missingRequired?: string[] }).missingRequired ?? [];
      setMsg(missing.length ? `Drafted. ${missing.length} required question(s) need your answer.` : 'Drafted. Review the filled form and approve.');
      void qc.invalidateQueries({ queryKey: ['review'] });
    },
    onError: (e: Error) => setMsg(e.message),
  });
  return (
    <Card className="flex flex-wrap items-center gap-2 p-4">
      <h3 className="mr-auto flex items-center gap-1.5 text-sm font-semibold">
        <Send className="size-4" /> Apply
      </h3>
      <Button size="sm" variant="outline" onClick={() => draft.mutate()} disabled={draft.isPending}>
        {draft.isPending ? 'Filling the form…' : 'Draft application'}
      </Button>
      {draft.isSuccess && (
        <Button size="sm" variant="ghost" onClick={onOpenReview}>
          Open review
        </Button>
      )}
      {msg && <p className="w-full text-xs text-muted-foreground">{msg}</p>}
    </Card>
  );
}
