import { describe, expect, it } from 'vitest';
import { InMemoryAuditLog, buildAuditRecord } from '@cooklabs/audit';

describe('audit log', () => {
  it('records denials as well as successes, tenant-scoped', async () => {
    const log = new InMemoryAuditLog();
    await log.append(
      buildAuditRecord({
        actor: { id: 'agent_7', type: 'agent' },
        tenant_id: 'org_a',
        action: 'customers.export',
        resource: { type: 'customers' },
        permission: 'export:customers',
        reason: 'agent requested bulk export',
        result: 'denied',
        model_tool: 'crm.export_customers',
      }),
    );
    await log.append(
      buildAuditRecord({
        actor: { id: 'user_1', type: 'user' },
        tenant_id: 'org_b',
        action: 'invoice.create',
        resource: { type: 'invoices', id: 'inv_1' },
        permission: 'create:invoices',
        reason: 'repair order completed',
        result: 'success',
      }),
    );

    expect(log.size).toBe(2);
    const tenantA = log.forTenant('org_a');
    expect(tenantA).toHaveLength(1);
    expect(tenantA[0]?.result).toBe('denied');
    expect(tenantA[0]?.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('freezes records (append-only, no mutation)', async () => {
    const log = new InMemoryAuditLog();
    const rec = buildAuditRecord({
      actor: { id: 'user_1', type: 'user' },
      tenant_id: 'org_a',
      action: 'x',
      resource: { type: 'y' },
      permission: 'p',
      reason: 'r',
      result: 'success',
    });
    await log.append(rec);
    const stored = log.forTenant('org_a')[0]!;
    expect(Object.isFrozen(stored)).toBe(true);
    expect(() => {
      (stored as { result: string }).result = 'failed';
    }).toThrow();
  });
});
