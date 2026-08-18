import { projectRoot } from '@shared/utils/paths';
import { logger } from '../utils/logger';
import { generateRequestId } from '../utils/request-id';
import * as fs from 'fs';
import * as path from 'path';

export interface ProjectReality {
  stack: {
    frontend: string[];
    backend: string[];
    database: string[];
    infrastructure: string[];
    ai: string[];
  };
  maturityLevel: 'MVP' | 'Initial Product' | 'Scaling Product';
  capabilities: {
    stableBackend: boolean;
    structuredAI: boolean;
    advancedFrontend: boolean;
  };
  detectedAt: string;
}

export class ProjectRealityReader {
  private projectRoot: string;

  constructor(root: string = projectRoot) {
    this.projectRoot = root;
  }

  public async readProjectReality(): Promise<ProjectReality> {
    const stack = await this.detectStack();
    const maturityLevel = this.determineMaturityLevel(stack);
    const capabilities = this.detectCapabilities(stack);

    return {
      stack,
      maturityLevel,
      capabilities,
      detectedAt: new Date().toISOString(),
    };
  }

  private async detectStack(): Promise<ProjectReality['stack']> {
    const frontend = this.detectFrontendStack();
    const backend = this.detectBackendStack();
    const database = this.detectDatabaseStack();
    const infrastructure = this.detectInfrastructureStack();
    const ai = this.detectAIStack();

    return { frontend, backend, database, infrastructure, ai };
  }

  private detectFrontendStack(): string[] {
    const technologies: string[] = [];

    // Check for common frontend frameworks
    if (fs.existsSync(path.join(this.projectRoot, 'package.json'))) {
      const packageJson = JSON.parse(
        fs.readFileSync(path.join(this.projectRoot, 'package.json'), 'utf-8'),
      );

      if (packageJson.dependencies) {
        if (packageJson.dependencies.react) technologies.push('React');
        if (packageJson.dependencies['@angular/core']) technologies.push('Angular');
        if (packageJson.dependencies.vue) technologies.push('Vue');
        if (packageJson.dependencies.svelte) technologies.push('Svelte');
        if (packageJson.dependencies.next) technologies.push('Next.js');
        if (packageJson.dependencies['@nestjs/core']) technologies.push('NestJS');
      }
    }

    // Check for TypeScript
    if (fs.existsSync(path.join(this.projectRoot, 'tsconfig.json'))) {
      technologies.push('TypeScript');
    }

    return technologies;
  }

  private detectBackendStack(): string[] {
    const technologies: string[] = [];

    // Check for Node.js
    if (fs.existsSync(path.join(this.projectRoot, 'package.json'))) {
      const packageJson = JSON.parse(
        fs.readFileSync(path.join(this.projectRoot, 'package.json'), 'utf-8'),
      );

      if (packageJson.dependencies) {
        if (packageJson.dependencies.express) technologies.push('Express');
        if (packageJson.dependencies.koa) technologies.push('Koa');
        if (packageJson.dependencies.fastify) technologies.push('Fastify');
        if (packageJson.dependencies['@nestjs/core']) technologies.push('NestJS');
      }
    }

    // Check for Python
    if (
      fs.existsSync(path.join(this.projectRoot, 'requirements.txt')) ||
      fs.existsSync(path.join(this.projectRoot, 'Pipfile'))
    ) {
      technologies.push('Python');
    }

    // Check for Java
    if (fs.existsSync(path.join(this.projectRoot, 'pom.xml'))) {
      technologies.push('Java/Spring');
    }

    return technologies;
  }

