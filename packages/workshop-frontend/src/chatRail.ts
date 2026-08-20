// Tone logic for the agent turn's timeline rail. Each thing an agent turn produces -- its
// reasoning, its tool calls, its prose -- becomes one dot on a vertical rail, and the dot's
// colour reports how that step went.
//
// This lives apart from ChatInterface.tsx so it can be tested without mounting the chat. The
// Tailwind classes the tones map to stay in the component, where the design-token guard
// (scripts/design-tokens.test.ts, which reads .tsx only) can see them.

/** How a rail dot reads: an outcome, or the absence of one. */
export type RailTone = "success" | "danger" | "pending" | "neutral";

/**
 * A step in an agent turn, as far as the rail is concerned.
 *
 * `inFlight` marks a step the agent is still producing. It holds for as long as the step is
 * provisional -- streaming state is cleared per step as each message arrives, so a step stops
 * being in flight when it commits, not when the whole turn ends.
 */
export type RailNodeSpec =
  | { type: "thinking"; inFlight?: boolean }
  | { type: "text"; inFlight?: boolean }
  | {
      type: "toolGroup";
      /** Whether any call in the group reported an error. */
      hasError: boolean;
      inFlight?: boolean;
    };

/** Picks the tone for one step of an agent turn. */
export function railToneFor(node: RailNodeSpec): RailTone {
  // An error is terminal: report it as soon as it lands rather than waiting for the turn to
  // settle, so the dot never walks backwards from red to green.
  if (node.type === "toolGroup" && node.hasError) return "danger";
  if (node.inFlight) return "pending";
  return node.type === "toolGroup" ? "success" : "neutral";
}

/**
 * The dot's colour as text, for assistive technology and to satisfy WCAG 1.4.1 -- green versus
 * red must not be the only thing carrying the outcome. Null where there is no outcome to report
 * and the node's own content says everything.
 */
export function railStatusLabel(tone: RailTone): string | null {
  switch (tone) {
    case "success":
      return "Succeeded";
    case "danger":
      return "Failed";
    case "pending":
      return "Running";
    case "neutral":
      return null;
  }
}
