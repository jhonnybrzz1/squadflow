# Design System — Tokens visuais (Demanda 10024)

Fonte de verdade: `client/src/index.css` (CSS variables, blocos `:root` = tema escuro padrão e `.light`) + `tailwind.config.ts` (mapeamento para classes utilitárias). **Nunca** usar hex solto em componente novo — sempre token Tailwind (`bg-card`, `text-warning`) ou `var(--...)`.

## Paleta

| Token                                       | Dark (padrão)                   | Light                      | Uso                             |
| ------------------------------------------- | ------------------------------- | -------------------------- | ------------------------------- |
| `--background`                              | `#0b1220` azul-marinho profundo | `#faf7f2` off-white quente | fundo da página                 |
| `--background-elevated`                     | `#111c30`                       | `#ffffff`                  | popovers, camadas elevadas      |
| `--card`                                    | `#0f1930`                       | `#ffffff`                  | cards e superfícies             |
| `--foreground`                              | `#eef2f8`                       | `#16233c` (navy)           | texto principal                 |
| `--foreground-muted` / `--muted-foreground` | `#9aa8bd`                       | `#5b6b82`                  | metadados, texto secundário     |
| `--primary` / `--accent-gold`               | `#f0b429` dourado/âmbar         | `#b45309` âmbar escuro     | ação primária, foco, destaque   |
| `--secondary`                               | `#182742`                       | `#eee9e0`                  | ação secundária                 |
| `--border`                                  | `#1f2e4d`                       | `#e2dbce`                  | bordas sutis 1px                |
| `--input`                                   | `#12203a`                       | `#f4f0e8`                  | fundos de campo                 |
| `--ring`                                    | dourado                         | âmbar                      | anel de foco (`:focus-visible`) |

### Cores semânticas (com `-foreground` par)

| Token           | Dark      | Light     | Classe Tailwind                      | Significado         |
| --------------- | --------- | --------- | ------------------------------------ | ------------------- |
| `--success`     | `#3dd68c` | `#1a7f4e` | `bg-success text-success-foreground` | sucesso             |
| `--warning`     | `#f0b429` | `#92610a` | `bg-warning ...`                     | alerta              |
| `--destructive` | `#e5484d` | `#e5484d` | `bg-destructive ...`                 | erro                |
| `--info`        | `#6cb2f5` | `#1d4ed8` | `bg-info ...`                        | informação/execução |
| `--processing`  | `#9b96e8` | `#5b54c0` | `bg-processing ...`                  | processamento IA    |

Accents legados (`--accent-cyan`, `--accent-magenta`, `--accent-lime`, `--accent-orange`, `--accent-violet`) foram **re-tonalizados** para a base navy — os componentes antigos que os referenciam ganham o novo tom automaticamente.

## Tipografia

Fontes: `Space Grotesk` (sans, corpo), `Syne` (display, headings), `JetBrains Mono` (código/dados).

Escala semântica (Tailwind `text-*`):

| Classe               | Tamanho             | Uso                   |
| -------------------- | ------------------- | --------------------- |
| `text-page-title`    | 28px/36px, bold     | título de página      |
| `text-section-title` | 20px/28px, semibold | título de seção       |
| `text-subtitle`      | 16px/24px, medium   | subtítulo             |
| `text-body`          | 15px/24px           | corpo                 |
| `text-label`         | 13px/20px, medium   | labels de formulário  |
| `text-meta`          | 12px/16px           | metadados, timestamps |

## Espaçamento

Base 4px do Tailwind; nos layouts usar múltiplos da base 8: `gap-2` (8px), `gap-4` (16px), `gap-6` (24px), `p-4`/`p-6` em cards, `space-y-6` entre seções.

## Raios e sombras

- `--radius: 0.75rem` (antes `0px` — brutalista). Classes: `rounded-sm|md|lg` derivam de `--radius`.
- Sombras suaves: `shadow-soft-sm|soft-md|soft-lg` (via `--shadow-soft-*`). Os glows neon (`--glow-*`) agora apontam para `--shadow-soft-md` (compat).

## Modo claro/escuro

`next-themes` com `attribute="class"`; dark é o `:root` padrão e `.light` sobrepõe. Componentes novos devem usar apenas tokens — nunca condicionar cor por `dark:` com hex solto; `dark:` é permitido para ajustes estruturais (ex.: opacidade).

## Motion

`--duration-fast|normal|slow` (150/300/500ms), easings `--ease-out`, `--ease-in-out`, `--spring`. `prefers-reduced-motion` tem kill-switch global no `index.css`.

## Sidebar (shell de navegação)

Tokens dedicados `--sidebar-*` (fundo navy mais profundo que o conteúdo em ambos os temas; item ativo âmbar). Mapeados no Tailwind como `bg-sidebar`, `text-sidebar-foreground`, `bg-sidebar-accent`, etc.
