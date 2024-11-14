import { performance } from "node:perf_hooks";
import { Logger } from "winston";
import crypto from "crypto";

type Detail = {
  message?: string;
  [key: string]: unknown;
};

const defaultMeta = { datadog: true };

export type PerformanceData = {
  taskName: string; // Name of the task being measured
  duration: number; // Duration in milliseconds
  message: string;
  at: string;
  data?: Record<string, unknown>; // Cumulative detail data
};

type ProfilerOptions = {
  logger: Logger;
  at: string;
} & Record<string, unknown>;

export class Profiler {
  private marks: Map<string, { time: number; detail?: Record<string, unknown> }>;
  private at: string;
  private detail: Detail;
  private logger: Logger;

  constructor({ logger, at, ...detail }: ProfilerOptions) {
    this.marks = new Map();
    this.at = at;
    this.detail = detail;
    this.logger = logger.child(defaultMeta);
  }

  start(
    taskName: string,
    detail?: Detail
  ): { startTime: number | undefined; stop: (_detail?: Detail) => number | undefined } {
    const start = crypto.randomUUID();
    const startTime = this.mark(start, detail);
    return {
      startTime,
      stop: (_detail?: Detail) => this.measure(taskName, { from: start, ...(detail ?? {}), ...(_detail ?? {}) }),
    };
  }

  /**
   * Records a mark with a label and optional detail.
   * @param label The label for the mark.
   * @param detail Optional detail data to merge.
   */
  mark(label: string, detail?: Detail): number {
    const currentTime = performance.now();

    // merge additional data
    this.detail = { ...(this.detail ?? {}), ...(detail ?? {}) };

    // Store the mark
    this.marks.set(label, { time: currentTime, detail });
    return currentTime;
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
  ): number | undefined {
    const { from, to, ...detail } = params;
    const startMark = this.marks.get(from);
    const endMark = to ? this.marks.get(to) : undefined;

    if (!startMark) {
      this.logger.warn({
        at: this.at,
        message: `Cannot find start marks for label "${params.startLabel}".`,
        ...this.detail,
      });
      return;
    }
    const endTime = endMark?.time ?? performance.now();

    const duration = endTime - startMark.time;

    // Merge detail
    const { message, ...combinedDetail } = { ...(this.detail ?? {}), ...(detail ?? {}) };
    const defaultMessage = `Profiler Log: ${taskName}`;

    const performanceData: PerformanceData = {
      at: this.at,
      taskName,
      duration,
      message: message ?? defaultMessage,
      data: combinedDetail,
    };

    this.logger.debug(performanceData);
    return duration;
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
        at: this.at,
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
        at: this.at,
        taskName,
        duration,
        message: message ?? defaultMessage,
        data: combinedDetail,
      };

      this.logger.debug(performanceData);
    }
  }
}
