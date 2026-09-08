import styles from "./AgentStatusLine.module.css";

/**
 * The "agent is working" indicator: a slowly turning spark beside a label whose color drifts along
 * the gray ramp.
 *
 * It stays up for as long as the agent holds the turn, so its disappearance -- rather than a
 * separate piece of chrome -- is what says the turn is done. Everything here sits in the muted text
 * ramp on purpose: the motion should be findable when looked for and ignorable when not.
 *
 * `presentational` drops the live region, for a second copy of a status already announced elsewhere
 * on screen -- two live regions carrying the same words would announce the turn twice.
 */
export function AgentStatusLine({
  label,
  className = "",
  presentational = false
}: {
  label: string;
  className?: string;
  presentational?: boolean;
}) {
  return (
    <div
      role={presentational ? undefined : "status"}
      aria-hidden={presentational || undefined}
      className={`inline-flex items-center gap-2 px-1.5 py-1 text-ui-md ${className}`}
    >
      <span aria-hidden="true" className={styles.spark}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 2.6c.75 4.9 4.5 8.65 9.4 9.4-4.9.75-8.65 4.5-9.4 9.4-.75-4.9-4.5-8.65-9.4-9.4 4.9-.75 8.65-4.5 9.4-9.4Z" />
        </svg>
      </span>
      <span className={styles.label}>{label}</span>
    </div>
  );
}
