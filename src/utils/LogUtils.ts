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
  stream?: boolean; // Determines if measures are streamed immediately; defaults to true
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
  private stream: boolean;
  private measures: PerformanceData[] = []; // Used if streaming is disabled

  /**
   * Constructs a new Profiler instance.
   * @param params Profiler options.
   * @param params.logger A custom Winston logger instance.
   * @param params.stream Determines if measures are streamed immediately; defaults to true.
   */
  constructor(params?: ProfilerOptions) {
    this.logger = params?.logger ?? defaultLogger;
    this.stream = params?.stream ?? true;
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
   * Marks the end of a performance measurement for a given task and records the measurement.
   * @param taskName The name of the task.
   * @param detail Optional additional data related to the task.
   */
  stop(taskName: string, detail?: unknown): void {
    const task = this.tasks.get(taskName);
    if (!task) {
      this.logger.warn(`No start time found for task "${taskName}". Did you forget to call start()?`);
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

    if (this.stream) {
      // Log the measure immediately
      this.logger.debug(performanceData);
    } else {
      // Store the measure for later reporting
      this.measures.push(performanceData);
    }

    // Clean up the task from the map
    this.tasks.delete(taskName);
  }

  /**
   * Generates a performance report based on the stored measurements.
   * Only applicable if streaming is disabled.
   * @param params Optional parameters for generating the report.
   * @param params.taskName Filters the report to include only measurements for the specified task.
   * @param params.keys Specifies which keys to include in each performance data entry.
   * @param params.asRecord Determines if the report should be returned as a record object.
   * @returns An array or record of performance data entries.
   */
  report(params?: {
    taskName?: string;
    keys?: Array<keyof PerformanceData>;
    asRecord?: boolean;
  }): Array<Partial<PerformanceData>> | Record<string, Partial<PerformanceData>> {
    if (this.stream) {
      this.logger.warn("Reporting is only available when streaming is disabled.");
      return [];
    }

    const taskName = params?.taskName;
    const keys = params?.keys ?? ["task", "duration", "data"];
    const asRecord = params?.asRecord ?? false;
    let filteredMeasures = this.measures;

    // Filter measurements by task name if provided
    if (taskName) {
      filteredMeasures = filteredMeasures.filter((measure) => measure.task === taskName);
    }

    // Map measurements to include only specified keys
    const transformed = filteredMeasures.map((measure) => {
      return pickObject<PerformanceData>(measure, keys);
    });

    return asRecord ? this.toRecord(transformed) : transformed;
  }

  /**
   * Converts an array of PerformanceData entries into a record indexed by task names.
   * @param measures An array of partial performance data entries.
   * @returns A record with task names as keys and performance data as values.
   */
  private toRecord(measures: Array<Partial<PerformanceData>>): Record<string, Partial<PerformanceData>> {
    return Object.fromEntries(measures.map(({ task, ...rest }) => [task, { ...rest }]));
  }

  /**
   * Logs the performance report using the configured logger.
   * Only applicable if streaming is disabled.
   * @param params Parameters to pass to the report method.
   */
  logReport(params?: { taskName?: string; keys?: Array<keyof PerformanceData>; asRecord?: boolean }): void {
    if (this.stream) {
      this.logger.warn("Logging reports is only available when streaming is disabled.");
      return;
    }
    const reportData = this.report(params);
    this.logger.debug(reportData);
  }

  /**
   * Clears all recorded performance entries and internal data structures.
   */
  clear(): void {
    this.tasks.clear();
    this.measures = [];
  }
}

// UTILS
export function sleep(milliseconds: number): Promise<boolean> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(true), milliseconds);
  });
}

function pickObject<T extends Record<string, unknown>>(obj: T, keys: Array<keyof T>): Partial<T> {
  const entries = keys.filter((key) => key in obj).map((key) => [key, obj[key]]);
  return Object.fromEntries(entries);
}