  private detectDatabaseStack(): string[] {
    const technologies: string[] = [];

    // Check for common database indicators
    if (fs.existsSync(path.join(this.projectRoot, 'package.json'))) {
      const packageJson = JSON.parse(
        fs.readFileSync(path.join(this.projectRoot, 'package.json'), 'utf-8'),
      );

      if (packageJson.dependencies) {
        if (packageJson.dependencies.mongoose) technologies.push('MongoDB');
        if (packageJson.dependencies.sequelize) technologies.push('SQL');
        if (packageJson.dependencies.typeorm) technologies.push('TypeORM');
        if (packageJson.dependencies.prisma) technologies.push('Prisma');
      }
    }

    // Check for SQLite files
    try {
      const files = fs.readdirSync(this.projectRoot);
      const dbFiles = files.filter(
        (file) => file.endsWith('.db') || file.endsWith('.sqlite') || file.endsWith('.sqlite3'),
      );
      if (dbFiles.length > 0) {
        technologies.push('SQLite');
      }
    } catch (error) {
      logger.error('Error reading directory for database files', {
        error: error instanceof Error ? error : undefined,
        context: { projectRoot: this.projectRoot, operationId: generateRequestId() },
      });
    }

    return technologies;
  }

  private detectInfrastructureStack(): string[] {
    const technologies: string[] = [];

    // Check for Docker
    if (
      fs.existsSync(path.join(this.projectRoot, 'Dockerfile')) ||
      fs.existsSync(path.join(this.projectRoot, 'docker-compose.yml'))
    ) {
      technologies.push('Docker');
    }

    // Check for Kubernetes
    if (
      fs.existsSync(path.join(this.projectRoot, 'k8s')) ||
      fs.existsSync(path.join(this.projectRoot, 'kubernetes'))
    ) {
      technologies.push('Kubernetes');
    }

    // Check for AWS
    if (
      fs.existsSync(path.join(this.projectRoot, 'serverless.yml')) ||
      fs.existsSync(path.join(this.projectRoot, 'template.yaml'))
    ) {
      technologies.push('AWS');
    }

    return technologies;
  }

  private detectAIStack(): string[] {
    const technologies: string[] = [];

    if (fs.existsSync(path.join(this.projectRoot, 'package.json'))) {
      const packageJson = JSON.parse(
        fs.readFileSync(path.join(this.projectRoot, 'package.json'), 'utf-8'),
      );

      if (packageJson.dependencies) {
        if (packageJson.dependencies['@tensorflow/tfjs']) technologies.push('TensorFlow.js');
        if (packageJson.dependencies['@xenova/transformers']) technologies.push('Transformers.js');
        if (packageJson.dependencies['langchain']) technologies.push('LangChain');
        if (packageJson.dependencies['openai']) technologies.push('OpenAI');
      }
    }

    // Check for Python AI libraries
    if (fs.existsSync(path.join(this.projectRoot, 'requirements.txt'))) {
      const requirements = fs.readFileSync(
        path.join(this.projectRoot, 'requirements.txt'),
        'utf-8',
      );

      if (requirements.includes('tensorflow')) technologies.push('TensorFlow');
      if (requirements.includes('pytorch')) technologies.push('PyTorch');
      if (requirements.includes('transformers')) technologies.push('HuggingFace Transformers');
    }

    return technologies;
  }

  private determineMaturityLevel(stack: ProjectReality['stack']): ProjectReality['maturityLevel'] {
    // Count the number of technology categories present
    const categoriesPresent = [
      stack.frontend.length > 0,
      stack.backend.length > 0,
      stack.database.length > 0,
      stack.infrastructure.length > 0,
      stack.ai.length > 0,
    ].filter(Boolean).length;

    // Count total technologies
    const totalTechnologies = [
      ...stack.frontend,
      ...stack.backend,
      ...stack.database,
      ...stack.infrastructure,
      ...stack.ai,
    ].length;

    // Determine maturity level
    if (categoriesPresent <= 2 && totalTechnologies <= 3) {
      return 'MVP';
    } else if (categoriesPresent <= 3 && totalTechnologies <= 6) {
      return 'Initial Product';
    } else {
      return 'Scaling Product';
    }
  }

  private detectCapabilities(stack: ProjectReality['stack']): ProjectReality['capabilities'] {
    return {
      stableBackend: stack.backend.length > 0 && stack.database.length > 0,
      structuredAI: stack.ai.length > 0,
      advancedFrontend:
        stack.frontend.includes('React') ||
        stack.frontend.includes('Angular') ||
        stack.frontend.includes('Vue'),
    };
  }
}
