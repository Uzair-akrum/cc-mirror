/**
 * WrapperUpdateStep - Writes or updates the CLI wrapper script
 */

import path from 'node:path';
import { ensureDir } from '../../fs.js';
import { writeLlmGatewayScript } from '../../llm-gateway/install.js';
import { expandTilde } from '../../paths.js';
import { writeWrapper } from '../../wrapper.js';
import type { UpdateContext, UpdateStep } from '../types.js';

export class WrapperUpdateStep implements UpdateStep {
  name = 'Wrapper';

  execute(ctx: UpdateContext): void {
    ctx.report('Writing CLI wrapper...');
    this.writeWrapper(ctx);
  }

  async executeAsync(ctx: UpdateContext): Promise<void> {
    await ctx.report('Writing CLI wrapper...');
    this.writeWrapper(ctx);
  }

  private writeWrapper(ctx: UpdateContext): void {
    const { name, opts, meta } = ctx;

    const resolvedBin = opts.binDir ? (expandTilde(opts.binDir) ?? opts.binDir) : meta.binDir;

    if (resolvedBin) {
      ensureDir(resolvedBin);
      const wrapperPath = path.join(resolvedBin, name);
      if (meta.provider === 'anthropic-router') {
        writeLlmGatewayScript(meta.configDir);
      }
      writeWrapper(wrapperPath, meta.configDir, meta.binaryPath, 'node');
      meta.binDir = resolvedBin;
    }
  }
}
