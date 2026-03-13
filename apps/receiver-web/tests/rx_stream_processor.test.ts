import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

describe('rx_stream_processor worklet', () => {
  it('downmixes stereo input to mono and emits rms/peak/sample payload', () => {
    const source = readFileSync(resolve(process.cwd(), 'public/rx_stream_processor.js'), 'utf8');

    let registeredCtor: (new () => { process(inputs: Float32Array[][]): boolean; port: { postMessage: (data: unknown) => void } }) | null = null;
    const posts: unknown[] = [];

    const sandbox = {
      AudioWorkletProcessor: class {
        port = {
          postMessage: (data: unknown) => {
            posts.push(data);
          }
        };
      },
      registerProcessor: (_name: string, ctor: unknown) => {
        registeredCtor = ctor as typeof registeredCtor;
      },
      Float32Array,
      Math
    };

    vm.runInNewContext(source, sandbox, { filename: 'rx_stream_processor.js' });
    expect(registeredCtor).not.toBeNull();

    const processor = new (registeredCtor as NonNullable<typeof registeredCtor>)();
    const left = Float32Array.from([1, -1, 0.5, -0.5]);
    const right = Float32Array.from([0, 0, 0, 0]);
    const keepAlive = processor.process([[left, right]]);

    expect(keepAlive).toBe(true);
    expect(posts.length).toBeGreaterThan(0);

    const last = posts[posts.length - 1] as { samples: Float32Array; rms: number; peak: number };
    expect(last.samples.length).toBe(4);
    expect(Array.from(last.samples)).toEqual([0.5, -0.5, 0.25, -0.25]);
    expect(last.peak).toBeCloseTo(0.5, 6);
    expect(last.rms).toBeCloseTo(0.3952847, 6);
  });
});
