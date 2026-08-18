import { Request, Response, NextFunction } from 'express';
import { z, AnyZodObject } from 'zod';
import { ValidationError } from './error-handler';

export const validateRequest = (schema: AnyZodObject) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const hasNested =
        'body' in schema.shape || 'query' in schema.shape || 'params' in schema.shape;
      if (hasNested) {
        await schema.parseAsync({
          body: req.body,
          query: req.query,
          params: req.params,
        });
      } else {
        await schema.parseAsync({
          ...req.params,
          ...req.query,
          ...req.body,
        });
      }
      return next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        // Pass to global error handler
        return next(
          new ValidationError(
            'Invalid request data',
            error.errors.map((e) => ({ path: e.path.join('.'), message: e.message })),
          ),
        );
      }
      return next(error);
    }
  };
};
