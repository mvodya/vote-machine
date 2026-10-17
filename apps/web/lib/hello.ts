export interface Hello {
  // Text returned by the API
  message: string;
  // Whether the database replied
  database: 'connected';
}

// Check the shape of a hello reply
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
