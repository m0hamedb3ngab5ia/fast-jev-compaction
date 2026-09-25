import { describe, expect, it, vi } from 'vitest';
import {
  compactSession,
  decisionLog,
  decisionLogLines,
  register,
  resolveHookConfig,
  summarize,
  toSessionMessages,
} from '../hooks/fast-jev.ts';
import { applyDecisions, collectToolCalls, decideCall, type Message } from '../src/index.js';

type SessionMessage = Message & { handle?: string };

function message(role: Message['role'], text: string, extra: Partial<SessionMessage> = {}): SessionMessage {
  return { role, text, toolUses: [], ...extra };
}

function call(id: string, tool: string, input: Record<string, unknown>, text: string): SessionMessage {
  return message('assistant', '', {
    toolUses: [{ tool_use_id: id, tool, input, text }],
    handle: `h-${id}`,
  });
}

function result(id: string, text: string, isError = false): SessionMessage {
  return message('user', '', { toolResults: [{ tool_use_id: id, text, isError }], handle: `r-${id}` });
}

const fileA = 'export const a = 1;\n'.repeat(50);

function transcript(): SessionMessage[] {
  return [
    message('user', 'Fix the failing test.', { handle: 'h-0' }),
    call('tool-1', 'Read', { file_path: 'src/a.ts' }, fileA),
    result('tool-1', fileA),
    call('tool-2', 'Bash', { command: 'npm test' }, 'FAIL'),
    result('tool-2', 'FAIL b.test.ts: expected 2 to be 3', true),
    message('assistant', 'Fixing now.', { handle: 'h-5' }),
    message('user', 'go ahead', { handle: 'h-6' }),
  ];
}

function jevFetch(answer: (name: string) => number, bodies: string[] = []) {
  return async (_url: string, init?: { body?: string }) => {
    bodies.push(init?.body ?? '');
    const { questions } = JSON.parse(init?.body ?? '{}') as { questions: Record<string, unknown> };
    const answers = Object.fromEntries(
      Object.keys(questions).map((key) => [key, { type: 'noul', noul: answer(key) }]),
    );
    return { status: 200, ok: true, text: JSON.stringify({ answers }) };
  };
}

describe('hook config', () => {
  it('reads userConfig values and falls back to defaults', () => {
    expect(resolveHookConfig({})).toEqual({
      compactAtPercent: 60,
      minReductionRatio: 0.25,
      model: 'jev-latest',
      smartRoutingEnabled: true,
      toolHeavyThreshold: 0.6,
      proseHeavyThreshold: 0.6,
    });
    expect(
      resolveHookConfig({ smartRoutingEnabled: false, toolHeavyThreshold: 0.7, proseHeavyThreshold: 'x' }),
    ).toMatchObject({ smartRoutingEnabled: false, toolHeavyThreshold: 0.7, proseHeavyThreshold: 0.6 });
    expect(
      resolveHookConfig({ apiKey: 'k', keepThreshold: 0.3, maxStateTokens: 1000, model: 'jev-x', goal: 'g', compactAtPercent: 'no' }),
    ).toEqual({
      apiKey: 'k',
      keepThreshold: 0.3,
      maxStateTokens: 1000,
      model: 'jev-x',
      goal: 'g',
      compactAtPercent: 60,
      minReductionRatio: 0.25,
      smartRoutingEnabled: true,
      toolHeavyThreshold: 0.6,
      proseHeavyThreshold: 0.6,
    });
  });
});

