import { Search } from 'lucide-react';
import { Input, Select } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { DEFAULT_FILTERS, type Filters, type RemotePolicy, type View } from '@/lib/filters';
import { cn } from '@/lib/utils';

const VIEWS: { id: View; label: string }[] = [
  { id: 'ranked', label: 'Ranked' },
  { id: 'all', label: 'All' },
  { id: 'unscored', label: 'Unscored' },
  { id: 'excluded', label: 'Excluded' },
];
const REMOTE: RemotePolicy[] = ['remote', 'hybrid', 'onsite'];

export function FilterBar({ value, onChange }: { value: Filters; onChange: (f: Filters) => void }) {
  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => onChange({ ...value, [k]: v });
  const toggleRemote = (r: RemotePolicy) =>
    set('remote', value.remote.includes(r) ? value.remote.filter((x) => x !== r) : [...value.remote, r]);
  const dirty = JSON.stringify({ ...value, view: DEFAULT_FILTERS.view }) !== JSON.stringify(DEFAULT_FILTERS);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <div role="tablist" className="inline-flex rounded-md border border-border bg-muted p-0.5">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              role="tab"
              aria-selected={value.view === v.id}
              onClick={() => set('view', v.id)}
              className={cn(
                'rounded px-2.5 py-1 text-xs font-medium',
                value.view === v.id ? 'bg-card shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {v.label}
            </button>
          ))}
        </div>
        <Select value={value.sort} onChange={(e) => set('sort', e.target.value as Filters['sort'])} aria-label="Sort" className="h-8 text-xs">
          <option value="score">Best match</option>
          <option value="posted">Newest</option>
        </Select>
        <div className="flex items-center gap-1">
          {REMOTE.map((r) => (
            <button
              key={r}
              onClick={() => toggleRemote(r)}
              aria-pressed={value.remote.includes(r)}
              className={cn(
                'rounded-md border px-2 py-1 text-xs capitalize',
                value.remote.includes(r) ? 'border-primary bg-primary text-primary-foreground' : 'border-border text-muted-foreground hover:bg-muted',
              )}
            >
              {r}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-40 flex-1">
          <Search className="pointer-events-none absolute top-2.5 left-2 h-4 w-4 text-muted-foreground" />
          <Input value={value.q} onChange={(e) => set('q', e.target.value)} placeholder="Title" className="w-full pl-8" aria-label="Title" />
        </div>
        <Input value={value.company} onChange={(e) => set('company', e.target.value)} placeholder="Company" className="w-32" aria-label="Company" />
        <Input value={value.location} onChange={(e) => set('location', e.target.value)} placeholder="Location" className="w-32" aria-label="Location" />
        <Input
          type="number"
          min={0}
          max={100}
          value={value.minScore ?? ''}
          onChange={(e) => set('minScore', e.target.value === '' ? null : Math.max(0, Math.min(100, Number(e.target.value))))}
          placeholder="Min score"
          className="w-24"
          aria-label="Minimum score"
        />
        {dirty && (
          <Button variant="ghost" size="sm" onClick={() => onChange({ ...DEFAULT_FILTERS, view: value.view })}>
            Clear
          </Button>
        )}
      </div>
    </div>
  );
}
