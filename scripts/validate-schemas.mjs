// Schema gate: compiles every normative JSON Schema (docs/schemas/) under ajv
// strict mode and validates the example instances from the spec documents.
// Run: node scripts/validate-schemas.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';

const addFormats = addFormatsModule.default ?? addFormatsModule;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMAS = join(ROOT, 'docs', 'schemas');

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);

let failed = false;
const validators = {};
for (const name of [
  'event-envelope',
  'industry-pack',
  'agent-definition',
  'workflow',
  'hercules-task',
]) {
  const schema = JSON.parse(readFileSync(join(SCHEMAS, `${name}.schema.json`), 'utf8'));
  try {
    validators[name] = ajv.compile(schema);
    console.log(`COMPILE OK  ${name}`);
  } catch (err) {
    failed = true;
    console.error(`COMPILE FAIL ${name}: ${err.message}`);
  }
}

function check(name, label, instance) {
  const validate = validators[name];
  if (!validate) return;
  if (validate(instance)) {
    console.log(`VALID       ${name} :: ${label}`);
  } else {
    failed = true;
    console.error(`INVALID     ${name} :: ${label}`);
    console.error(JSON.stringify(validate.errors, null, 2));
  }
}

check('event-envelope', 'spec-05 example', {
  event_id: '01J9ZK3V4E8Q6W2N7R5T1XYZAB',
  event_type: 'invoice.overdue',
  tenant_id: 'org_8f2c1a',
  entity_id: 'inv_00042',
  occurred_at: '2026-07-21T14:03:00Z',
  schema_version: 1,
  correlation_id: 'corr_7d1e9b',
  payload: {},
});

check('industry-pack', 'spec-07 example', {
  industry: 'auto_repair',
  version: '1.0.0',
  modules: ['crm', 'scheduling', 'estimates', 'inventory', 'invoicing'],
  entities: ['vehicle', 'repair_order', 'inspection', 'technician', 'part'],
  agents: ['service_advisor', 'diagnostic_assistant', 'parts_agent', 'retention_agent'],
  workflows: ['appointment_to_repair', 'estimate_approval', 'maintenance_followup'],
  dashboards: ['daily_sales', 'labor_utilization', 'average_ticket'],
  integrations: ['accounting', 'payments', 'communications'],
});

check('workflow', 'spec-06 example', {
  workflow: 'lead_qualification',
  version: 3,
  trigger: { event: 'lead.created' },
  steps: [
    { id: 'normalize', type: 'transformation', map: 'normalize_lead_v1' },
    { id: 'dedupe', type: 'database_action', action: 'crm.dedupe_lead' },
    {
      id: 'qualify',
      type: 'agent_action',
      agent: 'lead_qualification_agent',
      budget: { max_cost_usd: 0.5 },
      output: 'score',
    },
    {
      id: 'route',
      type: 'branch',
      on: 'score >= 80',
      when_true: 'personal_outreach',
      when_false: 'nurture_sequence',
    },
    {
      id: 'personal_outreach',
      type: 'agent_action',
      agent: 'sales_outreach_agent',
      next: 'end_ok',
    },
    {
      id: 'nurture_sequence',
      type: 'api_action',
      action: 'marketing.enroll_nurture',
      next: 'end_ok',
    },
    { id: 'end_ok', type: 'end', result: 'success' },
  ],
});

check('agent-definition', 'spec-03 warranty follow-up agent', {
  name: 'warranty_followup_agent',
  version: 1,
  display_name: 'Warranty Follow-Up Agent',
  role: 'customer_support',
  goal: 'Contact eligible customers before warranty expiration.',
  max_autonomy_level: 3,
  tools: ['crm.search_customers', 'email.draft', 'sms.send_template', 'calendar.book'],
  permissions: [
    { resource: 'customers', actions: ['read', 'list'] },
    { resource: 'messages', actions: ['create'], conditions: { template_approved: true } },
  ],
  knowledge_sources: ['warranty_policies', 'customer_records', 'product_records'],
  budget: { max_actions_per_day: 100, max_cost_usd_per_day: 5 },
  approval_rules: [{ condition: 'custom_offer_amount > 500', approver_role: 'owner' }],
  triggers: ['warranty.expiring_soon'],
});

check('hercules-task', 'spec-09 ARCH-001 example', {
  task_id: 'ARCH-001',
  epic_id: 'AUTO-SAAS-001',
  title: 'Multi-tenant architecture',
  specification: 'Design and implement the tenant-isolation architecture per spec 01.',
  owner: 'claude_code',
  branch: 'factory/arch-001-multitenancy',
  worktree: 'worktrees/arch-001',
  dependencies: [],
  allowed_paths: ['packages/tenancy/**', 'docs/architecture/**'],
  forbidden_changes: ['packages/auth public API'],
  acceptance_criteria: ['Tenant-isolation test suite passes', 'RLS policies on all tenant tables'],
  tests: ['npm test -w packages/tenancy'],
  security_requirements: ['No cross-tenant FK', 'RLS enabled'],
  context: {
    relevant_files: ['packages/tenancy/src/context.ts'],
    architecture_rules: ['spec 01 §2-3'],
    interfaces: ['TenantContext'],
    expected_output: 'PR with passing gates',
  },
  budget: { max_cost_usd: 25 },
  status: 'assigned',
  review: { reviewers: ['codex'], competitive: false },
  artifacts: [],
});

if (failed) {
  console.error('\nSchema gate FAILED');
  process.exit(1);
}
console.log('\nSchema gate passed');