describe('session message mapping', () => {
  it('returns the engine objects for untouched messages and handle-less copies for rebuilt ones', () => {
    const messages = transcript();
    const calls = collectToolCalls(messages, 0);
    const decisions = [
      decideCall(calls[0]!, { keepCall: 0.9, keepResult: 0.1 }, { keepThreshold: 0.5 }),
      decideCall(calls[1]!, { keepCall: 0.9, keepResult: 0.9 }, { keepThreshold: 0.5 }),
    ];
    messages[1]!.toolUses[0]!.text = 'x'.repeat(2000);
    messages[2]!.toolResults![0]!.text = 'x'.repeat(2000);
    const out = toSessionMessages(messages, applyDecisions(messages, decisions, calls, 300));
    expect(out).toHaveLength(messages.length);
    expect(out[0]).toBe(messages[0]);
    expect(out[1]?.handle).toBeUndefined();
    expect(out[1]?.toolUses[0]?.text).toMatch(
      new RegExp(`^${'x'.repeat(300)}\\n\\[fast-jev-compaction truncated 1700 chars`),
    );
    expect(out[2]?.handle).toBeUndefined();
    expect(out[2]?.toolResults?.[0]?.text).toMatch(
      new RegExp(`^${'x'.repeat(300)}\\n\\[fast-jev-compaction truncated 1700 chars`),
    );
    expect(out[2]?.toolResults?.[0]).toMatchObject({ tool_use_id: 'tool-1', isError: false });
    expect(out[3]).toBe(messages[3]);
    expect(out[4]).toBe(messages[4]);
  });

  it('preserves short dropped-result messages and their handles', () => {
    const messages = transcript();
    messages[1]!.toolUses[0]!.text = 'y'.repeat(100);
    messages[2]!.toolResults![0]!.text = 'y'.repeat(100);
    const calls = collectToolCalls(messages, 0);
    const decisions = [
      decideCall(calls[0]!, { keepCall: 0.9, keepResult: 0.1 }, { keepThreshold: 0.5 }),
      decideCall(calls[1]!, { keepCall: 0.9, keepResult: 0.9 }, { keepThreshold: 0.5 }),
    ];
    const out = toSessionMessages(messages, applyDecisions(messages, decisions, calls, 300));
    expect(out[1]).toBe(messages[1]);
    expect(out[2]).toBe(messages[2]);
  });
});

describe('compactSession', () => {
  it('runs the library over the engine fetch and reports the outcome', async () => {
    const bodies: string[] = [];
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1 }), apiKey: 'k', model: 'jev-x' };
    const { result: output, messages } = await compactSession(
      transcript(),
      config,
      jevFetch((name) => (name === 'call_t2' || name === 'result_t2' ? 0.9 : 0.1), bodies),
    );
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0]!).model).toBe('jev-x');
    expect(output.decisions.map((d) => d.action)).toEqual(['drop_call', 'keep']);
    expect(messages.map((m) => m.handle)).toEqual(['h-0', 'h-tool-2', 'r-tool-2', 'h-5', 'h-6']);
    expect(summarize(output)).toMatch(/^\d+% reduction; 1 kept, 1 call_dropped; state ~\d+ tokens \(full\) in 1 request\(s\)$/);
    expect(decisionLog(output)).toBe('t1:Read:drop_call/call=0.10/result=0.10 t2:Bash:keep/call=0.90/result=0.90');
    expect(decisionLogLines(output)).toEqual([`decisions: ${decisionLog(output)}`]);
  });

  it('splits a long decision log into ui.log lines under the host limit', async () => {
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1 }), apiKey: 'k' };
    const { result: output } = await compactSession(transcript(), config, jevFetch(() => 0.1));
    const lines = decisionLogLines(output, 60);
    expect(lines).toEqual([
      'decisions (1/2): t1:Read:drop_call/call=0.10/result=0.10',
      'decisions (2/2): t2:Bash:drop_call/call=0.10/result=0.10',
    ]);
    expect(lines.every((line) => line.length <= 60)).toBe(true);
    expect(decisionLogLines({ ...output, decisions: [] })).toEqual(['decisions: (none)']);
  });

  it('throws on a missing key and on failed requests so the hook falls back', async () => {
    const config = resolveHookConfig({ preserveRecentMessages: 1 });
    await expect(compactSession(transcript(), config, jevFetch(() => 0))).rejects.toThrow(/TYPESAFE_API_KEY/);
    await expect(
      compactSession(transcript(), { ...config, apiKey: 'k' }, async () => ({ status: 500, ok: false, text: 'x' })),
    ).rejects.toThrow(/500/);
  });
});

