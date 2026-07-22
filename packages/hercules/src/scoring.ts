/** Evidence-based routing (spec 09 §6): measured outcomes, not model loyalty. */

export interface Outcome {
  readonly correct: boolean;
  readonly costUsd: number;
  readonly durationMs: number;
}

export interface WorkerScore {
  readonly n: number;
  readonly correctness: number;
  readonly avgCostUsd: number;
  readonly avgDurationMs: number;
}

/** A lesson without provenance cannot become an architecture rule (spec 09 §3). */
export interface Lesson {
  readonly pattern: string;
  readonly evidence: string;
  readonly status: 'observed' | 'validated' | 'forbidden';
  readonly replacement?: string;
}

export class MissingEvidenceError extends Error {
  constructor() {
    super(
      'Lessons require provenance: evidence is mandatory, and forbidden status requires validation',
    );
    this.name = 'MissingEvidenceError';
  }
}

export class ScoreBoard {
  private readonly outcomes = new Map<string, Outcome[]>();
  private readonly lessons: Lesson[] = [];

  recordOutcome(workerId: string, category: string, outcome: Outcome): void {
    const key = `${workerId}:${category}`;
    const list = this.outcomes.get(key) ?? [];
    list.push(outcome);
    this.outcomes.set(key, list);
  }

  score(workerId: string, category: string): WorkerScore {
    const list = this.outcomes.get(`${workerId}:${category}`) ?? [];
    if (list.length === 0) {
      // Exploration prior: unknown workers are neither favored nor excluded.
      return { n: 0, correctness: 0.5, avgCostUsd: 0, avgDurationMs: 0 };
    }
    const sum = list.reduce(
      (acc, o) => ({
        correct: acc.correct + (o.correct ? 1 : 0),
        cost: acc.cost + o.costUsd,
        duration: acc.duration + o.durationMs,
      }),
      { correct: 0, cost: 0, duration: 0 },
    );
    return {
      n: list.length,
      correctness: sum.correct / list.length,
      avgCostUsd: sum.cost / list.length,
      avgDurationMs: sum.duration / list.length,
    };
  }

  /**
   * Picks the worker with the best weighted score for the category. Cost and
   * speed are normalized against the candidate pool; correctness dominates
   * unless the caller re-weights (a correctness-critical migration weighs
   * differently than cheap iteration).
   */
  selectWorker(
    workerIds: readonly string[],
    category: string,
    weights: { correctness?: number; cost?: number; speed?: number } = {},
  ): string {
    if (workerIds.length === 0) throw new Error('no candidate workers');
    const w = {
      correctness: weights.correctness ?? 0.7,
      cost: weights.cost ?? 0.15,
      speed: weights.speed ?? 0.15,
    };
    const scores = workerIds.map((id) => ({ id, s: this.score(id, category) }));
    const maxCost = Math.max(1e-9, ...scores.map(({ s }) => s.avgCostUsd));
    const maxDuration = Math.max(1e-9, ...scores.map(({ s }) => s.avgDurationMs));
    let best = scores[0]!;
    let bestValue = -Infinity;
    for (const candidate of scores) {
      const value =
        w.correctness * candidate.s.correctness +
        w.cost * (1 - candidate.s.avgCostUsd / maxCost) +
        w.speed * (1 - candidate.s.avgDurationMs / maxDuration);
      if (value > bestValue) {
        best = candidate;
        bestValue = value;
      }
    }
    return best.id;
  }

  addLesson(lesson: Lesson): Lesson {
    if (lesson.evidence.trim() === '') throw new MissingEvidenceError();
    // A hallucinated lesson cannot jump straight to forbidding architecture:
    // forbidden requires a replacement (what to do instead) as validation.
    if (lesson.status === 'forbidden' && (lesson.replacement ?? '').trim() === '') {
      throw new MissingEvidenceError();
    }
    this.lessons.push(lesson);
    return lesson;
  }

  allLessons(): readonly Lesson[] {
    return [...this.lessons];
  }
}
