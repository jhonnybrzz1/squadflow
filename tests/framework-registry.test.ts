import { describe, it, expect, beforeEach } from 'vitest';
import { FrameworkRegistry } from '../server/frameworks/framework-registry';
import { JTBDFrameworkImpl } from '../server/frameworks/implementations/jtbd';
import { HEARTFrameworkImpl } from '../server/frameworks/implementations/heart';

describe('FrameworkRegistry', () => {
  let registry: FrameworkRegistry;

  beforeEach(() => {
    registry = new FrameworkRegistry();
  });

  describe('register', () => {
    it('registers a framework', () => {
      const framework = new JTBDFrameworkImpl();
      registry.register(framework);
      expect(registry.has(framework.id)).toBe(true);
    });

    it('overwrites existing framework with same ID', () => {
      const framework1 = new JTBDFrameworkImpl();
      const framework2 = new JTBDFrameworkImpl();
      registry.register(framework1);
      registry.register(framework2);
      expect(registry.size()).toBe(1);
    });
  });

  describe('unregister', () => {
    it('removes a registered framework', () => {
      const framework = new JTBDFrameworkImpl();
      registry.register(framework);
      const result = registry.unregister(framework.id);
      expect(result).toBe(true);
      expect(registry.has(framework.id)).toBe(false);
    });

    it('returns false for non-existent framework', () => {
      const result = registry.unregister('non-existent');
      expect(result).toBe(false);
    });
  });

  describe('get', () => {
    it('returns registered framework', () => {
      const framework = new JTBDFrameworkImpl();
      registry.register(framework);
      const retrieved = registry.get(framework.id);
      expect(retrieved).toBe(framework);
    });

    it('returns undefined for non-existent framework', () => {
      const retrieved = registry.get('non-existent');
      expect(retrieved).toBeUndefined();
    });
  });

  describe('getAll', () => {
    it('returns all registered frameworks', () => {
      const jtbd = new JTBDFrameworkImpl();
      const heart = new HEARTFrameworkImpl();
      registry.register(jtbd);
      registry.register(heart);
      const all = registry.getAll();
      expect(all).toHaveLength(2);
    });

    it('returns empty array when no frameworks registered', () => {
      const all = registry.getAll();
      expect(all).toEqual([]);
    });
  });

  describe('getByType', () => {
    it('returns frameworks of specified type', () => {
      const jtbd = new JTBDFrameworkImpl();
      const heart = new HEARTFrameworkImpl();
      registry.register(jtbd);
      registry.register(heart);
      const jtbdFrameworks = registry.getByType('jtbd');
      expect(jtbdFrameworks).toHaveLength(1);
      expect(jtbdFrameworks[0].type).toBe('jtbd');
    });

    it('returns empty array for non-existent type', () => {
      const frameworks = registry.getByType('non-existent');
      expect(frameworks).toEqual([]);
    });
  });

  describe('has', () => {
    it('returns true for registered framework', () => {
      const framework = new JTBDFrameworkImpl();
      registry.register(framework);
      expect(registry.has(framework.id)).toBe(true);
    });

    it('returns false for non-existent framework', () => {
      expect(registry.has('non-existent')).toBe(false);
    });
  });

  describe('size', () => {
    it('returns number of registered frameworks', () => {
      expect(registry.size()).toBe(0);
      registry.register(new JTBDFrameworkImpl());
      expect(registry.size()).toBe(1);
      registry.register(new HEARTFrameworkImpl());
      expect(registry.size()).toBe(2);
    });
  });

  describe('clear', () => {
    it('removes all frameworks', () => {
      registry.register(new JTBDFrameworkImpl());
      registry.register(new HEARTFrameworkImpl());
      registry.clear();
      expect(registry.size()).toBe(0);
    });
  });
});
