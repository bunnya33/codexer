export type Row = Record<string, unknown>;

export type Sql = { query(sql: string, params?: unknown[]): Promise<{ rows: Row[] }> };

/** 整个回调必须使用同一连接；失败时回滚全部写入。 */
export type Transaction = <T>(operation: (sql: Sql) => Promise<T>) => Promise<T>;

export type Database = { sql: Sql; transaction: Transaction; close(): Promise<void> };