type Fetch = (url: string, init?: { body?: string }) => Promise<{ status: number; ok: boolean; text: string }>;

/** Registers the hook against a fake engine; `next` stands in for Claude Code's built-in summary. */
function engine(options: Record<string, unknown> = {}, fetch: Fetch = jevFetch(() => 0.1), key: string | null = 'k') {
  const handlers: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  register(((name: string, handler: (...args: unknown[]) => Promise<unknown>) => {
    handlers[name] = handler;
  }) as never, options as never);
  const toasts: string[] = [];
  const logs: string[] = [];
  let fetches = 0;
  const $ = {
    http: { fetch: (url: string, init?: { body?: string }) => ((fetches += 1), fetch(url, init)) },
    ui: { log: (text: string) => logs.push(text), toast: (text: string) => toasts.push(text) },
    env: { get: async () => key ?? undefined },
    settings: { read: async () => ({}) },
  };
  const summary = { messages: [message('assistant', 'built-in summary')] };
  const next = vi.fn(async () => summary);
  return {
    compact: (messages: SessionMessage[]) => handlers['session.compact']!($, { trigger: 'manual', messages }, next),
    toasts,
    logs,
    next,
    summary,
    fetches: () => fetches,
  };
}

const prose = (n: number) => 'We should weigh the trade-offs of this approach carefully. '.repeat(n);

function tail(): SessionMessage[] {
  return ['ok', 'next', 'ok', 'next', 'ok', 'thanks'].map((text, i) =>
    message(i % 2 ? 'user' : 'assistant', text, { handle: `tail-${i}` }),
  );
}

function toolHeavy(): SessionMessage[] {
  const out: SessionMessage[] = [message('user', 'Fix the failing test.', { handle: 'h-0' })];
  for (let i = 1; i <= 6; i++) out.push(call(`tool-${i}`, 'Read', { file_path: `src/f${i}.ts` }, ''), result(`tool-${i}`, 'x'.repeat(3000)));
  return [...out, ...tail()];
}

function proseHeavy(): SessionMessage[] {
  return [
    message('user', 'Plan the quarter.', { handle: 'h-0' }),
    call('tool-1', 'WebFetch', { url: 'https://example.com' }, ''),
    result('tool-1', 'y'.repeat(5000)),
    ...Array.from({ length: 8 }, (_, i) => message(i % 2 ? 'user' : 'assistant', prose(25))),
    ...tail(),
  ];
}

function mixed(): SessionMessage[] {
  return [
    message('user', 'Refactor the loader.', { handle: 'h-0' }),
    call('tool-1', 'Read', { file_path: 'src/loader.ts' }, ''),
    result('tool-1', 'z'.repeat(6000)),
    ...Array.from({ length: 4 }, (_, i) => message(i % 2 ? 'user' : 'assistant', prose(25))),
    ...tail(),
  ];
}

