import { performance, PerformanceObserver, PerformanceEntry } from "node:perf_hooks";

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

class Profiler {
  observer: PerformanceObserver | undefined;
  measurements: Map<string, PerformanceEntry> = new Map();
  functions: Map<string, PerformanceEntry> = new Map();

  constructor() {
    const observer = new PerformanceObserver((list) => {
      const entries = list.getEntries();
      entries.forEach((entry) => {
        if (entry.entryType === "measure") {
          this.measurements.set(entry.name, entry);
        }
        if (entry.entryType === "function") {
          this.functions.set(entry.name, entry);
        }
      });
    });
    observer.observe({ entryTypes: ["measure", "mark", "function"], buffered: true });
    this.observer = observer;
  }

  async measureAsync(pr: Promise<unknown>, id: string): Promise<unknown> {
    this.start(id);
    const res = await pr;
    this.stop(id);
    return res;
  }

  start(taskName: string): void {
    performance.mark(`${taskName}-start`);
  }

  stop(taskName: string): void {
    performance.mark(`${taskName}-stop`);
    performance.measure(taskName, `${taskName}-start`, `${taskName}-stop`);
  }

  report(params?: {
    taskName?: string;
    keys?: Array<keyof PerformanceEntry>;
  }): Record<string, Partial<PerformanceEntry>> {
    const taskName = params?.taskName;
    const keys = params?.keys ?? ["duration"];

    if (taskName) {
      const measurement = this.measurements.get(taskName);
      if (measurement) {
        return {
          [taskName]: pickObject(Object(measurement), keys),
        };
      }
    }

    return Object.fromEntries(
      Array.from(this.measurements.entries()).map(([key, value]) => [key, pickObject(Object(value), keys)])
    );
  }

  // Recommended to use this if possible since collection of measurements happens asynchronously via the observer
  async reportAsync(...args: Parameters<typeof this.report>): Promise<ReturnType<typeof this.report>> {
    await sleep(1);
    return this.report(...args);
  }
}
//  export a single instance. do we want to enforce a singleton here?
export const profiler = new Profiler();

// UTILS
export function sleep(milliseconds: number): Promise<boolean> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(true), milliseconds);
  });
}
// returns the object with entries for keys specified in 2nd arg
function pickObject<T extends Record<string, unknown>>(obj: T, keys: Array<keyof T>): Partial<T> {
  const entries = keys.filter((key) => key in obj).map((key) => [key, obj[key]]);
  return Object.fromEntries(entries);
}
