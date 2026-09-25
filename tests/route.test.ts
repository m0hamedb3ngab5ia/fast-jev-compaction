import { describe, expect, it } from 'vitest';
import {
  chooseStrategy,
  DEFAULT_ROUTING,
  measureTranscript,
  routeCompaction,
  type Message,
  type TranscriptSignals,
} from '../src/index.js';

function message(role: Message['role'], text: string, extra: Partial<Message> = {}): Message {
  return { role, text, toolUses: [], ...extra };
}

function call(id: string, tool: string, input: Record<string, unknown>): Message {
  return message('assistant', '', { toolUses: [{ tool_use_id: id, tool, input }] });
}

function result(id: string, text: string): Message {
  return message('user', '', { toolResults: [{ tool_use_id: id, text }] });
}

const prose = (n: number) => 'We should weigh the trade-offs of this approach carefully. '.repeat(n);

/** Six small closing messages, so the newest pinned window holds no tool calls. */
function tail(): Message[] {
  return [
    message('assistant', 'ok'),
    message('user', 'next'),
    message('assistant', 'ok'),
    message('user', 'next'),
    message('assistant', 'ok'),
    message('user', 'thanks'),
  ];
}

function toolHeavy(): Message[] {
  const out: Message[] = [message('user', 'Fix the failing test.')];
  for (let i = 1; i <= 6; i++) {
    out.push(call(`t${i}`, 'Read', { file_path: `src/file${i}.ts` }), result(`t${i}`, 'x'.repeat(3000)));
  }
  return [...out, ...tail()];
}

function proseHeavy(): Message[] {
  return [
    message('user', 'Let us plan the next quarter.'),
    call('t1', 'WebFetch', { url: 'https://example.com/notes' }),
    result('t1', 'y'.repeat(5000)),
    ...Array.from({ length: 8 }, (_, i) => message(i % 2 ? 'user' : 'assistant', prose(25))),
    ...tail(),
  ];
}

function mixed(): Message[] {
  return [
    message('user', 'Refactor the loader.'),
    call('t1', 'Read', { file_path: 'src/loader.ts' }),
    result('t1', 'z'.repeat(6000)),
    ...Array.from({ length: 4 }, (_, i) => message(i % 2 ? 'user' : 'assistant', prose(25))),
    ...tail(),
  ];
}

describe('measureTranscript', () => {
  it('splits characters into tool, prose, prunable and repeated', () => {
    const messages = [
      message('user', 'Fix it.'),
      call('t1', 'Read', { file_path: 'a.ts' }),
      result('t1', 'a'.repeat(100)),
      call('t2', 'Read', { file_path: 'a.ts' }),
      result('t2', 'a'.repeat(100)),
      ...tail(),
    ];
    const signals = measureTranscript(messages, 6);
    const input = JSON.stringify({ file_path: 'a.ts' }).length;
    expect(signals.toolChars).toBe(2 * (input + 100));
    expect(signals.proseChars).toBe('Fix it.'.length + 'oknextoknextokthanks'.length);
    expect(signals.totalChars).toBe(signals.toolChars + signals.proseChars);
    expect(signals.prunableChars).toBe(2 * (input + 100));
    expect(signals.repeatedChars).toBe(input + 100);
  });

  it('never counts pinned calls as prunable', () => {
    const messages = [message('user', 'hi'), call('t1', 'Bash', { command: 'ls' }), result('t1', 'x'.repeat(500))];
    const signals = measureTranscript(messages, 6);
    expect(signals.toolChars).toBeGreaterThan(500);
    expect(signals.prunableChars).toBe(0);
  });

  it('counts prose that must stay verbatim: code, paths, commands, errors', () => {
    const exact = [
      'Edit src/careeros/tracker.py and rerun it.',
      '$ npm run build',
      'TypeError: Cannot read properties of undefined',
      '```ts\nconst a = 1;\n```',
    ].join('\n');
    const signals = measureTranscript([message('user', exact), message('assistant', prose(2))], 0);
    expect(signals.exactProseChars).toBeGreaterThanOrEqual(exact.length - 4);
    expect(signals.exactProseChars).toBeLessThan(signals.proseChars);
  });
});

describe('chooseStrategy', () => {
  const base: TranscriptSignals = {
    totalChars: 10_000,
    toolChars: 0,
    proseChars: 10_000,
    prunableChars: 0,
    repeatedChars: 0,
    exactProseChars: 0,
  };

  it('uses the built-in summary when Jev cannot reach the minimum reduction', () => {
    const route = chooseStrategy({ ...base, toolChars: 9000, proseChars: 1000, prunableChars: 1000 }, DEFAULT_ROUTING);
    expect(route.strategy).toBe('builtin');
    expect(route.reason).toMatch(/Jev can remove at most 10%/);
  });

  it('uses Jev when stale repeated calls alone reach the minimum', () => {
    const route = chooseStrategy(
      { ...base, toolChars: 3000, proseChars: 7000, prunableChars: 3000, repeatedChars: 2600 },
      DEFAULT_ROUTING,
    );
    expect(route.strategy).toBe('jev');
    expect(route.reason).toMatch(/repeated/);
  });

  it('honours configured thresholds', () => {
    const signals = { ...base, toolChars: 5000, proseChars: 5000, prunableChars: 5000 };
    expect(chooseStrategy(signals, DEFAULT_ROUTING).strategy).toBe('jev_then_builtin');
    expect(chooseStrategy(signals, { ...DEFAULT_ROUTING, toolHeavyThreshold: 0.5 }).strategy).toBe('jev');
    expect(chooseStrategy(signals, { ...DEFAULT_ROUTING, proseHeavyThreshold: 0.5 }).strategy).toBe('builtin');
  });

  it('handles an empty transcript', () => {
    const route = chooseStrategy({ ...base, totalChars: 0, proseChars: 0 }, DEFAULT_ROUTING);
    expect(route.strategy).toBe('builtin');
  });
});

describe('routeCompaction', () => {
  const options = { ...DEFAULT_ROUTING, preserveRecentMessages: 6 };

  it('sends a tool-heavy coding session to Jev', () => {
    const route = routeCompaction(toolHeavy(), options);
    expect(route.strategy).toBe('jev');
    expect(route.reason).toMatch(/tool-heavy/);
  });

  it('sends a prose-heavy planning session to the built-in summary', () => {
    const route = routeCompaction(proseHeavy(), options);
    expect(route.strategy).toBe('builtin');
    expect(route.reason).toMatch(/prose-heavy/);
  });

  it('tries Jev first on a mixed session', () => {
    const route = routeCompaction(mixed(), options);
    expect(route.strategy).toBe('jev_then_builtin');
    expect(route.reason).toMatch(/mixed/);
  });

  it('keeps prose-heavy sessions full of exact technical detail away from a lossy summary', () => {
    const exact = 'Run `npm test` in src/app/main.ts; got TypeError: x is undefined at src/app/main.ts:12\n';
    const messages = proseHeavy().map((m) => (m.text.length > 1000 ? { ...m, text: exact.repeat(17) } : m));
    const route = routeCompaction(messages, options);
    expect(route.strategy).toBe('jev_then_builtin');
    expect(route.reason).toMatch(/verbatim/);
  });

  it('skips Jev for a short session where every call is pinned', () => {
    const messages = [message('user', 'hi'), call('t1', 'Bash', { command: 'ls' }), result('t1', 'x'.repeat(5000))];
    expect(routeCompaction(messages, options).strategy).toBe('builtin');
  });
});
