import { performance } from "node:perf_hooks";
import { Logger } from "winston";
import crypto from "crypto";

type Detail = {
  message?: string;
  [key: string]: unknown;
};

const defaultMeta = { datadog: true };

export type PerformanceData = {
  task: string; // The name of the task being measured.
  duration: number; // Duration in milliseconds.
  message: string; // A descriptive message about the task.
  at: string; // Identifier indicating where the profiling is happening.
  data?: Record<string, unknown>; // Additional detail data.
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

  /**
   * Initializes a new instance of the Profiler class.
   * @param logger The logger instance for logging performance data.
   * @param at A string identifier for where the profiler is used.
   * @param detail Optional additional detail data.
   */
  constructor({ logger, at, ...detail }: ProfilerOptions) {
    this.marks = new Map();
    this.at = at;
    this.detail = detail;
    this.logger = logger.child(defaultMeta);
  }

  /**
   * Starts a profiling session for a task.
   * @param task The name of the task being measured.
   * @param detail Optional detail data to merge.
   * @returns An object containing the start time and a stop function.
   */
  start(task: string, detail?: Detail): { startTime: number; stop: (_detail?: Detail) => number | undefined } {
    const start = crypto.randomUUID();
    const startTime = this.mark(start, detail);
    return {
      startTime,
      stop: (_detail?: Detail) => this.measure(task, { from: start, ...(detail ?? {}), ...(_detail ?? {}) }),
    };
  }

  /**
   * Records a mark with a label and optional detail.
   * @param label The label for the mark.
   * @param detail Optional detail data to merge.
   * @returns The current timestamp in milliseconds.
   */
  mark(label: string, detail?: Detail): number {
    const currentTime = performance.now();

    // Merge additional data
    this.detail = { ...(this.detail ?? {}), ...(detail ?? {}) };

    // Store the mark
    this.marks.set(label, { time: currentTime, detail });
    return currentTime;
  }

  /**
   * Measures the duration between two marks and logs the performance data.
   * @param task The name of the task for this measurement.
   * @param params An object containing:
   *  - `from`: The label of the starting mark.
   *  - `to` (optional): The label of the ending mark.
   *  - Additional detail data to merge.
   * @returns The duration in milliseconds, or undefined if the start mark is not found.
   */
  measure(
    task: string,
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
        message: `Cannot find start mark for label "${from}".`,
        ...this.detail,
      });
      return;
    }
    const endTime = endMark?.time ?? performance.now();

    const duration = endTime - startMark.time;

    // Merge detail
    const { message, ...combinedDetail } = { ...(this.detail ?? {}), ...(detail ?? {}) };
    const defaultMessage = `Profiler Log: ${task}`;

    const performanceData: PerformanceData = {
      at: this.at,
      task,
      duration,
      message: message ?? defaultMessage,
      data: combinedDetail,
    };

    this.logger.debug(performanceData);
    return duration;
  }

  /**
   * Measures the performance of an asynchronous operation represented by a promise.
   * @param pr The promise representing the asynchronous operation to measure.
   * @param task The name of the task for this measurement.
   * @param detail Optional detail data to merge.
   * @returns A promise that resolves with the result of the asynchronous operation.
   */
  async measureAsync<T>(pr: Promise<T>, task: string, detail?: Detail): Promise<T> {
    const startTime = performance.now();

    try {
      const result = await pr;
      return result;
    } finally {
      const endTime = performance.now();
      const duration = endTime - startTime;
      const { message, ...combinedDetail } = { ...detail };
      const defaultMessage = `Profiler Log: ${task}`;

      const performanceData: PerformanceData = {
        at: this.at,
        task,
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
   * @param task The name of the task for this measurement.
   * @param detail Optional detail data to merge.
   * @returns The result of the synchronous function.
   */
  measureSync<T>(fn: () => T, task: string, detail?: Detail): T {
    const startTime = performance.now();

    try {
      const result = fn();
      return result;
    } finally {
      const endTime = performance.now();
      const duration = endTime - startTime;
      const { message, ...combinedDetail } = { ...detail };
      const defaultMessage = `Profiler Log: ${task}`;

      const performanceData: PerformanceData = {
        at: this.at,
        task,
        duration,
        message: message ?? defaultMessage,
        data: combinedDetail,
      };

      this.logger.debug(performanceData);
    }
  }
}
