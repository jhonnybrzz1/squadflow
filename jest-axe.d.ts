declare module 'jest-axe' {
  export function axe(
    container: Element | DocumentFragment,
    options?: unknown,
  ): Promise<{
    violations: Array<unknown>;
  }>;
}
