import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Job, LLMClient, LLMRequest, LLMResponse } from '@jobforge/plugin-sdk';
import { assembleTex } from './assembler.js';
import { loadResume } from './manifest-loader.js';
import { deterministicSelection } from './index.js';
import { extractItemCatalogue, tailorSkills, techStackItems, validateSkillsLatex } from './skills.js';

const ORIGINAL = `\\begin{itemize}[leftmargin=0.15in, label={}]
    \\small{\\item{
     \\textbf{Languages}{: JavaScript, TypeScript, Python, Java, SQL} \\\\
     \\textbf{Frameworks \\& Libraries}{: React, Vue 3, Node.js, Fastify} \\\\
     \\textbf{Databases \\& Cloud}{: PostgreSQL, Redis, AWS}
    }}
\\end{itemize}`;

describe('skills validator', () => {
  it('accepts a reorder within the original catalogue', () => {
    const catalogue = extractItemCatalogue(ORIGINAL);
    const tailored = `\\begin{itemize}[leftmargin=0.15in, label={}]
    \\small{\\item{
     \\textbf{Languages}{: TypeScript, JavaScript, Python} \\\\
     \\textbf{Databases \\& Cloud}{: PostgreSQL, Redis}
    }}
\\end{itemize}`;
    const r = validateSkillsLatex(tailored, catalogue);
    expect(r.ok).toBe(true);
  });

  it('rejects invented items', () => {
    const catalogue = extractItemCatalogue(ORIGINAL);
    const tailored = `\\begin{itemize}[leftmargin=0.15in, label={}]
    \\small{\\item{\\textbf{Languages}{: Rust, Go}}}
\\end{itemize}`;
    const r = validateSkillsLatex(tailored, catalogue);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/invented items/);
  });

  it('rejects shell-escape and other forbidden tokens', () => {
    const catalogue = extractItemCatalogue(ORIGINAL);
    const tailored = `\\begin{itemize}[leftmargin=0.15in, label={}]\\immediate\\write18{echo pwned}\\end{itemize}`;
    const r = validateSkillsLatex(tailored, catalogue);
    expect(r.ok).toBe(false);
  });

  it('rejects unknown LaTeX commands', () => {
    const catalogue = extractItemCatalogue(ORIGINAL);
    const tailored = `\\begin{itemize}[leftmargin=0.15in, label={}]
     \\textcolor{red}{\\textbf{Languages}{: Python}}
\\end{itemize}`;
    const r = validateSkillsLatex(tailored, catalogue);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/disallowed command/);
  });

  it('rejects fragments that do not open with \\begin{itemize}', () => {
    const catalogue = extractItemCatalogue(ORIGINAL);
    const r = validateSkillsLatex('nothing here', catalogue);
    expect(r.ok).toBe(false);
  });
});

describe('skills rewrite v2', () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const MANIFEST = resolve(HERE, '../../../profile/resume/manifest.yaml');
  const JOB: Job = {
    id: 'j1',
    companyId: 'c1',
    company: 'Acme',
    title: 'ML Engineer',
    normalizedTitle: 'ml engineer',
    locations: [],
    remotePolicy: null,
    seniority: null,
    descriptionMd: 'Python, Groq inference, Kubernetes.',
    applyUrl: 'https://example.com',
    postedAt: null,
    embedding: null,
  };

  function llmReturning(latex: string) {
    const prompts: string[] = [];
    const llm: LLMClient = {
      async generate<T>(req: LLMRequest<T>): Promise<LLMResponse<T>> {
        prompts.push(req.prompt);
        return {
          data: req.schema.parse({ latex }),
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          provider: 'fake',
          model: 'fake',
        };
      },
    };
    return { llm, prompts };
  }

  const withAi = (items: string) => `\\begin{itemize}[leftmargin=0.15in, label={}]
    \\small{\\item{
     \\textbf{AI \\& ML}{: ${items}} \\\\
     \\textbf{Languages}{: Python, TypeScript}
    }}
\\end{itemize}`;

  async function run(latex: string, withDrillMirror: boolean) {
    const resume = await loadResume(MANIFEST);
    const ids = deterministicSelection(resume).included_block_ids.filter((id) => withDrillMirror || id !== 'proj.drillmirror');
    const tex = assembleTex({ resume, includedBlockIds: ids });
    const { llm, prompts } = llmReturning(latex);
    const r = await tailorSkills(resume, JOB, { assembledTex: tex, includedBlockIds: ids }, { llm, signal: AbortSignal.timeout(5000) });
    return { r: r!, prompt: prompts[0]! };
  }

  it('collects tech-stack items of the selected blocks only', async () => {
    const resume = await loadResume(MANIFEST);
    expect(techStackItems(resume, ['proj.drillmirror', 'proj.crdt'])).toEqual([
      'Python', 'OWL', 'Scikit-learn', 'Groq', 'TypeScript', 'Node.js', 'WebSockets',
    ]);
  });

  it('surfaces a tech-stack-only item (Groq) and shows the LLM the assembled resume', async () => {
    const { r, prompt } = await run(withAi('LLMs, Groq, Scikit-learn'), true);
    expect(r.used).toBe(true);
    expect(r.latex).toContain('Groq');
    expect(prompt).toContain('DrillMirror - Digital Twin for Oil Drilling');
    expect(prompt).toMatch(/Allowed items not in the fragment[^\n]*\n.*Groq/);
    expect(prompt).not.toContain('\\usepackage');
  });

  it('rejects an invented item (Kubernetes)', async () => {
    const { r } = await run(withAi('LLMs, Groq, Kubernetes'), true);
    expect(r.used).toBe(false);
    expect(r.reason).toMatch(/invented items: Kubernetes/);
  });

  it('rejects a tech-stack item whose block was not selected', async () => {
    const { r } = await run(withAi('LLMs, Groq'), false);
    expect(r.used).toBe(false);
    expect(r.reason).toMatch(/Groq/);
  });
});
