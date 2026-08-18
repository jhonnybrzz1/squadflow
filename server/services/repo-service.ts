import { eq, and, sql } from 'drizzle-orm';
import { db, isPostgres } from '../db';
import { repos, repoFiles } from '@shared/schema-unified';
import { InsertRepo, Repo, RepoFile } from '@shared/schema';
import { GitHubService } from './github';
import { openAIService } from './openai-ai';
import { z } from 'zod';
import { logger } from '../utils/logger';
import { dbRun } from '../utils/db-utils';

const isSupportedGitHubToken = (token: string): boolean => token.startsWith('github_pat_');

const repositoryContextSchema = z.object({
  repositoryBriefing: z
    .object({
      projectType: z.string().default('outro'),
      techStack: z.array(z.string()).default([]),
      architecturalPattern: z.string().default('Desconhecido'),
      technicalStage: z.string().default('em desenvolvimento ativo'),
      criticalAreas: z.array(z.string()).default([]),
      sensitiveAreas: z.array(z.string()).default([]),
    })
    .passthrough(),
  systemMap: z.string().default(''),
});

export class RepoService {
  private gitHubService: GitHubService;
  private initPromise: Promise<void>;

  constructor() {
    const githubToken = process.env.GITHUB_ACCESS_TOKEN || process.env.GITHUB_TOKEN;
    logger.debug('RepoService inicializando GitHubService', {
      context: { tokenAvailable: !!githubToken },
    });
    if (githubToken) {
      logger.debug('GitHub token disponível');
      // Validate token format
      if (!isSupportedGitHubToken(githubToken)) {
        logger.warn(
          'Use um fine-grained GitHub personal access token que começa com "github_pat_" com permissões de leitura de repositório.',
        );
      }
    }
    this.gitHubService = new GitHubService(githubToken || undefined);
    this.initPromise = this.ensureSchema();
  }

  private async ensureSchema(): Promise<void> {
    if (!isPostgres) return;

    try {
      await dbRun(
        db,
        sql`
          CREATE TABLE IF NOT EXISTS repos (
            id SERIAL PRIMARY KEY,
            owner TEXT NOT NULL,
            name TEXT NOT NULL,
            full_name TEXT NOT NULL UNIQUE,
            description TEXT,
            url TEXT NOT NULL,
            clone_url TEXT,
            ssh_url TEXT,
            html_url TEXT,
            default_branch TEXT,
            language TEXT,
            size INTEGER,
            stars INTEGER DEFAULT 0,
            forks INTEGER DEFAULT 0,
            is_private BOOLEAN DEFAULT FALSE,
            is_fork BOOLEAN DEFAULT FALSE,
            indexed_content TEXT,
            indexed_at TIMESTAMP,
            briefing TEXT,
            briefing_generated_at TIMESTAMP,
            system_map TEXT,
            system_map_generated_at TIMESTAMP,
            last_commit TEXT,
            last_commit_date TIMESTAMP,
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW()
          )
        `,
      );

      await dbRun(
        db,
        sql`
          CREATE TABLE IF NOT EXISTS repo_files (
            id SERIAL PRIMARY KEY,
            repo_id INTEGER REFERENCES repos(id) ON DELETE CASCADE,
            path TEXT NOT NULL,
            filename TEXT NOT NULL,
            content TEXT,
            language TEXT,
            size INTEGER,
            sha TEXT,
            url TEXT,
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW()
          )
        `,
      );
    } catch (error) {
      logger.warn('Não foi possível garantir schema de repositórios', {
        error: error instanceof Error ? error : undefined,
      });
    }
  }

