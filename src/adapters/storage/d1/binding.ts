/** Structural subset of the Workers binding, supplied by the host; no REST client or credentials. */
export interface D1Result<T = Record<string, unknown>> {
  success: boolean;
  results: T[];
  meta: { changes: number; rows_read?: number; rows_written?: number };
}
export interface D1Statement {
  bind(...values: (string | number | null)[]): D1Statement;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}
export interface D1Session {
  prepare(sql: string): D1Statement;
  batch(statements: D1Statement[]): Promise<D1Result[]>;
}
export interface D1Binding {
  readonly writeGeneration?: number;
  withSession(constraint: "first-primary"): D1Session;
}
