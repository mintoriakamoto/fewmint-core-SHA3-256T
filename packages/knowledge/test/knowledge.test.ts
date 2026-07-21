import { describe, expect, it } from 'vitest';
import { InMemoryHybridIndex, ingest } from '@cooklabs/knowledge';
import { runWithTenant, type TenantContext } from '@cooklabs/tenancy';
import type { Grant } from '@cooklabs/permissions';

const tenantA: TenantContext = {
  tenantId: 'org_a',
  organizationId: 'org_a',
  actor: { id: 'user_a', type: 'user' },
};
const tenantB: TenantContext = {
  tenantId: 'org_b',
  organizationId: 'org_b',
  actor: { id: 'user_b', type: 'user' },
};

const readKnowledge: Grant[] = [{ resource: 'knowledge', actions: ['read'] }];

const warrantyDoc = {
  source: { id: 'doc_warranty', title: 'Warranty Policy', uri: 'file://warranty.pdf' },
  text: 'Powertrain warranty covers engine and transmission repairs for 24 months.\n\nBrake pads are wear items excluded from warranty coverage.',
  classification: 'internal' as const,
  permissionResource: 'knowledge',
};

describe('ingestion', () => {
  it('stamps tenant and provenance from context, chunks by paragraph', () => {
    const chunks = runWithTenant(tenantA, () => ingest({ ...warrantyDoc, maxChunkChars: 60 }));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.tenant_id).toBe('org_a');
      expect(chunk.provenance).toBe('ingested by user:user_a');
      expect(chunk.classification).toBe('internal');
    }
  });

  it('refuses empty content and fails closed outside a context', () => {
    expect(() => runWithTenant(tenantA, () => ingest({ ...warrantyDoc, text: '  ' }))).toThrow();
    expect(() => ingest(warrantyDoc)).toThrow();
  });
});

describe('permission-aware retrieval', () => {
  function seededIndex() {
    const index = new InMemoryHybridIndex();
    // Both tenants ingest IDENTICAL content — the classic leak scenario.
    index.add(runWithTenant(tenantA, () => ingest(warrantyDoc)));
    index.add(runWithTenant(tenantB, () => ingest(warrantyDoc)));
    index.add(
      runWithTenant(tenantA, () =>
        ingest({
          source: { id: 'doc_payroll', title: 'Payroll Bands' },
          text: 'Technician payroll bands and warranty bonus multipliers for engine work.',
          classification: 'restricted',
          permissionResource: 'payroll_docs',
        }),
      ),
    );
    return index;
  }

  it('returns citations and tags every passage as untrusted data', () => {
    const index = seededIndex();
    const passages = runWithTenant(tenantA, () =>
      index.search('engine warranty', { grants: readKnowledge, classificationCeiling: 'internal' }),
    );
    expect(passages.length).toBeGreaterThan(0);
    for (const passage of passages) {
      expect(passage.kind).toBe('untrusted_data');
      expect(passage.citation.sourceId).toBe('doc_warranty');
      expect(passage.citation.sourceTitle).toBe('Warranty Policy');
      expect(passage.citation.chunkId).toBeTruthy();
    }
  });

  it('cross-tenant chunks are unreachable even with identical content', () => {
    const index = seededIndex();
    const forA = runWithTenant(tenantA, () =>
      index.search('engine warranty', { grants: readKnowledge, classificationCeiling: 'internal' }),
    );
    const chunkIdsA = new Set(forA.map((p) => p.citation.chunkId));
    const forB = runWithTenant(tenantB, () =>
      index.search('engine warranty', { grants: readKnowledge, classificationCeiling: 'internal' }),
    );
    expect(forB.length).toBeGreaterThan(0);
    for (const passage of forB) {
      expect(chunkIdsA.has(passage.citation.chunkId)).toBe(false);
    }
  });

  it('classification ceiling hides restricted chunks from uncleared readers', () => {
    const index = seededIndex();
    const uncleared = runWithTenant(tenantA, () =>
      index.search('payroll warranty engine', {
        grants: [
          { resource: 'knowledge', actions: ['read'] },
          { resource: 'payroll_docs', actions: ['read'] },
        ],
        classificationCeiling: 'internal',
      }),
    );
    expect(uncleared.every((p) => p.citation.sourceId !== 'doc_payroll')).toBe(true);

    const cleared = runWithTenant(tenantA, () =>
      index.search('payroll warranty engine', {
        grants: [
          { resource: 'knowledge', actions: ['read'] },
          { resource: 'payroll_docs', actions: ['read'] },
        ],
        classificationCeiling: 'restricted',
      }),
    );
    expect(cleared.some((p) => p.citation.sourceId === 'doc_payroll')).toBe(true);
  });

  it('permission grants filter chunks the reader cannot read', () => {
    const index = seededIndex();
    const withoutPayrollGrant = runWithTenant(tenantA, () =>
      index.search('payroll warranty engine', {
        grants: readKnowledge, // no payroll_docs grant
        classificationCeiling: 'highly_sensitive',
      }),
    );
    expect(withoutPayrollGrant.every((p) => p.citation.sourceId !== 'doc_payroll')).toBe(true);
  });

  it('fails closed outside a tenant context', () => {
    const index = seededIndex();
    expect(() =>
      index.search('warranty', { grants: readKnowledge, classificationCeiling: 'internal' }),
    ).toThrow();
  });
});
