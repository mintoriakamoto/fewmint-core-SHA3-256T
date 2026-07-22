import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv/dist/2020.js';
import { buildAuditRecord, type AuditLog } from '@cooklabs/audit';
import {
  NoMembershipError,
  establishTenantContext,
  resolveGrants,
  type AuthenticatedSession,
  type RoleRegistry,
} from '@cooklabs/auth';
import { BookingConflictError, type SchedulingService } from '@cooklabs/scheduling';
import { DuplicateCustomerError, type CrmService } from '@cooklabs/crm';
import type { BillingService } from '@cooklabs/billing';
import { authorize, type Action, type Grant } from '@cooklabs/permissions';
import { runWithTenant } from '@cooklabs/tenancy';

/**
 * HTTP surface (spec 04 §3): authentication → tenant context → validation →
 * authorization → audit → structured errors. tenant_id NEVER comes from the
 * request body — it derives from the verified membership for the org header.
 */

export interface ApiDeps {
  /** Bearer-token resolution (session issuance lives outside this app). */
  readonly resolveToken: (token: string) => AuthenticatedSession | undefined;
  readonly roles: RoleRegistry;
  readonly audit: AuditLog;
  readonly crm: CrmService;
  readonly scheduling: SchedulingService;
  readonly billing: BillingService;
}

type ErrorCode =
  'unauthenticated' | 'forbidden' | 'validation_failed' | 'not_found' | 'conflict' | 'internal';

const STATUS: Record<ErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  validation_failed: 400,
  not_found: 404,
  conflict: 409,
  internal: 500,
};

class ApiError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const ajv = new Ajv2020({ strict: true, allErrors: true });

interface RouteSpec {
  readonly method: string;
  readonly path: string;
  readonly permission: { readonly resource: string; readonly action: Action };
  readonly validate: ValidateFunction;
  readonly handle: (body: Record<string, unknown>, deps: ApiDeps) => Promise<unknown>;
}

function schema(properties: Record<string, object>, required: string[]): ValidateFunction {
  return ajv.compile({
    type: 'object',
    required,
    properties,
    additionalProperties: false,
  });
}

const ROUTES: RouteSpec[] = [
  {
    method: 'POST',
    path: '/customers',
    permission: { resource: 'customers', action: 'create' },
    validate: schema(
      {
        name: { type: 'string', minLength: 1 },
        email: { type: 'string' },
        phone: { type: 'string' },
      },
      ['name'],
    ),
    handle: (body, deps) =>
      deps.crm.createCustomer(body as { name: string; email?: string; phone?: string }),
  },
  {
    method: 'POST',
    path: '/appointments',
    permission: { resource: 'appointments', action: 'create' },
    validate: schema(
      {
        customer_id: { type: 'string' },
        resource_id: { type: 'string' },
        starts_at: { type: 'string' },
        ends_at: { type: 'string' },
        notes: { type: 'string' },
      },
      ['customer_id', 'resource_id', 'starts_at', 'ends_at'],
    ),
    handle: (body, deps) =>
      deps.scheduling.book(
        body as {
          customer_id: string;
          resource_id: string;
          starts_at: string;
          ends_at: string;
        },
      ),
  },
  {
    method: 'POST',
    path: '/invoices',
    permission: { resource: 'invoices', action: 'create' },
    validate: schema(
      {
        customer_id: { type: 'string' },
        lines: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['description', 'quantity', 'unit_price_cents'],
            properties: {
              description: { type: 'string' },
              quantity: { type: 'integer' },
              unit_price_cents: { type: 'integer' },
            },
            additionalProperties: false,
          },
        },
        tax_bps: { type: 'integer' },
      },
      ['customer_id', 'lines'],
    ),
    handle: (body, deps) =>
      deps.billing.createInvoice(
        body as {
          customer_id: string;
          lines: { description: string; quantity: number; unit_price_cents: number }[];
          tax_bps?: number;
        },
      ),
  },
];

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.length === 0) return resolve({});
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('body must be a JSON object');
        }
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new ApiError('validation_failed', 'body must be valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

export function createApiServer(deps: ApiDeps): http.Server {
  return http.createServer((req, res) => {
    const requestId = randomUUID();
    void handle(req, deps)
      .then((result) => {
        res.writeHead(result === undefined ? 404 : 201, {
          'content-type': 'application/json',
          'x-request-id': requestId,
        });
        res.end(JSON.stringify(result ?? notFoundBody(requestId)));
      })
      .catch((err: unknown) => {
        const apiError = toApiError(err);
        res.writeHead(STATUS[apiError.code], {
          'content-type': 'application/json',
          'x-request-id': requestId,
        });
        res.end(
          JSON.stringify({
            error: {
              code: apiError.code,
              message: apiError.message,
              ...(apiError.details !== undefined ? { details: apiError.details } : {}),
            },
            request_id: requestId,
          }),
        );
      });
  });
}

function notFoundBody(requestId: string): object {
  return { error: { code: 'not_found', message: 'no such route' }, request_id: requestId };
}

function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof NoMembershipError) return new ApiError('forbidden', err.message);
  if (err instanceof DuplicateCustomerError || err instanceof BookingConflictError) {
    return new ApiError('conflict', err.message);
  }
  if (err instanceof Error && err.name === 'AuthorizationDeniedError') {
    return new ApiError('forbidden', err.message);
  }
  // Downstream failure: visible, never silently converted to success.
  return new ApiError('internal', err instanceof Error ? err.message : 'internal error');
}

