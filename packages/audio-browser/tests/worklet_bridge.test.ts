import { describe, expect, it, vi } from 'vitest';

import { registerWorklet } from '../src/index.js';

describe('registerWorklet', () => {
  it('forwards module registration to audioWorklet', async () => {
    const addModule = vi.fn(async () => undefined);
    await registerWorklet({ audioWorklet: { addModule } }, 'tx_processor.js');
    expect(addModule).toHaveBeenCalledWith('tx_processor.js');
  });

  it('surfaces worklet registration failure explicitly', async () => {
    const addModule = vi.fn(async () => {
      throw new Error('module load failed');
    });

    await expect(registerWorklet({ audioWorklet: { addModule } }, 'bad.js')).rejects.toThrow(
      /module load failed/
    );
  });
});
