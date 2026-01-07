import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const writeLlmGatewayScript = (configDir: string): void => {
  const baseDir = path.dirname(fileURLToPath(import.meta.url));
  const assets = ['llm-gateway.mjs', 'llm-gateway-hook.cjs'] as const;
  for (const filename of assets) {
    const sourcePath = path.join(baseDir, filename);
    const targetPath = path.join(configDir, filename);
    fs.copyFileSync(sourcePath, targetPath);
  }
};
