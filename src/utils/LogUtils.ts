import { bigNumberFormatter } from "@uma/logger";
import { performance } from "node:perf_hooks";
import winston, { Logger } from "winston";
import crypto from "crypto";

export type DefaultLogLevels = "debug" | "info" | "warn" | "error";

export function stringifyThrownValue(value: unknown): string {
  if (value instanceof Error) {
    const errToString = value.toString();
    return value.stack || value.message || errToString !== "[object Object]"
      ? errToString
      : "could not extract error from 'Error' instance";
  } else if (value instanceof Object) {
    const objStringified = JSON.stringify(value);
    return objStringified !== "{}" ? objStringified : "could not extract error from 'Object' instance";
  } else {
    return `ThrownValue: ${value.toString()}`;
  }
}

type Detail = {
  message?: string;
  [key: string]: unknown;
};

export type PerformanceData = {
  id: string; // Unique identifier for the profiling session
  taskName: string; // Name of the task being measured
  duration: number; // Duration in milliseconds
  message: string;
  data?: Record<string, unknown>; // Cumulative detail data
};

type ProfilerOptions = {
  logger?: Logger;
};

const defaultLogger = winston.createLogger({
  level: "debug",
  defaultMeta: { datadog: true },
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format(bigNumberFormatter)(),
    winston.format.json({
      space: 2,
    })
  ),
  transports: [new winston.transports.Console()],
});

class TaskProfiler {
  id: string;
  private marks: Map<string, { time: number; detail?: Record<string, unknown> }>;
  private detail: Detail;
  private logger: Logger;

  constructor(logger: Logger, detail?: Record<string, unknown>) {
    this.id = crypto.randomUUID();
    this.marks = new Map();
    this.detail = detail ? { ...detail } : {};
    this.logger = logger;
  }

  /**
   * Records a mark with a label and optional detail.
   * @param label The label for the mark.
   * @param detail Optional detail data to merge.
   */
  mark(label: string, detail?: Detail): void {
    const currentTime = performance.now();

    // merge additional data
    this.detail = { ...(this.detail ?? {}), ...(detail ?? {}) };

    // Store the mark
    this.marks.set(label, { time: currentTime, detail });
  }

  /**
   * Measures the duration between two marks and logs the performance data.
   * @param taskName The name of the task for this measurement.
   * @param startLabel The label of the starting mark.
   * @param endLabel The label of the ending mark.
   * @param detail Optional detail data to merge.
   */
  measure(
    taskName: string,
    params: {
      from: string;
      to?: string;
    } & Detail
  ): void {
    const { from, to, ...detail } = params;
    const startMark = this.marks.get(from);
    const endMark = to ? this.marks.get(to) : undefined;

    if (!startMark) {
      this.logger.warn(`Cannot find start marks for label "${params.startLabel}".`);
      return;
    }
    const endTime = endMark?.time ?? performance.now();

    const duration = endTime - startMark.time;

    // Merge detail
    const { message, ...combinedDetail } = { ...(this.detail ?? {}), ...(detail ?? {}) };
    const defaultMessage = `Profiler Log: ${taskName}`;

    const performanceData: PerformanceData = {
      id: this.id,
      taskName,
      duration,
      message: message ?? defaultMessage,
      data: combinedDetail,
    };

    this.logger.debug(performanceData);
  }

  /**
   * Measures the performance of an asynchronous function by wrapping it.
   * @param fn The asynchronous function to measure.
   * @param taskName The name of the task for this measurement.
   * @param detail Optional detail data to merge.
   * @returns The result of the asynchronous function.
   */
  async measureAsync<T>(pr: Promise<T>, taskName: string, detail?: Detail): Promise<T> {
    const startTime = performance.now();

    try {
      const result = await pr;
      return result;
    } finally {
      const endTime = performance.now();
      const duration = endTime - startTime;
      const { message, ...combinedDetail } = { ...detail };
      const defaultMessage = `Profiler Log: ${taskName}`;

      const performanceData: PerformanceData = {
        id: crypto.randomUUID(),
        taskName,
        duration,
        message: message ?? defaultMessage,
        data: combinedDetail,
      };

      this.logger.debug(performanceData);
    }
  }

  /**
   * Measures the performance of a synchronous function by wrapping it.
   * @param fn The synchronous function to measure.
   * @param taskName The name of the task for this measurement.
   * @param detail Optional detail data to merge.
   * @returns The result of the synchronous function.
   */
  measureSync<T>(fn: () => T, taskName: string, detail?: Detail): T {
    const startTime = performance.now();

    try {
      const result = fn();
      return result;
    } finally {
      const endTime = performance.now();
      const duration = endTime - startTime;
      const { message, ...combinedDetail } = { ...detail };
      const defaultMessage = `Profiler Log: ${taskName}`;

      const performanceData: PerformanceData = {
        id: crypto.randomUUID(),
        taskName,
        duration,
        message: message ?? defaultMessage,
        data: combinedDetail,
      };

      this.logger.debug(performanceData);
    }
  }
}

export class Profiler {
  private logger: Logger;

  constructor(options?: ProfilerOptions) {
    this.logger = options?.logger ?? defaultLogger;
  }

  /**
   * Creates a new profiling session.
   * @param detail Optional detail data.
   * @returns A TaskProfiler instance.
   */
  create(detail?: Record<string, unknown>): TaskProfiler {
    return new TaskProfiler(this.logger, detail);
  }
}

export const profiler = new Profiler();
