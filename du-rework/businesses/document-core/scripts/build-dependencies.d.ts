export interface BuildStep {
  name: string;
  dir: string;
  cmd: string;
}

export interface BuildResult {
  success: boolean;
  executed: string[];
  failedAt?: string;
  error?: Error;
}

export interface BuildOptions {
  runner?: (cmd: string, cwd?: string, step?: BuildStep) => void;
  logger?: (msg: string) => void;
  throwOnError?: boolean;
  validateGraph?: boolean;
}

export interface GraphValidationResult {
  valid: boolean;
  packages: string[];
}

export const DEPENDENCY_BUILD_ORDER: BuildStep[];
export function validateDependencyGraphOrder(
  order?: BuildStep[],
  workspaceRoot?: string
): GraphValidationResult;
export function executeDependencyOrderedBuild(options?: BuildOptions): BuildResult;
