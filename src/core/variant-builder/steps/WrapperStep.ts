/**
 * WrapperStep - Writes the CLI wrapper script
 */

import { writeWrapper } from '../../wrapper.js';
import { writeLlmGatewayScript } from '../../llm-gateway/install.js';
import type { BuildContext, BuildStep } from '../types.js';

export class WrapperStep implements BuildStep {
  name = 'Wrapper';

  execute(ctx: BuildContext): void {
    ctx.report('Writing CLI wrapper...');
    if (ctx.params.providerKey === 'anthropic-router') {
      writeLlmGatewayScript(ctx.paths.configDir);
    }
    writeWrapper(ctx.paths.wrapperPath, ctx.paths.configDir, ctx.state.binaryPath, 'node');
  }

  async executeAsync(ctx: BuildContext): Promise<void> {
    await ctx.report('Writing CLI wrapper...');
    if (ctx.params.providerKey === 'anthropic-router') {
      writeLlmGatewayScript(ctx.paths.configDir);
    }
    writeWrapper(ctx.paths.wrapperPath, ctx.paths.configDir, ctx.state.binaryPath, 'node');
  }
}
