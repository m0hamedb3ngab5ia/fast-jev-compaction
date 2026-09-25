import { messageChars } from './compact.js';
import { collectToolCalls } from './state.js';
import type { Message } from './types.js';

/**
 * How a compaction runs: Jev pruning, Claude Code's built-in summary, or Jev
 * first with the summary as fallback when the reduction is too small.
 */
export type CompactionStrategy = 'jev' | 'builtin' | 'jev_then_builtin';

/** Character counts, in `messageChars` units, that the routing rules read. */
export interface TranscriptSignals {
  totalChars: number;
  /** Tool inputs plus tool results. */
  toolChars: number;
  /** User and assistant text. */
  proseChars: number;
  /** Inputs plus results of calls outside the pinned messages: all Jev can ever remove. */
  prunableChars: number;
  /** Prunable calls repeated later with the same tool and input (stale re-reads). */
  repeatedChars: number;
  /** Prose a summary would lose: code, file paths, commands, errors. */
  exactProseChars: number;
}

export interface RoutingOptions {
  /** Tool share of the transcript at or above which Jev runs alone. Default 0.6. */
  toolHeavyThreshold: number;
  /** Prose share at or above which the built-in summary runs alone. Default 0.6. */
  proseHeavyThreshold: number;
  /** Reduction Jev must reach for its result to replace the summary. Default 0.25. */
  minReductionRatio: number;
}

export interface CompactionRoute {
  strategy: CompactionStrategy;
  /** Short human-readable cause, for the toast. */
  reason: string;
  signals: TranscriptSignals;
}

export const DEFAULT_ROUTING: RoutingOptions = {
  toolHeavyThreshold: 0.6,
  proseHeavyThreshold: 0.6,
  minReductionRatio: 0.25,
};

/** Share of prose that is exact technical detail above which a summary is avoided. */
const EXACT_PROSE_SHARE = 0.3;

const EXACT_LINE = new RegExp(
  [
    String.raw`(?:^|[\s(\x60'"])[\w.~-]*/[\w./-]*\w\.\w{1,6}\b`, // a file path with an extension
    String.raw`^\s*[$>#] \S`, // a shell prompt
    String.raw`\b(?:npm|npx|git|gh|python3?|pip|pytest|node|cargo|go|make|docker|kubectl|curl|brew|xcodebuild)\s+-{0,2}\w`,
    String.raw`\b\w*(?:Error|Exception)\b|Traceback|\bFAIL(?:ED)?\b|\bERR_[A-Z_]+|exit code \d+|\bE[A-Z]{3,}\b`,
    String.raw`\x60[^\x60\n]+\x60`, // inline code
  ].join('|'),
);

/** Characters of `text` on lines inside code fences or matching `EXACT_LINE`. */
export function exactChars(text: string): number {
  let total = 0;
  let fenced = false;
  for (const line of text.split('\n')) {
    const fence = line.trimStart().startsWith('```');
    if (fence || fenced || EXACT_LINE.test(line)) total += line.length + 1;
    if (fence) fenced = !fenced;
  }
  return Math.min(total, text.length);
}

function inputChars(input: Record<string, unknown>): number {
  try {
    return JSON.stringify(input).length;
  } catch {
    return 20;
  }
}

function inputKey(tool: string, input: Record<string, unknown>): string {
  try {
    return `${tool} ${JSON.stringify(input)}`;
  } catch {
    return `${tool} [unserializable]`;
  }
}

export function measureTranscript(
  messages: readonly Message[],
  preserveRecentMessages: number,
): TranscriptSignals {
  let totalChars = 0;
  let proseChars = 0;
  let exactProseChars = 0;
  for (const message of messages) {
    totalChars += messageChars(message);
    proseChars += message.text.length;
    exactProseChars += exactChars(message.text);
  }
  const calls = collectToolCalls(messages, preserveRecentMessages);
  const lastIndex = new Map<string, number>();
  calls.forEach((call, index) => lastIndex.set(inputKey(call.tool, call.input), index));
  let prunableChars = 0;
  let repeatedChars = 0;
  calls.forEach((call, index) => {
    if (call.pinned) return;
    const chars = inputChars(call.input) + call.resultChars;
    prunableChars += chars;
    if ((lastIndex.get(inputKey(call.tool, call.input)) ?? index) > index) repeatedChars += chars;
  });
  return {
    totalChars,
    toolChars: totalChars - proseChars,
    proseChars,
    prunableChars,
    repeatedChars,
    exactProseChars,
  };
}

function pct(part: number, whole: number): string {
  return `${whole === 0 ? 0 : Math.round((part / whole) * 100)}%`;
}

/** The routing rules, first match wins. */
export function chooseStrategy(
  signals: TranscriptSignals,
  options: RoutingOptions,
): CompactionRoute {
  const { totalChars: total, toolChars, proseChars, prunableChars, repeatedChars, exactProseChars } =
    signals;
  const share = (part: number) => (total === 0 ? 0 : part / total);
  const shares = `tools ${pct(toolChars, total)}, prose ${pct(proseChars, total)}`;
  const route = (strategy: CompactionStrategy, reason: string): CompactionRoute => ({
    strategy,
    reason,
    signals,
  });

  if (share(prunableChars) < options.minReductionRatio) {
    return route(
      'builtin',
      `Jev can remove at most ${pct(prunableChars, total)} (below ${pct(options.minReductionRatio, 1)} minimum)`,
    );
  }
  if (share(repeatedChars) >= options.minReductionRatio) {
    return route('jev', `repeated tool calls ${pct(repeatedChars, total)} of context`);
  }
  if (share(toolChars) >= options.toolHeavyThreshold) {
    return route('jev', `tool-heavy session (${shares})`);
  }
  const exactShare = proseChars === 0 ? 0 : exactProseChars / proseChars;
  if (share(proseChars) >= options.proseHeavyThreshold) {
    if (exactShare < EXACT_PROSE_SHARE) return route('builtin', `prose-heavy session (${shares})`);
    return route(
      'jev_then_builtin',
      `prose must stay verbatim (${pct(exactProseChars, proseChars)} code/paths/errors; ${shares})`,
    );
  }
  return route('jev_then_builtin', `mixed session (${shares})`);
}

export function routeCompaction(
  messages: readonly Message[],
  options: RoutingOptions & { preserveRecentMessages: number },
): CompactionRoute {
  return chooseStrategy(measureTranscript(messages, options.preserveRecentMessages), options);
}
