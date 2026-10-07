import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import type { ReviewItemAny } from '@/lib/api';

/** Placeholder until Phase 11 adds application drafts. */
export function ApplicationCard({ item }: { item: ReviewItemAny }) {
  return (
    <Card className="p-4 text-sm">
      <Badge variant="outline">application</Badge> {item.jobTitle}
    </Card>
  );
}