async function handle(req: http.IncomingMessage, deps: ApiDeps): Promise<unknown> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/health') return { ok: true };

  const route = ROUTES.find((r) => r.method === req.method && r.path === url.pathname);
  if (!route) return undefined;

  // 1. Authentication.
  const authHeader = req.headers.authorization ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const session = token !== '' ? deps.resolveToken(token) : undefined;
  if (!session) throw new ApiError('unauthenticated', 'missing or invalid bearer token');

  // 2. Tenant context from the VERIFIED membership for the requested org.
  const orgHeader = req.headers['x-organization-id'];
  const orgId = typeof orgHeader === 'string' ? orgHeader : '';
  if (orgId === '') throw new ApiError('forbidden', 'x-organization-id header required');
  const { context, membership } = establishTenantContext(session, orgId);

  // 3. Input validation — tenant/ownership fields in the body are discarded
  //    before validation so they can never influence anything.
  const body = await readBody(req);
  delete body['tenant_id'];
  delete body['organization_id'];
  delete body['created_by'];
  if (!route.validate(body)) {
    throw new ApiError(
      'validation_failed',
      'request body failed validation',
      (route.validate.errors ?? []).map(
        (e) => `${e.instancePath || '(root)'} ${e.message ?? 'invalid'}`,
      ),
    );
  }

  return runWithTenant(context, async () => {
    // 4. Authorization from the caller's role-resolved grants (deny by default).
    const grants: readonly Grant[] = resolveGrants(membership.roles, deps.roles);
    const decision = authorize({
      grants,
      resource: route.permission.resource,
      action: route.permission.action,
      actorId: session.identity.id,
    });
    await deps.audit.append(
      buildAuditRecord({
        actor: { id: session.identity.id, type: session.identity.type },
        tenant_id: context.tenantId,
        action: `api.${route.method.toLowerCase()}${route.path.replaceAll('/', '.')}`,
        resource: { type: route.permission.resource },
        permission: `${route.permission.action}:${route.permission.resource}`,
        reason: decision.reason,
        result: decision.allowed ? 'success' : 'denied',
      }),
    );
    if (!decision.allowed) throw new ApiError('forbidden', decision.reason);

    // 5. The domain service applies its own guard/audit/events (layered defense).
    return route.handle(body, deps);
  });
}
