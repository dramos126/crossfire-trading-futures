import { FieldBadge } from "@/components/field-badge";
import { INTENT_LABELS, type StrategyIntent } from "@/lib/trading/strategy-types";

/**
 * Renders a playbook's `config.intent` as `FieldBadge`s, in declared order,
 * through the one wording in `INTENT_LABELS`.
 *
 * **Guidance only.** The badge states which admission shelf a playbook
 * cleared — it is not itself a gate, and nothing about rendering it may
 * start branching on the value; see `StrategyConfig.intent`'s doc comment
 * and `strategy-types.test.ts`.
 *
 * Absent or empty renders nothing, not an empty wrapper — an unlabelled
 * module shows no badge at all rather than a placeholder slot.
 */
export function IntentBadges({
  intent,
  className,
}: {
  intent: ReadonlyArray<StrategyIntent> | undefined;
  className?: string;
}) {
  if (!intent || intent.length === 0) return null;
  return (
    <span className={`inline-flex items-center gap-1 ${className ?? ""}`}>
      {intent.map((i) => (
        <FieldBadge key={i} label={INTENT_LABELS[i]} />
      ))}
    </span>
  );
}
