import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Save, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { getJson, send, type ResumeBlock, type ResumeData } from '@/lib/api';
import { cn } from '@/lib/utils';

// Resume block editor: lists manifest sections in the sidebar, lets the user
// hand-edit each block's LaTeX fragment + metadata. The server owns writing
// profile/resume/manifest.yaml + blocks/*.tex and re-validates on every write.

export function ResumeEditor() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['resume'], queryFn: () => getJson<ResumeData>('/api/resume') });
  const [sectionId, setSectionId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const data = q.data;
  const sectionsOrder = data?.manifest.sections_order ?? [];
  const activeSection = sectionId ?? sectionsOrder[0] ?? null;

  const blocksBySection = useMemo(() => {
    const map = new Map<string, ResumeBlock[]>();
    for (const b of data?.manifest.blocks ?? []) {
      if (b.section === 'header') continue;
      const list = map.get(b.section) ?? [];
      list.push(b);
      map.set(b.section, list);
    }
    return map;
  }, [data]);

  if (q.isPending) return <div className="p-6 text-sm text-muted-foreground">Loading resume…</div>;
  if (q.error || !data)
    return (
      <div className="p-6 text-sm text-red-600">
        Could not load resume: {(q.error as Error | undefined)?.message ?? 'unknown error'}. Make sure
        the server was started from the repo root and <code>profile/resume/manifest.yaml</code> exists.
      </div>
    );

  const activeBlocks = (activeSection ? blocksBySection.get(activeSection) : undefined) ?? [];
  const selectedBlock = activeBlocks.find((b) => b.id === selectedId);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['resume'] });

  return (
    <div className="mx-auto grid h-full max-w-6xl grid-cols-[240px_1fr] gap-6 p-6">
      <aside className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">Sections</h2>
        <nav className="flex flex-col gap-1 text-sm">
          {sectionsOrder.map((s) => {
            const count = blocksBySection.get(s)?.length ?? 0;
            if (s === 'header') return null;
            return (
              <button
                key={s}
                onClick={() => {
                  setSectionId(s);
                  setSelectedId(null);
                  setCreating(false);
                }}
                className={cn(
                  'flex items-center justify-between rounded-md px-2.5 py-1.5 text-left capitalize',
                  activeSection === s ? 'bg-muted font-medium' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <span>{s}</span>
                <span className="text-xs text-muted-foreground">{count}</span>
              </button>
            );
          })}
        </nav>
      </aside>

      <section className="flex min-h-0 flex-col gap-4">
        <header className="flex items-center justify-between">
          <h1 className="text-lg font-semibold capitalize">{activeSection ?? '—'}</h1>
          <Button
            size="sm"
            onClick={() => {
              setCreating(true);
              setSelectedId(null);
            }}
            disabled={!activeSection}
          >
            <Plus className="h-3.5 w-3.5" />
            Add block
          </Button>
        </header>

        <div className="grid grid-cols-[220px_1fr] gap-4">
          <ul className="flex flex-col gap-1 text-sm">
            {activeBlocks.map((b) => (
              <li key={b.id}>
                <button
                  onClick={() => {
                    setSelectedId(b.id);
                    setCreating(false);
                  }}
                  className={cn(
                    'w-full rounded-md px-2.5 py-1.5 text-left',
                    selectedId === b.id ? 'bg-muted' : 'hover:bg-muted/60',
                  )}
                >
                  <div className="font-medium">{b.title ?? b.id}</div>
                  <div className="text-xs text-muted-foreground">{b.id}</div>
                </button>
              </li>
            ))}
            {!activeBlocks.length && !creating && (
              <li className="text-xs text-muted-foreground">No blocks yet. Click “Add block”.</li>
            )}
          </ul>

          {creating && activeSection ? (
            <BlockForm
              section={activeSection}
              fragment=""
              onCancel={() => setCreating(false)}
              onSaved={(id) => {
                setCreating(false);
                setSelectedId(id);
                refresh();
              }}
            />
          ) : selectedBlock ? (
            <BlockForm
              key={selectedBlock.id}
              block={selectedBlock}
              section={selectedBlock.section}
              fragment={data.fragments[selectedBlock.id] ?? ''}
              onCancel={() => setSelectedId(null)}
              onSaved={() => refresh()}
              onDeleted={() => {
                setSelectedId(null);
                refresh();
              }}
            />
          ) : (
            <Card className="p-6 text-sm text-muted-foreground">
              Select a block on the left to edit, or add a new one.
            </Card>
          )}
        </div>
      </section>
    </div>
  );
}

interface BlockFormProps {
  section: string;
  fragment: string;
  block?: ResumeBlock;
  onCancel(): void;
  onSaved(id: string): void;
  onDeleted?(): void;
}

function BlockForm({ section, fragment, block, onCancel, onSaved, onDeleted }: BlockFormProps) {
  const isNew = !block;
  const [id, setId] = useState(block?.id ?? '');
  const [title, setTitle] = useState(block?.title ?? '');
  const [tags, setTags] = useState((block?.tags ?? []).join(', '));
  const [bulletIds, setBulletIds] = useState((block?.bullets ?? []).map((b) => b.id).join(', '));
  const [techStack, setTechStack] = useState(block?.tech_stack_line ?? '');
  const [alwaysInclude, setAlwaysInclude] = useState(block?.always_include ?? false);
  const [latex, setLatex] = useState(fragment);

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        section,
        title: title.trim() || undefined,
        tags: parseList(tags),
        always_include: alwaysInclude || undefined,
        tech_stack_line: techStack.trim() || undefined,
        bullets: parseList(bulletIds).map((bid) => ({ id: bid })),
        latex,
      };
      if (isNew) {
        return send<{ created: boolean; block: ResumeBlock }>('/api/resume/blocks', 'POST', { id, ...body });
      }
      return send<{ created: boolean; block: ResumeBlock }>(`/api/resume/blocks/${encodeURIComponent(block!.id)}`, 'PUT', body);
    },
    onSuccess: (r) => onSaved(r.block.id),
  });

  const del = useMutation({
    mutationFn: () => send<{ deleted: boolean }>(`/api/resume/blocks/${encodeURIComponent(block!.id)}`, 'DELETE'),
    onSuccess: () => onDeleted?.(),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  return (
    <form onSubmit={submit} className="flex min-w-0 flex-col gap-3">
      <Card className="flex flex-col gap-3 p-4">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label="id" help="lowercase, alnum + . _ -">
            <Input value={id} onChange={(e) => setId(e.target.value)} readOnly={!isNew} />
          </Field>
          <Field label="title" help="display name in this editor">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label="tags" help="comma-separated; the LLM uses these to match the JD">
            <Input value={tags} onChange={(e) => setTags(e.target.value)} />
          </Field>
          <Field label="bullet ids" help="one id per bullet, in order; used later for rewrites">
            <Input value={bulletIds} onChange={(e) => setBulletIds(e.target.value)} />
          </Field>
          {section === 'projects' && (
            <Field label="tech stack line" help="verbatim contents of the \\emph{...} line">
              <Input value={techStack} onChange={(e) => setTechStack(e.target.value)} />
            </Field>
          )}
          <Field label="always include">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={alwaysInclude} onChange={(e) => setAlwaysInclude(e.target.checked)} />
              Always include this block, even when the LLM doesn’t pick it
            </label>
          </Field>
        </div>

        <Field label="LaTeX" help="Pasted verbatim between the section wrappers. No preamble, no \\section{}.">
          <Textarea
            value={latex}
            onChange={(e) => setLatex(e.target.value)}
            rows={16}
            className="font-mono text-xs"
            spellCheck={false}
          />
        </Field>

        {save.error && <p className="text-xs text-red-600">{(save.error as Error).message}</p>}
        {del.error && <p className="text-xs text-red-600">{(del.error as Error).message}</p>}

        <div className="flex items-center justify-between">
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={save.isPending}>
              <Save className="h-3.5 w-3.5" />
              {isNew ? 'Create block' : 'Save'}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={onCancel}>
              Cancel
            </Button>
          </div>
          {!isNew && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                if (confirm(`Delete block ${block!.id}? Its .tex file is removed.`)) del.mutate();
              }}
              disabled={del.isPending}
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete
            </Button>
          )}
        </div>
        {!isNew && block?.tags?.length ? (
          <div className="flex flex-wrap gap-1 pt-2">
            {block.tags.map((t) => (
              <Badge key={t} variant="outline">
                {t}
              </Badge>
            ))}
          </div>
        ) : null}
      </Card>
    </form>
  );
}

function Field({ label, help, children }: { label: string; help?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium">{label}</span>
      {children}
      {help && <span className="text-[11px] text-muted-foreground">{help}</span>}
    </label>
  );
}

function parseList(s: string): string[] {
  return s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}
