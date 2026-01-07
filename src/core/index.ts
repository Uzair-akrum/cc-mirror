import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_BIN_DIR, DEFAULT_NPM_PACKAGE, DEFAULT_NPM_VERSION, DEFAULT_ROOT } from './constants.js';
import { ensureDir, readJson } from './fs.js';
import { expandTilde } from './paths.js';
import { ensureTweakccConfig, launchTweakccUi } from './tweakcc.js';
import { formatTweakccFailure } from './errors.js';
import { listVariants as listVariantsImpl, loadVariantMeta } from './variants.js';
import { VariantBuilder, VariantUpdater } from './variant-builder/index.js';
import type {
  CreateVariantParams,
  CreateVariantResult,
  DoctorReportItem,
  UpdateVariantOptions,
  UpdateVariantResult,
  VariantEntry,
} from './types.js';

export { DEFAULT_ROOT, DEFAULT_BIN_DIR, DEFAULT_NPM_PACKAGE, DEFAULT_NPM_VERSION };
export { expandTilde } from './paths.js';

export const createVariant = (params: CreateVariantParams): CreateVariantResult => {
  return new VariantBuilder(false).build(params);
};

/**
 * Async version of createVariant - allows UI progress updates during long operations
 */
export const createVariantAsync = async (params: CreateVariantParams): Promise<CreateVariantResult> => {
  return new VariantBuilder(true).buildAsync(params);
};

/**
 * Async version of updateVariant - allows UI progress updates during long operations
 */
export const updateVariantAsync = async (
  rootDir: string,
  name: string,
  opts: UpdateVariantOptions = {}
): Promise<UpdateVariantResult> => {
  return new VariantUpdater(true).updateAsync(rootDir, name, opts);
};

export const updateVariant = (rootDir: string, name: string, opts: UpdateVariantOptions = {}): UpdateVariantResult => {
  return new VariantUpdater(false).update(rootDir, name, opts);
};

export const removeVariant = (rootDir: string, name: string) => {
  const resolvedRoot = expandTilde(rootDir || DEFAULT_ROOT) ?? rootDir;
  const variantDir = path.join(resolvedRoot, name);
  if (!fs.existsSync(variantDir)) throw new Error(`Variant not found: ${name}`);
  fs.rmSync(variantDir, { recursive: true, force: true });
};

export const doctor = (rootDir: string, binDir: string): DoctorReportItem[] => {
  const resolvedRoot = expandTilde(rootDir || DEFAULT_ROOT) ?? rootDir;
  const resolvedBin = expandTilde(binDir || DEFAULT_BIN_DIR) ?? binDir;
  const variants = listVariantsImpl(resolvedRoot);

  const normalizeSecret = (value: unknown): string | null => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (trimmed === '<API_KEY>' || trimmed === '<MINIMAX_API_KEY>') return null;
    return trimmed;
  };

  return variants.map(({ name, meta }) => {
    const wrapperPath = path.join(resolvedBin, name);
    const issues: string[] = [];
    const binaryExists = Boolean(meta?.binaryPath && fs.existsSync(meta.binaryPath));
    const wrapperExists = fs.existsSync(wrapperPath);

    if (meta?.provider === 'anthropic-router') {
      const gatewayPath = path.join(meta.configDir, 'llm-gateway.mjs');
      if (!fs.existsSync(gatewayPath)) {
        issues.push('Missing config/llm-gateway.mjs');
      }
      const gatewayHookPath = path.join(meta.configDir, 'llm-gateway-hook.cjs');
      if (!fs.existsSync(gatewayHookPath)) {
        issues.push('Missing config/llm-gateway-hook.cjs');
      }

      const settings = readJson<{ proxyEnv?: Record<string, string | number | undefined> }>(
        path.join(meta.configDir, 'settings.json')
      );
      const minimaxKey = normalizeSecret(settings?.proxyEnv?.MINIMAX_API_KEY);
      if (!minimaxKey) {
        issues.push('Missing proxyEnv.MINIMAX_API_KEY in config/settings.json');
      }
    }

    const ok = Boolean(meta && binaryExists && wrapperExists && issues.length === 0);
    return {
      name,
      ok,
      binaryPath: meta?.binaryPath,
      wrapperPath,
      ...(issues.length > 0 ? { issues } : {}),
    };
  });
};

export const listVariants = (rootDir: string): VariantEntry[] => listVariantsImpl(rootDir);

export const tweakVariant = (rootDir: string, name: string): void => {
  const resolvedRoot = expandTilde(rootDir || DEFAULT_ROOT) ?? rootDir;
  const variantDir = path.join(resolvedRoot, name);
  const meta = loadVariantMeta(variantDir);
  if (!meta) throw new Error(`Variant not found: ${name}`);
  ensureDir(meta.tweakDir);
  const brandKey = meta.brand ?? null;
  ensureTweakccConfig(meta.tweakDir, brandKey);
  const result = launchTweakccUi(meta.tweakDir, meta.binaryPath);
  if (result.status && result.status !== 0) {
    const output = `${result.stderr ?? ''}\n${result.stdout ?? ''}`.trim();
    throw new Error(formatTweakccFailure(output));
  }
};
