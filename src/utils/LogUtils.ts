import { bigNumberFormatter } from "@uma/logger";
import { performance, PerformanceObserver, PerformanceEntry, PerformanceMeasure } from "node:perf_hooks";
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
  task: PerformanceEntry["name"]; // Name of the task being measured
  duration: PerformanceEntry["duration"]; // Duration of the task in milliseconds
  data?: unknown; // Optional additional data related to the task
};

const defaultLogger = winston.createLogger({
  level: "debug",
  defaultMeta: { datadog: true }, // Key to identify data for ingestion
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format(bigNumberFormatter)(), // Handle big numbers in logs
    winston.format.json()
  ),
  transports: [new winston.transports.Console()],
});

export class Profiler {
  observer: PerformanceObserver | undefined;
  marks: Map<string, PerformanceEntry> = new Map();
  measures: Set<PerformanceData> = new Set();
  functions: Map<string, PerformanceEntry> = new Map();
  logger: Logger;

  /**
   * Constructs a new Profiler instance.
   * @param params.logger A custom Winston logger instance.
   */
  constructor(params?: { logger: Logger }) {
    this.logger = params?.logger ?? defaultLogger;

    const observer = new PerformanceObserver((list) => {
      // Collect function performance entries
      list.getEntriesByType("function").forEach((func) => {
        this.functions.set(func.name, func);
      });
      // Collect measure performance entries
      list.getEntriesByType("measure").forEach((measure) => {
        this.measures.add({
          task: measure.name,
          duration: measure.duration,
          data: this.getDetail(measure.name),
        });
      });
      // Collect mark performance entries
      list.getEntriesByType("mark").forEach((mark) => {
        this.marks.set(mark.name, mark);
      });
    });
    observer.observe({ entryTypes: ["measure", "mark", "function"], buffered: true });
    this.observer = observer;
  }

  /**
   * Measures the performance of an asynchronous operation.
   * @param pr The promise representing the asynchronous operation.
   * @param id A unique identifier for the task.
   * @param detail Optional additional data related to the task.
   * @returns The result of the asynchronous operation.
   */
  async measureAsync<T extends Promise<unknown>>(pr: T, id: string, detail?: unknown): Promise<T> {
    this.start(id, {
      detail,
    });
    const res = await pr;
    this.stop(id);
    return res;
  }

  /**
   * Retrieves the additional data associated with a task.
   * @param taskName The name of the task.
   * @returns The detail object associated with the task's start or stop mark.
   */
  private getDetail(taskName: string) {
    const startMark = this.marks.get(`${taskName}-start`);
    const endMark = this.marks.get(`${taskName}-stop`);
    return startMark?.detail ?? endMark?.detail;
  }

  /**
   * Disconnects the PerformanceObserver, stopping it from receiving further performance entries.
   */
  disconnect(): void {
    this.observer?.disconnect();
  }

  /**
   * Clears all recorded performance entries and internal data structures.
   */
  clear(): void {
    performance.clearMarks();
    this.marks = new Map();
    this.measures = new Set();
    this.functions = new Map();
  }

  /**
   * Marks the start of a performance measurement for a given task.
   * @param taskName The name of the task.
   * @param detail Optional additional data related to the task.
   */
  start(taskName: string, detail?: unknown): void {
    performance.mark(`${taskName}-start`, {
      detail,
    });
  }

  /**
   * Marks the end of a performance measurement for a given task and records the measurement.
   * @param taskName The name of the task.
   * @param detail Optional additional data related to the task.
   * @returns The performance measure entry created.
   */
  stop(taskName: string, detail?: unknown): PerformanceMeasure {
    performance.mark(`${taskName}-stop`, {
      detail,
    });
    return performance.measure(taskName, `${taskName}-start`, `${taskName}-stop`);
  }

  /**
   * Converts a PerformanceData entry to a JSON-friendly format.
   * @param entry The performance data entry to convert.
   * @returns The JSON representation of the entry.
   */
  toJSON(entry: PerformanceData): unknown {
    return JSON.parse(JSON.stringify(entry));
  }

  /**
   * Converts an array of PerformanceData entries into a record indexed by task names.
   * @param measures An array of partial performance data entries.
   * @returns A record with task names as keys and performance data as values.
   */
  toRecord(
    measures: Array<Partial<PerformanceData>>
  ): Record<PerformanceData["task"], Partial<Omit<PerformanceData, "task">>> {
    return Object.fromEntries(measures.map(({ task, ...rest }) => [task, { ...rest }]));
  }

  /**
   * Creates a performance report based on the recorded measurements.
   * @param params Optional parameters for generating the report.
   * @param params.taskName Filters the report to include only measurements for the specified task.
   * @param params.keys Specifies which keys to include in each performance data entry.
   * @param params.asRecord Determines if the report should be returned as a record object.
   * @returns An array or record of performance data entries.
   */
  createReport(params?: {
    taskName?: string;
    keys?: Array<keyof PerformanceData>;
    asRecord?: boolean;
  }): Array<Partial<PerformanceData>> | ReturnType<typeof this.toRecord> {
    const taskName = params?.taskName;
    const keys = params?.keys ?? ["task", "duration", "data"];
    const asRecord = params?.asRecord ?? false;
    let measurements = Array.from(this.measures);

    // Filter measurements by task name if provided
    if (taskName) {
      measurements = measurements.filter((task) => task.task === taskName);
    }
    // Map measurements to include only specified keys
    const measures = measurements.map((measure) => {
      return pickObject<PerformanceData>({ ...measure, data: this.getDetail(measure.task) }, keys);
    });
    return asRecord ? this.toRecord(measures) : measures;
  }

  /**
   * Ensures all performance entries have been captured before creating a report.
   * @param args Arguments to pass to the createReport method.
   * @returns A promise that resolves to the performance report.
   */
  async createReportAsync(
    ...args: Parameters<typeof this.createReport>
  ): Promise<ReturnType<typeof this.createReport>> {
    await sleep(1); // Wait for the observer to process all entries
    return this.createReport(...args);
  }

  /**
   * Logs the performance report using the configured logger.
   * @param args Arguments to pass to the createReport method.
   */
  log(...args: Parameters<typeof this.createReport>): void {
    const report = this.createReport(...args);
    this.logger.debug(report);
  }

  /**
   * Asynchronously logs the performance report after ensuring all entries are captured.
   * @param args Arguments to pass to the createReportAsync method.
   * @returns A promise that resolves when logging is complete.
   */
  async logAsync(...args: Parameters<typeof this.createReportAsync>): Promise<void> {
    const report = await this.createReportAsync(...args);
    this.logger.debug(report);
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
