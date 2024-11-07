import { bigNumberFormatter } from "@uma/logger";
import { performance } from "node:perf_hooks";
import winston, { Logger } from "winston";

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

export type PerformanceData = {
  task: string; // Name of the task being measured
  duration: number; // Duration of the task in milliseconds
  data?: unknown; // Optional additional data related to the task
};

type ProfilerOptions = {
  logger?: Logger;
};

const defaultLogger = winston.createLogger({
  level: "debug",
  defaultMeta: { datadog: true }, // Key to identify data for ingestion
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format(bigNumberFormatter)(),
    winston.format.json()
  ),
  transports: [new winston.transports.Console()],
});

export class Profiler {
  private tasks: Map<
    string,
    {
      startTime: number;
      detail?: unknown;
    }
  > = new Map();
  private logger: Logger;

  /**
   * Constructs a new Profiler instance.
   * @param params Profiler options.
   * @param params.logger A custom Winston logger instance.
   */
  constructor(params?: ProfilerOptions) {
    this.logger = params?.logger ?? defaultLogger;
  }

  /**
   * Measures the performance of a synchronous function.
   * @param fn The synchronous function to measure.
   * @param taskName A unique identifier for the task.
   * @param detail Optional additional data related to the task.
   * @returns The result of the synchronous function.
   */
  measureSync<T>(fn: () => T, taskName: string, detail?: unknown): T {
    this.start(taskName, detail);
    try {
      const result = fn();
      return result;
    } finally {
      this.stop(taskName, detail);
    }
  }

  /**
   * Measures the performance of an asynchronous operation.
   * @param pr The promise representing the asynchronous operation.
   * @param taskName A unique identifier for the task.
   * @param detail Optional additional data related to the task.
   * @returns The result of the asynchronous operation.
   */
  async measureAsync<T>(pr: Promise<T>, taskName: string, detail?: unknown): Promise<T> {
    this.start(taskName, detail);
    const result = await pr;
    this.stop(taskName, detail);
    return result;
  }

  /**
   * Marks the start of a performance measurement for a given task.
   * @param taskName The name of the task.
   * @param detail Optional additional data related to the task.
   */
  start(taskName: string, detail?: unknown): void {
    this.tasks.set(taskName, {
      startTime: performance.now(),
      detail,
    });
  }

  /**
   * Marks the end of a performance measurement for a given task and logs the measurement.
   * @param taskName The name of the task.
   * @param detail Optional additional data related to the task.
   */
  stop(taskName: string, detail?: unknown): void {
    const task = this.tasks.get(taskName);
    if (!task) {
      this.logger.warn(`No start time found for task "${taskName}". Did you forget to call start()?`, detail);
      return;
    }

    const endTime = performance.now();
    const duration = endTime - task.startTime;
    const data = detail ?? task.detail;

    const performanceData: PerformanceData = {
      task: taskName,
      duration,
      data,
    };

    // Log the measure immediately
    this.logger.debug(performanceData);

    // Clean up the task from the map
    this.tasks.delete(taskName);
  }

  /**
   * Clears all recorded performance entries and internal data structures.
   */
  clear(): void {
    this.tasks.clear();
  }
}
