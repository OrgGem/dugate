import { ValidationError } from '../types/results';

export class SchemaValidator {
  private static readonly MAX_DEPTH = 5;
  private static readonly MAX_PROPERTIES = 50;

  public static validateCustomSchema(schema: Record<string, unknown>): void {
    if (!schema || typeof schema !== 'object') {
      throw new ValidationError('Schema must be a valid JSON object', 'INVALID_CUSTOM_SCHEMA');
    }

    let propertyCount = 0;

    const traverse = (obj: unknown, currentDepth: number): void => {
      if (currentDepth > this.MAX_DEPTH) {
        throw new ValidationError(
          `Schema nesting exceeds maximum allowed depth (${this.MAX_DEPTH})`,
          'SCHEMA_DEPTH_EXCEEDED'
        );
      }

      if (!obj || typeof obj !== 'object') return;

      const record = obj as Record<string, unknown>;

      // Check for forbidden network $ref
      if ('$ref' in record && typeof record['$ref'] === 'string') {
        const refVal = record['$ref'];
        if (
          refVal.startsWith('http://') ||
          refVal.startsWith('https://') ||
          refVal.startsWith('//')
        ) {
          throw new ValidationError(
            `Network $ref references are forbidden in custom schema: "${refVal}"`,
            'FORBIDDEN_SCHEMA_REF'
          );
        }
      }

      if ('properties' in record && typeof record.properties === 'object' && record.properties) {
        const props = record.properties as Record<string, unknown>;
        const keys = Object.keys(props);
        propertyCount += keys.length;

        if (propertyCount > this.MAX_PROPERTIES) {
          throw new ValidationError(
            `Schema contains too many properties (exceeds ${this.MAX_PROPERTIES})`,
            'SCHEMA_SIZE_EXCEEDED'
          );
        }

        for (const key of keys) {
          traverse(props[key], currentDepth + 1);
        }
      }

      if ('items' in record) {
        traverse(record.items, currentDepth + 1);
      }
    };

    traverse(schema, 1);
  }
}
