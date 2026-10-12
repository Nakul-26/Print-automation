import { describe, expect, it } from 'vitest';
import { planCapacity } from '../src/platform/capacity/capacity.js';
import { createGate, GateFullError } from '../src/platform/capacity/gate.js';

const GB = 1024 ** 3;

describe('planCapacity', () => {
  it('leaves one core for the web server and the database', () => {
    expect(planCapacity({ cores: 4, memoryBytes: 16 * GB, jobMemoryMb: 600 }).jobs).toBe(3);
  });

  it('is limited by memory when the server has little of it', () => {
    // 2 GB / 600 MB = 3 jobs even though 16 cores could run more
    expect(planCapacity({ cores: 16, memoryBytes: 2 * GB, jobMemoryMb: 600 }).jobs).toBe(3);
  });

  it('never drops below one job, even on a tiny machine', () => {
    expect(planCapacity({ cores: 1, memoryBytes: 256 * 1024 * 1024, jobMemoryMb: 600 })).toEqual({
      jobs: 1,
      office: 1,
      previews: 1,
    });
  });

  it('gives Office conversions about half the slots, never more than all of them', () => {
    expect(planCapacity({ cores: 9, memoryBytes: 64 * GB, jobMemoryMb: 600 })).toMatchObject({
      jobs: 8,
      office: 4,
    });
    expect(
      planCapacity({ cores: 4, memoryBytes: 16 * GB, jobMemoryMb: 600, jobs: 2, office: 9 }),
    ).toMatchObject({ jobs: 2, office: 2 });
  });

  it('keeps previews within the memory of a small API container', () => {
    // 16 cores but only 1 GB: 60% of 1 GB / 200 MB = 3 previews
    expect(planCapacity({ cores: 16, memoryBytes: 1 * GB, jobMemoryMb: 600 }).previews).toBe(3);
  });

  it('lets explicit settings override the calculation', () => {
    expect(
      planCapacity({ cores: 2, memoryBytes: 4 * GB, jobMemoryMb: 600, jobs: 6, previews: 5 }),
    ).toMatchObject({ jobs: 6, previews: 5 });
  });
});

describe('createGate', () => {
  const pause = () => {
    let release!: () => void;
    const done = new Promise<void>((resolve) => (release = resolve));
    return { done, release };
  };

  it('runs at most `limit` tasks at once and the rest in arrival order', async () => {
    const gate = createGate(2, 10);
    const started: number[] = [];
    const holds = [pause(), pause(), pause(), pause()];
    const runs = holds.map((hold, i) =>
      gate.run(async () => {
        started.push(i);
        await hold.done;
        return i;
      }),
    );
    await Promise.resolve();
    expect(started).toEqual([0, 1]);
    expect(gate.stats).toEqual({ running: 2, waiting: 2 });

    holds[0]!.release();
    await runs[0];
    await Promise.resolve();
    expect(started).toEqual([0, 1, 2]);

    holds.forEach((h) => h.release());
    expect(await Promise.all(runs)).toEqual([0, 1, 2, 3]);
    expect(gate.stats).toEqual({ running: 0, waiting: 0 });
  });

  it('turns callers away once the waiting line is full', async () => {
    const gate = createGate(1, 1);
    const hold = pause();
    const first = gate.run(() => hold.done);
    const second = gate.run(async () => 'second');
    await expect(gate.run(async () => 'third')).rejects.toBeInstanceOf(GateFullError);
    hold.release();
    await first;
    expect(await second).toBe('second');
  });

  it('frees the slot when a task fails', async () => {
    const gate = createGate(1, 0);
    await expect(
      gate.run(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await gate.run(async () => 'ok')).toBe('ok');
  });
});
