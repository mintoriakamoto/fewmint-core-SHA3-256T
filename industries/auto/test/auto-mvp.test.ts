import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import {
  InstallError,
  RepairOrderService,
  VehicleService,
  compileServiceAdvisor,
  installPack,
  type AgentManifest,
} from '@cooklabs/industry-auto';
import { InMemoryAuditLog } from '@cooklabs/audit';
import { BillingService } from '@cooklabs/billing';
import { CrmService } from '@cooklabs/crm';
import type { EventEnvelope } from '@cooklabs/events';
import { SchedulingService } from '@cooklabs/scheduling';
import {
  ToolGateway,
  ToolRegistry,
  executeProposedAction,
  type ToolDefinition,
} from '@cooklabs/agents';
import { WorkflowEngine, type AgentInvoker } from '@cooklabs/workflows';
import { runWithTenant, type TenantContext } from '@cooklabs/tenancy';
import type { Grant } from '@cooklabs/permissions';

const DOCS_SCHEMAS = join(__dirname, '../../../docs/schemas');
const PACK_DIR = join(__dirname, '..');

const addFormats =
  (addFormatsModule as { default?: typeof addFormatsModule }).default ?? addFormatsModule;
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);

function loadJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

describe('manifests validate against the normative schemas', () => {
  it('pack.json is a valid Industry Pack manifest', () => {
    const validate = ajv.compile(
      loadJson(join(DOCS_SCHEMAS, 'industry-pack.schema.json')) as object,
    );
    expect(validate(loadJson(join(PACK_DIR, 'pack.json')))).toBe(true);
  });

  it('all three workflows are valid workflow definitions', () => {
    const validate = ajv.compile(loadJson(join(DOCS_SCHEMAS, 'workflow.schema.json')) as object);
    for (const name of ['appointment_to_repair', 'estimate_approval', 'maintenance_followup']) {
      const definition = loadJson(join(PACK_DIR, 'workflows', `${name}.json`));
      const valid = validate(definition);
      if (!valid) throw new Error(`${name}: ${JSON.stringify(validate.errors)}`);
      expect(valid).toBe(true);
    }
  });

  it('service_advisor.json is a valid agent definition', () => {
    const validate = ajv.compile(
      loadJson(join(DOCS_SCHEMAS, 'agent-definition.schema.json')) as object,
    );
    const manifest = loadJson(join(PACK_DIR, 'agents', 'service_advisor.json'));
    const valid = validate(manifest);
    if (!valid) throw new Error(JSON.stringify(validate.errors));
    expect(valid).toBe(true);
  });
});

describe('pack installation (spec 07 §3 validate stage)', () => {
  const registries = {
    modules: new Set(['crm', 'scheduling', 'estimates', 'inventory', 'invoicing']),
    agents: new Set(['service_advisor', 'diagnostic_assistant', 'parts_agent', 'retention_agent']),
    workflows: new Set(['appointment_to_repair', 'estimate_approval', 'maintenance_followup']),
    dashboards: new Set(['daily_sales', 'labor_utilization', 'average_ticket']),
    integrations: new Set(['accounting', 'payments', 'communications']),
  };

  it('installs when every reference resolves, idempotently', () => {
    const manifest = loadJson(join(PACK_DIR, 'pack.json'));
    const first = installPack(manifest, registries);
    expect(first.industry).toBe('auto_repair');
    const second = installPack(manifest, registries);
    expect(second).toBe(first);
  });

  it('unresolved references fail install, not runtime', () => {
    const manifest = loadJson(join(PACK_DIR, 'pack.json')) as Record<string, unknown>;
    const broken = { ...manifest, version: '9.9.9', workflows: ['ghost_workflow'] };
    expect(() => installPack(broken, registries)).toThrow(InstallError);
    expect(() => installPack(broken, registries)).toThrow(/ghost_workflow/);
  });

  it('schema-invalid manifests are rejected', () => {
    expect(() => installPack({ industry: 'Bad Name' }, registries)).toThrow(InstallError);
  });
});

