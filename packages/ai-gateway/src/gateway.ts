/**
 * Model Gateway (spec 08). All AI requests pass through here — application
 * and agent code never call model providers directly. Routing walks the
 * preference chain; total failure is a visible state, never faked success.
 */

export interface ModelRequest {
  readonly tenantId: string;
  readonly task: string;
  readonly input: string;
  readonly maxTokens?: number;
  /** Tenant policy constraint: only these providers may serve the request. */
  readonly allowedProviders?: readonly string[];
  readonly correlationId?: string;
}

export interface ProviderCompletion {
  readonly output: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
}

export interface ModelProvider {
  readonly name: string;
  /** USD per 1k tokens (in+out combined), for metering and budgets. */
  readonly costPer1kTokens: number;
  complete(request: ModelRequest): Promise<ProviderCompletion>;
}

/** Per-request metering record (spec 08 §5). */
export interface MeterRecord {
  readonly tenantId: string;
  readonly provider: string;
  readonly task: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly costUsd: number;
  readonly latencyMs: number;
  readonly outcome: 'ok' | 'error';
  readonly correlationId?: string;
}

export interface MeterSink {
  record(entry: MeterRecord): void;
}

export class InMemoryMeter implements MeterSink {
  readonly entries: MeterRecord[] = [];
  record(entry: MeterRecord): void {
    this.entries.push(entry);
  }
  spentUsd(tenantId: string): number {
    return this.entries
      .filter((e) => e.tenantId === tenantId)
      .reduce((sum, e) => sum + e.costUsd, 0);
  }
}

/** Hard per-tenant spend ceilings — one customer cannot create unlimited cost. */
export class TenantBudgets {
  private readonly limits = new Map<string, number>();
  constructor(private readonly meter: InMemoryMeter) {}
  setLimit(tenantId: string, maxUsd: number): void {
    this.limits.set(tenantId, maxUsd);
  }
  remaining(tenantId: string): number {
    const limit = this.limits.get(tenantId);
    if (limit === undefined) return Number.POSITIVE_INFINITY;
    return Math.max(0, limit - this.meter.spentUsd(tenantId));
  }
}

export type RouteResult =
  | { readonly status: 'ok'; readonly provider: string; readonly completion: ProviderCompletion }
  | {
      readonly status: 'failed';
      readonly attempts: readonly { provider: string; error: string }[];
      /** Task is parked for retry and the caller must surface the failure. */
      readonly queued: true;
    }
  | { readonly status: 'denied_budget'; readonly reason: string };

export class ModelGateway {
  constructor(
    private readonly providers: readonly ModelProvider[],
    private readonly meter: MeterSink & { spentUsd?(tenantId: string): number },
    private readonly budgets?: TenantBudgets,
  ) {
    if (providers.length === 0) throw new Error('ModelGateway requires at least one provider');
  }

  /**
   * Preferred → secondary → … → visible failure (spec 08 §3). Every attempt
   * is metered, including errors. Never reports success it did not get.
   */
  async route(request: ModelRequest): Promise<RouteResult> {
    if (this.budgets && this.budgets.remaining(request.tenantId) <= 0) {
      return {
        status: 'denied_budget',
        reason: `tenant ${request.tenantId} has exhausted its AI budget`,
      };
    }

    const eligible = this.providers.filter(
      (p) => !request.allowedProviders || request.allowedProviders.includes(p.name),
    );
    const attempts: { provider: string; error: string }[] = [];

    for (const provider of eligible) {
      const started = Date.now();
      try {
        const completion = await provider.complete(request);
        this.meter.record({
          tenantId: request.tenantId,
          provider: provider.name,
          task: request.task,
          tokensIn: completion.tokensIn,
          tokensOut: completion.tokensOut,
          costUsd: ((completion.tokensIn + completion.tokensOut) / 1000) * provider.costPer1kTokens,
          latencyMs: Date.now() - started,
          outcome: 'ok',
          ...(request.correlationId !== undefined ? { correlationId: request.correlationId } : {}),
        });
        return { status: 'ok', provider: provider.name, completion };
      } catch (err) {
        this.meter.record({
          tenantId: request.tenantId,
          provider: provider.name,
          task: request.task,
          tokensIn: 0,
          tokensOut: 0,
          costUsd: 0,
          latencyMs: Date.now() - started,
          outcome: 'error',
          ...(request.correlationId !== undefined ? { correlationId: request.correlationId } : {}),
        });
        attempts.push({
          provider: provider.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { status: 'failed', attempts, queued: true };
  }
}