  async generateStructuralContext(owner: string, name: string): Promise<void> {
    logger.info(`Iniciando geração de contexto estrutural para ${owner}/${name}`);
    const repo = await this.getOrCreateRepo(owner, name);

    // 1. Coletar dados do repositório
    const { defaultBranch } = repo;
    if (!defaultBranch) {
      logger.error(`Branch padrão não encontrado para ${owner}/${name}`);
      return;
    }

    let fileTree = '';
    let keyFilesContent = '';

    try {
      // Primeiro, verificar se o repositório é acessível
      try {
        logger.debug(`Verificando acessibilidade do repositório ${owner}/${name}`);
        await this.gitHubService.client.repos.get({ owner, repo: name });
        logger.debug(`Repositório ${owner}/${name} é acessível`);
      } catch (checkError) {
        logger.error(`Repositório ${owner}/${name} não é acessível ou não existe`, {
          error: checkError instanceof Error ? checkError : undefined,
        });
        // Se o repositório não é acessível, não tente gerar o contexto
        return;
      }

      // Buscar a árvore de arquivos completa
      try {
        logger.debug(
          `Buscando árvore de arquivos para ${owner}/${name} no branch ${defaultBranch}`,
        );
        const treeData = await this.gitHubService.client.git.getTree({
          owner,
          repo: name,
          tree_sha: defaultBranch,
          recursive: 'true',
        });
        if (treeData.data.truncated) {
          logger.warn(`A árvore de arquivos para ${owner}/${name} está truncada.`);
        }
        fileTree = treeData.data.tree.map((file) => file.path).join('\n');
        logger.debug(`Árvore de arquivos obtida com sucesso`, {
          context: { repo: `${owner}/${name}`, fileCount: treeData.data.tree.length },
        });
      } catch (treeError) {
        logger.error(`Erro ao buscar árvore de arquivos para ${owner}/${name}`, {
          error: treeError instanceof Error ? treeError : undefined,
        });
        // Se não conseguirmos a árvore de arquivos, não podemos gerar o contexto
        return;
      }

      // Identificar e ler o conteúdo de arquivos chave
      const keyFiles = [
        'package.json',
        'pom.xml',
        'build.gradle',
        'requirements.txt',
        'docker-compose.yml',
        'README.md',
        'ARCHITECTURE.md',
        'tsconfig.json',
      ];
      try {
        logger.debug(`Buscando conteúdo da raiz para identificar arquivos chave`, {
          context: { repo: `${owner}/${name}` },
        });
        const rootContent = await this.gitHubService.getRepoContent(owner, name);
        const rootItems = Array.isArray(rootContent) ? rootContent : [];
        const filesToRead = rootItems.filter(
          (item: { type: string; name: string; path: string }) =>
            item.type === 'file' && keyFiles.includes(item.name),
        );
        logger.debug(`Arquivos chave encontrados`, {
          context: { repo: `${owner}/${name}`, files: filesToRead.map((f) => f.name) },
        });

        for (const file of filesToRead) {
          try {
            const content = await this.gitHubService.getRepoContent(owner, name, file.path);
            if (
              content &&
              !Array.isArray(content) &&
              'encoding' in content &&
              content.encoding === 'base64' &&
              'content' in content &&
              content.content
            ) {
              const decodedContent = Buffer.from(content.content, 'base64').toString('utf8');
              keyFilesContent += `--- CONTEÚDO DO ARQUIVO: ${file.path} ---\n${decodedContent}\n\n`;
            }
          } catch (fileError) {
            logger.warn(`Erro ao ler arquivo ${file.path}`, {
              error: fileError instanceof Error ? fileError : undefined,
            });
            // Continue com os outros arquivos mesmo se um falhar
          }
        }
      } catch (contentError) {
        logger.warn(`Erro ao buscar conteúdo da raiz para ${owner}/${name}`, {
          error: contentError instanceof Error ? contentError : undefined,
        });
        // Continue mesmo sem os arquivos chave
      }
    } catch (error) {
      logger.error(`Erro ao coletar dados para o contexto estrutural de ${owner}/${name}`, {
        error: error instanceof Error ? error : undefined,
      });
      // Mesmo com erro, tenta continuar com o que tiver
    }

    // 2. Criar o prompt para a IA
    const systemPrompt = `Você é um Arquiteto de Software Sênior. Sua tarefa é analisar a estrutura de um repositório de código e gerar um "Repository Briefing" e um "System Map".

Responda em formato JSON com a seguinte estrutura:
{
  "repositoryBriefing": {
    "projectType": "monolito | microserviços | biblioteca | outro",
    "techStack": ["Tecnologia 1", "Tecnologia 2", ...],
    "architecturalPattern": "MVC | MVVM | Camadas | Hexagonal | Event-Driven | Desconhecido",
    "technicalStage": "estável | legado parcial | refatoração contínua | em desenvolvimento ativo",
    "criticalAreas": ["auth | billing | core-logic | ..."],
    "sensitiveAreas": ["migrations | feature-flags | external-integrations | ..."]
  },
  "systemMap": "PASTA / -> descrição (TAGS)\\n  PASTA /src -> código fonte (CRÍTICO)\\n    PASTA /src/api -> camada de api\\n  PASTA /test -> testes (SENSÍVEL)"
}

- projectType: Classifique o tipo de projeto.
- techStack: Liste as principais tecnologias, frameworks e linguagens.
- architecturalPattern: Identifique o padrão de arquitetura principal.
- technicalStage: Avalie o estágio técnico do projeto.
- criticalAreas: Identifique diretórios ou módulos que são o coração do sistema.
- sensitiveAreas: Identifique áreas que não devem ser alteradas sem cuidado (ex: configurações, migrações).
- systemMap: Crie um mapa de pastas simplificado, com uma breve descrição e tags como (CRÍTICO), (SENSÍVEL), (LEGADO). Use indentação para hierarquia.`;

    const userPrompt = `Analise os seguintes dados do repositório "${owner}/${name}":

--- ÁRVORE DE ARQUIVOS ---
${fileTree}

--- CONTEÚDO DE ARQUIVOS CHAVE ---
${keyFilesContent}

Gere o "Repository Briefing" e o "System Map" no formato JSON solicitado.`;

    // 3. Chamar a IA para gerar o contexto
    try {
      const contextJson = await openAIService.generateJSONResponse(systemPrompt, userPrompt, {
        maxTokens: 4000,
        taskType: 'technical',
        operation: 'repo:structural_context',
        schema: repositoryContextSchema,
      });

      // 4. Salvar no banco de dados
      await db
        .update(repos)
        .set({
          briefing: JSON.stringify(contextJson.repositoryBriefing, null, 2),
          systemMap: contextJson.systemMap,
          briefingGeneratedAt: new Date(),
          systemMapGeneratedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(repos.id, repo.id));

      logger.info(`Contexto estrutural gerado e salvo para ${owner}/${name}`);
    } catch (error) {
      logger.error(`Erro ao gerar ou salvar o contexto estrutural para ${owner}/${name}`, {
        error: error instanceof Error ? error : undefined,
      });
    }
  }

  // Track ongoing context generation to prevent duplicate calls
  private ongoingContextGeneration = new Set<string>();

  /**
   * Get or create a repository in the database
   * @param owner - Repository owner
   * @param name - Repository name
   * @returns The repository record
   */
  async getOrCreateRepo(owner: string, name: string): Promise<Repo> {
    await this.initPromise;
    const [repo] = await db
      .select()
      .from(repos)
      .where(eq(repos.fullName, `${owner}/${name}`))
      .limit(1);

    // Se o repositório já existe, verifica se o briefing precisa ser atualizado
    if (repo) {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      // Se o briefing não existe ou é mais antigo que 7 dias, gera em segundo plano
      if (!repo.briefing || !repo.briefingGeneratedAt || repo.briefingGeneratedAt < sevenDaysAgo) {
        const repoKey = `${owner}/${name}`;
        if (!this.ongoingContextGeneration.has(repoKey)) {
          this.ongoingContextGeneration.add(repoKey);
          logger.info(
            `Briefing para ${owner}/${name} desatualizado ou inexistente. Gerando em segundo plano...`,
          );
          this.generateStructuralContext(owner, name)
            .catch((error) => {
              logger.error(`Erro na geração de contexto em segundo plano para ${owner}/${name}`, {
                error: error instanceof Error ? error : undefined,
              });
            })
            .finally(() => {
              this.ongoingContextGeneration.delete(repoKey);
            });
        } else {
          logger.debug(
            `Geração de contexto já em andamento para ${owner}/${name}. Pulando chamada duplicada.`,
          );
        }
      }
      return repo;
    }

    // Se o repositório não existe, busca no GitHub e cria
    let repoDataFromGitHub;
    try {
      logger.debug(`Buscando metadados do repositório ${owner}/${name} no GitHub`);
      const response = await this.gitHubService.client.repos.get({ owner, repo: name });
      repoDataFromGitHub = response.data;
      logger.debug(`Metadados do repositório ${owner}/${name} obtidos com sucesso`);
    } catch (error: unknown) {
      logger.warn(
        `Não foi possível buscar metadados do repositório ${owner}/${name}. Criando registro mínimo.`,
        { error: error instanceof Error ? error : undefined },
      );
      repoDataFromGitHub = {
        name,
        full_name: `${owner}/${name}`,
        owner: { login: owner },
        description: 'Repositório não acessível via API do GitHub.',
        html_url: `https://github.com/${owner}/${name}`,
        default_branch: 'main',
        language: null,
        size: 0,
        stargazers_count: 0,
        forks_count: 0,
        private: false,
        fork: false,
      };
    }

    const newRepo: InsertRepo = {
      owner,
      name,
      fullName: repoDataFromGitHub.full_name,
      description: repoDataFromGitHub.description,
      url: `https://github.com/${owner}/${name}`,
      cloneUrl: repoDataFromGitHub.clone_url,
      sshUrl: repoDataFromGitHub.ssh_url,
      htmlUrl: repoDataFromGitHub.html_url,
      defaultBranch: repoDataFromGitHub.default_branch,
      language: repoDataFromGitHub.language,
      size: repoDataFromGitHub.size,
      stars: repoDataFromGitHub.stargazers_count,
      forks: repoDataFromGitHub.forks_count,
      isPrivate: repoDataFromGitHub.private,
      isFork: repoDataFromGitHub.fork,
    };

    const [createdRepo] = await db.insert(repos).values(newRepo).returning();

    // Dispara a geração de contexto em segundo plano para o novo repositório
    const repoKey = `${owner}/${name}`;
    if (!this.ongoingContextGeneration.has(repoKey)) {
      this.ongoingContextGeneration.add(repoKey);
      logger.info(
        `Disparando geração de contexto inicial para o novo repositório ${owner}/${name}...`,
      );
      this.generateStructuralContext(owner, name)
        .catch((error) => {
          logger.error(
            `Erro na geração de contexto inicial em segundo plano para ${owner}/${name}`,
            { error: error instanceof Error ? error : undefined },
          );
        })
        .finally(() => {
          this.ongoingContextGeneration.delete(repoKey);
        });
    } else {
      logger.debug(
        `Geração de contexto já em andamento para ${owner}/${name}. Pulando chamada duplicada.`,
      );
    }

    return createdRepo;
  }

  /**
   * Get a repository and its files from the database
   * @param owner - Repository owner
   * @param name - Repository name
   * @returns Repository with files
   */
  async getRepoWithFiles(
    owner: string,
    name: string,
  ): Promise<{ repo: Repo; files: RepoFile[] } | null> {
    await this.initPromise;
    const repo = await db
      .select()
      .from(repos)
      .where(eq(repos.fullName, `${owner}/${name}`))
      .limit(1);

    if (repo.length === 0) {
      return null;
    }

    const files = await db.select().from(repoFiles).where(eq(repoFiles.repoId, repo[0].id));

    return {
      repo: repo[0],
      files,
    };
  }

  /**
   * Get a specific file from a repository
   * @param repoId - Repository ID
   * @param path - File path
   * @returns The repository file
   */
  async getRepoFile(repoId: number, path: string): Promise<RepoFile | null> {
    await this.initPromise;
    const files = await db
      .select()
      .from(repoFiles)
      .where(and(eq(repoFiles.repoId, repoId), eq(repoFiles.path, path)))
      .limit(1);

    return files.length > 0 ? files[0] : null;
  }

  /**
   * Get all repositories from the database
   */
  async getAllRepos(): Promise<Repo[]> {
    await this.initPromise;
    return await db.select().from(repos);
  }

  /**
   * Get all files for a specific repository
   * @param repoId - Repository ID
   */
  async getRepoFiles(repoId: number): Promise<RepoFile[]> {
    await this.initPromise;
    return await db.select().from(repoFiles).where(eq(repoFiles.repoId, repoId));
  }

  /**
   * Update repository metadata
   * @param repoId - Repository ID
   * @param updates - Fields to update
   */
  async updateRepo(repoId: number, updates: Partial<Repo>): Promise<Repo> {
    await this.initPromise;
    const [updatedRepo] = await db
      .update(repos)
      .set({
        ...updates,
        updatedAt: new Date(),
      })
      .where(eq(repos.id, repoId))
      .returning();

    return updatedRepo;
  }
}

export const repoService = new RepoService();