describe('Cook Labs Auto MVP acceptance (doc 13 §1 executable slice)', () => {
  it('walks the customer journey end to end', async () => {
    const shop: TenantContext = {
      tenantId: 'org_shop',
      organizationId: 'org_shop',
      actor: { id: 'user_owner', type: 'user' },
    };
    const audit = new InMemoryAuditLog();
    const events: EventEnvelope[] = [];
    const publish = (e: EventEnvelope) => events.push(e);

    const ownerGrants: Grant[] = [
      { resource: 'customers', actions: ['create', 'read', 'list'] },
      { resource: 'leads', actions: ['create', 'update', 'read', 'list'] },
      { resource: 'vehicles', actions: ['create', 'read', 'list'] },
      { resource: 'repair_orders', actions: ['create', 'update', 'read', 'list'] },
      { resource: 'appointments', actions: ['create', 'update', 'read', 'list'] },
      { resource: 'invoices', actions: ['create', 'update', 'read', 'list'] },
    ];
    const deps = { grants: ownerGrants, audit, publish };

    const crm = new CrmService(deps);
    const scheduling = new SchedulingService(deps);
    const billing = new BillingService(deps);
    const vehicles = new VehicleService(deps);
    const orders = new RepairOrderService(deps);

    // AI Service Advisor: compiled from its manifest, using real typed tools.
    const manifest = loadJson(join(PACK_DIR, 'agents', 'service_advisor.json')) as AgentManifest;
    const advisor = compileServiceAdvisor(manifest);
    expect(advisor.maxAutonomyLevel).toBe(4);
    const toolRegistry = new ToolRegistry();
    const bookTool: ToolDefinition<
      { customer_id: string; resource_id: string; starts_at: string; ends_at: string },
      { id: string }
    > = {
      name: 'scheduling.book',
      description: 'Book a maintenance appointment',
      inputSchema: {
        type: 'object',
        required: ['customer_id', 'resource_id', 'starts_at', 'ends_at'],
        properties: {
          customer_id: { type: 'string' },
          resource_id: { type: 'string' },
          starts_at: { type: 'string' },
          ends_at: { type: 'string' },
        },
        additionalProperties: false,
      },
      requiredPermission: { resource: 'appointments', action: 'create' },
      riskClass: 'reversible',
      execute: (input) => scheduling.book(input),
    };
    toolRegistry.register(bookTool);
    const tools = new ToolGateway(toolRegistry);

    const advisorInvoker: AgentInvoker = {
      invoke: (_name, _step, context) =>
        executeProposedAction(
          advisor,
          {
            tool: 'scheduling.book',
            input: {
              customer_id: String(context.customer_id),
              resource_id: 'bay_1',
              starts_at: '2026-11-01T09:00:00Z',
              ends_at: '2026-11-01T10:00:00Z',
            },
            reason: 'maintenance follow-up 90 days after completed job',
          },
          { tools, audit, publish },
        ),
    };

    let clock = Date.parse('2026-08-01T00:00:00Z');
    const engine = new WorkflowEngine({
      actions: {
        'auto.create_repair_order': async (_params, context) => {
          const order = await orders.create({
            customer_id: String(context.customer_id),
            vehicle_id: String(context.vehicle_id),
            complaint: String(context.complaint),
            appointment_id: String(context.appointment_id),
          });
          return order.id;
        },
        'auto.approve_estimate': async (_params, context) => {
          const approved = await orders.approveEstimate(
            String(context.repair_order_id),
            String(context.approval_ref),
          );
          return approved.status;
        },
      },
      agents: advisorInvoker,
      now: () => clock,
    });
    const workflowOf = (name: string) => loadJson(join(PACK_DIR, 'workflows', `${name}.json`));

    await runWithTenant(shop, async () => {
      // 4–5: customer + vehicle (VIN)
      const customer = await crm.createCustomer({
        name: 'Riley Nguyen',
        email: 'riley@example.com',
        phone: '555-0100',
      });
      const vehicle = await vehicles.addVehicle({
        customer_id: customer.id,
        vin: '1HGCM82633A004352',
        make: 'Honda',
        model: 'Accord',
        year: 2019,
      });

      // 6: appointment
      const appointment = await scheduling.book({
        customer_id: customer.id,
        resource_id: 'bay_1',
        starts_at: '2026-08-03T09:00:00Z',
        ends_at: '2026-08-03T11:00:00Z',
      });

      // 7: repair order via the appointment_to_repair workflow
      const openRun = await engine.start(workflowOf('appointment_to_repair'), {
        appointment_id: appointment.id,
        customer_id: customer.id,
        vehicle_id: vehicle.id,
        complaint: 'Grinding noise when braking',
      });
      expect(openRun.status).toBe('succeeded');
      const repairOrderId = String(openRun.context.repair_order);

      // 8: inspection with photo evidence
      await orders.startInspection(repairOrderId, 'tech_1');
      await orders.recordInspection(
        repairOrderId,
        'Front pads at 1mm; rotors scored',
        'photo://insp/1',
      );

      // 9: estimate (billing draft invoice, integer cents, 8.25% tax)
      const estimated = await orders.createEstimate(
        repairOrderId,
        [
          { description: 'Front brake pads', quantity: 1, unit_price_cents: 8_900 },
          { description: 'Rotor resurfacing', quantity: 2, unit_price_cents: 6_500 },
          { description: 'Labor', quantity: 2, unit_price_cents: 12_000 },
        ],
        billing,
        825,
      );
      expect(estimated.status).toBe('estimated');

      // 10: approval through the estimate_approval workflow's human gate
      const approvalRun = await engine.start(workflowOf('estimate_approval'), {
        repair_order_id: repairOrderId,
      });
      expect(approvalRun.status).toBe('awaiting_approval'); // parked — never auto-approves
      const approved = await engine.resume(approvalRun, 'appr_riley_1');
      expect(approved.status).toBe('succeeded');
      expect((await orders.orders.findById(repairOrderId))?.approval_ref).toBe('appr_riley_1');

      // 11: work status
      await orders.startWork(repairOrderId);
      await orders.completeWork(repairOrderId);

      // 12–13: invoice + payment (46,900 subtotal + 3,869 tax = 50,769)
      const invoiced = await orders.invoice(repairOrderId, billing, '2026-09-01T00:00:00Z');
      expect(invoiced.status).toBe('invoiced');
      const paidInvoice = await billing.recordPayment(invoiced.invoice_id!, 50_769);
      expect(paidInvoice.status).toBe('paid');

      // 14: maintenance follow-up — parks 90 days, then the AI Service
      // Advisor books the next appointment through the real pipeline.
      const followupRun = await engine.start(workflowOf('maintenance_followup'), {
        customer_id: customer.id,
      });
      expect(followupRun.status).toBe('delayed');
      clock += 1 * 24 * 3600 * 1000;
      expect((await engine.tick(followupRun, clock)).status).toBe('delayed'); // too early
      clock += 91 * 24 * 3600 * 1000;
      const done = await engine.tick(followupRun, clock);
      expect(done.status).toBe('succeeded');

      // The advisor's booking really exists.
      const bookings = scheduling.appointments.list((a) => a.starts_at.startsWith('2026-11-01'));
      expect(bookings).toHaveLength(1);
    });

    // 15: the event stream tells the whole story, in order.
    expect(events.map((e) => e.event_type)).toEqual([
      'customer.created',
      'appointment.booked',
      'invoice.created',
      'estimate.created',
      'estimate.approved',
      'job.started',
      'job.completed',
      'payment.received',
      'appointment.booked',
      'agent.action.completed',
    ]);
    // Every event is tenant-scoped.
    expect(events.every((e) => e.tenant_id === 'org_shop')).toBe(true);

    // Audit trail: human operations AND the agent's action are recorded.
    const trail = audit.forTenant('org_shop');
    expect(trail.length).toBeGreaterThanOrEqual(10);
    const agentRecords = trail.filter((r) => r.actor.type === 'agent');
    expect(agentRecords).toHaveLength(1);
    expect(agentRecords[0]?.result).toBe('success');
    expect(agentRecords[0]?.model_tool).toBe('service_advisor@1/scheduling.book');
  });

  it('the state machine refuses to skip the approval gate', async () => {
    const shop: TenantContext = {
      tenantId: 'org_shop2',
      organizationId: 'org_shop2',
      actor: { id: 'user_owner', type: 'user' },
    };
    const deps = {
      grants: [{ resource: 'repair_orders', actions: ['create', 'update'] }] as Grant[],
      audit: new InMemoryAuditLog(),
      publish: () => undefined,
    };
    const orders = new RepairOrderService(deps);
    await runWithTenant(shop, async () => {
      const order = await orders.create({
        customer_id: 'c',
        vehicle_id: 'v',
        complaint: 'noise',
      });
      // created → in_progress without inspection/estimate/approval is refused.
      await expect(orders.startWork(order.id)).rejects.toThrow(/Invalid repair order transition/);
    });
  });
});
