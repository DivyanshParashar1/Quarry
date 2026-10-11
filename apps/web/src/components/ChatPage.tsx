import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, GitMerge, Plus, Send, Square, Trash2, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { getJson, send } from '@/lib/api';
import { relativeDate } from '@/lib/format';
import { cn } from '@/lib/utils';

// The chatbot: Claude Code with the product's tools, the web, scripts and gated
// code changes. It drafts; approving stays in the Review tab.

interface ChatSession {
  id: string;
  title: string;
  status: string;
  updatedAt: string;
}
interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  meta: Record<string, unknown>;
  createdAt: string;
}

const SUGGESTIONS = [
  'Here is a job link: <paste URL>. Add it, tailor my resume for it and draft referral asks.',
  'What is broken right now? Check health and incidents and fix what you can.',
  'Which of my top matches are still waiting on a referral, and what should I do next?',
];

export function ChatPage() {
  const qc = useQueryClient();
  const [active, setActive] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const bottom = useRef<HTMLDivElement>(null);
  const sessions = useQuery({ queryKey: ['chat-sessions'], queryFn: () => getJson<{ sessions: ChatSession[] }>('/api/chat/sessions'), refetchInterval: 10_000 });
  const current = useQuery({
    queryKey: ['chat', active],
    queryFn: () => getJson<{ session: ChatSession; messages: ChatMessage[]; running: boolean }>(`/api/chat/sessions/${active}`),
    enabled: !!active,
    refetchInterval: (q) => (q.state.data?.running ? 1500 : false),
  });
  useEffect(() => {
    if (!active && sessions.data?.sessions[0]) setActive(sessions.data.sessions[0].id);
  }, [active, sessions.data]);
  useEffect(() => {
    // Braces matter: newer browsers return a Promise from scrollIntoView, which React would take for a cleanup function.
    bottom.current?.scrollIntoView({ behavior: 'smooth' });
  }, [current.data?.messages.length]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['chat-sessions'] });
    void qc.invalidateQueries({ queryKey: ['chat', active] });
  };
  const create = useMutation({
    mutationFn: () => send<ChatSession>('/api/chat/sessions', 'POST', {}),
    onSuccess: (s) => {
      setActive(s.id);
      refresh();
    },
  });
  const post = useMutation({
    mutationFn: async (text: string) => {
      let id = active;
      if (!id) {
        id = (await send<ChatSession>('/api/chat/sessions', 'POST', {})).id;
        setActive(id);
      }
      await send(`/api/chat/sessions/${id}/messages`, 'POST', { text });
    },
    onSuccess: () => {
      setDraft('');
      refresh();
    },
    onSettled: refresh,
  });
  const stop = useMutation({ mutationFn: () => send(`/api/chat/sessions/${active}/stop`, 'POST'), onSettled: refresh });
  const remove = useMutation({
    mutationFn: (id: string) => send(`/api/chat/sessions/${id}`, 'DELETE'),
    onSuccess: () => {
      setActive(null);
      refresh();
    },
  });

  const running = current.data?.running ?? false;
  const submit = () => {
    const text = draft.trim();
    if (text && !running) post.mutate(text);
  };

  return (
    <div className="grid h-full min-h-0 grid-cols-1 md:grid-cols-[240px_1fr]">
      <aside className="hidden min-h-0 flex-col gap-1 overflow-y-auto border-r border-border p-2 md:flex">
        <Button variant="outline" size="sm" onClick={() => create.mutate()} disabled={create.isPending}>
          <Plus className="size-3" /> New chat
        </Button>
        {sessions.data?.sessions.map((s) => (
          <button
            key={s.id}
            onClick={() => setActive(s.id)}
            className={cn('group flex items-center justify-between gap-1 rounded-md px-2 py-1.5 text-left text-sm', s.id === active ? 'bg-muted font-medium' : 'text-muted-foreground hover:text-foreground')}
          >
            <span className="truncate">{s.title}</span>
            <span className="flex shrink-0 items-center gap-1 text-xs">
              {s.status === 'running' ? '…' : relativeDate(s.updatedAt)}
              <Trash2
                className="hidden size-3 group-hover:block"
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm(`Delete "${s.title}"?`)) remove.mutate(s.id);
                }}
              />
            </span>
          </button>
        ))}
      </aside>

      <section className="flex min-h-0 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {!current.data?.messages.length && (
            <div className="mx-auto mt-8 flex max-w-xl flex-col gap-3 text-sm">
              <div className="flex items-center gap-2 font-medium">
                <Bot className="size-5" /> JobForge assistant
              </div>
              <p className="text-muted-foreground">
                It can use the whole product (jobs, resumes, referrals, applications, contacts, health), read the web, run scripts, and change the code — code changes are checked
                (typecheck, lint, tests; safety files are off-limits) before they are merged. It never approves or sends anything: drafts wait for you in Review.
              </p>
              {SUGGESTIONS.map((s) => (
                <button key={s} className="rounded-md border border-border px-3 py-2 text-left hover:bg-muted" onClick={() => setDraft(s)}>
                  {s}
                </button>
              ))}
            </div>
          )}
          <div className="mx-auto flex max-w-3xl flex-col gap-2">
            {current.data?.messages.map((m) => <Message key={m.id} m={m} />)}
            {running && <div className="animate-pulse text-sm text-muted-foreground">working…</div>}
            <div ref={bottom} />
          </div>
        </div>
        <div className="border-t border-border p-3">
          <div className="mx-auto flex max-w-3xl items-end gap-2">
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder={running ? 'Working on it…' : 'Ask anything — paste a job link, ask what is broken, ask for a change…'}
              rows={2}
              className="min-h-[44px] flex-1 resize-y"
            />
            {running ? (
              <Button variant="outline" onClick={() => stop.mutate()}>
                <Square className="size-4" /> Stop
              </Button>
            ) : (
              <Button onClick={submit} disabled={!draft.trim() || post.isPending}>
                <Send className="size-4" /> Send
              </Button>
            )}
          </div>
          {post.error && <p className="mx-auto mt-1 max-w-3xl text-sm text-red-600">{post.error.message}</p>}
        </div>
      </section>
    </div>
  );
}

function Message({ m }: { m: ChatMessage }) {
  if (m.role === 'user') return <div className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-lg bg-muted px-3 py-2 text-sm">{m.content}</div>;
  if (m.role === 'assistant') return <div className="max-w-[90%] whitespace-pre-wrap text-sm leading-relaxed">{m.content}</div>;
  if (m.role === 'tool') {
    const name = m.content.replace(/^mcp__jobforge__/, '');
    return (
      <details className="text-xs text-muted-foreground">
        <summary className="flex cursor-pointer items-center gap-1">
          <Wrench className="size-3" /> {name}
        </summary>
        <pre className="mt-1 whitespace-pre-wrap break-all rounded bg-muted p-2">{String(m.meta.input ?? m.meta.error ?? '')}</pre>
      </details>
    );
  }
  if (m.meta.kind === 'result') {
    return <div className="text-xs text-muted-foreground">{m.content === 'done' ? `done${typeof m.meta.costUsd === 'number' ? ` · $${m.meta.costUsd.toFixed(2)}` : ''}` : m.content}</div>;
  }
  const code = m.meta.kind === 'code_change';
  return (
    <div className={cn('whitespace-pre-wrap rounded-md px-3 py-2 text-xs', code ? 'border border-violet-300 bg-violet-50 text-violet-900' : 'bg-amber-50 text-amber-900')}>
      {code && <GitMerge className="mr-1 inline size-3" />}
      {m.content}
    </div>
  );
}
