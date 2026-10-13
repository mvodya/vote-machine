export interface Hello {
  message: string;
  database: 'connected';
}

export function isHello(value: unknown): value is Hello {
  return (
    typeof value === 'object' &&
    value !== null &&
    'message' in value &&
    typeof value.message === 'string' &&
    'database' in value &&
    value.database === 'connected'
  );
}
