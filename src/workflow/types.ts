export type WorkflowLifecycle = "connection_bound" | "detached";

export type WorkflowRunStatus =
  | "queued"
  | "running"
  | "retrying"
  | "succeeded"
  | "failed"
  | "blocked"
  | "cancelled"
  | "interrupted";

export type WorkflowStepStatus =
  | "pending"
  | "ready"
  | "running"
  | "succeeded"
  | "failed"
  | "blocked"
  | "skipped";

export type WorkflowAttemptStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "rejected"
  | "cancelled"
  | "interrupted";

export interface WorkflowBudget {
  readonly maxTotalAttempts: number;
  readonly maxAttemptsPerStep: number;
  readonly maxCallsPerEdge: number;
}

export interface WorkflowVersionSnapshot {
  readonly workflowVersion?: string;
  readonly runtimeVersion?: string;
  readonly agentVersion?: string;
  readonly modelProvider?: string;
  readonly modelName?: string;
  readonly promptHash?: string;
  readonly toolSchemaHash?: string;
}

export interface WorkflowRunRecord {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly externalKey?: string;
  readonly kind: string;
  readonly lifecycle: WorkflowLifecycle;
  readonly status: WorkflowRunStatus;
  readonly budget: WorkflowBudget;
  readonly attemptsUsed: number;
  readonly metadata: Readonly<Record<string, string>>;
  readonly versions: WorkflowVersionSnapshot;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly terminalReason?: string;
}

export interface WorkflowStepRecord {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly stepId: string;
  readonly kind: string;
  readonly status: WorkflowStepStatus;
  readonly dependencies: readonly string[];
  readonly attemptsUsed: number;
  readonly edgeCalls: Readonly<Record<string, number>>;
  readonly checkpoint?: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly terminalReason?: string;
}

export interface WorkflowAttemptRecord {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly stepId: string;
  readonly attemptId: string;
  readonly ordinal: number;
  readonly status: WorkflowAttemptStatus;
  readonly strategy: Readonly<Record<string, unknown>>;
  readonly strategyFingerprint: string;
  readonly triggerErrorFingerprint?: string;
  readonly resultErrorFingerprint?: string;
  readonly diffFingerprint?: string;
  readonly idempotencyPrefix: string;
  readonly circuitKey?: string;
  readonly execution?: {
    readonly kind: "child_agent";
    readonly externalKey: string;
    readonly childRunId: string;
    readonly boundAt: string;
  };
  readonly versions: WorkflowVersionSnapshot;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly endedAt?: string;
  readonly summary?: string;
}

export interface WorkflowEventRecord {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly seq: number;
  readonly type: string;
  readonly ts: string;
  readonly stepId?: string;
  readonly attemptId?: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface FailureExperienceRecord {
  readonly schemaVersion: 1;
  readonly experienceId: string;
  readonly runId: string;
  readonly stepId: string;
  readonly attemptId: string;
  readonly workflowKind: string;
  readonly errorFingerprint: string;
  readonly strategyFingerprint: string;
  readonly diffFingerprint?: string;
  readonly contextFingerprint?: string;
  readonly summary: string;
  readonly versions: WorkflowVersionSnapshot;
  readonly createdAt: string;
  readonly resolution: "unresolved" | "resolved" | "superseded";
}

export type CircuitBreakerState = "closed" | "open" | "half_open";

export interface CircuitBreakerRecord {
  readonly schemaVersion: 1;
  readonly key: string;
  readonly state: CircuitBreakerState;
  readonly failureCount: number;
  readonly threshold: number;
  readonly updatedAt: string;
  readonly openedAt?: string;
  readonly cooldownUntil?: string;
  readonly probeRunId?: string;
}
