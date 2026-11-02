/**
 * Метрики в формате Prometheus text exposition (T1-18) без внешних зависимостей: counter, gauge, histogram.
 * Каркас для RED (Rate/Errors/Duration) по эндпоинтам api, длины очередей и ошибок воркера.
 */

export type Labels = Record<string, string>;

const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

const escape = (v: string) => v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
const labelKey = (labels: Labels) =>
  Object.keys(labels)
    .sort()
    .map((k) => `${k}="${escape(labels[k] ?? "")}"`)
    .join(",");
const fmt = (name: string, key: string, value: number) => `${name}${key ? `{${key}}` : ""} ${value}`;

interface Metric {
  render(): string[];
}

export class Counter implements Metric {
  private readonly values = new Map<string, number>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}
  inc(labels: Labels = {}, by = 1): void {
    const k = labelKey(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + by);
  }
  get(labels: Labels = {}): number {
    return this.values.get(labelKey(labels)) ?? 0;
  }
  render(): string[] {
    return [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} counter`,
      ...[...this.values].map(([k, v]) => fmt(this.name, k, v)),
    ];
  }
}

export class Gauge implements Metric {
  private readonly values = new Map<string, number>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}
  set(labels: Labels, value: number): void {
    this.values.set(labelKey(labels), value);
  }
  get(labels: Labels = {}): number | undefined {
    return this.values.get(labelKey(labels));
  }
  render(): string[] {
    return [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} gauge`,
      ...[...this.values].map(([k, v]) => fmt(this.name, k, v)),
    ];
  }
}

export class Histogram implements Metric {
  private readonly series = new Map<string, { counts: number[]; sum: number; count: number }>();
  constructor(
    readonly name: string,
    readonly help: string,
    readonly buckets: readonly number[] = DEFAULT_BUCKETS,
  ) {}
  observe(labels: Labels, value: number): void {
    const k = labelKey(labels);
    let s = this.series.get(k);
    if (!s) {
      s = { counts: this.buckets.map(() => 0), sum: 0, count: 0 };
      this.series.set(k, s);
    }
    for (let i = 0; i < this.buckets.length; i++) if (value <= this.buckets[i]!) s.counts[i]! += 1;
    s.sum += value;
    s.count += 1;
  }
  count(labels: Labels = {}): number {
    return this.series.get(labelKey(labels))?.count ?? 0;
  }
  render(): string[] {
    const out = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [k, s] of this.series) {
      const join = (extra: string) => (k ? `${k},${extra}` : extra);
      this.buckets.forEach((b, i) => out.push(`${this.name}_bucket{${join(`le="${b}"`)}} ${s.counts[i]}`));
      out.push(`${this.name}_bucket{${join('le="+Inf"')}} ${s.count}`);
      out.push(fmt(`${this.name}_sum`, k, s.sum), fmt(`${this.name}_count`, k, s.count));
    }
    return out;
  }
}

/** Реестр метрик процесса. Повторная регистрация по имени возвращает ту же метрику. */
export class MetricsRegistry {
  private readonly metrics = new Map<string, Metric>();
  counter(name: string, help: string): Counter {
    return this.getOrAdd(name, () => new Counter(name, help));
  }
  gauge(name: string, help: string): Gauge {
    return this.getOrAdd(name, () => new Gauge(name, help));
  }
  histogram(name: string, help: string, buckets?: readonly number[]): Histogram {
    return this.getOrAdd(name, () => new Histogram(name, help, buckets));
  }
  /** Prometheus text exposition format. */
  render(): string {
    return [...this.metrics.values()].flatMap((m) => m.render()).join("\n") + "\n";
  }
  private getOrAdd<M extends Metric>(name: string, make: () => M): M {
    const existing = this.metrics.get(name);
    if (existing) return existing as M;
    const m = make();
    this.metrics.set(name, m);
    return m;
  }
}

export const PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";
