import { STATUS_PRESENTATION } from '@/lib/shipment-normalizer/status';
import type { NormalizedStatus } from '@/lib/types';

export function StatusBadge({
  status,
  resolved = false,
}: {
  status: NormalizedStatus;
  resolved?: boolean;
}) {
  const presentation = STATUS_PRESENTATION[status];
  // A resolved shipment keeps its real status but stops shouting about it.
  const tone = resolved ? 'neutral' : presentation.tone;
  return (
    <span className={`badge tone-${tone}`} title={presentation.description}>
      {presentation.display}
      {resolved ? ' · resolved' : ''}
    </span>
  );
}
