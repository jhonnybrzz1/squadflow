// Frameworks Module - Main exports
// Export all framework-related types and classes

export * from './types';
export * from './framework-interface';
export * from './framework-registry';
export * from './framework-manager-facade';

// Export singleton instance for retrocompatibility
export { frameworkManager } from './framework-manager-facade';
