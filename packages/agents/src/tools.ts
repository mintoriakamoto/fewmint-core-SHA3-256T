import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv/dist/2020.js';
import type { Action } from '@cooklabs/permissions';

export type RiskClass = 'reversible' | 'compensable' | 'irreversible';

export type ToolCredentials = Readonly<Record<string, string>>;

/**
 * A typed tool (spec 04 §1): narrow capability with a JSON Schema input
 * contract, a declared permission, and a risk class. The executor receives
 * gateway-injected credentials — the model never sees them.
 */
export interface ToolDefinition<I = unknown, R = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: object;
  readonly requiredPermission: { readonly resource: string; readonly action: Action };
  readonly riskClass: RiskClass;
  readonly approvalGated?: boolean;
  execute(input: I, credentials: ToolCredentials): Promise<R>;
  /** Optional post-execution verification (spec 03 §2 result verification). */
  verify?(result: R): boolean;
}

export class UnknownToolError extends Error {
  constructor(name: string) {
    super(`Unknown tool: ${name}`);
    this.name = 'UnknownToolError';
  }
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly validators = new Map<string, ValidateFunction>();
  private readonly ajv = new Ajv2020({ strict: false, allErrors: true });

  register<I, R>(tool: ToolDefinition<I, R>): void {
    this.tools.set(tool.name, tool as ToolDefinition);
    this.validators.set(tool.name, this.ajv.compile(tool.inputSchema));
  }

  get(name: string): ToolDefinition {
    const tool = this.tools.get(name);
    if (!tool) throw new UnknownToolError(name);
    return tool;
  }

  validateInput(name: string, input: unknown): { valid: boolean; errors: string[] } {
    const validate = this.validators.get(name);
    if (!validate) throw new UnknownToolError(name);
    if (validate(input)) return { valid: true, errors: [] };
    return {
      valid: false,
      errors: (validate.errors ?? []).map(
        (e) => `${e.instancePath || '(root)'} ${e.message ?? 'invalid'}`,
      ),
    };
  }
}

/** Resolves credentials at execution time (spec 04 §2, 12 §4). */
export interface SecretsProvider {
  credentialsFor(toolName: string, tenantId: string): Promise<ToolCredentials>;
}

const NO_CREDENTIALS: ToolCredentials = Object.freeze({});

/**
 * Tool Gateway: the only path to tool execution. Injects credentials from the
 * secrets provider — callers (and models) pass none and receive none back.
 */
export class ToolGateway {
  constructor(
    readonly registry: ToolRegistry,
    private readonly secrets?: SecretsProvider,
  ) {}

  async execute(toolName: string, input: unknown, tenantId: string): Promise<unknown> {
    const tool = this.registry.get(toolName);
    const credentials = this.secrets
      ? await this.secrets.credentialsFor(toolName, tenantId)
      : NO_CREDENTIALS;
    return tool.execute(input, credentials);
  }
}
