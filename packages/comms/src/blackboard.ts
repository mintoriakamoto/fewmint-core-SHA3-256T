import { randomUUID } from 'node:crypto';

export type AuthorType = 'agent' | 'worker' | 'human' | 'system';

export interface Author {
  readonly id: string;
  readonly type: AuthorType;
}

export type EntryKind =
  'finding' | 'hypothesis' | 'question' | 'answer' | 'claim' | 'artifact' | 'decision' | 'status';

/**
 * One immutable posting on a board (spec 14). Content authored by agents or
 * workers is DATA (untrusted: true) — consumers must never treat it as
 * instructions (spec 12 §3). Corrections are new entries superseding old ones.
 */
export interface BlackboardEntry {
  readonly id: string;
  readonly board: string;
  readonly author: Author;
  readonly kind: EntryKind;
  readonly content: string;
  readonly untrusted: boolean;
  readonly refs: readonly string[];
  readonly supersedes?: string;
  readonly confidence?: number;
  readonly created_at: string;
}

export type ClaimResult =
  | { readonly granted: true; readonly entry: BlackboardEntry }
  | { readonly granted: false; readonly conflict: BlackboardEntry };

export class EvidenceRequiredError extends Error {
  constructor() {
    super('A decision must reference at least one finding or artifact entry as evidence');
    this.name = 'EvidenceRequiredError';
  }
}

export class UnknownRefError extends Error {
  constructor(ref: string) {
    super(`Referenced entry ${ref} does not exist on this board`);
    this.name = 'UnknownRefError';
  }
}

/**
 * Append-only shared working space for multi-agent coordination (spec 14).
 * Boards are cheap — one per factory task, per topic, or per tenant workroom.
 */
export class Blackboard {
  private readonly byBoard = new Map<string, BlackboardEntry[]>();
  private readonly claims = new Map<string, BlackboardEntry>();
  private readonly subscribers = new Map<string, Set<(entry: BlackboardEntry) => void>>();

  constructor(
    private readonly options?: {
      /** Durable sink: every accepted entry is journaled (spec 14). */
      readonly journal?: (record: { kind: 'entry'; entry: BlackboardEntry }) => void;
    },
  ) {}

  /**
   * Replay path: reinstates a journaled entry verbatim — original id and
   * timestamps preserved, no re-journaling, no subscriber notification.
   * Live claim state is derived from claim/release entries. Idempotent.
   */
  restore(entry: BlackboardEntry): void {
    const entries = this.byBoard.get(entry.board) ?? [];
    if (entries.some((e) => e.id === entry.id)) return;
    entries.push(entry);
    this.byBoard.set(entry.board, entries);
    if (entry.kind === 'claim') {
      this.claims.set(`${entry.board}:${entry.content}`, entry);
    }
    if (entry.kind === 'status' && entry.content.startsWith('released claim on ')) {
      const resource = entry.content.slice('released claim on '.length);
      const key = `${entry.board}:${resource}`;
      const held = this.claims.get(key);
      if (held && entry.refs.includes(held.id)) this.claims.delete(key);
    }
  }

  post(
    board: string,
    author: Author,
    kind: EntryKind,
    content: string,
    options?: {
      readonly refs?: readonly string[];
      readonly supersedes?: string;
      readonly confidence?: number;
    },
  ): BlackboardEntry {
    const entries = this.byBoard.get(board) ?? [];
    const known = new Set(entries.map((e) => e.id));
    for (const ref of options?.refs ?? []) {
      if (!known.has(ref)) throw new UnknownRefError(ref);
    }
    if (options?.supersedes !== undefined && !known.has(options.supersedes)) {
      throw new UnknownRefError(options.supersedes);
    }
    if (kind === 'decision') {
      const evidence = (options?.refs ?? []).filter((ref) => {
        const target = entries.find((e) => e.id === ref);
        return target !== undefined && (target.kind === 'finding' || target.kind === 'artifact');
      });
      if (evidence.length === 0) throw new EvidenceRequiredError();
    }
    const entry: BlackboardEntry = Object.freeze({
      id: randomUUID(),
      board,
      author,
      kind,
      content,
      untrusted: author.type === 'agent' || author.type === 'worker',
      refs: [...(options?.refs ?? [])],
      ...(options?.supersedes !== undefined ? { supersedes: options.supersedes } : {}),
      ...(options?.confidence !== undefined ? { confidence: options.confidence } : {}),
      created_at: new Date().toISOString(),
    });
    entries.push(entry);
    this.byBoard.set(board, entries);
    this.options?.journal?.({ kind: 'entry', entry });
    for (const handler of this.subscribers.get(board) ?? []) handler(entry);
    return entry;
  }

  /** Full append-only history. */
  entries(board: string): readonly BlackboardEntry[] {
    return [...(this.byBoard.get(board) ?? [])];
  }

  /**
   * The condensed working state: live (non-superseded) entries, newest last.
   * This is what an agent should load — never the raw full history
   * (spec 03 §6: no unlimited context dumping).
   */
  digest(board: string): readonly BlackboardEntry[] {
    const entries = this.byBoard.get(board) ?? [];
    const superseded = new Set(
      entries.map((e) => e.supersedes).filter((id): id is string => id !== undefined),
    );
    return entries.filter((e) => !superseded.has(e.id));
  }

  /**
   * Registers intent to work on a resource (a file path, an entity, a bay).
   * A second live claim on the same resource is a CONFLICT, returned with
   * the holder — parallel work without chaos (spec 09 §4).
   */
  claim(board: string, author: Author, resource: string): ClaimResult {
    const key = `${board}:${resource}`;
    const existing = this.claims.get(key);
    if (existing && existing.author.id !== author.id) {
      return { granted: false, conflict: existing };
    }
    if (existing) return { granted: true, entry: existing };
    const entry = this.post(board, author, 'claim', resource);
    this.claims.set(key, entry);
    return { granted: true, entry };
  }

  releaseClaim(board: string, authorId: string, resource: string): void {
    const key = `${board}:${resource}`;
    const existing = this.claims.get(key);
    if (!existing) return;
    if (existing.author.id !== authorId) {
      throw new Error(`Claim on ${resource} is held by ${existing.author.id}, not ${authorId}`);
    }
    this.claims.delete(key);
    this.post(board, existing.author, 'status', `released claim on ${resource}`, {
      refs: [existing.id],
    });
  }

  subscribe(board: string, handler: (entry: BlackboardEntry) => void): () => void {
    const handlers = this.subscribers.get(board) ?? new Set();
    handlers.add(handler);
    this.subscribers.set(board, handlers);
    return () => handlers.delete(handler);
  }
}
