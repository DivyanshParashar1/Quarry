import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { getJson, send, type BankAnswer } from '@/lib/api';
import { relativeDate } from '@/lib/format';

/**
 * Phase 19: answers you approved on applications. A similar question on a later
 * form gets the saved answer first (before the LLM); edit or delete them here.
 */
export function AnswerBank() {
  const q = useQuery({ queryKey: ['answer-bank'], queryFn: () => getJson<{ answers: BankAnswer[] }>('/api/answers') });
  if (q.error) return <p className="text-sm text-red-600">Could not load saved answers: {(q.error as Error).message}</p>;
  const answers = q.data?.answers ?? [];
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Answers you approved on applications (LLM-written, or your own). A similar question on a later form reuses them first;
        salary, notice, visa and EEO questions are never saved. Answers in preferences.yaml still take priority.
      </p>
      {!answers.length && q.data && <p className="text-sm text-muted-foreground">Nothing saved yet — approve an application to start.</p>}
      {answers.map((a) => (
        <AnswerRow key={a.id} a={a} />
      ))}
    </div>
  );
}

function AnswerRow({ a }: { a: BankAnswer }) {
  const qc = useQueryClient();
  const [text, setText] = useState<string | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['answer-bank'] });
  const save = useMutation({ mutationFn: () => send(`/api/answers/${a.id}`, 'PATCH', { answer: text }), onSuccess: () => (setText(null), refresh()) });
  const del = useMutation({ mutationFn: () => send(`/api/answers/${a.id}`, 'DELETE'), onSuccess: refresh });
  return (
    <Card className="flex flex-col gap-2 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{a.question}</span>
        <Badge variant="outline">{a.kind}</Badge>
        <span className="text-xs text-muted-foreground">
          from {a.origin} · used {a.uses}× · updated {relativeDate(a.updatedAt)}
        </span>
        <div className="ml-auto flex gap-1">
          <Button size="sm" variant="ghost" onClick={() => setText(text === null ? a.answer : null)} title="Edit">
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" variant="ghost" onClick={() => window.confirm('Delete this saved answer?') && del.mutate()} title="Delete">
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      {text === null ? (
        <p className="whitespace-pre-wrap text-muted-foreground">{a.answer}</p>
      ) : (
        <>
          <Textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} />
          <div>
            <Button size="sm" onClick={() => save.mutate()} disabled={!text.trim() || save.isPending}>
              Save
            </Button>
          </div>
        </>
      )}
      {(save.error || del.error) && <p className="text-xs text-red-600">{((save.error ?? del.error) as Error).message}</p>}
    </Card>
  );
}
