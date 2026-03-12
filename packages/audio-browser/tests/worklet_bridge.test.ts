import { describe, expect, it, vi } from 'vitest';

import { registerWorklet } from '../src/index.js';

describe('registerWorklet', () => {
  it('forwards module registration to audioWorklet', async () => {
    const addModule = vi.fn(async () => undefined);
    await registerWorklet({ audioWorklet: { addModule } }, 'tx_processor.js');
    expect(addModule).toHaveBeenCalledWith('tx_processor.js');
  });
});