describe('smart routing in session.compact', () => {
  it('prunes a tool-heavy session with Jev and never calls the built-in summary', async () => {
    const hook = engine();
    const input = toolHeavy();
    const out = (await hook.compact(input)) as { messages: SessionMessage[] };
    expect(hook.next).not.toHaveBeenCalled();
    expect(hook.fetches()).toBe(1);
    expect(out.messages[0]).toBe(input[0]);
    expect(out.messages.slice(-6)).toEqual(input.slice(-6));
    out.messages.slice(-6).forEach((m, i) => expect(m).toBe(input[input.length - 6 + i]));
    expect(hook.toasts).toEqual([expect.stringMatching(/^smart-compact: strategy=jev, reduction=\d+%, kept 7\/19 messages$/)]);
  });

  it('keeps tool call/result pairs valid in the pruned transcript', async () => {
    const hook = engine({}, jevFetch((name) => (name.endsWith('t2') ? 0.9 : 0.1)));
    const out = (await hook.compact(toolHeavy())) as { messages: SessionMessage[] };
    const uses = new Set(out.messages.flatMap((m) => m.toolUses.map((t) => t.tool_use_id)));
    const results = out.messages.flatMap((m) => (m.toolResults ?? []).map((r) => r.tool_use_id));
    expect(results).toEqual(['tool-2']);
    expect(results.every((id) => uses.has(id))).toBe(true);
  });

  it('sends a prose-heavy session straight to the built-in summary without asking Jev', async () => {
    const hook = engine();
    const input = proseHeavy();
    expect(await hook.compact(input)).toBe(hook.summary);
    expect(hook.next).toHaveBeenCalledOnce();
    expect(hook.next).toHaveBeenCalledWith({ trigger: 'manual', messages: input });
    expect(hook.fetches()).toBe(0);
    expect(hook.toasts).toEqual([expect.stringMatching(/^smart-compact: strategy=builtin, prose-heavy session \(tools \d+%, prose \d+%\)$/)]);
  });

  it('tries Jev on a mixed session and falls back when the reduction is too small', async () => {
    const hook = engine({}, jevFetch(() => 0.9));
    expect(await hook.compact(mixed())).toBe(hook.summary);
    expect(hook.fetches()).toBe(1);
    expect(hook.next).toHaveBeenCalledOnce();
    expect(hook.toasts).toEqual(['smart-compact: strategy=jev_then_builtin, Jev reduction=0%, falling back to built-in']);
  });

  it('uses the Jev result on a mixed session when the reduction is enough', async () => {
    const hook = engine();
    const out = (await hook.compact(mixed())) as { messages: SessionMessage[] };
    expect(hook.next).not.toHaveBeenCalled();
    expect(out.messages.length).toBeLessThan(mixed().length);
    expect(hook.toasts[0]).toMatch(/^smart-compact: strategy=jev_then_builtin, reduction=\d+%/);
  });

  it('falls back to the built-in summary when Jev fails', async () => {
    const hook = engine({}, async () => ({ status: 500, ok: false, text: 'boom' }));
    expect(await hook.compact(toolHeavy())).toBe(hook.summary);
    expect(hook.next).toHaveBeenCalledOnce();
    expect(hook.toasts[0]).toMatch(/^smart-compact: strategy=jev, Jev failed \(.*500.*\), falling back to built-in$/);
  });

  it('falls back when Jev answers are malformed', async () => {
    const hook = engine({}, async () => ({ status: 200, ok: true, text: JSON.stringify({ answers: {} }) }));
    expect(await hook.compact(toolHeavy())).toBe(hook.summary);
    expect(hook.next).toHaveBeenCalledOnce();
  });

  it('falls back when no TypeSafe key is configured', async () => {
    const hook = engine({}, jevFetch(() => 0.1), null);
    expect(await hook.compact(toolHeavy())).toBe(hook.summary);
    expect(hook.next).toHaveBeenCalledOnce();
    expect(hook.toasts[0]).toMatch(/Jev failed \(TYPESAFE_API_KEY is not configured\)/);
  });

  it('never blocks /compact when routing itself throws', async () => {
    const hook = engine();
    const broken = [...toolHeavy(), { role: 'user', toolUses: [] } as unknown as SessionMessage];
    await expect(hook.compact(broken)).resolves.toBe(hook.summary);
    expect(hook.next).toHaveBeenCalledOnce();
    expect(hook.logs[0]).toMatch(/^smart-compact: routing failed \(.+\), using jev_then_builtin$/);
  });

  it('behaves like upstream when smart routing is off', async () => {
    const hook = engine({ smartRoutingEnabled: false });
    const out = (await hook.compact(proseHeavy())) as { messages: SessionMessage[] };
    expect(hook.fetches()).toBe(1);
    expect(hook.next).not.toHaveBeenCalled();
    expect(out.messages.length).toBeLessThan(proseHeavy().length);
    expect(hook.toasts[0]).toMatch(/^smart-compact: strategy=jev_then_builtin, reduction=\d+%/);
  });
});
