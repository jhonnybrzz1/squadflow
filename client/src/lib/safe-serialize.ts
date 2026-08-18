/**
 * safe-serialize.ts - Utilitário de serialização segura para React
 *
 * Converte objetos potencialmente não serializáveis em objetos seguros para renderização.
 * Resolve problemas com Date, BigInt, Promises, funções e símbolos que causam erros React.
 */

type SerializableValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | SerializableValue[]
  | { [key: string]: SerializableValue };

interface SafeSerializeOptions {
  /** Profundidade máxima de aninhamento (default: 10) */
  maxDepth?: number;
  /** Valor de fallback para Promises não resolvidas */
  promiseFallback?: string;
  /** Se true, inclui o tipo original como _type no resultado */
  preserveTypeInfo?: boolean;
}

const DEFAULT_OPTIONS: Required<SafeSerializeOptions> = {
  maxDepth: 10,
  promiseFallback: '[Promise pendente]',
  preserveTypeInfo: false,
};

/**
 * Verifica se um valor é uma Promise
 */
function isPromise(value: unknown): value is Promise<unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as Promise<unknown>).then === 'function'
  );
}

/**
 * Verifica se um valor é um objeto Date
 */
function isDate(value: unknown): value is Date {
  return value instanceof Date;
}

/**
 * Verifica se um valor é um BigInt
 */
function isBigInt(value: unknown): value is bigint {
  return typeof value === 'bigint';
}

/**
 * Verifica se um valor é uma função
 */
function isFunction(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === 'function';
}

/**
 * Verifica se um valor é um símbolo
 */
function isSymbol(value: unknown): value is symbol {
  return typeof value === 'symbol';
}

/**
 * Verifica se um valor é um objeto simples (não array, não null)
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !isDate(value) &&
    !isPromise(value)
  );
}

/**
 * Serializa um valor de forma segura para React
 */
function serializeValue(
  value: unknown,
  depth: number,
  options: Required<SafeSerializeOptions>,
  seen: WeakSet<object>,
): SerializableValue {
  // Limite de profundidade
  if (depth > options.maxDepth) {
    return '[Profundidade máxima excedida]';
  }

  // Valores primitivos seguros
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  // BigInt → string
  if (isBigInt(value)) {
    return options.preserveTypeInfo
      ? { _type: 'bigint', value: value.toString() }
      : value.toString();
  }

  // Date → ISO string
  if (isDate(value)) {
    const isoString = value.toISOString();
    return options.preserveTypeInfo ? { _type: 'date', value: isoString } : isoString;
  }

  // Promise → fallback
  if (isPromise(value)) {
    return options.preserveTypeInfo
      ? { _type: 'promise', value: options.promiseFallback }
      : options.promiseFallback;
  }

  // Funções → remover
  if (isFunction(value)) {
    return options.preserveTypeInfo ? { _type: 'function', value: '[Função]' } : '[Função]';
  }

  // Símbolos → remover
  if (isSymbol(value)) {
    return options.preserveTypeInfo
      ? { _type: 'symbol', value: value.toString() }
      : value.toString();
  }

  // Detectar referência circular
  if (typeof value === 'object') {
    if (seen.has(value as object)) {
      return '[Referência circular]';
    }
    seen.add(value as object);
  }

  // Arrays
  if (Array.isArray(value)) {
    return value.map((item) => serializeValue(item, depth + 1, options, seen));
  }

  // Objetos simples
  if (isPlainObject(value)) {
    const result: Record<string, SerializableValue> = {};

    for (const key of Object.keys(value)) {
      // Ignora propriedades com símbolos como chave
      if (typeof key !== 'string') continue;

      const propValue = value[key];
      // Ignora funções e símbolos em propriedades
      if (!isFunction(propValue) && !isSymbol(propValue)) {
        result[key] = serializeValue(propValue, depth + 1, options, seen);
      }
    }

    return result;
  }

  // Fallback para outros tipos
  try {
    return String(value);
  } catch (_) {
    return '[Valor não serializável]';
  }
}

/**
 * Serializa um objeto de forma segura para renderização em React.
 *
 * @example
 * ```typescript
 * const unsafe = {
 *   date: new Date(),
 *   bigNum: BigInt(123),
 *   promise: fetch('/api'),
 *   fn: () => {},
 *   nested: { deep: { value: 42 } }
 * };
 *
 * const safe = safeSerialize(unsafe);
 * // { date: "2024-01-15T...", bigNum: "123", promise: "[Promise pendente]", nested: { deep: { value: 42 } } }
 * ```
 */
export function safeSerialize<T = SerializableValue>(
  value: unknown,
  options?: SafeSerializeOptions,
): T {
  const mergedOptions = { ...DEFAULT_OPTIONS, ...options };
  const seen = new WeakSet<object>();

  return serializeValue(value, 0, mergedOptions, seen) as T;
}
