import { randomUUID } from 'node:crypto';
import type { Author } from './blackboard.js';

/** Speech-act performatives (spec 14 §3) — intent travels in the envelope,
 *  never inferred from prose. */
export type Performative =
  'request' | 'inform' | 'propose' | 'accept' | 'reject' | 'question' | 'answer' | 'escalate';

export interface AgentMessage {
  readonly id: string;
  readonly conversation_id: string;
  readonly in_reply_to?: string;
  readonly from: Author;
  /** Direct recipient — or a topic for broadcast (exactly one is set). */
  readonly to?: string;
  readonly topic?: string;
  readonly performative: Performative;
  /** Agent-authored content is DATA, never instructions (spec 12 §3). */
  readonly content: string;
  readonly untrusted: boolean;
  readonly task_ref?: string;
  readonly created_at: string;
}

export type MessageHandler = (
  message: AgentMessage,
) => Promise<{ performative: Performative; content: string } | undefined>;

interface SendInput {
  readonly id?: string;
  readonly conversation_id?: string;
  readonly in_reply_to?: string;
  readonly from: Author;
  readonly to?: string;
  readonly topic?: string;
  readonly performative: Performative;
  readonly content: string;
  readonly task_ref?: string;
}

/**
 * In-memory agent message bus (spec 14). Delivery rules:
 * - idempotent on message id (redelivery returns the original, no duplicate),
 * - unroutable messages land in the dead-letter queue — never dropped silently,
 * - `escalate` always routes to the human inbox, whatever `to` says: the one
 *   governed agent→human path,
 * - a registered handler may return a reply, which the bus threads back
 *   (same conversation_id, in_reply_to set) to the sender's queue.
 */
export class MessageBus {
  private readonly handlers = new Map<string, MessageHandler | undefined>();
  private readonly queues = new Map<string, AgentMessage[]>();
  private readonly topics = new Map<string, Set<string>>();
  private readonly seen = new Map<string, AgentMessage>();
  private readonly deadLetterQueue: AgentMessage[] = [];
  private readonly humanInboxQueue: AgentMessage[] = [];

  register(agentId: string, handler?: MessageHandler): void {
    this.handlers.set(agentId, handler);
    if (!this.queues.has(agentId)) this.queues.set(agentId, []);
  }

  subscribeTopic(topic: string, agentId: string): void {
    if (!this.handlers.has(agentId)) throw new Error(`agent ${agentId} is not registered`);
    const subs = this.topics.get(topic) ?? new Set();
    subs.add(agentId);
    this.topics.set(topic, subs);
  }

  async send(input: SendInput): Promise<AgentMessage> {
    if ((input.to === undefined) === (input.topic === undefined)) {
      throw new Error('exactly one of to/topic must be set');
    }
    const id = input.id ?? randomUUID();
    const existing = this.seen.get(id);
    if (existing) return existing; // idempotent: no redelivery

    const message: AgentMessage = Object.freeze({
      id,
      conversation_id: input.conversation_id ?? randomUUID(),
      ...(input.in_reply_to !== undefined ? { in_reply_to: input.in_reply_to } : {}),
      from: input.from,
      ...(input.to !== undefined ? { to: input.to } : {}),
      ...(input.topic !== undefined ? { topic: input.topic } : {}),
      performative: input.performative,
      content: input.content,
      untrusted: input.from.type === 'agent' || input.from.type === 'worker',
      ...(input.task_ref !== undefined ? { task_ref: input.task_ref } : {}),
      created_at: new Date().toISOString(),
    });
    this.seen.set(id, message);

    if (message.performative === 'escalate') {
      this.humanInboxQueue.push(message);
      return message;
    }
    if (message.topic !== undefined) {
      for (const subscriber of this.topics.get(message.topic) ?? []) {
        await this.deliver(subscriber, message);
      }
      return message;
    }
    if (!this.handlers.has(message.to!)) {
      this.deadLetterQueue.push(message);
      return message;
    }
    await this.deliver(message.to!, message);
    return message;
  }

  /** Sends a request and returns the correlated reply, if the recipient's
   *  handler produced one. */
  async request(
    from: Author,
    to: string,
    content: string,
    taskRef?: string,
  ): Promise<AgentMessage | undefined> {
    const message = await this.send({
      from,
      to,
      performative: 'request',
      content,
      ...(taskRef !== undefined ? { task_ref: taskRef } : {}),
    });
    const queue = this.queues.get(from.id) ?? [];
    const index = queue.findIndex((m) => m.in_reply_to === message.id);
    if (index === -1) return undefined;
    return queue.splice(index, 1)[0];
  }

  /** Drains the agent's queue. */
  receive(agentId: string): AgentMessage[] {
    const queue = this.queues.get(agentId) ?? [];
    this.queues.set(agentId, []);
    return queue;
  }

  deadLetters(): readonly AgentMessage[] {
    return [...this.deadLetterQueue];
  }

  humanInbox(): readonly AgentMessage[] {
    return [...this.humanInboxQueue];
  }

  private async deliver(agentId: string, message: AgentMessage): Promise<void> {
    const queue = this.queues.get(agentId) ?? [];
    queue.push(message);
    this.queues.set(agentId, queue);
    const handler = this.handlers.get(agentId);
    if (!handler) return;
    const reply = await handler(message);
    if (reply !== undefined) {
      const author: Author = { id: agentId, type: 'agent' };
      await this.send({
        from: author,
        to: message.from.id,
        conversation_id: message.conversation_id,
        in_reply_to: message.id,
        performative: reply.performative,
        content: reply.content,
        ...(message.task_ref !== undefined ? { task_ref: message.task_ref } : {}),
      });
    }
  }
}
